// =============================================================================
// 共有型定義(凍結) — 全モジュールの契約
// 各モジュールはこのファイルと constants.ts、three 以外を import しないこと。
// 詳細仕様は docs/ARCHITECTURE.md を参照。
// =============================================================================
import type { Vector3 } from 'three'

// ---------------------------------------------------------------------------
// 基本
// ---------------------------------------------------------------------------

/** player = 手前側 (z>0)、opponent = 奥側 (z<0) */
export type Side = 'player' | 'opponent'

export type ShotType = 'flat' | 'topspin' | 'slice' | 'lob' | 'drop'

/** サーブの種類(docs/GAME_DESIGN.md §5.1)。flat=速い/低い、slice=曲がる/低い、kick=安全/高く弾む */
export type ServeType = 'flat' | 'slice' | 'kick'

export type Difficulty = 'easy' | 'normal' | 'hard'

export type GamePhase = 'menu' | 'serve' | 'rally' | 'pointOver' | 'matchOver'

/** 相手側の Side を返す */
export function otherSide(s: Side): Side {
  return s === 'player' ? 'opponent' : 'player'
}

/** その Side のコートの z 符号(player: +1, opponent: -1) */
export function sideSign(s: Side): 1 | -1 {
  return s === 'player' ? 1 : -1
}

// ---------------------------------------------------------------------------
// ボール物理
// ---------------------------------------------------------------------------

export interface BallState {
  pos: Vector3
  vel: Vector3
  /** 角速度 rad/s。規約は docs/ARCHITECTURE.md §5.4 */
  spin: Vector3
  /** 最後の打球以降の地面バウンド数 */
  bounceCount: number
  lastHitBy: Side | null
  inPlay: boolean
}

export type BallEvent =
  | { kind: 'bounce'; pos: Vector3 }
  | { kind: 'net' }
  | { kind: 'hit'; by: Side; shot: ShotType }

export interface LandingPrediction {
  /** 次の地面バウンド位置(y=0 平面) */
  pos: Vector3
  /** 現在から着地までの秒数 */
  time: number
}

// ---------------------------------------------------------------------------
// ショット
// ---------------------------------------------------------------------------

export interface ShotRequest {
  type: ShotType
  hitter: Side
  /** 打点(ボール現在位置) */
  hitPos: Vector3
  /** 望む着地点(品質ノイズ適用前)。y=0 */
  target: Vector3
  /** 品質 0.35..1.0(docs/GAME_DESIGN.md §4.2) */
  quality: number
  /**
   * チャージ量 0..CHARGE_MAX(docs/GAME_DESIGN.md §4.4)。
   * 威力係数 CHARGE_POWER_MIN + CHARGE_POWER_GAIN·min(charge,1) を速度に乗算。
   * charge > 1 はオーバーチャージ: 狙い誤差 +(charge−1)·OVERCHARGE_NOISE、
   * ネット越えマージン縮小(アウト/ネットのリスク増)。
   */
  charge: number
  /**
   * 打球直前のボール速度の大きさ(m/s)。相手球の勢い。
   * ソルバが「球威の打ち返し(counter/redirect)」と「速球の制御難」を
   * 計算するのに使う(docs/GAME_DESIGN.md §4.5)。サーブ等で 0 でも可。
   * 打点の高さは hitPos.y、コート位置(ネットからの距離)は |hitPos.z| を使うため
   * 追加フィールドは不要。
   */
  incomingSpeed: number
}

export interface ShotSolution {
  vel: Vector3
  spin: Vector3
}

// ---------------------------------------------------------------------------
// プレイヤー / コントローラ
// ---------------------------------------------------------------------------

/** スイングアニメ・当たり判定用の状態 */
export type SwingState = 'idle' | 'swing' | 'whiff'

