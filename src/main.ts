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
  type PracticeBall,
  type PracticeCourse,
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
  JUST_SWEET_DIST,
  MEET_HINT_LEAD,
  MISHIT_ACTIVE_EPS,
  MOMENTUM_FULL_STREAK,
  NET_POINT_Z,
  OPEN_COURT_MIN_OFFSET,
  PHYS_DT,
  PLAYER_PERSONAS,
  personaModifiers,
  PRACTICE_COURSE_BACK_Z,
  PRACTICE_COURSE_FRONT_Z,
  PRACTICE_FEED_DELAY,
  PRACTICE_MACHINE_Z,
  PRACTICE_SPREAD_X,
  REACH,
  REACH_HEIGHT,
  SERVE_HIT_HEIGHT,
  SERVICE_LINE_Z,
  setSurface,
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
// ?auto: オートプレイ(両コートを AI が操作)。デモ/挙動検証用。
const AUTO_PLAY = new URLSearchParams(location.search).has('auto')
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
  surface: 'hard',
}
// 各サイドのペルソナ倍率(startMatch で確定)。サーブ倍率・打点高に使う。
let playerMods: PersonaModifiers = personaModifiers(PLAYER_PERSONAS.federun.ratings, PLAYER_PERSONAS.federun.mental)
let opponentMods: PersonaModifiers = personaModifiers(PLAYER_PERSONAS.jokovin.ratings, PLAYER_PERSONAS.jokovin.mental)
let score: MatchScore
let playerCtrl: Controller
let aiCtrl: Controller
let stats: MatchStats
let serveNumber: 1 | 2 = 1
let pointsInGame = 0 // サーブサイド(デュース/アド)決定用
// 練習モード(ボールマシン)状態
let practiceActive = false
let practiceBall: PracticeBall = 'topspin'
let practiceCourse: PracticeCourse = 'back'
let practiceFeedTimer = 0 // 次の球出しまでの待ち(秒)
let practiceStats = { just: 0, nonJust: 0, safety: 0 }
let banner: string | null = null
let bannerTimer = 0
let pointOverTimer = 0
let pendingVerdict: RallyVerdict | null = null

function newStats(): MatchStats {
  return {
    winners: { player: 0, opponent: 0 },
    errors: { player: 0, opponent: 0 },
    doubleFaults: { player: 0, opponent: 0 },
    pointsPlayed: 0,
    totalShots: 0,
    firstServeIn: { player: 0, opponent: 0 },
    firstServeTotal: { player: 0, opponent: 0 },
    netPointsWon: { player: 0, opponent: 0 },
    netPointsPlayed: { player: 0, opponent: 0 },
    runDistance: { player: 0, opponent: 0 },
  }
}

// ---------------------------------------------------------------------------
// モメンタム(勢い)+ ポイント内集計(IMPROVEMENTS §4 高)
// ---------------------------------------------------------------------------
let streak: { player: number; opponent: number } = { player: 0, opponent: 0 }
/** このポイントの集計(ポイント終了時に stats へ反映) */
let pointShots = 0
let pointNetTouch: { player: boolean; opponent: boolean } = { player: false, opponent: false }
let prevPos: { player: Vector3; opponent: Vector3 } | null = null

/** あるサイドのモメンタム −1..+1(自分の連勝 − 相手の連勝、MOMENTUM_FULL_STREAK で正規化) */
function momentumOf(side: Side): number {
  const mine = Math.min(streak[side] / MOMENTUM_FULL_STREAK, 1)
  const rival = Math.min(streak[otherSide(side)] / MOMENTUM_FULL_STREAK, 1)
  return mine - rival
}

/**
 * オープンコートの可視化対象を算出(IMPROVEMENTS §4 高)。
 * プレイヤーが打つ番(相手が最後に打った)で、相手(AI)がセンターから外れているとき、
 * 相手コートの空いた側(AI の x と反対側)を返す。配球が報われる手応えの可視化。
 */
// オープンコートの床ハイライトは装飾過剰のため無効化(ユーザー要望)。
// 走らせ距離などの集計は別経路なので影響なし。再有効化はこのフラグを true に。
const OPEN_COURT_ENABLED = false

