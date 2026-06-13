// =============================================================================
// エントリポイント — 全モジュールの結線とゲームループ(docs/ARCHITECTURE.md §7, §15)
// このファイルだけが全モジュールを import してよい。
// =============================================================================
import { Vector3 } from 'three'
import {
  type BallEvent,
  type ControlContext,
  type Controller,
  type GamePhase,
  type HudView,
  type InputSource,
  type InputState,
  type MatchConfig,
  type MatchStats,
  type PersonaModifiers,
  type RallyVerdict,
  type ServeType,
  type ServiceBox,
  type ShotRequest,
  type Side,
  otherSide,
  sideSign,
} from './types'
import {
  AI_PROFILES,
  BANNER_SEC,
  BASE_HEIGHT_M,
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  PHYS_DT,
  PLAYER_PERSONAS,
  personaModifiers,
  SERVE_HIT_HEIGHT,
  SERVICE_LINE_Z,
  STAMINA_MAX,
} from './constants'
import { BallSim } from './physics/ball'
import { solveShot, solveServe } from './gameplay/shot'
import { InputManager } from './gameplay/input'
import { PlayerController } from './gameplay/player'
import { AIController } from './gameplay/ai'
import { MatchScore } from './core/scoring'
import { RallyJudge } from './core/rally'
import { GameRenderer } from './render/renderer'
import { UI } from './ui/ui'
import { Sfx } from './audio/sfx'

// ---------------------------------------------------------------------------
// 生成(マッチをまたいで使い回すもの)
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game-canvas') as HTMLCanvasElement
const uiRoot = document.getElementById('ui-root') as HTMLElement

// ?debug でゲームプレイ診断ログを有効化(バランス調整・自動検証用)
const DEBUG = new URLSearchParams(location.search).has('debug')
const dbg = (...args: unknown[]) => {
  if (DEBUG) console.log('[dbg]', ...args)
}
const fmt = (v: Vector3) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`

const renderer = new GameRenderer(canvas)
const sfx = new Sfx()
const input = new InputManager()
const ballSim = new BallSim()
const judge = new RallyJudge()

// poll() はエッジ(shotPressed / serveReleased / escPressed)を消費するため、
// 1物理フレームにつき main が1回だけ呼び、同じスナップショットを
// PlayerController と共有する(二重ポーリングするとエッジが失われる)。
let currentInput: InputState = input.poll()
const sharedInput: InputSource = { poll: () => currentInput }

// 初回ユーザー操作で AudioContext を有効化
const resumeAudio = () => sfx.resume()
window.addEventListener('pointerdown', resumeAudio, { once: true })
window.addEventListener('keydown', resumeAudio, { once: true })
window.addEventListener('resize', () => renderer.resize())

// 「0」キーでデバッグオーバーレイ表示をトグル(docs/ARCHITECTURE.md §17)。
// 旧バッククォート( ` )は配列によって反応しないため数字キーに変更(Backquote も一応許可)。
window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Digit0' || ev.code === 'Numpad0' || ev.code === 'Backquote') {
    debugMode = !debugMode
    ui.setDebugVisible(debugMode)
  }
})

// ---------------------------------------------------------------------------
// マッチ状態(onStart で初期化)
// ---------------------------------------------------------------------------
let phase: GamePhase = 'menu'
let config: MatchConfig = {
  difficulty: 'normal',
  gamesToWin: 2,
  playerPersona: 'federun',
  opponentPersona: 'jokovin',
}
// 各サイドのペルソナ倍率(startMatch で確定)。サーブ倍率・打点高に使う。
let playerMods: PersonaModifiers = personaModifiers(PLAYER_PERSONAS.federun.ratings)
let opponentMods: PersonaModifiers = personaModifiers(PLAYER_PERSONAS.jokovin.ratings)
let score: MatchScore
let playerCtrl: Controller
let aiCtrl: Controller
let stats: MatchStats
let serveNumber: 1 | 2 = 1
let pointsInGame = 0 // サーブサイド(デュース/アド)決定用
let banner: string | null = null
let bannerTimer = 0
let pointOverTimer = 0
let pendingVerdict: RallyVerdict | null = null

function newStats(): MatchStats {
  return {
    winners: { player: 0, opponent: 0 },
    errors: { player: 0, opponent: 0 },
    doubleFaults: { player: 0, opponent: 0 },
  }
}