/** 読み取り専用のプレイヤービュー(相手や描画・UI に公開する情報) */
export interface PlayerView {
  side: Side
  pos: Vector3
  vel: Vector3
  /** 0..100 */
  stamina: number
  sprinting: boolean
  swing: SwingState
  /** 直近に選んだショット(描画・音用) */
  lastShot: ShotType | null
  /** チャージ中か(ショットキー長押し)。AI は常に false でよい */
  charging: boolean
  /** チャージ量 0..CHARGE_MAX。非チャージ時は 0 */
  charge: number
  /** スイング種別(フォア=利き手側/バック)。スイング中以外は null */
  swingSide: 'fore' | 'back' | null
}

/** サーブメーター表示用 */
export interface ServeMeterView {
  active: boolean
  /** 0..1 */
  value: number
  /** 現在選択中のサーブ種類(サーブフェーズ中の HUD 表示用) */
  serveType: ServeType
}

/**
 * コントローラ(人間/AI 共通)へ main が注入するコンテキスト。
 * コントローラはこれを通してのみ外界と相互作用する。
 */
export interface ControlContext {
  phase: GamePhase
  ball: Readonly<BallState>
  self: PlayerView
  rival: PlayerView
  /** 現在のボールの着地予測(ネット衝突予測時は null) */
  predictLanding(): LandingPrediction | null
  /** ラリー中の打球要求。main がソルバ→BallSim.launch に接続する */
  requestShot(req: ShotRequest): void
  /** サーブ発射要求。power 0..1、aimX: -1=左 0=中央 1=右、serveType=サーブ種類 */
  requestServe(power: number, aimX: -1 | 0 | 1, serveType: ServeType): void
  /** 現在サーブすべき側か(serve フェーズで自分がサーバーか) */
  isServing: boolean
  /** サーブ何本目か(1 or 2) */
  serveNumber: 1 | 2
}

export interface Controller {
  /** 固定タイムステップで毎物理フレーム呼ばれる */
  update(dt: number, ctx: ControlContext): void
  /** ポイント開始時(サーブフェーズ突入時)に呼ばれる。定位置リセット等 */
  resetForPoint(servingSide: Side, serveFromRight: boolean): void
  /** ゲーム間のスタミナ全回復(GAME_DESIGN §6)。main がゲーム決着時に呼ぶ */
  recoverFullStamina(): void
  readonly view: PlayerView
  /** 人間プレイヤーのみ意味を持つ。AI は {active:false,value:0} を返す */
  readonly serveMeter: ServeMeterView
}

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

export interface InputState {
  /** -1..1(A/D, ←/→) */
  moveX: number
  /** -1..1(W/S, ↑/↓)。-1 = 前進(ネット方向 = z-) */
  moveZ: number
  sprint: boolean
  /** このフレームに押されたショットキー(エッジ検出、1フレーム1発) */
  shotPressed: ShotType | null
  /** 現在押しっぱなしのショットキー(複数同時押しは最初に押したもの優先) */
  shotHeld: ShotType | null
  /** このフレームに離されたショットキー(エッジ検出) */
  shotReleased: ShotType | null
  /** Space が押されているか(サーブメーター用) */
  servePressed: boolean
  /** このフレームに Space が離されたか */
  serveReleased: boolean
  /** Esc エッジ */
  escPressed: boolean
}

export interface InputSource {
  /** 物理フレームごとに呼び、スナップショットを得る(エッジはここで消費) */
  poll(): InputState
}

// ---------------------------------------------------------------------------
// ルール: ラリー判定・スコア
// ---------------------------------------------------------------------------

export type VerdictReason =
  | 'winner'        // 相手が触れず2バウンド or 返球不能
  | 'out'
  | 'net'           // ネットにかけた
  | 'doubleBounce'
  | 'fault'         // サーブフォルト(1st)。失点ではない
  | 'doubleFault'

export interface RallyVerdict {
  winner: Side
  reason: VerdictReason
}

/** サービスボックス指定: サーバーから見て対角のボックス */
export interface ServiceBox {
  /** 受け側コートの z 符号(= sideSign(receiver)) */
  zSign: 1 | -1
  /** x の範囲 [min, max](センターライン〜シングルスライン) */
  xMin: number
  xMax: number
}