function computeOpenCourt(): { x: number; z: number; strength: number } | null {
  if (!OPEN_COURT_ENABLED) return null
  if (phase !== 'rally' || !ballSim.state.inPlay) return null
  if (ballSim.state.lastHitBy !== 'opponent') return null // プレイヤーが打つ局面のみ
  const aiX = aiCtrl.view.pos.x
  const off = Math.abs(aiX) - OPEN_COURT_MIN_OFFSET
  if (off <= 0) return null
  const strength = Math.min(off / (COURT_HALF_WIDTH - OPEN_COURT_MIN_OFFSET), 1)
  // 相手コート(z<0)の、AI の反対側のコーナー寄り
  const openX = -Math.sign(aiX) * COURT_HALF_WIDTH * 0.62
  const openZ = -(COURT_HALF_LENGTH * 0.55)
  return { x: openX, z: openZ, strength }
}

/**
 * ジャストミートのタイミングヒント(§6.1.1 F)を算出する。リリース方式に対応。
 * - eta: ボールがリーチに入る(打てる)までの残り時間。前方シミュレート。リーチ内なら 0。
 *        リード時間(MEET_HINT_LEAD)より先の接触は出さない(直前だけ表示)。
 * - sweet: 今ボールがスイートゾーン(芯=JUST_SWEET_DIST 以内)にある=「今リリースで just」。
 * 描画側は eta でリングを収束させ、sweet のとき金色+脈動で「今離す」を示す。
 */
function computeMeetHint(): { eta: number; x: number; z: number; sweet: boolean } | null {
  if (phase !== 'rally' || !ballSim.state.inPlay) return null
  // 自分が打った球は対象外(相手から来る球のみ)
  if (ballSim.state.lastHitBy === 'player') return null
  if (!playerCtrl) return null
  const pv = playerCtrl.view
  const reach = REACH * playerMods.reachMul
  const bp = ballSim.state.pos
  const hDist = Math.hypot(bp.x - pv.pos.x, bp.z - pv.pos.z)
  const hittableNow = hDist <= reach && bp.y <= REACH_HEIGHT
  let eta: number
  if (hittableNow) {
    eta = 0
  } else {
    const c = ballSim.predictReach(pv.pos.x, pv.pos.z, reach, REACH_HEIGHT, MEET_HINT_LEAD)
    if (!c) return null
    eta = c.time
  }
  const sweet = hittableNow && hDist <= JUST_SWEET_DIST
  return { eta, x: pv.pos.x, z: pv.pos.z, sweet }
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
    get pressure() {
      return currentPressure
    },
    get momentum() {
      return momentumOf(self)
    },
    predictLanding: () => ballSim.predictLanding(),
    requestShot: (req: ShotRequest) => handleShot(req),
    requestServe: (power, aimX, serveType) => handleServe(self, power, aimX, serveType),
    logDebug: (e) => pushLog(self === 'opponent' ? 'AI' : 'P', e.kind, e.msg, e.data),
  }
}

// ---------------------------------------------------------------------------
// プレッシャー値の算出(GAME_DESIGN §6 / IMPROVEMENTS §5.5)
// スコア状況からその局面の「重圧」0..1 を求める。両者に同じ値を注入し、
// 各ペルソナの mental(pressureDrainMul)が反応の差を生む。
// ---------------------------------------------------------------------------
let currentPressure = 0
const POINT_RANK: Record<string, number> = { '0': 0, '15': 1, '30': 2, '40': 3, Ad: 4 }

function computePressure(): number {
  if (!score) return 0
  const sv = score.view
  const pP = POINT_RANK[sv.points.player] ?? 0
  const pO = POINT_RANK[sv.points.opponent] ?? 0
  // ゲームポイント(次の1点でゲームを取れる側)
  const gpPlayer = pP === 4 || (pP === 3 && pO < 3)
  const gpOpp = pO === 4 || (pO === 3 && pP < 3)
  if (gpPlayer || gpOpp) {
    const winner: Side = gpPlayer ? 'player' : 'opponent'
    // このゲームを取るとマッチ決着ならマッチポイント = 最大の重圧
    const matchPoint = sv.games[winner] + 1 >= config.gamesToWin
    if (matchPoint) return 1.0
    // ブレークポイント(レシーバーのゲームポイント)はやや重い
    const isBreak = winner !== sv.server
    return isBreak ? 0.8 : 0.7
  }
  if (pP >= 3 && pO >= 3) return 0.4 // デュース(40-40)
  if (pP === 2 && pO === 2) return 0.25 // 30-30 の競り
  return 0
}

const ctxPlayer = makeContext('player')
const ctxOpponent = makeContext('opponent')