// ---------------------------------------------------------------------------
// デバッグログ(敵AIの判断ログ。docs/ARCHITECTURE.md §17)
// バッククォート( ` )でオーバーレイ表示をトグル。直近1ポイントのログを保持し、
// ポイント終了時に JSON 化して UI へ渡す(コピー用)。ON 中はライブ表示も流す。
// ---------------------------------------------------------------------------
interface DebugEntry {
  t: number // ポイント開始からの経過秒
  side: string // 'AI' | 'P' | 'sys'
  kind: string
  msg: string
  data?: Record<string, unknown>
}
let debugMode = new URLSearchParams(location.search).has('debug') // ?debug で初期 ON
let paused = false // プレイ中の一時停止(Esc でトグル)
let pointClock = 0
let pointLog: DebugEntry[] = []
let pointFlagged = false // このポイントで異常(フォルト等)が起きたか
let pointStartScore = '' // ポイント開始時のスコア表示

function pushLog(side: string, kind: string, msg: string, data?: Record<string, unknown>): void {
  pointLog.push({ t: Math.round(pointClock * 100) / 100, side, kind, msg, data })
  if (pointLog.length > 400) pointLog.shift()
  if (debugMode) ui.pushDebugLine(`${pointClock.toFixed(1)}s ${side} ${msg}`)
}

function resetPointLog(): void {
  pointClock = 0
  pointLog = []
  pointFlagged = false
  pointStartScore = score ? `${score.view.points.player}-${score.view.points.opponent}` : ''
}

/** ポイント終了時に直近ポイントのログを JSON 化して UI へ渡す */
function finalizePointLog(verdict: RallyVerdict): void {
  const dump = {
    server: score.view.server,
    difficulty: config.difficulty,
    playerPersona: config.playerPersona,
    opponentPersona: config.opponentPersona,
    scoreAtStart: pointStartScore,
    verdict: { winner: verdict.winner, reason: verdict.reason },
    events: pointLog,
  }
  ui.setDebugDump(JSON.stringify(dump, null, 2), pointFlagged)
}

// ---------------------------------------------------------------------------
// サーブ位置・サービスボックス
// ---------------------------------------------------------------------------

/** ポイント合計が偶数 → デュースサイド(サーバーから見て右) */
function serveFromRight(): boolean {
  return pointsInGame % 2 === 0
}

/** サーバーとサイドから対角のサービスボックスを求める */
function currentServiceBox(server: Side): ServiceBox {
  const receiver = otherSide(server)
  const zs = sideSign(receiver)
  // serveFromRight は「世界座標で +x 側」として両コントローラと統一
  // (player.ts / ai.ts のサーブ・レシーブ定位置と同じ規約)。
  // 対角に入れるため、ボックスの世界 x 範囲はサーバー立ち位置の反対側になる。
  const stanceX = serveFromRight() ? 1 : -1
  const boxOnPositiveX = stanceX < 0
  return {
    zSign: zs,
    xMin: boxOnPositiveX ? 0 : -COURT_HALF_WIDTH,
    xMax: boxOnPositiveX ? COURT_HALF_WIDTH : 0,
  }
}

// ---------------------------------------------------------------------------
// コントローラへ注入するコンテキスト
// ---------------------------------------------------------------------------
function makeContext(self: Side): ControlContext {
  return {
    get phase() {
      return phase
    },
    get ball() {
      return ballSim.state
    },
    get self() {
      return (self === 'player' ? playerCtrl : aiCtrl).view
    },
    get rival() {
      return (self === 'player' ? aiCtrl : playerCtrl).view
    },
    get isServing() {
      return phase === 'serve' && score.view.server === self
    },
    get serveNumber() {
      return serveNumber
    },
    predictLanding: () => ballSim.predictLanding(),
    requestShot: (req: ShotRequest) => handleShot(req),
    requestServe: (power, aimX, serveType) => handleServe(self, power, aimX, serveType),
    logDebug: (e) => pushLog(self === 'opponent' ? 'AI' : 'P', e.kind, e.msg, e.data),
  }
}

const ctxPlayer = makeContext('player')
const ctxOpponent = makeContext('opponent')

// ---------------------------------------------------------------------------
// 打球・サーブ
// ---------------------------------------------------------------------------
function handleShot(req: ShotRequest): void {
  if (phase !== 'rally' || !ballSim.state.inPlay) return
  const sol = solveShot(req)
  dbg(`shot ${req.hitter} ${req.type} q=${req.quality.toFixed(2)} hit=${fmt(req.hitPos)} target=${fmt(req.target)}`)
  ballSim.launch(req.hitPos.clone(), sol.vel, sol.spin, req.hitter)
  renderer.sceneApi.spawnHitFx(req.hitPos.clone())
  const sfxName =
    req.type === 'flat' ? 'hit_flat' : req.type === 'slice' || req.type === 'drop' ? 'hit_slice' : 'hit_spin'
  sfx.play(sfxName, { intensity: req.quality })
  judge.onEvent({ kind: 'hit', by: req.hitter, shot: req.type }, ballSim.state)
}