export interface ScorePoints {
  /** '0' | '15' | '30' | '40' | 'Ad' */
  player: string
  opponent: string
}

export interface ScoreView {
  points: ScorePoints
  games: { player: number; opponent: number }
  server: Side
  /** 直前の addPoint でゲームが決まったか */
  gameJustWon: Side | null
  /** マッチ勝者(未決着なら null) */
  matchWinner: Side | null
}

// ---------------------------------------------------------------------------
// マッチ設定・スタッツ
// ---------------------------------------------------------------------------

export interface MatchConfig {
  difficulty: Difficulty
  gamesToWin: 1 | 2 | 4
}

export interface MatchStats {
  winners: { player: number; opponent: number }
  errors: { player: number; opponent: number }
  doubleFaults: { player: number; opponent: number }
}

export interface MatchResult {
  winner: Side
  games: { player: number; opponent: number }
  stats: MatchStats
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export interface AIProfile {
  /** 相手打球からの反応遅延(秒) */
  reactionDelay: number
  /** 移動速度係数 */
  speedScale: number
  /** 追加の狙い誤差(m)。品質ノイズに加算 */
  extraAimNoise: number
  /** 強気配球(ライン際・フラット)を選ぶ傾向 0..1 */
  aggressiveness: number
  /** 凡ミス率 0..1(ポイントごとに大きく品質を落とす確率) */
  blunderRate: number
  /** サーブ power の平均(1st) */
  servePower1st: number
  /** サーブ power の平均(2nd) */
  servePower2nd: number
  /**
   * 明らかにアウトのボール(着地予測がコート外 AI_LEAVE_CLEAR_MARGIN 超)を
   * 見送る確率 0..1(docs/GAME_DESIGN.md §7.1)。難易度が高いほど高い。
   */
  leaveOutClearProb: number
  /**
   * きわどいアウト(ラインぎりぎり外)のボールを見送る確率 0..1。
   * 実際の見送り確率は outDist に応じて leaveOutEdgeProb..leaveOutClearProb を補間。
   */
  leaveOutEdgeProb: number
}

// ---------------------------------------------------------------------------
// レンダリング
// ---------------------------------------------------------------------------

/** 描画に必要なワールドの読み取りビュー */
export interface WorldView {
  phase: GamePhase
  ball: Readonly<BallState>
  player: PlayerView
  opponent: PlayerView
  /** 飛行中ボールの着地予測(視認性マーカー描画用)。非ラリー時は null */
  landing: LandingPrediction | null
}

/** main からエフェクトを発火するための API(GameRenderer が実装) */
export interface SceneApi {
  spawnBounceFx(pos: Vector3): void
  spawnHitFx(pos: Vector3): void
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export interface HudView {
  score: ScoreView
  playerStamina: number
  opponentStamina: number
  serveMeter: ServeMeterView
  /** サーブ何本目か(serve フェーズ表示用) */
  serveNumber: 1 | 2
  phase: GamePhase
  /** 表示すべきバナー(null なら非表示)。main が設定し時間経過で消す */
  banner: string | null
  /** プレイヤーのチャージ状態(非チャージ時 null)。HUD のチャージバー用 */
  charge: { value: number; overcharged: boolean } | null
  /**
   * サーブ種類ラベルを表示するキャンバス上の座標(CSS px)。
   * サーブフェーズでプレイヤーの頭上に表示するため main が投影して設定する。
   * null のとき(非サーブ時や投影不可)はラベルを既定位置にしない=非表示扱い。
   */
  serveLabelScreen: { x: number; y: number } | null
}

export interface UIHandlers {
  onStart(config: MatchConfig): void
  onRematch(): void
  onQuit(): void
}

// ---------------------------------------------------------------------------
// オーディオ
// ---------------------------------------------------------------------------

export type SfxName =
  | 'hit_flat'
  | 'hit_spin'
  | 'hit_slice'
  | 'bounce'
  | 'net'
  | 'serve'
  | 'point'
  | 'applause'
  | 'ui'