// ---------------------------------------------------------------------------
// 打球・サーブ
// ---------------------------------------------------------------------------
function handleShot(req: ShotRequest): void {
  if (phase !== 'rally' || !ballSim.state.inPlay) return
  // 集計: 打球数 + ネットポイント(前衛での打球)検出
  pointShots++
  if (Math.abs(req.hitPos.z) < NET_POINT_Z) pointNetTouch[req.hitter] = true
  const sol = solveShot(req)
  dbg(`shot ${req.hitter} ${req.type} q=${req.quality.toFixed(2)} hit=${fmt(req.hitPos)} target=${fmt(req.target)}`)
  ballSim.launch(req.hitPos.clone(), sol.vel, sol.spin, req.hitter)
  renderer.sceneApi.spawnHitFx(req.hitPos.clone())
  // ジャストミート(§6.1.1): 成立打球は金白の発光リング+スパーク、ボール飛行着色、
  // 打球音に澄んだベル倍音を重ねる。
  if (req.just) {
    renderer.sceneApi.spawnJustMeetFx(req.hitPos.clone())
    renderer.flashJustBall()
    dbg(`JUST ${req.hitter} ${req.type} q=${req.quality.toFixed(2)}`)
  }
  // 打球音(§7): ショット種別ごとに音色を作り分け、球威(quality)で明るさを、
  // 打点 x でステレオ定位を決める。差し込まれ(山なり化)は鈍い "コツッ" に。
  sfx.playHit(req.type, {
    intensity: req.quality,
    panX: Math.max(-1, Math.min(1, req.hitPos.x / COURT_HALF_WIDTH)),
    mishit: (sol.mishit ?? 0) > MISHIT_ACTIVE_EPS,
    just: req.just ?? false,
  })
  // 練習モード: プレイヤーの打球をカウント(セーフティ / ジャスト / 通常)。スコア判定はしない。
  if (practiceActive) {
    if (req.hitter === 'player') {
      if (req.safety) practiceStats.safety++
      else if (req.just) practiceStats.just++
      else practiceStats.nonJust++
    }
    return
  }
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
  // 集計: 1stサーブ確率(打った数と入った数)+ サーブも1打球
  if (serveNumber === 1) {
    stats.firstServeTotal[server]++
    if (landIn) stats.firstServeIn[server]++
  }
  pointShots++
  // サーブ音(§7.4): フラットを増強した最も重く速い一撃。
  sfx.playHit('flat', {
    intensity: power,
    panX: Math.max(-1, Math.min(1, hitPos.x / COURT_HALF_WIDTH)),
    serve: true,
  })
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
  // 失点側のテレメトリを付与: ボールまでの距離・スタミナを残し、
  // 「届かなかった(距離大=ウロウロ走らされ/ドロップ)」か「見送り・空振り(距離小)」かを
  // 事後に判別できるようにする(?debug 診断用)。
  const loserSide = otherSide(v.winner)
  const loserView = (loserSide === 'player' ? playerCtrl : aiCtrl).view
  const bp = ballSim.state.pos
  const distToBall = Math.hypot(bp.x - loserView.pos.x, bp.z - loserView.pos.z)
  pushLog('sys', 'verdict', `verdict ${v.reason} → ${v.winner} (loser=${loserSide} distToBall=${distToBall.toFixed(1)} stamina=${loserView.staminaPct.toFixed(2)})`, {
    reason: v.reason,
    winner: v.winner,
    loser: loserSide,
    ballX: Math.round(bp.x * 100) / 100,
    ballZ: Math.round(bp.z * 100) / 100,
    loserX: Math.round(loserView.pos.x * 100) / 100,
    loserZ: Math.round(loserView.pos.z * 100) / 100,
    loserDistToBall: Math.round(distToBall * 100) / 100,
    loserStaminaPct: Math.round(loserView.staminaPct * 100) / 100,
  })
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

  // スタッツ集計(ポイント確定)+ モメンタム更新
  stats.pointsPlayed++
  stats.totalShots += pointShots
  for (const s of ['player', 'opponent'] as Side[]) {
    if (pointNetTouch[s]) {
      stats.netPointsPlayed[s]++
      if (verdict.winner === s) stats.netPointsWon[s]++
    }
  }
  streak[verdict.winner]++
  streak[otherSide(verdict.winner)] = 0

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
  // ポイント内集計のリセット
  pointShots = 0
  pointNetTouch = { player: false, opponent: false }
  prevPos = null
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
  playerMods = personaModifiers(playerPersona.ratings, playerPersona.mental)
  opponentMods = personaModifiers(opponentPersona.ratings, opponentPersona.mental)
  // オートプレイ(AI 対 AI / デモ・検証用): ?auto 付きなら手前コートも AIController で操作する。
  // 通常は手前コートを人間プレイヤー(PlayerController)が操作する。
  playerCtrl = AUTO_PLAY
    ? new AIController(AI_PROFILES[cfg.difficulty], playerMods, playerPersona.physique, 'player')
    : new PlayerController(sharedInput, playerMods, playerPersona.physique)
  aiCtrl = new AIController(AI_PROFILES[cfg.difficulty], opponentMods, opponentPersona.physique, 'opponent')
  // サーフェスを適用(物理スケール + コート色)
  setSurface(cfg.surface)
  renderer.setSurface(cfg.surface)
  // 3Dモデルをペルソナの体格・外見・チームカラーで再構成
  renderer.setMatchup(
    { physique: playerPersona.physique, appearance: playerPersona.appearance },
    { physique: opponentPersona.physique, appearance: opponentPersona.appearance },
  )
  serveNumber = 1
  pointsInGame = 0
  banner = null
  paused = false
  streak = { player: 0, opponent: 0 }
  ui.setPaused(false)
  // スコアボードにマッチ情報(ペルソナ名・難易度)を表示
  ui.setMatchInfo({
    difficulty: cfg.difficulty,
    playerName: playerPersona.name,
    opponentName: opponentPersona.name,
  })
  ui.showHud()
  if (cfg.mode === 'practice') {
    practiceActive = true
    practiceBall = cfg.practiceBall ?? 'topspin'
    practiceCourse = cfg.practiceCourse ?? 'back'
    practiceStats = { just: 0, nonJust: 0, safety: 0 }
    startPractice()
  } else {
    practiceActive = false
    startNextPoint()
  }
}