function handleServe(
  server: Side,
  power: number,
  aimX: -1 | 0 | 1,
  serveType: ServeType,
): void {
  if (phase !== 'serve' || score.view.server !== server) return
  const box = currentServiceBox(server)
  const ctrl = server === 'player' ? playerCtrl : aiCtrl
  const serverPersona = PLAYER_PERSONAS[server === 'player' ? config.playerPersona : config.opponentPersona]
  const mods = server === 'player' ? playerMods : opponentMods
  const hitPos = ctrl.view.pos.clone()
  // 打点高はサーブ基準 × 身長比(高身長ほど高い打点。控えめ)
  hitPos.y = SERVE_HIT_HEIGHT * (serverPersona.physique.heightM / BASE_HEIGHT_M)
  // ボックス内の狙い: aimX でワイド/センターを選ぶ(中央はボックス中心)
  const margin = 0.5
  const xCenter = (box.xMin + box.xMax) / 2
  const xAim =
    aimX === 0 ? xCenter : aimX > 0 ? box.xMax - margin : box.xMin + margin
  const target = new Vector3(xAim, 0, box.zSign * (SERVICE_LINE_Z - 1.0))
  const sol = solveServe(hitPos, target, power, server, serveType, mods)
  ballSim.launch(hitPos, sol.vel, sol.spin, server)
  judge.reset(server, box)
  judge.onEvent({ kind: 'hit', by: server, shot: 'flat' }, ballSim.state)
  // サーブ結果を記録(初速・予測着地・ボックス内か)。サーブ暴投の診断に使う。
  const pred = ballSim.predictLanding()
  const speed = Math.hypot(sol.vel.x, sol.vel.y, sol.vel.z)
  const landIn =
    pred != null &&
    Math.sign(pred.pos.z) === box.zSign &&
    pred.pos.x >= box.xMin - 0.3 &&
    pred.pos.x <= box.xMax + 0.3 &&
    Math.abs(pred.pos.z) <= SERVICE_LINE_Z + 0.4
  pushLog('sys', 'serve', `serve→ v=${speed.toFixed(1)} land=${pred ? `(${pred.pos.x.toFixed(1)},${pred.pos.z.toFixed(1)})` : 'NET'} ${landIn ? 'IN' : 'OUT?'}`, {
    server,
    serveType,
    power: Math.round(power * 100) / 100,
    aimX,
    speed: Math.round(speed * 10) / 10,
    targetX: Math.round(target.x * 100) / 100,
    landX: pred ? Math.round(pred.pos.x * 100) / 100 : null,
    landZ: pred ? Math.round(pred.pos.z * 100) / 100 : null,
    boxXMin: box.xMin,
    boxXMax: box.xMax,
    predictedIn: landIn,
  })
  dbg(`serve ${server} ${serveType} power=${power.toFixed(2)} aimX=${aimX}`)
  sfx.play('serve', { intensity: power })
  renderer.sceneApi.spawnHitFx(hitPos.clone())
  phase = 'rally'
}

// ---------------------------------------------------------------------------
// ポイント決着処理
// ---------------------------------------------------------------------------
function bannerForVerdict(v: RallyVerdict): string {
  switch (v.reason) {
    case 'winner':
    case 'doubleBounce':
      return 'Winner!'
    case 'out':
      return 'Out!'
    case 'net':
      return 'Net!'
    case 'fault':
      return serveNumber === 1 ? 'Fault' : 'Double Fault'
    case 'doubleFault':
      return 'Double Fault'
  }
}

