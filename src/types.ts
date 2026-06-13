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

// ---------------------------------------------------------------------------
// プレイヤーペルソナ(プレイスタイル/能力タイプ) — docs/GAME_DESIGN.md §12
// ---------------------------------------------------------------------------

export type PersonaId =
  | 'sambrant'
  | 'agachi'
  | 'jokovin'
  | 'nishigoori'
  | 'nadau'
  | 'federun'

/** 6軸の能力値(各 1..5)。レーダーチャートにそのまま使う */
export interface PersonaRatings {
  serve: number
  power: number
  spin: number
  speed: number
  stamina: number
  finesse: number
}

/** 身体的特徴(見た目の識別 + ごく軽いゲーム挙動) */
export interface PersonaPhysique {
  /** 身長(m)。モデル縦スケールとサーブ打点高に影響 */
  heightM: number
  /** 体格(手足・胴の太さスケール) */
  build: 'slim' | 'athletic' | 'stocky'
  /** 利き手。'left' はフォア/バック判定を左右反転 */
  handedness: 'right' | 'left'
}

/** 外見(チームカラーとは独立したペルソナ識別子) */
export interface PersonaAppearance {
  hair: 'short' | 'bald' | 'headband' | 'long' | 'cap'
  sleeves: 'sleeved' | 'sleeveless'
  /** 小物(ヘッドバンド/リスト/シューズ)のアクセント色 hex。青/赤に紛れない色 */
  accent: number
}

export interface Persona {
  id: PersonaId
  name: string
  archetype: string
  blurb: string
  ratings: PersonaRatings
  physique: PersonaPhysique
  appearance: PersonaAppearance
}

/**
 * ペルソナ能力値から導出した倍率の束(docs/ARCHITECTURE.md §6.5)。
 * 既存定数に掛けるだけでペルソナ差を表現する(新システムを足さない)。
 * 1.0 = 影響なし。constants.ts の personaModifiers() で算出する。
 */
export interface PersonaModifiers {
  // サーブ
  serveSpeedMul: number
  serveFaultMul: number
  // パワー
  shotSpeedMul: number
  chargeGainMul: number
  // スピン/安定
  aimNoiseMul: number
  netMarginMul: number
  returnSolidMul: number
  // スピード
  moveSpeedMul: number
  reachMul: number
  // スタミナ
  staminaMaxMul: number
  staminaDrainMul: number
  staminaRegenMul: number
  // 技巧
  touchNoiseMul: number
  returnTouchMul: number
}

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
  /**
   * 打者のペルソナ倍率(docs/ARCHITECTURE.md §6.5)。省略時は中立(全 1.0)。
   * solveShot がショット初速・チャージ・狙い誤差・ネットマージン・差し込まれ等に乗算する。
   */
  mods?: PersonaModifiers
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
  /** AI の判断ログ出力(デバッグ用、任意)。実装側は省略可・null チェックして呼ぶ */
  logDebug?: (e: AIDebugEvent) => void
}

/**
 * AI の判断ログ 1 件(デバッグ用)。msg はライブ表示用の 1 行、data は JSON ダンプ用の構造化値。
 * docs/ARCHITECTURE.md §17(デバッグ)。
 */
export interface AIDebugEvent {
  /** 種別。'serve'=サーブ選択, 'shot'=ショット選択, 'leave'=見送り判定, 'note'=その他 */
  kind: 'serve' | 'shot' | 'leave' | 'note'
  /** 1 行サマリ(ライブログ表示用) */
  msg: string
  /** 構造化データ(JSON ダンプ用) */
  data?: Record<string, number | string | boolean | null>
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
  /** プレイヤーが選んだペルソナ */
  playerPersona: PersonaId
  /** 相手 AI のペルソナ */
  opponentPersona: PersonaId
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
  /**
   * サーブのリターン位置取りの上手さ 0..1(docs/GAME_DESIGN.md §7.1)。
   * 1 ほどプレイヤーのサーブ位置を読んで最適な受け位置(両極サーブの二等分点)に
   * 寄せる。0 に近いほど汎用的な定位置のまま。難易度が高いほど高い。
   */
  returnPositioning: number
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
  /** ポーズ画面の「再開」。プレイを再開する */
  onResume(): void
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