// ---------------------------------------------------------------------------
// 練習モード(ボールマシン)
// ---------------------------------------------------------------------------
function startPractice(): void {
  resetPointLog()
  pointClock = 0
  // プレイヤーは受け手、相手(マシン)はベースラインに立たせる(モデル表示用。動かさない)
  playerCtrl.resetForPoint('opponent', true)
  aiCtrl.resetForPoint('opponent', true)
  ballSim.state.inPlay = false
  ballSim.state.bounceCount = 0
  ballSim.state.lastHitBy = null
  phase = 'rally' // 練習中は常にラリー扱い(プレイヤーが打てる)
  practiceFeedTimer = 0.6 // 最初の球出しまで少し待つ
}

/** マシンが1球出す。練習設定の球種・コースに従う。 */
function feedPracticeBall(): void {
  const type =
    practiceBall === 'random'
      ? (['flat', 'topspin', 'slice', 'lob'] as const)[Math.floor(Math.random() * 4)]
      : practiceBall
  let z: number
  if (practiceCourse === 'front') z = PRACTICE_COURSE_FRONT_Z
  else if (practiceCourse === 'back') z = PRACTICE_COURSE_BACK_Z
  else z = Math.random() < 0.5 ? PRACTICE_COURSE_FRONT_Z : PRACTICE_COURSE_BACK_Z
  const x = (Math.random() * 2 - 1) * PRACTICE_SPREAD_X
  const machinePos = new Vector3(0, 1.0, PRACTICE_MACHINE_Z)
  const target = new Vector3(x, 0, z)
  // マシンの球出し = 相手側からプレイヤーコートへの打球(solveShot を流用)
  const sol = solveShot({
    type,
    hitter: 'opponent',
    hitPos: machinePos,
    target,
    quality: 0.95,
    charge: 0.3,
    incomingSpeed: 0,
    mods: opponentMods,
  })
  ballSim.launch(machinePos, sol.vel, sol.spin, 'opponent')
  resetPointLog()
  pointClock = 0
  dbg(`practice feed ${type} → (${x.toFixed(1)},${z.toFixed(1)})`)
}

/** 練習モードの物理ステップ(球出し→打ち返し→決着→次の球。スコアなし)。 */
function practiceStep(): void {
  pointClock += PHYS_DT
  currentPressure = 0
  // プレイヤーのみ更新(相手=マシンは定位置)
  playerCtrl.update(PHYS_DT, ctxPlayer)

  if (ballSim.state.inPlay) {
    const events: BallEvent[] = ballSim.step(PHYS_DT)
    for (const e of events) {
      if (e.kind === 'bounce') {
        renderer.sceneApi.spawnBounceFx(e.pos.clone())
        sfx.play('bounce')
      } else if (e.kind === 'net') {
        sfx.play('net')
      }
    }
    // 決着: 2バウンド or 場外(inPlay false)。少し待って次の球出し。
    if (!ballSim.state.inPlay || ballSim.state.bounceCount >= 2) {
      ballSim.state.inPlay = false
      practiceFeedTimer = PRACTICE_FEED_DELAY
    }
  } else if (practiceFeedTimer > 0) {
    practiceFeedTimer -= PHYS_DT
    if (practiceFeedTimer <= 0) feedPracticeBall()
  }
}