function applyVerdict(v: RallyVerdict): void {
  dbg(`verdict winner=${v.winner} reason=${v.reason} ball=${fmt(ballSim.state.pos)}`)
  pushLog('sys', 'verdict', `verdict ${v.reason} → ${v.winner}`, { reason: v.reason, winner: v.winner })
  // フォルト/ダブルフォルトはこのポイントを「異常」としてフラグ(デバッグで拾いやすく)
  if (v.reason === 'fault' || v.reason === 'doubleFault') pointFlagged = true
  // 1stサーブのフォルトは失点にせず 2nd へ(ポイント継続なのでログは確定しない)
  if (v.reason === 'fault' && serveNumber === 1) {
    serveNumber = 2
    setBanner('Fault')
    sfx.play('net')
    enterPointOver(null)
    return
  }
  const verdict: RallyVerdict =
    v.reason === 'fault' ? { winner: v.winner, reason: 'doubleFault' } : v

  // スタッツ
  const loser = otherSide(verdict.winner)
  if (verdict.reason === 'winner' || verdict.reason === 'doubleBounce') {
    stats.winners[verdict.winner]++
  } else if (verdict.reason === 'out' || verdict.reason === 'net') {
    stats.errors[loser]++
  } else if (verdict.reason === 'doubleFault') {
    stats.doubleFaults[loser]++
  }

  score.addPoint(verdict.winner)
  pointsInGame++
  serveNumber = 1

  const sv = score.view
  if (sv.matchWinner) {
    setBanner(sv.matchWinner === 'player' ? 'Match!' : 'Match…')
    sfx.play('applause')
  } else if (sv.gameJustWon) {
    setBanner('Game!')
    pointsInGame = 0
    sfx.play('applause')
    // ゲーム間はスタミナ全回復(仕様 GAME_DESIGN §6)
    playerCtrl.recoverFullStamina()
    aiCtrl.recoverFullStamina()
  } else {
    setBanner(`${bannerForVerdict(verdict)}  ${sv.points.player} - ${sv.points.opponent}`)
    sfx.play('point')
  }
  // ポイント確定 → 直近1ポイントのログを JSON 化して UI(デバッグメニュー)へ
  finalizePointLog(verdict)
  enterPointOver(verdict)
}

function setBanner(text: string): void {
  banner = text
  bannerTimer = BANNER_SEC
}

function enterPointOver(v: RallyVerdict | null): void {
  pendingVerdict = v
  phase = 'pointOver'
  pointOverTimer = BANNER_SEC
  ballSim.state.inPlay = false
}

function startNextPoint(): void {
  const sv = score.view
  if (sv.matchWinner) {
    phase = 'matchOver'
    ui.showMatchOver({ winner: sv.matchWinner, games: sv.games, stats })
    return
  }
  const server = sv.server
  const right = serveFromRight()
  resetPointLog() // 新しいポイントの判断ログを開始(スコアはまだ更新前)
  playerCtrl.resetForPoint(server, right)
  aiCtrl.resetForPoint(server, right)
  ballSim.state.inPlay = false
  ballSim.state.bounceCount = 0
  ballSim.state.lastHitBy = null
  phase = 'serve'
}

// ---------------------------------------------------------------------------
// マッチ開始 / 終了
// ---------------------------------------------------------------------------
function startMatch(cfg: MatchConfig): void {
  config = cfg
  score = new MatchScore(cfg.gamesToWin)
  stats = newStats()
  // ペルソナ倍率・身体を算出して各モジュールへ注入(docs/ARCHITECTURE.md §6.5)
  const playerPersona = PLAYER_PERSONAS[cfg.playerPersona]
  const opponentPersona = PLAYER_PERSONAS[cfg.opponentPersona]
  playerMods = personaModifiers(playerPersona.ratings)
  opponentMods = personaModifiers(opponentPersona.ratings)
  playerCtrl = new PlayerController(sharedInput, playerMods, playerPersona.physique)
  aiCtrl = new AIController(AI_PROFILES[cfg.difficulty], opponentMods, opponentPersona.physique)
  // 3Dモデルをペルソナの体格・外見・チームカラーで再構成
  renderer.setMatchup(
    { physique: playerPersona.physique, appearance: playerPersona.appearance },
    { physique: opponentPersona.physique, appearance: opponentPersona.appearance },
  )
  serveNumber = 1
  pointsInGame = 0
  banner = null
  paused = false
  ui.setPaused(false)
  // スコアボードにマッチ情報(ペルソナ名・難易度)を表示
  ui.setMatchInfo({
    difficulty: cfg.difficulty,
    playerName: playerPersona.name,
    opponentName: opponentPersona.name,
  })
  ui.showHud()
  startNextPoint()
}

function quitToMenu(): void {
  phase = 'menu'
  paused = false
  ballSim.state.inPlay = false
  ui.setPaused(false)
  ui.showMenu()
}

const ui = new UI(uiRoot, {
  onStart: (cfg) => {
    sfx.play('ui')
    startMatch(cfg)
  },
  onRematch: () => {
    sfx.play('ui')
    startMatch(config)
  },
  onQuit: () => {
    sfx.play('ui')
    quitToMenu()
  },
  onResume: () => {
    sfx.play('ui')
    paused = false
    ui.setPaused(false)
  },
})

