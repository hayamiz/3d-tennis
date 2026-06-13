// =============================================================================
// UI クラス — HUD・メニュー・マッチ終了画面の DOM 管理
// ARCHITECTURE §13 の契約に従う。
// =============================================================================

import type {
  UIHandlers,
  HudView,
  MatchResult,
  Difficulty,
  MatchConfig,
  ServeType,
  PersonaId,
} from '../types'
import {
  SERVE_SWEET_MIN,
  SERVE_SWEET_MAX,
  STAMINA_LOW_THRESHOLD,
  STAMINA_MAX,
  STAMINA_GAUGE_GREEN,
  STAMINA_GAUGE_YELLOW,
  PLAYER_PERSONAS,
  PERSONA_ORDER,
} from '../constants'

// ---------------------------------------------------------------------------
// 内部ヘルパー: DOM 要素生成
// ---------------------------------------------------------------------------

/** タグ名とオプションのクラス名で要素を生成する */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text != null) e.textContent = text
  return e
}

// ---------------------------------------------------------------------------
// キャッシュ: 前回 updateHud に渡された値(差分更新用)
// ---------------------------------------------------------------------------

interface HudCache {
  pointPlayer: string
  pointOpponent: string
  gamePlayer: number
  gameOpponent: number
  server: string
  playerStamina: number
  opponentStamina: number
  serveMeterActive: boolean
  serveMeterValue: number
  serveNumber: number
  phase: string
  banner: string | null
  /** チャージバー: null=非表示、非 null=表示中 */
  chargeValue: number | null
  chargeOvercharged: boolean
  /** 選択中のサーブ種類(サーブフェーズ表示用) */
  serveType: ServeType
  /** 円形ゲージ: 前回の pct 値(差分更新用) */
  playerStaminaPct: number
  opponentStaminaPct: number
}

// ---------------------------------------------------------------------------
// レーダーチャート描画
// ---------------------------------------------------------------------------

/**
 * 六角形レーダーチャートを canvas に描画する。
 * 軸の順(時計回り): サーブ → パワー → スピン/安定 → スタミナ → 技巧 → スピード
 * IMPROVEMENTS §3.1 の並びに従う。
 */