function quitToMenu(): void {
  phase = 'menu'
  paused = false
  practiceActive = false
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

  // 練習モードは専用ステップ(ボールマシン)で処理して終了
  if (practiceActive) {
    practiceStep()
    if (bannerTimer > 0) {
      bannerTimer -= PHYS_DT
      if (bannerTimer <= 0) banner = null
    }
    return
  }

  // ポイント中(serve / rally)の経過時間(デバッグログのタイムスタンプ用)
  if (phase === 'serve' || phase === 'rally') pointClock += PHYS_DT

  // この局面のプレッシャーを更新(コントローラのスタミナ/メンタル計算に注入)
  currentPressure = computePressure()

  playerCtrl.update(PHYS_DT, ctxPlayer)
  aiCtrl.update(PHYS_DT, ctxOpponent)

  // 走らせ距離の集計(ラリー中の各プレイヤーの移動量を加算)
  if (phase === 'rally') {
    const pp = playerCtrl.view.pos
    const op = aiCtrl.view.pos
    if (prevPos) {
      stats.runDistance.player += Math.hypot(pp.x - prevPos.player.x, pp.z - prevPos.player.z)
      stats.runDistance.opponent += Math.hypot(op.x - prevPos.opponent.x, op.z - prevPos.opponent.z)
      prevPos.player.copy(pp)
      prevPos.opponent.copy(op)
    } else {
      prevPos = { player: pp.clone(), opponent: op.clone() }
    }
  }

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
    openCourt: computeOpenCourt(),
    meetHint: computeMeetHint(),
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
    // スタミナ円形ゲージ用: プレイヤーの右横・胸の高さにオフセット(頭上だと
    // サーブラベルやボール視線と干渉するため。IMPROVEMENTS §5.1)。相手ゲージは非表示。
    const ov = aiCtrl.view
    const playerHead = pv.pos.clone(); playerHead.x += 0.6; playerHead.y += 1.4
    const opponentHead = ov.pos.clone(); opponentHead.y += 2.3
    const hud: HudView = {
      score: score.view,
      playerStamina: pv.stamina,
      opponentStamina: ov.stamina,
      serveMeter: playerCtrl.serveMeter,
      serveNumber,
      phase,
      banner,
      charge: pv.charging ? { value: pv.charge, overcharged: pv.charge > 1 } : null,
      serveLabelScreen,
      playerStaminaPct: pv.staminaPct,
      opponentStaminaPct: ov.staminaPct,
      playerStaminaScreen: renderer.worldToScreen(playerHead),
      opponentStaminaScreen: renderer.worldToScreen(opponentHead),
      playerMomentum: momentumOf('player'),
      // 練習モード成績(ジャスト/通常/セーフティの累計)。通常対戦では null。
      practiceStats: practiceActive ? practiceStats : null,
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
    staminaPct: 1,
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

// ?debug 限定の計測フック(scripts/ のヘッドレス検証から AI/プレイヤーのスタミナ・
// スプリント状態を毎フレーム読むためのもの。本番ビルドの挙動には影響しない)。
if (debugMode) {
  ;(window as unknown as { __diag?: () => unknown }).__diag = () => ({
    phase,
    ball: { x: ballSim.state.pos.x, y: ballSim.state.pos.y, z: ballSim.state.pos.z, by: ballSim.state.lastHitBy, bc: ballSim.state.bounceCount },
    player: playerCtrl ? { x: playerCtrl.view.pos.x, z: playerCtrl.view.pos.z, staminaPct: playerCtrl.view.staminaPct, sprinting: playerCtrl.view.sprinting } : null,
    ai: aiCtrl ? { x: aiCtrl.view.pos.x, z: aiCtrl.view.pos.z, staminaPct: aiCtrl.view.staminaPct, sprinting: aiCtrl.view.sprinting } : null,
  })
  // 現在ポイントのデバッグログ(サーブ・スタンス・追走・打球イベント)。検証スクリプト用。
  ;(window as unknown as { __pointlog?: () => unknown }).__pointlog = () => pointLog

}

requestAnimationFrame(frame)