// ---------------------------------------------------------------------------
// 物理フレーム(固定 PHYS_DT)
// ---------------------------------------------------------------------------
function physicsStep(): void {
  currentInput = input.poll()
  // プレイ中の Esc はポーズ/再開のトグルのみ(うっかり終了を防ぐ)。
  // ポーズ中にマウスで「ゲーム終了」を押すとメニューへ戻る(onQuit)。
  const inPlay = phase === 'serve' || phase === 'rally' || phase === 'pointOver'
  if (currentInput.escPressed && inPlay) {
    paused = !paused
    ui.setPaused(paused)
  }
  if (phase === 'menu' || phase === 'matchOver') return
  if (paused) return // ポーズ中は物理を進めない(描画は現フレームを維持)

  // ポイント中(serve / rally)の経過時間(デバッグログのタイムスタンプ用)
  if (phase === 'serve' || phase === 'rally') pointClock += PHYS_DT

  playerCtrl.update(PHYS_DT, ctxPlayer)
  aiCtrl.update(PHYS_DT, ctxOpponent)

  if (phase === 'serve') {
    // サーブ待機中はボールをサーバーの手元に保持(描画用)
    const server = score.view.server
    const ctrl = server === 'player' ? playerCtrl : aiCtrl
    ballSim.state.pos.copy(ctrl.view.pos)
    ballSim.state.pos.y = 1.0
    ballSim.state.vel.set(0, 0, 0)
  }

  if (phase === 'rally') {
    const events: BallEvent[] = ballSim.step(PHYS_DT)
    let verdict: RallyVerdict | null = null
    for (const e of events) {
      if (e.kind === 'bounce') {
        renderer.sceneApi.spawnBounceFx(e.pos.clone())
        sfx.play('bounce')
        dbg(`bounce ${fmt(e.pos)} count=${ballSim.state.bounceCount} lastHitBy=${ballSim.state.lastHitBy}`)
      } else if (e.kind === 'net') {
        sfx.play('net')
        dbg('net hit')
      }
      verdict ??= judge.onEvent(e, ballSim.state)
    }
    verdict ??= judge.update(ballSim.state)
    if (verdict) applyVerdict(verdict)
  } else if (phase === 'pointOver') {
    // 余韻: ボールは転がしておく
    ballSim.step(PHYS_DT)
    pointOverTimer -= PHYS_DT
    if (pointOverTimer <= 0) startNextPoint()
  }

  if (bannerTimer > 0) {
    bannerTimer -= PHYS_DT
    if (bannerTimer <= 0) banner = null
  }
}

// ---------------------------------------------------------------------------
// メインループ(rAF + アキュムレータ)
// ---------------------------------------------------------------------------
let prevTime = performance.now()
let acc = 0

function frame(now: number): void {
  const dt = Math.min((now - prevTime) / 1000, 0.1)
  prevTime = now
  acc += dt
  while (acc >= PHYS_DT) {
    physicsStep()
    acc -= PHYS_DT
  }

  renderer.render(dt, {
    phase,
    ball: ballSim.state,
    player: playerCtrl ? playerCtrl.view : dummyView('player'),
    opponent: aiCtrl ? aiCtrl.view : dummyView('opponent'),
    landing: phase === 'rally' && ballSim.state.inPlay ? ballSim.predictLanding() : null,
  })

  if (phase !== 'menu') {
    const pv = playerCtrl.view
    // サーブフェーズ中はプレイヤーの頭上(+2.4m)を画面投影してサーブ種類ラベルを置く
    let serveLabelScreen: { x: number; y: number } | null = null
    if (phase === 'serve' && score.view.server === 'player') {
      const head = pv.pos.clone()
      head.y += 2.0
      serveLabelScreen = renderer.worldToScreen(head)
    }
    const hud: HudView = {
      score: score.view,
      playerStamina: pv.stamina,
      opponentStamina: aiCtrl.view.stamina,
      serveMeter: playerCtrl.serveMeter,
      serveNumber,
      phase,
      banner,
      charge: pv.charging ? { value: pv.charge, overcharged: pv.charge > 1 } : null,
      serveLabelScreen,
    }
    ui.updateHud(hud)
  }
  requestAnimationFrame(frame)
}

// メニュー中(マッチ未生成)に描画へ渡すダミー
import type { PlayerView } from './types'
function dummyView(side: Side): PlayerView {
  return {
    side,
    pos: new Vector3(0, 0, sideSign(side) * (COURT_HALF_LENGTH + 1)),
    vel: new Vector3(),
    stamina: STAMINA_MAX,
    sprinting: false,
    swing: 'idle',
    lastShot: null,
    charging: false,
    charge: 0,
    swingSide: null,
  }
}

ui.showMenu()
ui.setDebugVisible(debugMode) // ?debug 付きなら初期 ON
requestAnimationFrame(frame)