function drawRadar(
  canvas: HTMLCanvasElement,
  ratings: { serve: number; power: number; spin: number; speed: number; stamina: number; finesse: number },
  strokeColor: string,
  fillColor: string,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)

  const cx = w / 2
  const cy = h / 2
  // 外周グリッドのサイズ(最大 rating=5 のときの半径)
  const maxR = Math.min(w, h) * 0.42
  const N = 6
  // 頂点0が上(12時方向)から時計回り
  // IMPROVEMENTS §3.1: サーブ→パワー→スピン/安定→スタミナ→技巧→スピード
  const axisLabels = ['サーブ', 'パワー', 'スピン/安定', 'スタミナ', '技巧', 'スピード']
  const axisValues = [
    ratings.serve,
    ratings.power,
    ratings.spin,
    ratings.stamina,
    ratings.finesse,
    ratings.speed,
  ]
  const MAX_RATING = 5

  /** 軸インデックス i の頂点座標を返す(0=上=12時から時計回り) */
  function axisXY(i: number, r: number): { x: number; y: number } {
    const angle = (Math.PI * 2 * i) / N - Math.PI / 2
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
  }

  // --- グリッド描画(5段階の同心六角形) ---
  for (let level = 1; level <= MAX_RATING; level++) {
    const r = (maxR * level) / MAX_RATING
    ctx.beginPath()
    for (let i = 0; i < N; i++) {
      const { x, y } = axisXY(i, r)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 0.8
    ctx.stroke()
  }

  // --- 軸線 ---
  for (let i = 0; i < N; i++) {
    const { x, y } = axisXY(i, maxR)
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(x, y)
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.lineWidth = 0.8
    ctx.stroke()
  }

  // --- データ多角形 ---
  ctx.beginPath()
  for (let i = 0; i < N; i++) {
    const r = (maxR * axisValues[i]) / MAX_RATING
    const { x, y } = axisXY(i, r)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fillStyle = fillColor
  ctx.fill()
  ctx.strokeStyle = strokeColor
  ctx.lineWidth = 2
  ctx.stroke()

  // --- 頂点ドット ---
  for (let i = 0; i < N; i++) {
    const r = (maxR * axisValues[i]) / MAX_RATING
    const { x, y } = axisXY(i, r)
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.fillStyle = strokeColor
    ctx.fill()
  }

  // --- 軸ラベル ---
  ctx.fillStyle = 'rgba(200,220,240,0.80)'
  ctx.font = `${Math.round(w * 0.085)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < N; i++) {
    const labelR = maxR + 16
    const { x, y } = axisXY(i, labelR)
    ctx.fillText(axisLabels[i], x, y)
  }
}

// ---------------------------------------------------------------------------
// ペルソナピッカーコンポーネント
// ---------------------------------------------------------------------------

interface PersonaPickerRefs {
  canvas: HTMLCanvasElement
  /** ピッカー全体の外側コンテナ(選択変更時に再描画を起動するために保持) */
  container: HTMLElement
}

interface PersonaPickerResult {
  /** 現在の選択ペルソナ ID を返すゲッター */
  getPersonaId: () => PersonaId
  refs: PersonaPickerRefs
}

/**
 * ペルソナピッカーを構築して親要素に追加する。
 * title: 「あなた」「相手」などのラベル。
 * defaultId: 初期選択ペルソナ。
 * strokeColor/fillColor: レーダーチャートの色。
 */
function buildPersonaPicker(
  parent: HTMLElement,
  title: string,
  defaultId: PersonaId,
  strokeColor: string,
  fillColor: string,
): PersonaPickerResult {
  let currentIndex = PERSONA_ORDER.indexOf(defaultId)
  if (currentIndex < 0) currentIndex = 0

  const container = el('div', 'persona-picker')

  // --- タイトルラベル ---
  container.appendChild(el('div', 'persona-picker-title', title))

  // --- 名前行(◀ 名前 ▶) ---
  const nameRow = el('div', 'persona-name-row')

  const prevBtn = el('button', 'persona-nav-btn', '◀')
  const nameEl = el('span', 'persona-name', '')
  const nextBtn = el('button', 'persona-nav-btn', '▶')

  nameRow.appendChild(prevBtn)
  nameRow.appendChild(nameEl)
  nameRow.appendChild(nextBtn)
  container.appendChild(nameRow)

  // --- レーダーチャート canvas ---
  const canvas = document.createElement('canvas')
  canvas.className = 'persona-radar'
  canvas.width = 200
  canvas.height = 200
  container.appendChild(canvas)

  // --- アーキタイプ + blurb ---
  const archetypeEl = el('div', 'persona-archetype', '')
  const blurbEl = el('div', 'persona-blurb', '')
  container.appendChild(archetypeEl)
  container.appendChild(blurbEl)

  // --- ランダムボタン ---
  const randomBtn = el('button', 'persona-random-btn', '🎲 ランダム')
  container.appendChild(randomBtn)

  parent.appendChild(container)

  /** 表示・レーダーを現在インデックスに合わせて更新する */
  function refresh(): void {
    const id = PERSONA_ORDER[currentIndex]
    const persona = PLAYER_PERSONAS[id]
    nameEl.textContent = persona.name
    archetypeEl.textContent = persona.archetype
    blurbEl.textContent = persona.blurb
    drawRadar(canvas, persona.ratings, strokeColor, fillColor)
  }

  prevBtn.addEventListener('click', () => {
    currentIndex = (currentIndex - 1 + PERSONA_ORDER.length) % PERSONA_ORDER.length
    refresh()
  })

  nextBtn.addEventListener('click', () => {
    currentIndex = (currentIndex + 1) % PERSONA_ORDER.length
    refresh()
  })

  randomBtn.addEventListener('click', () => {
    currentIndex = Math.floor(Math.random() * PERSONA_ORDER.length)
    refresh()
  })

  // 初期描画
  refresh()

  return {
    getPersonaId: () => PERSONA_ORDER[currentIndex],
    refs: { canvas, container },
  }
}

// ---------------------------------------------------------------------------
// UI クラス
// ---------------------------------------------------------------------------

export class UI {
  private readonly root: HTMLElement
  private readonly handlers: UIHandlers

  // 画面コンテナ
  private readonly menuScreen: HTMLElement
  private readonly hudScreen: HTMLElement
  private readonly matchOverScreen: HTMLElement

  // メニュー内の選択状態
  private selectedDifficulty: Difficulty = 'normal'
  private selectedGamesToWin: 1 | 2 | 4 = 2

  // HUD 要素(差分更新のためにキャッシュ)
  private readonly hudPointPlayer: HTMLElement
  private readonly hudPointOpponent: HTMLElement
  private readonly hudGamePlayer: HTMLElement
  private readonly hudGameOpponent: HTMLElement
  private readonly hudServerDotPlayer: HTMLElement
  private readonly hudServerDotOpponent: HTMLElement
  private readonly hudStaminaPlayerBar: HTMLElement
  private readonly hudStaminaOpponentBar: HTMLElement
  private readonly hudServeLabel: HTMLElement
  /** サーブ種類ラベル(サーブフェーズ中に FLAT / SLICE / KICK を表示) */
  private readonly hudServeTypeLabel: HTMLElement
  private readonly hudServeMeter: HTMLElement
  private readonly hudServeMeterFill: HTMLElement
  private readonly hudBanner: HTMLElement
  private readonly hudBannerText: HTMLElement
  /** チャージバーのコンテナ要素 */
  private readonly hudChargeBar: HTMLElement
  /** チャージバーの塗り(幅 % で変化) */
  private readonly hudChargeBarFill: HTMLElement
  /** マッチ情報(ペルソナ名・難易度)表示 */
  private readonly hudMiPlayer: HTMLElement
  private readonly hudMiDiff: HTMLElement
  private readonly hudMiOpponent: HTMLElement

  // -------------------------------------------------------------------------
  // 円形スタミナゲージ(キャラ頭上追従)
  // -------------------------------------------------------------------------

  /** プレイヤー円形ゲージのコンテナ(position:absolute で頭上に追従) */
  private readonly staminaRingPlayer: HTMLElement
  /** プレイヤー用 SVG の弧(stroke-dashoffset で残量を表現) */
  private readonly staminaRingPlayerArc: SVGCircleElement
  /** プレイヤー用ゲージ中央のパーセント表示ラベル */
  private readonly staminaRingPlayerLabel: HTMLElement

  /** 相手円形ゲージのコンテナ */
  private readonly staminaRingOpponent: HTMLElement
  /** 相手用 SVG の弧 */
  private readonly staminaRingOpponentArc: SVGCircleElement
  /** 相手用ゲージ中央のパーセント表示ラベル */
  private readonly staminaRingOpponentLabel: HTMLElement

  /** ポーズ画面のコンテナ */
  private readonly pauseScreen: HTMLElement

  // -------------------------------------------------------------------------
  // デバッグオーバーレイ関連フィールド
  // -------------------------------------------------------------------------

  /** オーバーレイ全体のコンテナ(左下固定) */
  private readonly debugOverlay: HTMLElement
  /** ライブログ行を格納するリスト要素 */
  private readonly debugLogEl: HTMLElement
  /** デバッグメニューのヘッダ行 */
  private readonly debugHeader: HTMLElement
  /** JSON を表示する <pre> 要素 */
  private readonly debugJsonPre: HTMLElement
  /** [Show/Hide JSON] ボタン */
  private readonly debugShowJsonBtn: HTMLButtonElement
  /** [Copy JSON] ボタン */
  private readonly debugCopyBtn: HTMLButtonElement

  /** ライブログの内部バッファ(最大200行) */
  private readonly debugLines: string[] = []
  /** 直近1ポイント分のJSON文字列 */
  private debugDumpJson: string = ''

  // 前回描画値のキャッシュ
  private cache: HudCache = {
    pointPlayer: '',
    pointOpponent: '',
    gamePlayer: -1,
    gameOpponent: -1,
    server: '',
    playerStamina: -1,
    opponentStamina: -1,
    serveMeterActive: false,
    serveMeterValue: -1,
    serveNumber: 1,
    phase: '',
    banner: undefined as unknown as null,
    chargeValue: undefined as unknown as null,
    chargeOvercharged: false,
    serveType: 'flat',
    playerStaminaPct: -1,
    opponentStaminaPct: -1,
  }

  constructor(root: HTMLElement, handlers: UIHandlers) {
    this.root = root
    this.handlers = handlers

    // 3 画面を生成(メニュー画面はペルソナピッカーのゲッターを返す)
    const menuResult = this.buildMenuScreen()
    this.menuScreen = menuResult.screen

    this.hudScreen = el('div', 'screen-hud hidden')
    this.matchOverScreen = el('div', 'screen-match-over hidden')

    // HUD 内部要素を構築して参照を保持
    const hudRefs = this.buildHudScreen(this.hudScreen)
    this.hudPointPlayer = hudRefs.pointPlayer
    this.hudPointOpponent = hudRefs.pointOpponent
    this.hudGamePlayer = hudRefs.gamePlayer
    this.hudGameOpponent = hudRefs.gameOpponent
    this.hudServerDotPlayer = hudRefs.serverDotPlayer
    this.hudServerDotOpponent = hudRefs.serverDotOpponent
    this.hudStaminaPlayerBar = hudRefs.staminaPlayerBar
    this.hudStaminaOpponentBar = hudRefs.staminaOpponentBar
    this.hudServeLabel = hudRefs.serveLabel
    this.hudServeTypeLabel = hudRefs.serveTypeLabel
    this.hudServeMeter = hudRefs.serveMeter
    this.hudServeMeterFill = hudRefs.serveMeterFill
    this.hudBanner = hudRefs.banner
    this.hudBannerText = hudRefs.bannerText
    this.hudChargeBar = hudRefs.chargeBar
    this.hudChargeBarFill = hudRefs.chargeBarFill
    this.hudMiPlayer = hudRefs.miPlayer
    this.hudMiDiff = hudRefs.miDiff
    this.hudMiOpponent = hudRefs.miOpponent

    // ポーズ画面を構築
    this.pauseScreen = this.buildPauseScreen()

    // 円形スタミナゲージを構築(HUD スクリーンに追加)
    const playerRingRefs = this.buildStaminaRing('player')
    this.staminaRingPlayer = playerRingRefs.container
    this.staminaRingPlayerArc = playerRingRefs.arc
    this.staminaRingPlayerLabel = playerRingRefs.label
    this.hudScreen.appendChild(this.staminaRingPlayer)

    const opponentRingRefs = this.buildStaminaRing('opponent')
    this.staminaRingOpponent = opponentRingRefs.container
    this.staminaRingOpponentArc = opponentRingRefs.arc
    this.staminaRingOpponentLabel = opponentRingRefs.label
    this.hudScreen.appendChild(this.staminaRingOpponent)

    root.appendChild(this.menuScreen)
    root.appendChild(this.hudScreen)
    root.appendChild(this.matchOverScreen)
    root.appendChild(this.pauseScreen)

    // デバッグオーバーレイを構築して root に追加
    const debugRefs = this.buildDebugOverlay()
    this.debugOverlay    = debugRefs.overlay
    this.debugLogEl      = debugRefs.logEl
    this.debugHeader     = debugRefs.header
    this.debugJsonPre    = debugRefs.jsonPre
    this.debugShowJsonBtn = debugRefs.showJsonBtn
    this.debugCopyBtn    = debugRefs.copyBtn
    root.appendChild(this.debugOverlay)
  }

  // -------------------------------------------------------------------------
  // 公開 API
  // -------------------------------------------------------------------------

  /** タイトル / メニュー画面を表示する */
  showMenu(): void {
    this.menuScreen.classList.remove('hidden')
    this.hudScreen.classList.add('hidden')
    this.matchOverScreen.classList.add('hidden')
  }

  /** HUD 画面を表示する(メニュー・マッチ終了を隠す) */
  showHud(): void {
    this.menuScreen.classList.add('hidden')
    this.hudScreen.classList.remove('hidden')
    this.matchOverScreen.classList.add('hidden')
    this.pauseScreen.classList.add('hidden')
    // キャッシュを無効化して次フレームに全更新させる
    this.invalidateCache()
  }

  /** ポーズ画面の表示/非表示(プレイ中の Esc トグル) */
  setPaused(on: boolean): void {
    this.pauseScreen.classList.toggle('hidden', !on)
  }

  /** スコアボードにマッチ情報(ペルソナ名・難易度)を設定する(マッチ開始時に1回) */
  setMatchInfo(info: { difficulty: string; playerName: string; opponentName: string }): void {
    this.hudMiPlayer.textContent = info.playerName
    this.hudMiOpponent.textContent = info.opponentName
    this.hudMiDiff.textContent = info.difficulty
  }

  /**
   * HUD を更新する(毎フレーム呼ばれる)。
   * DOM 書き換えは前回値からの差分のみ実行する。
   */
  updateHud(view: HudView): void {
    const c = this.cache
    const { score, playerStamina, opponentStamina, serveMeter, serveNumber, phase, banner } = view

    // --- ポイント表示 ---
    if (score.points.player !== c.pointPlayer) {
      this.hudPointPlayer.textContent = score.points.player
      c.pointPlayer = score.points.player
    }
    if (score.points.opponent !== c.pointOpponent) {
      this.hudPointOpponent.textContent = score.points.opponent
      c.pointOpponent = score.points.opponent
    }

    // --- ゲーム数 ---
    if (score.games.player !== c.gamePlayer) {
      this.hudGamePlayer.textContent = String(score.games.player)
      c.gamePlayer = score.games.player
    }
    if (score.games.opponent !== c.gameOpponent) {
      this.hudGameOpponent.textContent = String(score.games.opponent)
      c.gameOpponent = score.games.opponent
    }

    // --- サーバーマーク ---
    if (score.server !== c.server) {
      this.hudServerDotPlayer.classList.toggle('hidden', score.server !== 'player')
      this.hudServerDotOpponent.classList.toggle('hidden', score.server !== 'opponent')
      c.server = score.server
    }

    // --- 下部スタミナバー(補助表示: 円形ゲージが主表示のため小さく維持) ---
    if (playerStamina !== c.playerStamina) {
      const pct = Math.max(0, Math.min(100, (playerStamina / STAMINA_MAX) * 100))
      this.hudStaminaPlayerBar.style.width = `${pct}%`
      this.hudStaminaPlayerBar.classList.toggle('low', playerStamina < STAMINA_LOW_THRESHOLD)
      c.playerStamina = playerStamina
    }
    if (opponentStamina !== c.opponentStamina) {
      const pct = Math.max(0, Math.min(100, (opponentStamina / STAMINA_MAX) * 100))
      this.hudStaminaOpponentBar.style.width = `${pct}%`
      this.hudStaminaOpponentBar.classList.toggle('low', opponentStamina < STAMINA_LOW_THRESHOLD)
      c.opponentStamina = opponentStamina
    }

    // --- 円形スタミナゲージ(キャラ頭上追従: 毎フレーム位置・残量更新) ---
    // プレイヤーゲージ
    const psPct = view.playerStaminaPct
    const psScreen = view.playerStaminaScreen
    if (psScreen) {
      this.staminaRingPlayer.classList.remove('hidden')
      this.staminaRingPlayer.style.left = `${psScreen.x}px`
      this.staminaRingPlayer.style.top = `${psScreen.y}px`
    } else {
      this.staminaRingPlayer.classList.add('hidden')
    }
    if (psPct !== c.playerStaminaPct) {
      this.updateStaminaRingArc(this.staminaRingPlayerArc, this.staminaRingPlayerLabel, psPct)
      c.playerStaminaPct = psPct
    }

    // 相手ゲージ
    const osPct = view.opponentStaminaPct
    const osScreen = view.opponentStaminaScreen
    if (osScreen) {
      this.staminaRingOpponent.classList.remove('hidden')
      this.staminaRingOpponent.style.left = `${osScreen.x}px`
      this.staminaRingOpponent.style.top = `${osScreen.y}px`
    } else {
      this.staminaRingOpponent.classList.add('hidden')
    }
    if (osPct !== c.opponentStaminaPct) {
      this.updateStaminaRingArc(this.staminaRingOpponentArc, this.staminaRingOpponentLabel, osPct)
      c.opponentStaminaPct = osPct
    }

    // --- サーブメーター ---
    if (serveMeter.active !== c.serveMeterActive) {
      this.hudServeMeter.classList.toggle('hidden', !serveMeter.active)
      c.serveMeterActive = serveMeter.active
    }
    if (serveMeter.active && serveMeter.value !== c.serveMeterValue) {
      const pct = Math.max(0, Math.min(100, serveMeter.value * 100))
      this.hudServeMeterFill.style.height = `${pct}%`
      // バーの色をゾーンで切り替え
      const v = serveMeter.value
      this.hudServeMeterFill.classList.remove('sweet', 'overpow')
      if (v > SERVE_SWEET_MAX) {
        this.hudServeMeterFill.classList.add('overpow')
      } else if (v >= SERVE_SWEET_MIN) {
        this.hudServeMeterFill.classList.add('sweet')
      }
      c.serveMeterValue = serveMeter.value
    }

    // --- サーブ番号ラベル(上部中央)/ サーブ種類ラベル(プレイヤー頭上) ---
    const currentServeType = serveMeter.serveType
    // テキスト・色は変化時のみ更新(DOM 書き換え最小化)
    if (phase !== c.phase || serveNumber !== c.serveNumber || currentServeType !== c.serveType) {
      const showServeLabel = phase === 'serve'
      this.hudServeLabel.classList.toggle('hidden', !showServeLabel)
      if (showServeLabel) {
        this.hudServeLabel.textContent = serveNumber === 1 ? '1st Serve' : '2nd Serve'
      }
      const labelMap: Record<ServeType, string> = {
        flat: 'FLAT',
        slice: 'SLICE',
        kick: 'KICK',
      }
      this.hudServeTypeLabel.textContent = labelMap[currentServeType]
      this.hudServeTypeLabel.classList.remove('serve-type-flat', 'serve-type-slice', 'serve-type-kick')
      this.hudServeTypeLabel.classList.add(`serve-type-${currentServeType}`)
      c.phase = phase
      c.serveNumber = serveNumber
      c.serveType = currentServeType
    }
    // サーブ種類ラベルの表示・位置は毎フレーム更新(頭上座標が動くため)。
    // プレイヤーがサーブする時のみ表示(view.serveLabelScreen が非 null)。
    const sls = view.serveLabelScreen
    if (phase === 'serve' && sls) {
      this.hudServeTypeLabel.classList.remove('hidden')
      this.hudServeTypeLabel.style.left = `${sls.x}px`
      this.hudServeTypeLabel.style.top = `${sls.y}px`
    } else {
      this.hudServeTypeLabel.classList.add('hidden')
    }

    // --- バナー ---
    if (banner !== c.banner) {
      if (banner) {
        this.hudBanner.classList.remove('hidden')
        this.hudBannerText.textContent = banner
        // アニメをリセットするため一旦クラスを外し再付与
        this.hudBannerText.classList.remove('animate')
        // 強制リフロー
        void this.hudBannerText.offsetWidth
        this.hudBannerText.classList.add('animate')
      } else {
        this.hudBanner.classList.add('hidden')
      }
      c.banner = banner
    }

    // --- チャージバー ---
    // serveMeter.active の間は表示しない(仕様: 同時に出ることはない)
    const charge = serveMeter.active ? null : view.charge
    const newChargeValue = charge !== null ? charge.value : null
    const newOvercharged = charge !== null ? charge.overcharged : false

    if (newChargeValue !== c.chargeValue || newOvercharged !== c.chargeOvercharged) {
      if (newChargeValue !== null) {
        this.hudChargeBar.classList.remove('hidden')
        // 0..CHARGE_MAX(1.25)の範囲で幅を計算。1.0 超はオーバーチャージ域として扱う
        // バーは 0..1 が通常域(80%)、1..1.25 がオーバーチャージ域(20%)に対応するよう
        // トータルを最大値(1.25)で割った割合を幅に使う
        const CHARGE_MAX_DISPLAY = 1.25
        const pct = Math.min(100, (newChargeValue / CHARGE_MAX_DISPLAY) * 100)
        this.hudChargeBarFill.style.width = `${pct}%`
        this.hudChargeBarFill.classList.toggle('overcharged', newOvercharged)
      } else {
        this.hudChargeBar.classList.add('hidden')
      }
      c.chargeValue = newChargeValue
      c.chargeOvercharged = newOvercharged
    }
  }

  /** マッチ終了画面を表示する */
  showMatchOver(result: MatchResult): void {
    this.menuScreen.classList.add('hidden')
    this.hudScreen.classList.add('hidden')
    this.matchOverScreen.classList.remove('hidden')

    // 前の内容を消して再構築
    this.matchOverScreen.innerHTML = ''

    const isWin = result.winner === 'player'

    // 勝敗テキスト
    const resultEl = el('div', `match-over-result ${isWin ? 'win' : 'lose'}`,
      isWin ? 'WIN!' : 'LOSE...')
    this.matchOverScreen.appendChild(resultEl)

    // ゲームカウント
    const gamesEl = el(
      'div',
      'match-over-games',
      `${result.games.player} — ${result.games.opponent}`,
    )
    this.matchOverScreen.appendChild(gamesEl)

    // スタッツ表
    const statsWrap = el('div', 'match-stats')
    const statsTable = el('table', 'stats-table')

    const thead = el('thead')
    const headRow = el('tr')
    ;(['', 'You', 'CPU'] as const).forEach(h => {
      const th = el('th', undefined, h)
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)
    statsTable.appendChild(thead)

    const tbody = el('tbody')
    const statsRows: Array<{ label: string; player: number; opponent: number }> = [
      { label: 'Winners', player: result.stats.winners.player, opponent: result.stats.winners.opponent },
      { label: 'Errors', player: result.stats.errors.player, opponent: result.stats.errors.opponent },
      { label: 'Double Faults', player: result.stats.doubleFaults.player, opponent: result.stats.doubleFaults.opponent },
    ]

    statsRows.forEach(({ label, player, opponent }) => {
      const tr = el('tr')
      const tdName = el('td', 'stat-name', label)
      // 勝っている側を強調
      const pBetter = label === 'Errors' || label === 'Double Faults'
        ? player <= opponent
        : player >= opponent
      const tdPlayer = el('td', pBetter ? 'highlight' : undefined, String(player))
      const tdOpponent = el('td', !pBetter ? 'highlight' : undefined, String(opponent))
      tr.appendChild(tdName)
      tr.appendChild(tdPlayer)
      tr.appendChild(tdOpponent)
      tbody.appendChild(tr)
    })

    statsTable.appendChild(tbody)
    statsWrap.appendChild(statsTable)
    this.matchOverScreen.appendChild(statsWrap)

    // ボタン群
    const btns = el('div', 'match-over-buttons')

    const rematchBtn = el('button', 'match-btn rematch', 'Rematch')
    rematchBtn.addEventListener('click', () => { this.handlers.onRematch() })

    const titleBtn = el('button', 'match-btn title', 'Title')
    titleBtn.addEventListener('click', () => { this.handlers.onQuit() })

    btns.appendChild(rematchBtn)
    btns.appendChild(titleBtn)
    this.matchOverScreen.appendChild(btns)
  }

  // -------------------------------------------------------------------------
  // デバッグオーバーレイ 公開 API
  // -------------------------------------------------------------------------

  /**
   * デバッグオーバーレイ(ライブログ窓 + メニュー)の表示/非表示を切り替える。
   * main.ts が `D` キー等でトグルする想定。showMenu/showHud では変化しない(独立)。
   */
  setDebugVisible(on: boolean): void {
    this.debugOverlay.classList.toggle('visible', on)
    // 表示したときに最新ログを反映する
    if (on) {
      this.renderDebugLog()
    }
  }

  /**
   * ライブログ窓に1行追記する。
   * 内部バッファは最大 200 行でキャップし、表示は直近 16 行のみ。
   * オーバーレイ非表示中でも内部バッファには蓄積する。
   */
  pushDebugLine(line: string): void {
    this.debugLines.push(line)
    // 最大 200 行でキャップ(古いものを破棄)
    if (this.debugLines.length > 200) {
      this.debugLines.splice(0, this.debugLines.length - 200)
    }
    // 表示中のときのみ DOM に反映する
    if (this.debugOverlay.classList.contains('visible')) {
      this.renderDebugLog()
    }
  }

  /**
   * 直近1ポイント分のログ JSON を保持する。
   * flagged=true(ダブルフォルト等の異常)のときヘッダを警告色にして "⚠" を付ける。
   * JSON 表示 <pre> の内容も即座に更新する。
   */
  setDebugDump(json: string, flagged: boolean): void {
    this.debugDumpJson = json
    // ヘッダの flagged 状態を更新
    this.debugHeader.classList.toggle('flagged', flagged)
    this.debugHeader.textContent = flagged
      ? '⚠ DEBUG — last point (FLAGGED)'
      : 'DEBUG — last point'
    // JSON <pre> が表示中なら内容も更新
    if (!this.debugJsonPre.classList.contains('hidden')) {
      this.debugJsonPre.textContent = json
    }
  }

  // -------------------------------------------------------------------------
  // メニュー画面構築
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // デバッグオーバーレイ 画面構築
  // -------------------------------------------------------------------------

  /**
   * デバッグオーバーレイ DOM を構築して返す。
   * root には append しない — constructor で行う。
   */
  private buildDebugOverlay(): {
    overlay: HTMLElement
    logEl: HTMLElement
    header: HTMLElement
    jsonPre: HTMLElement
    showJsonBtn: HTMLButtonElement
    copyBtn: HTMLButtonElement
  } {
    // オーバーレイ全体(左下固定。既定は非表示)
    const overlay = el('div', 'debug-overlay')

    // ライブログ窓
    const logEl = el('div', 'debug-log')
    overlay.appendChild(logEl)

    // ---- デバッグメニュー ----
    const menu = el('div', 'debug-menu')

    // ヘッダ行
    const header = el('div', 'debug-header', 'DEBUG — last point')
    menu.appendChild(header)

    // ボタン行
    const btnRow = el('div', 'debug-btn-row')

    // [Copy JSON] ボタン
    const copyBtn = el('button', 'debug-btn', 'Copy JSON')
    copyBtn.addEventListener('click', () => {
      // クリップボード API が利用可能な場合は書き込みを試みる
      navigator.clipboard.writeText(this.debugDumpJson).then(() => {
        // 成功フィードバック: 一時的にラベル変更
        copyBtn.textContent = 'Copied!'
        setTimeout(() => { copyBtn.textContent = 'Copy JSON' }, 1600)
      }).catch(() => {
        // 失敗時: JSON <pre> を開いて手動コピーを促す
        jsonPre.classList.remove('hidden')
        jsonPre.textContent = this.debugDumpJson
        showJsonBtn.textContent = 'Hide JSON'
      })
    })
    btnRow.appendChild(copyBtn)

    // [Show/Hide JSON] ボタン
    const showJsonBtn = el('button', 'debug-btn', 'Show JSON')
    showJsonBtn.addEventListener('click', () => {
      const hidden = jsonPre.classList.contains('hidden')
      if (hidden) {
        jsonPre.classList.remove('hidden')
        jsonPre.textContent = this.debugDumpJson
        showJsonBtn.textContent = 'Hide JSON'
      } else {
        jsonPre.classList.add('hidden')
        showJsonBtn.textContent = 'Show JSON'
      }
    })
    btnRow.appendChild(showJsonBtn)

    menu.appendChild(btnRow)

    // JSON 全文表示 <pre>(既定 hidden。pointer-events:auto で選択可能)
    const jsonPre = el('pre', 'debug-json hidden')
    menu.appendChild(jsonPre)

    overlay.appendChild(menu)

    return { overlay, logEl, header, jsonPre, showJsonBtn, copyBtn }
  }

  // -------------------------------------------------------------------------
  // デバッグオーバーレイ 内部ヘルパー
  // -------------------------------------------------------------------------

  /**
   * debugLines 配列の直近 16 行を debugLogEl に再描画する。
   * DOM の子を一括差し替えるので毎フレーム呼ぶことは想定していない
   * (pushDebugLine / setDebugVisible のタイミングのみ)。
   */
  private renderDebugLog(): void {
    // 直近 16 行だけ表示
    const visibleLines = this.debugLines.slice(-16)
    // 既存 DOM をクリアして再構築
    this.debugLogEl.innerHTML = ''
    for (const line of visibleLines) {
      const lineEl = el('div', 'debug-log-line', line)
      this.debugLogEl.appendChild(lineEl)
    }
    // 最下行にスクロール
    this.debugLogEl.scrollTop = this.debugLogEl.scrollHeight
  }

  // -------------------------------------------------------------------------
  // ポーズ画面構築
  // -------------------------------------------------------------------------

  /** ポーズ画面(Esc で表示)。再開 / ゲーム終了ボタンを持つ。 */
  private buildPauseScreen(): HTMLElement {
    const screen = el('div', 'screen-pause hidden')
    const box = el('div', 'pause-box')
    box.appendChild(el('div', 'pause-title', 'PAUSED'))
    box.appendChild(el('div', 'pause-hint', 'Esc で再開'))

    const btns = el('div', 'pause-buttons')
    const resumeBtn = el('button', 'pause-btn resume', '再開')
    resumeBtn.addEventListener('click', () => this.handlers.onResume())
    const quitBtn = el('button', 'pause-btn quit', 'ゲーム終了')
    quitBtn.addEventListener('click', () => this.handlers.onQuit())
    btns.appendChild(resumeBtn)
    btns.appendChild(quitBtn)
    box.appendChild(btns)

    screen.appendChild(box)
    return screen
  }

  // -------------------------------------------------------------------------
  // メニュー画面構築
  // -------------------------------------------------------------------------

  private buildMenuScreen(): {
    screen: HTMLElement
    getPlayerPersona: () => PersonaId
    getOpponentPersona: () => PersonaId
  } {
    const screen = el('div', 'screen-menu')

    // タイトル
    screen.appendChild(el('h1', 'menu-title', '3D TENNIS'))
    screen.appendChild(el('div', 'menu-subtitle', 'Browser Tennis'))

    const options = el('div', 'menu-options')

    // 難易度選択
    const diffGroup = el('div', 'option-group')
    diffGroup.appendChild(el('div', 'option-label', 'Difficulty'))
    const diffButtons = el('div', 'option-buttons')
    const difficulties: Difficulty[] = ['easy', 'normal', 'hard']
    const diffLabels: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' }

    const diffBtnMap = new Map<Difficulty, HTMLButtonElement>()
    difficulties.forEach(d => {
      const btn = el('button', `opt-btn${d === this.selectedDifficulty ? ' selected' : ''}`,
        diffLabels[d])
      btn.addEventListener('click', () => {
        this.selectedDifficulty = d
        diffBtnMap.forEach((b, key) => {
          b.classList.toggle('selected', key === d)
        })
      })
      diffBtnMap.set(d, btn)
      diffButtons.appendChild(btn)
    })
    diffGroup.appendChild(diffButtons)
    options.appendChild(diffGroup)

    // 先取ゲーム数選択
    const gamesGroup = el('div', 'option-group')
    gamesGroup.appendChild(el('div', 'option-label', 'Games to Win'))
    const gamesButtons = el('div', 'option-buttons')
    const gamesToWinOptions: Array<1 | 2 | 4> = [1, 2, 4]
    const gamesToWinLabels: Record<number, string> = { 1: '1 Game', 2: '2 Games', 4: '4 Games' }

    const gamesBtnMap = new Map<number, HTMLButtonElement>()
    gamesToWinOptions.forEach(g => {
      const btn = el('button', `opt-btn${g === this.selectedGamesToWin ? ' selected' : ''}`,
        gamesToWinLabels[g])
      btn.addEventListener('click', () => {
        this.selectedGamesToWin = g
        gamesBtnMap.forEach((b, key) => {
          b.classList.toggle('selected', key === g)
        })
      })
      gamesBtnMap.set(g, btn)
      gamesButtons.appendChild(btn)
    })
    gamesGroup.appendChild(gamesButtons)
    options.appendChild(gamesGroup)

    screen.appendChild(options)

    // --- ペルソナ選択セクション ---
    const personaSection = el('div', 'persona-section')
    personaSection.appendChild(el('div', 'persona-section-label', 'プレイヤータイプ'))

    const personaRow = el('div', 'persona-row')

    // 自分のピッカー(青系)
    const playerPickerResult = buildPersonaPicker(
      personaRow,
      'あなた',
      'federun',
      '#4488ff',
      'rgba(40,100,220,0.25)',
    )

    // 相手のピッカー(赤系)
    const opponentPickerResult = buildPersonaPicker(
      personaRow,
      '相手',
      'jokovin',
      '#ff5544',
      'rgba(220,60,40,0.25)',
    )

    personaSection.appendChild(personaRow)
    screen.appendChild(personaSection)

    // 操作説明はメニューには出さない(プレイ中の画面端パネルで常時表示)。

    // スタートボタン
    const startBtn = el('button', 'start-btn', 'START')
    startBtn.addEventListener('click', () => {
      const config: MatchConfig = {
        difficulty: this.selectedDifficulty,
        gamesToWin: this.selectedGamesToWin,
        playerPersona: playerPickerResult.getPersonaId(),
        opponentPersona: opponentPickerResult.getPersonaId(),
      }
      this.handlers.onStart(config)
    })
    screen.appendChild(startBtn)

    return {
      screen,
      getPlayerPersona: playerPickerResult.getPersonaId,
      getOpponentPersona: opponentPickerResult.getPersonaId,
    }
  }

  // -------------------------------------------------------------------------
  // HUD 画面構築
  // -------------------------------------------------------------------------

  private buildHudScreen(container: HTMLElement): {
    pointPlayer: HTMLElement
    pointOpponent: HTMLElement
    gamePlayer: HTMLElement
    gameOpponent: HTMLElement
    serverDotPlayer: HTMLElement
    serverDotOpponent: HTMLElement
    staminaPlayerBar: HTMLElement
    staminaOpponentBar: HTMLElement
    serveLabel: HTMLElement
    /** サーブ種類ラベル(FLAT/SLICE/KICK) */
    serveTypeLabel: HTMLElement
    serveMeter: HTMLElement
    serveMeterFill: HTMLElement
    banner: HTMLElement
    bannerText: HTMLElement
    chargeBar: HTMLElement
    chargeBarFill: HTMLElement
    miPlayer: HTMLElement
    miDiff: HTMLElement
    miOpponent: HTMLElement
  } {
    // --- スコアボード ---
    const scoreboard = el('div', 'hud-scoreboard')

    // ゲーム数行
    const gamesRow = el('div', 'score-games')

    const gamePlayerVal = el('span', 'score-game-val', '0')
    const serverDotPlayer = el('span', 'server-dot')
    const gameSep = el('span', 'score-game-sep', '—')
    const serverDotOpponent = el('span', 'server-dot hidden')
    const gameOpponentVal = el('span', 'score-game-val', '0')

    // プレイヤー側: [ゲーム数][●]
    const playerGameGroup = el('span')
    playerGameGroup.appendChild(gamePlayerVal)
    playerGameGroup.appendChild(serverDotPlayer)

    // 相手側: [●][ゲーム数]
    const opponentGameGroup = el('span')
    opponentGameGroup.appendChild(serverDotOpponent)
    opponentGameGroup.appendChild(gameOpponentVal)

    const playerLabel = el('span', 'score-game-label', 'You')
    const opponentLabel = el('span', 'score-game-label', 'CPU')

    gamesRow.appendChild(playerLabel)
    gamesRow.appendChild(playerGameGroup)
    gamesRow.appendChild(gameSep)
    gamesRow.appendChild(opponentGameGroup)
    gamesRow.appendChild(opponentLabel)
    scoreboard.appendChild(gamesRow)

    // ポイント行
    const pointsRow = el('div', 'score-points')
    const pointPlayerVal = el('span', 'score-point-val', '0')
    const pointSep = el('span', 'score-point-sep', '-')
    const pointOpponentVal = el('span', 'score-point-val', '0')
    pointsRow.appendChild(pointPlayerVal)
    pointsRow.appendChild(pointSep)
    pointsRow.appendChild(pointOpponentVal)
    scoreboard.appendChild(pointsRow)

    // マッチ情報行(ペルソナ名 + 難易度)。setMatchInfo で内容を設定する。
    const matchInfoRow = el('div', 'hud-matchinfo')
    const miPlayer = el('span', 'mi-persona mi-player', '')
    const miDiff = el('span', 'mi-diff', '')
    const miOpponent = el('span', 'mi-persona mi-opponent', '')
    matchInfoRow.appendChild(miPlayer)
    matchInfoRow.appendChild(miDiff)
    matchInfoRow.appendChild(miOpponent)
    scoreboard.appendChild(matchInfoRow)

    container.appendChild(scoreboard)

    // --- サーブ番号ラベル ---
    const serveLabel = el('div', 'hud-serve-label hidden', '1st Serve')
    container.appendChild(serveLabel)

    // --- サーブ種類ラベル(サーブ番号ラベルの下に表示) ---
    const serveTypeLabel = el('div', 'hud-serve-type-label hidden', 'SERVE: FLAT')
    container.appendChild(serveTypeLabel)

    // --- プレイヤー スタミナバー ---
    const staminaPlayer = el('div', 'hud-stamina player-side')
    staminaPlayer.appendChild(el('div', 'stamina-label', 'You'))
    const staminaPlayerOuter = el('div', 'stamina-bar-outer')
    const staminaPlayerBar = el('div', 'stamina-bar-inner')
    staminaPlayerBar.style.width = '100%'
    staminaPlayerOuter.appendChild(staminaPlayerBar)
    staminaPlayer.appendChild(staminaPlayerOuter)
    container.appendChild(staminaPlayer)

    // --- 相手 スタミナバー ---
    const staminaOpponent = el('div', 'hud-stamina opponent-side')
    staminaOpponent.appendChild(el('div', 'stamina-label', 'CPU'))
    const staminaOpponentOuter = el('div', 'stamina-bar-outer')
    const staminaOpponentBar = el('div', 'stamina-bar-inner')
    staminaOpponentBar.style.width = '100%'
    staminaOpponentOuter.appendChild(staminaOpponentBar)
    staminaOpponent.appendChild(staminaOpponentOuter)
    container.appendChild(staminaOpponent)

    // --- サーブメーター ---
    const serveMeter = el('div', 'hud-serve-meter hidden')
    serveMeter.appendChild(el('div', 'serve-meter-label', 'Power'))
    const meterTrack = el('div', 'serve-meter-track')
    // スイートゾーン帯
    meterTrack.appendChild(el('div', 'serve-sweet-zone'))
    const serveMeterFill = el('div', 'serve-meter-fill')
    serveMeterFill.style.height = '0%'
    meterTrack.appendChild(serveMeterFill)
    serveMeter.appendChild(meterTrack)
    container.appendChild(serveMeter)

    // --- バナー ---
    const banner = el('div', 'hud-banner hidden')
    const bannerText = el('div', 'banner-text')
    banner.appendChild(bannerText)
    container.appendChild(banner)

    // --- チャージバー(画面下部中央。サーブメーターと同時には出ない) ---
    const chargeBar = el('div', 'hud-charge-bar hidden')
    chargeBar.appendChild(el('div', 'charge-bar-label', 'Charge'))
    const chargeBarOuter = el('div', 'charge-bar-outer')
    // オーバーチャージ境界マーカー(80% 位置に線)
    chargeBarOuter.appendChild(el('div', 'charge-bar-limit'))
    const chargeBarFill = el('div', 'charge-bar-fill')
    chargeBarFill.style.width = '0%'
    chargeBarOuter.appendChild(chargeBarFill)
    chargeBar.appendChild(chargeBarOuter)
    container.appendChild(chargeBar)

    // --- 操作説明パネル(右端常時表示) ---
    const keysPanel = el('div', 'hud-keys-panel')
    keysPanel.appendChild(el('div', 'keys-panel-title', 'Controls'))
    const keyRows: Array<[string, string]> = [
      ['WASD', '移動'],
      ['Shift', 'スプリント'],
      ['J', 'フラット'],
      ['K', 'トップスピン'],
      ['L', 'スライス'],
      ['U', 'ロブ'],
      ['I', 'ドロップ'],
      ['長押し', 'チャージ'],
      ['移動+ショット', 'コース指定'],
      ['Space', 'サーブ'],
      ['J/K/L(サーブ)', 'フラット/キック/スライス'],
      ['Esc', 'ポーズ'],
      ['0', 'デバッグ表示'],
    ]
    const keysTable = el('table', 'keys-table')
    keyRows.forEach(([key, desc]) => {
      const tr = el('tr')
      tr.appendChild(el('td', 'keys-key', key))
      tr.appendChild(el('td', 'keys-desc', desc))
      keysTable.appendChild(tr)
    })
    keysPanel.appendChild(keysTable)
    container.appendChild(keysPanel)

    return {
      pointPlayer: pointPlayerVal,
      pointOpponent: pointOpponentVal,
      gamePlayer: gamePlayerVal,
      gameOpponent: gameOpponentVal,
      serverDotPlayer,
      serverDotOpponent,
      staminaPlayerBar,
      staminaOpponentBar,
      serveLabel,
      serveTypeLabel,
      serveMeter,
      serveMeterFill,
      banner,
      bannerText,
      chargeBar,
      chargeBarFill,
      miPlayer,
      miDiff,
      miOpponent,
    }
  }

  // -------------------------------------------------------------------------
  // 円形スタミナゲージ構築・更新
  // -------------------------------------------------------------------------

  /**
   * 円形スタミナゲージ DOM を構築して返す。
   * side='player' は大きめ(青枠)、side='opponent' は小さめ(赤枠)。
   * SVG の stroke-dasharray/dashoffset でリング弧の残量を表現する。
   */
  private buildStaminaRing(side: 'player' | 'opponent'): {
    container: HTMLElement
    arc: SVGCircleElement
    label: HTMLElement
  } {
    // プレイヤー: 半径 22px、相手: 17px
    const radius = side === 'player' ? 22 : 17
    const size = (radius + 5) * 2  // コンテナサイズ(px)
    const cx = radius + 5
    const cy = radius + 5
    // 円周 = 2πr
    const circumference = 2 * Math.PI * radius

    // 外側コンテナ(position:absolute で頭上に追従)
    const container = el('div', `stamina-ring stamina-ring-${side} hidden`)
    container.style.width = `${size}px`
    container.style.height = `${size}px`

    // SVG 本体
    const svgNS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(svgNS, 'svg')
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
    svg.style.position = 'absolute'
    svg.style.inset = '0'

    // --- 背景リング(薄い縁取り: チームカラー) ---
    const trackCircle = document.createElementNS(svgNS, 'circle')
    trackCircle.setAttribute('cx', String(cx))
    trackCircle.setAttribute('cy', String(cy))
    trackCircle.setAttribute('r', String(radius))
    trackCircle.setAttribute('fill', 'none')
    trackCircle.setAttribute('stroke', side === 'player' ? 'rgba(68,136,255,0.4)' : 'rgba(255,80,80,0.4)')
    trackCircle.setAttribute('stroke-width', side === 'player' ? '4' : '3')
    svg.appendChild(trackCircle)

    // --- 残量アーク(12時から時計回り。初期は満タン) ---
    const arcCircle = document.createElementNS(svgNS, 'circle') as SVGCircleElement
    arcCircle.setAttribute('cx', String(cx))
    arcCircle.setAttribute('cy', String(cy))
    arcCircle.setAttribute('r', String(radius))
    arcCircle.setAttribute('fill', 'none')
    arcCircle.setAttribute('stroke', '#6ab040')  // 初期色: 緑
    arcCircle.setAttribute('stroke-width', side === 'player' ? '5' : '4')
    arcCircle.setAttribute('stroke-linecap', 'round')
    // 12時(上)から開始するために -90度回転
    arcCircle.setAttribute('transform', `rotate(-90 ${cx} ${cy})`)
    // 満タン状態(dashoffset=0 で全周が塗られる)
    arcCircle.setAttribute('stroke-dasharray', String(circumference))
    arcCircle.setAttribute('stroke-dashoffset', '0')
    svg.appendChild(arcCircle)

    container.appendChild(svg)

    // --- 中央のパーセント表示ラベル ---
    const label = el('div', 'stamina-ring-label', '100')
    label.style.position = 'absolute'
    label.style.inset = '0'
    label.style.display = 'flex'
    label.style.alignItems = 'center'
    label.style.justifyContent = 'center'
    label.style.fontSize = side === 'player' ? '11px' : '9px'
    label.style.fontWeight = '700'
    label.style.color = '#fff'
    label.style.textShadow = '0 1px 3px rgba(0,0,0,0.8)'
    label.style.pointerEvents = 'none'
    container.appendChild(label)

    return { container, arc: arcCircle, label }
  }

  /**
   * 円形ゲージの弧と色を pct(0..1) に応じて更新する。
   * STAMINA_GAUGE_GREEN/YELLOW 境界で緑→黄→赤に色変化させる。
   * circumference は arc の stroke-dasharray から読み取る。
   */
  private updateStaminaRingArc(
    arc: SVGCircleElement,
    label: HTMLElement,
    pct: number,
  ): void {
    const clampedPct = Math.max(0, Math.min(1, pct))
    // dasharray 属性から周長を取得
    const circumference = parseFloat(arc.getAttribute('stroke-dasharray') ?? '138')
    // dashoffset = 周長 × (1 - pct) で残量の弧を描く
    const offset = circumference * (1 - clampedPct)
    arc.setAttribute('stroke-dashoffset', String(offset))

    // 色判定: pct >= GREEN=緑、>= YELLOW=黄、< YELLOW=赤
    let color: string
    if (clampedPct >= STAMINA_GAUGE_GREEN) {
      color = '#6ab040'  // 緑(余裕)
    } else if (clampedPct >= STAMINA_GAUGE_YELLOW) {
      color = '#d4b040'  // 黄(注意)
    } else {
      color = '#d04040'  // 赤(危険)
    }
    arc.setAttribute('stroke', color)

    // ラベル: パーセント整数表示
    const pctInt = Math.round(clampedPct * 100)
    label.textContent = String(pctInt)
    label.style.color = color
  }

  // -------------------------------------------------------------------------
  // 内部ヘルパー
  // -------------------------------------------------------------------------

  /** キャッシュを無効化して次の updateHud で全要素を再描画させる */
  private invalidateCache(): void {
    this.cache = {
      pointPlayer: '',
      pointOpponent: '',
      gamePlayer: -1,
      gameOpponent: -1,
      server: '',
      playerStamina: -1,
      opponentStamina: -1,
      serveMeterActive: false,
      serveMeterValue: -1,
      serveNumber: 0 as 1 | 2,
      phase: '',
      banner: undefined as unknown as null,
      chargeValue: undefined as unknown as null,
      chargeOvercharged: false,
      // 空文字列で無効化し、次フレームで必ず再描画させる
      serveType: '' as ServeType,
      // 円形ゲージ: -1 で無効化
      playerStaminaPct: -1,
      opponentStaminaPct: -1,
    }
  }
}
