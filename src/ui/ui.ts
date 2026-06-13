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
} from '../types'
import {
  SERVE_SWEET_MIN,
  SERVE_SWEET_MAX,
  STAMINA_LOW_THRESHOLD,
  STAMINA_MAX,
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
  private readonly hudServeMeter: HTMLElement
  private readonly hudServeMeterFill: HTMLElement
  private readonly hudBanner: HTMLElement
  private readonly hudBannerText: HTMLElement
  /** チャージバーのコンテナ要素 */
  private readonly hudChargeBar: HTMLElement
  /** チャージバーの塗り(幅 % で変化) */
  private readonly hudChargeBarFill: HTMLElement

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
  }

  constructor(root: HTMLElement, handlers: UIHandlers) {
    this.root = root
    this.handlers = handlers

    // 3 画面を生成
    this.menuScreen = this.buildMenuScreen()
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
    this.hudServeMeter = hudRefs.serveMeter
    this.hudServeMeterFill = hudRefs.serveMeterFill
    this.hudBanner = hudRefs.banner
    this.hudBannerText = hudRefs.bannerText
    this.hudChargeBar = hudRefs.chargeBar
    this.hudChargeBarFill = hudRefs.chargeBarFill

    root.appendChild(this.menuScreen)
    root.appendChild(this.hudScreen)
    root.appendChild(this.matchOverScreen)
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
    // キャッシュを無効化して次フレームに全更新させる
    this.invalidateCache()
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

    // --- スタミナ(プレイヤー) ---
    if (playerStamina !== c.playerStamina) {
      const pct = Math.max(0, Math.min(100, (playerStamina / STAMINA_MAX) * 100))
      this.hudStaminaPlayerBar.style.width = `${pct}%`
      this.hudStaminaPlayerBar.classList.toggle('low', playerStamina < STAMINA_LOW_THRESHOLD)
      c.playerStamina = playerStamina
    }

    // --- スタミナ(相手) ---
    if (opponentStamina !== c.opponentStamina) {
      const pct = Math.max(0, Math.min(100, (opponentStamina / STAMINA_MAX) * 100))
      this.hudStaminaOpponentBar.style.width = `${pct}%`
      this.hudStaminaOpponentBar.classList.toggle('low', opponentStamina < STAMINA_LOW_THRESHOLD)
      c.opponentStamina = opponentStamina
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

    // --- サーブ番号ラベル(serve フェーズ時のみ) ---
    if (phase !== c.phase || serveNumber !== c.serveNumber) {
      const showServeLabel = phase === 'serve'
      this.hudServeLabel.classList.toggle('hidden', !showServeLabel)
      if (showServeLabel) {
        this.hudServeLabel.textContent = serveNumber === 1 ? '1st Serve' : '2nd Serve'
      }
      c.phase = phase
      c.serveNumber = serveNumber
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
  // メニュー画面構築
  // -------------------------------------------------------------------------

  private buildMenuScreen(): HTMLElement {
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

    // 操作説明表
    const ctrlWrap = el('div', 'menu-controls')
    ctrlWrap.appendChild(el('div', 'controls-label', 'Controls'))
    const table = el('table', 'controls-table')
    const controlRows: Array<[string, string]> = [
      ['W / A / S / D  or  ↑←↓→', 'Move'],
      ['Shift', 'Sprint'],
      ['J', 'Flat shot'],
      ['K', 'Topspin'],
      ['L', 'Slice'],
      ['U', 'Lob'],
      ['I', 'Drop shot'],
      ['Hold shot key', 'Charge (stronger, but risky if overcharged)'],
      ['Move + Shot key', 'Aim direction'],
      ['Space (serve)', 'Power meter — release to serve'],
      ['Esc', 'Pause / Title'],
    ]
    controlRows.forEach(([key, desc]) => {
      const tr = el('tr')
      tr.appendChild(el('td', undefined, key))
      tr.appendChild(el('td', undefined, desc))
      table.appendChild(tr)
    })
    ctrlWrap.appendChild(table)
    screen.appendChild(ctrlWrap)

    // スタートボタン
    const startBtn = el('button', 'start-btn', 'START')
    startBtn.addEventListener('click', () => {
      const config: MatchConfig = {
        difficulty: this.selectedDifficulty,
        gamesToWin: this.selectedGamesToWin,
      }
      this.handlers.onStart(config)
    })
    screen.appendChild(startBtn)

    return screen
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
    serveMeter: HTMLElement
    serveMeterFill: HTMLElement
    banner: HTMLElement
    bannerText: HTMLElement
    chargeBar: HTMLElement
    chargeBarFill: HTMLElement
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

    container.appendChild(scoreboard)

    // --- サーブ番号ラベル ---
    const serveLabel = el('div', 'hud-serve-label hidden', '1st Serve')
    container.appendChild(serveLabel)

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
      ['Esc', 'タイトル'],
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
      serveMeter,
      serveMeterFill,
      banner,
      bannerText,
      chargeBar,
      chargeBarFill,
    }
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
    }
  }
}
