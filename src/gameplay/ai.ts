// =============================================================================
// AI 制御(対戦相手) — docs/ARCHITECTURE.md §11 / docs/GAME_DESIGN.md §7
// AIController は Controller インターフェースを実装する。
// import は 'three' / '../types' / '../constants' のみ(依存ルール厳守)。
// =============================================================================
import { Vector3 } from 'three'
import type {
  AIProfile,
  ControlContext,
  Controller,
  LandingPrediction,
  PersonaModifiers,
  PersonaPhysique,
  PlayerView,
  ServeType,
  ServeMeterView,
  Side,
  ShotRequest,
  ShotType,
  SwingState,
} from '../types'
import { otherSide, sideSign } from '../types'
import {
  AIM_NOISE_R,
  AIM_OFFSET_X,
  AIM_OFFSET_Z,
  AI_APPROACH_NEED_MAX,
  AI_APPROACH_NEED_MIN,
  AI_BASELINE_DROPBACK,
  AI_NET_ADVANCE,
  AI_NET_MIN_Z,
  AI_NET_PACE_W,
  AI_NET_READY_Z,
  AI_SHORT_FORWARD,
  AI_SERVE_DELAY_MAX,
  AI_SERVE_DELAY_MIN,
  AI_SHORT_BALL_Z,
  AI_LEAVE_CLEAR_MARGIN,
  BALL_RADIUS,
  CONTACT_PIVOT_HEIGHT,
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  HIGH_TOPSPIN_ANGLE_BONUS,
  HOME_POS_Z,
  MOVE_ACCEL,
  MOMENTUM_QUALITY_K,
  MOVE_X_LIMIT,
  MOVE_Z_MAX,
  MOVE_Z_MIN,
  PRESSURE_CHOKE_K,
  QUALITY_MIN,
  REACH,
  REACH_HEIGHT,
  RETURN_PACE_THRESH,
  SERVE_X_MARGIN_CENTER,
  SERVICE_LINE_Z,
  SHOT_PARAMS,
  SMASH_MAX_DEPTH,
  SMASH_MIN_HEIGHT,
  SMASH_MOTION_HEIGHT,
  SPRINT_SHOT_PENALTY,
  SPRINT_SPEED,
  STAMINA_LOW_THRESHOLD,
  STAMINA_MAX,
  STAMINA_QUALITY_FLOOR,
  STAMINA_REGEN_IDLE,
  STAMINA_MOVE_DRAIN_K,
  STAMINA_SPRINT_EXTRA,
  moveEconomyMul,
  STAMINA_POINT_RECOVERY,
  shotStaminaCost,
  SWEET_DIST,
  SWING_LOCK_MOVE_FACTOR,
  SWING_LOCK_TIME,
  TARGET_CLAMP_MARGIN,
  WALK_SPEED,
} from '../constants'

// AI の内部行動状態(ARCHITECTURE §11)
type AiMode = 'returning' | 'intercept' | 'recover'

// AI 固有のチューニング値(constants にない補助パラメータはここに局所定義)
const AI_REACH_BUFFER = 0.85 // この余裕(m)以内に近づいたら打球を試みる
const AI_HYSTERESIS = 0.25 // 目標 x/z の更新ヒステリシス(m)。これ未満の変化は無視
const AI_ARRIVE_EPS = 0.12 // 目標到達とみなす距離(m)
// スプリント判断の到達余裕マージン(秒)。「歩いて到達に要する時間」が
// 「ボール着地までの残り時間 − このマージン」を超える=歩きでは間に合わない時だけ走る。
// 大きいほど早めに(=余裕をもって)走り出し、小さいほどギリギリまで歩いて体力を温存する。
const AI_SPRINT_TIME_MARGIN = 0.18
const AI_BLUNDER_QUALITY = 0.4 // 凡ミス時に品質に乗算する係数
const AI_SERVE_AIM_WIDE_PROB = 0.55 // サーブでワイド/センター(端)を狙う確率
/** スイング演出の表示時間(秒) */
const AI_SWING_DISPLAY_TIME = 0.3

// -------------------------------------------------------------------------
// ペルソナ別ショット嗜好の加点係数(IMPROVEMENTS §4中 / GAME_DESIGN §7.1)
// 既存の重み(オープンコート・体勢・相手前後・aggressiveness)より小さめにし、
// 中立(全 mul=1.0、netRushTendency=0.3)では加点ゼロで従来と一致する。
// -------------------------------------------------------------------------
/** 技巧型(touchNoiseMul が 1.0 未満): drop/lob/鋭角(横に振った)に加点する最大値 */
const PERSONA_FINESSE_W = 1.2
/** スピン/安定型(aimNoiseMul が 1.0 未満): topspin に加点する最大値 */
const PERSONA_SPIN_W = 1.0
/** パワー型(shotSpeedMul が 1.0 超): flat に加点する最大値 */
const PERSONA_POWER_W = 1.0
/** ネット志向型(netRushTendency が 0.3 超): 前寄りの場面で flat/決め球に加点する最大値 */
const PERSONA_NETRUSH_W = 0.8
/**
 * netRushTendency の中立基準値(NEUTRAL_PERSONA_MODIFIERS と一致)。
 * tendency がこの値を超えた分のみ加点する(中立以下は 0)。
 */
const PERSONA_NETRUSH_NEUTRAL = 0.3

// 相手が「前」と判断する“ネットからの距離”の閾値。サービスライン付近までを前と見なす。
// 呼び出し側は Math.abs(rivalZ) と比較するので side 非依存(どちらのコートでも使える)。
function frontThreshold(): number {
  return SERVICE_LINE_Z
}

// ---------------------------------------------------------------------------
// 補助: 乱数
// ---------------------------------------------------------------------------

/** ボックス=ミュラー法による標準正規乱数 */
function gaussian(): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** デバッグログ用に小数2桁へ丸める */
function round2(x: number): number {
  return Math.round(x * 100) / 100
}

// ---------------------------------------------------------------------------
// AIController
// ---------------------------------------------------------------------------

export class AIController implements Controller {
  // 担当サイド。既定は奥コート(opponent)だが、AI 対 AI(オートプレイ)では
  // 手前コート(player)にも割り当てられる。side 依存はすべて sideSign(this.side) で吸収する。
  readonly side: Side
  private readonly profile: AIProfile

  // ペルソナ倍率・身体(DI)。中立倍率(全1.0)・右利きでは従来と同一挙動。
  private readonly mods: PersonaModifiers
  private readonly physique: PersonaPhysique
  // ペルソナ倍率を反映した有効スタミナ上限・有効リーチ
  private readonly effStaminaMax: number
  private readonly effReach: number

  // 物理状態(初期位置は constructor で side に応じて設定する)
  private readonly pos = new Vector3(0, 0, 0)
  private readonly vel = new Vector3(0, 0, 0)
  private stamina = STAMINA_MAX
  private sprinting = false
  private swingState: SwingState = 'idle'
  private lastShot: ShotType | null = null
  private swingTimer = 0 // スイング/空振り演出の残り時間
  /** 打球時に設定するフォア/バック種別(表示用) */
  private swingSide: 'fore' | 'back' | null = null
  private swingKind: 'normal' | 'smash' = 'normal' // 高い打点のオーバーヘッド表示用
  /** スイングロック残り時間(SWING_LOCK_TIME 秒間は移動速度を低下) */
  private swingLockTimer = 0

  // 行動状態
  private mode: AiMode = 'returning'
  // 戦術スタンス: 'baseline'=後ろで打ち合う(着地点より深く構える) /
  // 'net'=前へ詰めてボレー(着地点より前に出る)。入射球ごとに decideStance で決める。
  private stance: 'baseline' | 'net' = 'baseline'
  private stanceDecided = false // この入射球についてスタンスを決定済みか
  private chaseLogged = false // この入射球について追走ログを出力済みか(?debug 診断用)
  // intercept 時の「ボール着地までの残り時間」(秒)。decideTarget で predictLanding から保存し、
  // moveToward のスプリント判断(歩いて間に合うか)に使う。余裕不明時は < 0(距離ベースへフォールバック)。
  private interceptTimeAvail = -1
  private readonly targetPos = new Vector3(0, 0, 0) // 現在の移動目標(初期位置は constructor で設定)
  private reactionTimer = 0 // 相手打球後の反応遅延の残り時間
  private lastSeenHitBy: Side | null = null // 直近に観測した lastHitBy(打球検出用)
  private blunderThisPoint = false // このポイントで凡ミスするか
  // 見送り判定: 相手の打球がアウトと判断したら true(その球は打たずに見送る)。
  // 1球ごとに一度だけ確率判定し、次の相手打球まで固定する。
  private leaveCurrentBall = false
  private leaveDecided = false

  // サーブ状態
  private serveDelayTimer = 0
  private serveArmed = false // サーブ待機中(遅延カウント中)か
  private hasServedThisPhase = false
  /** このポイントで AI が選んだサーブ種類(resetForPoint か updateServe で決定) */
  private chosenServeType: ServeType = 'flat'
  /** このポイントのサーブサイド(世界座標 +x 側=true)。レシーブ位置取りに使う */
  private servingFromRight = false

  // ビュー(参照は固定。中身を更新する)
  private readonly _view: PlayerView
  private readonly _serveMeter: ServeMeterView = { active: false, value: 0, serveType: 'flat' }

  constructor(profile: AIProfile, mods: PersonaModifiers, physique: PersonaPhysique, side: Side = 'opponent') {
    this.side = side
    this.profile = profile
    this.mods = mods
    this.physique = physique
    this.effStaminaMax = STAMINA_MAX * mods.staminaMaxMul
    this.effReach = REACH * mods.reachMul
    // スタミナ初期値を有効上限に(中立倍率では STAMINA_MAX のまま)
    this.stamina = this.effStaminaMax
    // 初期位置は担当サイドのホームへ(opponent: z<0 / player: z>0)
    const homeZ = sideSign(side) * HOME_POS_Z
    this.pos.set(0, 0, homeZ)
    this.targetPos.set(0, 0, homeZ)
    this._view = {
      side: this.side,
      pos: this.pos,
      vel: this.vel,
      stamina: this.stamina,
      staminaPct: this.effStaminaMax > 0 ? this.stamina / this.effStaminaMax : 0,
      sprinting: this.sprinting,
      swing: this.swingState,
      lastShot: this.lastShot,
      // AI はチャージ演出なし: 常に false / 0 / null
      charging: false,
      charge: 0,
      swingSide: null,
      swingKind: 'normal',
    }
  }

  get view(): PlayerView {
    // 値型フィールドはビューに同期
    this._view.stamina = this.stamina
    this._view.staminaPct = this.effStaminaMax > 0 ? this.stamina / this.effStaminaMax : 0
    this._view.sprinting = this.sprinting
    this._view.swing = this.swingState
    this._view.lastShot = this.lastShot
    // AI はチャージなし。swingSide はスイング中のみセット、終了後 null
    this._view.charging = false
    this._view.charge = 0
    this._view.swingSide = this.swingState === 'swing' ? this.swingSide : null
    this._view.swingKind = this.swingState === 'swing' ? this.swingKind : 'normal'
    return this._view
  }

  get serveMeter(): ServeMeterView {
    return this._serveMeter
  }

  // -------------------------------------------------------------------------
  // ポイント開始時のリセット(定位置へ)
  // -------------------------------------------------------------------------
  resetForPoint(servingSide: Side, serveFromRight: boolean): void {
    const sign = sideSign(this.side) // opponent => -1
    const amServing = servingSide === this.side
    this.servingFromRight = serveFromRight

    // スタミナ回復(ポイント間)。回復量にクラッチ回復倍率を反映。上限は effStaminaMax。
    this.stamina = clamp(
      this.stamina + STAMINA_POINT_RECOVERY * this.mods.clutchRecoveryMul,
      0,
      this.effStaminaMax,
    )

    // サーブ位置はポイント合計の偶奇で決まるが、ここでは serveFromRight を
    // サーバー視点の左右として受け取る。AI(奥側)から見た右はプレイヤーの左。
    // x の配置: デュースサイド(right)は自陣から見て右側、アドサイドは左側。
    // 受け手も対角に構える。プレイヤー視点座標(x)へ写像する。
    let placeX: number
    let placeZ: number

    if (amServing) {
      // サーバーはベースライン後方の対応サイドへ。
      // serveFromRight は「世界座標で +x 側」の統一規約(main.currentServiceBox と同じ)。
      // 両サイド共通で world +x/-x に立ち、ボックスは対角(反対の world x)に入る。side では反転しない。
      // サーブサイド半面内 [SERVE_X_MARGIN_CENTER, COURT_HALF_WIDTH] でランダムに配置。
      // ワイド寄り/センター寄りを時々変えることで配球の駆け引きを演出する。
      const xRand = SERVE_X_MARGIN_CENTER + Math.random() * (COURT_HALF_WIDTH - SERVE_X_MARGIN_CENTER)
      placeX = (serveFromRight ? 1 : -1) * xRand
      placeZ = sign * (COURT_HALF_LENGTH + 0.5)
    } else {
      // レシーバーは対角ボックスを受ける位置(やや内側・ベースライン付近)
      // サーバーが right に立つなら、対角の受けは受け手視点で逆側
      placeX = serveFromRight ? -COURT_HALF_WIDTH * 0.5 : COURT_HALF_WIDTH * 0.5
      placeZ = sign * (COURT_HALF_LENGTH + 0.3)
    }

    this.pos.set(placeX, 0, placeZ)
    this.vel.set(0, 0, 0)
    this.targetPos.set(0, 0, sign * HOME_POS_Z)
    this.targetPos.x = placeX

    this.mode = amServing ? 'returning' : 'intercept'
    this.stance = 'baseline'
    this.stanceDecided = false
    this.swingState = 'idle'
    this.swingTimer = 0
    this.swingLockTimer = 0
    this.swingSide = null
    this.reactionTimer = 0
    this.lastSeenHitBy = null
    this.leaveCurrentBall = false
    this.leaveDecided = false

    // 凡ミスをこのポイントで起こすか抽選
    this.blunderThisPoint = Math.random() < this.profile.blunderRate

    // サーブ準備
    this.hasServedThisPhase = false
    if (amServing) {
      this.serveArmed = true
      this.serveDelayTimer = lerp(AI_SERVE_DELAY_MIN, AI_SERVE_DELAY_MAX, Math.random())
      // 1st サーブ用の種類を事前決定(2nd は updateServe 内で上書き)。
      // aggressiveness が高いほど flat 寄り、低いほど slice 寄り。
      this.chosenServeType = this.decideServeType(1)
      this._serveMeter.serveType = this.chosenServeType
    } else {
      this.serveArmed = false
      this.serveDelayTimer = 0
    }
  }

  /** ゲーム間のスタミナ全回復(GAME_DESIGN §6) */
  recoverFullStamina(): void {
    this.stamina = this.effStaminaMax
  }

  // -------------------------------------------------------------------------
  // サーブ種類の決定
  // -------------------------------------------------------------------------
  /**
   * AI がサーブ種類を選ぶ。
   * - 1st: aggressiveness が高いほど flat 寄り、低いほど slice 寄り。
   *   各難易度の aggressiveness(0.25/0.5/0.75)に対して自然な分布になるよう設定。
   *   flat の選択確率 ≈ aggr * 0.55 + 0.1、残りを slice に割り当てる。
   * - 2nd: 呼び出し元(updateServe)が kick に強制するため、ここでは 1st のみ対象。
   */
  private decideServeType(serveNumber: 1 | 2): ServeType {
    if (serveNumber === 2) return 'kick'
    const aggr = this.profile.aggressiveness
    // flat の確率: easy(0.25)≈ 0.24, normal(0.5)≈ 0.38, hard(0.75)≈ 0.51
    const pFlat = aggr * 0.55 + 0.10
    const r = Math.random()
    if (r < pFlat) return 'flat'
    return 'slice'
  }

  // -------------------------------------------------------------------------
  // 毎物理フレーム更新
  // -------------------------------------------------------------------------
  update(dt: number, ctx: ControlContext): void {
    // スイング演出タイマー
    if (this.swingTimer > 0) {
      this.swingTimer -= dt
      if (this.swingTimer <= 0) {
        this.swingTimer = 0
        this.swingState = 'idle'
        this.swingSide = null
      }
    }

    // スイングロックタイマー(移動速度を低下させる)
    if (this.swingLockTimer > 0) {
      this.swingLockTimer -= dt
      if (this.swingLockTimer < 0) this.swingLockTimer = 0
    }

    if (ctx.phase === 'serve') {
      this.updateServe(dt, ctx)
      // サーブ前は移動目標に応じて動く(positionForReturn 内で moveToward)。
      // ここでは現在の速度を元にスタミナを加算モデルで更新する。
      this.updateStamina(dt, this.sprinting, ctx.pressure)
      return
    }

    if (ctx.phase !== 'rally') {
      // pointOver / menu / matchOver 中は静止
      this.vel.set(0, 0, 0)
      this.sprinting = false
      this.updateStamina(dt, false, ctx.pressure)
      return
    }

    // --- rally 中 ---
    this.updateReaction(dt, ctx)
    this.updateLeaveDecision(ctx)
    this.decideTarget(ctx)
    this.moveToward(dt)
    this.updateStamina(dt, this.sprinting, ctx.pressure)
    this.tryHit(ctx)
  }

  // -------------------------------------------------------------------------
  // 見送り判定(アウトになりそうなボールは打たない)— GAME_DESIGN §7.1
  // 相手の打球の着地予測がコート外なら、その球は見送る(きわどいものは確率的に)。
  // 反応遅延の経過後・まだ自陣でバウンドしていない(bounceCount===0)球にのみ適用し、
  // 1球につき一度だけ確率判定して固定する。
  // -------------------------------------------------------------------------
  private updateLeaveDecision(ctx: ControlContext): void {
    // 自分が最後の打者、またはバウンド後(=インプレー確定)は見送らない
    if (ctx.ball.lastHitBy === this.side || ctx.ball.bounceCount > 0) {
      this.leaveCurrentBall = false
      this.leaveDecided = false
      return
    }
    // 既に判定済みなら再判定しない(1球につき一度だけ抽選して固定)。
    // 着地予測は打球直後から有効なため反応遅延は待たない(速いアウト球を
    // 反応前に打ってしまうのを防ぐ意味でも即時に見送りを判断する)。
    if (this.leaveDecided) return

    const pred = ctx.predictLanding()
    // 予測なし(ネット衝突予測など)は判断材料がないので保留(打ちにいかせる)
    if (!pred) return
    // 自分側に来ない予測は無関係
    if (!this.isOwnSide(pred.pos.z)) return

    // コート外への「はみ出し距離」outDist(m)。正ならアウト。
    const overBaseline = Math.abs(pred.pos.z) - COURT_HALF_LENGTH
    const overSide = Math.abs(pred.pos.x) - COURT_HALF_WIDTH
    const outDist = Math.max(overBaseline, overSide)

    this.leaveDecided = true
    if (outDist <= BALL_RADIUS) {
      // コート内(ライン上含む)に収まる → 必ず打つ
      this.leaveCurrentBall = false
      return
    }
    // アウト: はみ出し量に応じて見送り確率を edge..clear で補間
    const frac = clamp(outDist / AI_LEAVE_CLEAR_MARGIN, 0, 1)
    const leaveProb = lerp(this.profile.leaveOutEdgeProb, this.profile.leaveOutClearProb, frac)
    this.leaveCurrentBall = Math.random() < leaveProb
    ctx.logDebug?.({
      kind: 'leave',
      msg: `leave-judge land=(${round2(pred.pos.x)},${round2(pred.pos.z)}) out=${round2(outDist)}m p=${round2(leaveProb)} → ${this.leaveCurrentBall ? 'LEAVE' : 'play'}`,
      data: {
        landX: round2(pred.pos.x),
        landZ: round2(pred.pos.z),
        outDist: round2(outDist),
        leaveProb: round2(leaveProb),
        leave: this.leaveCurrentBall,
      },
    })
  }

  // -------------------------------------------------------------------------
  // サーブ処理
  // -------------------------------------------------------------------------
  private updateServe(dt: number, ctx: ControlContext): void {
    if (!ctx.isServing) {
      // レシーブ側: プレイヤーのサーブ位置に応じてリターンしやすい位置へ移動する
      // (賢い AI ほど的確に。GAME_DESIGN §7.1)。
      this.positionForReturn(dt, ctx)
      return
    }
    if (this.hasServedThisPhase) return
    if (!this.serveArmed) {
      // 念のため(resetForPoint 漏れ対策)
      this.serveArmed = true
      this.serveDelayTimer = lerp(AI_SERVE_DELAY_MIN, AI_SERVE_DELAY_MAX, Math.random())
    }

    this.serveDelayTimer -= dt
    this.vel.set(0, 0, 0)
    if (this.serveDelayTimer > 0) return

    // 発射: power は profile の平均(1st/2nd)中心の正規分布、クランプ 0..1
    const meanPower = ctx.serveNumber === 1 ? this.profile.servePower1st : this.profile.servePower2nd
    // 2nd はばらつきを抑えて安全側に
    const sigma = ctx.serveNumber === 1 ? 0.08 : 0.05
    const power = clamp(meanPower + gaussian() * sigma, 0, 1)

    // aimX: ランダム寄り。時々ワイド(端)/センター狙い、それ以外は中央寄り
    let aimX: -1 | 0 | 1
    const r = Math.random()
    if (r < AI_SERVE_AIM_WIDE_PROB) {
      // ワイド or センター。サービスボックスの左右どちらか
      aimX = Math.random() < 0.5 ? -1 : 1
    } else {
      aimX = 0
    }

    // サーブ種類の決定。2nd はフォルト後なので安全な kick に上書き。
    // 1st はすでに resetForPoint で chosenServeType に入っているが、
    // serveNumber が実際に 2 になっている場合は kick に差し替える。
    const serveType: ServeType = ctx.serveNumber === 2 ? 'kick' : this.chosenServeType
    // serveMeter に反映(HUD 表示用、active は false のまま)
    this._serveMeter.serveType = serveType

    ctx.logDebug?.({
      kind: 'serve',
      msg: `serve ${serveType} pow=${power.toFixed(2)} aimX=${aimX} (${ctx.serveNumber}st)`,
      data: {
        serveType,
        power: round2(power),
        aimX,
        serveNumber: ctx.serveNumber,
        posX: round2(this.pos.x),
        posZ: round2(this.pos.z),
      },
    })
    ctx.requestServe(power, aimX, serveType)
    this.hasServedThisPhase = true
    this.serveArmed = false
    this.swingState = 'swing'
    this.swingTimer = AI_SWING_DISPLAY_TIME
    this.swingLockTimer = SWING_LOCK_TIME
    // サーブは常にフォアハンド(利き手側)とみなす
    this.swingSide = 'fore'
    this.swingKind = 'smash' // サーブは頭上のオーバーヘッドモーション
    this.lastShot = 'flat'
  }

  // -------------------------------------------------------------------------
  // レシーブ位置取り(プレイヤーのサーブ位置を読んで受けやすい場所へ)
  // テニスのセオリー: サーバーから打てる両極(ワイド/センターT)のサーブ軌道を
  // レシーバーの構え位置まで延長し、その二等分点に立つと両方に等しく備えられる。
  // returnPositioning(難易度)で、汎用の定位置からこの最適点へどれだけ寄せるかを決める。
  // -------------------------------------------------------------------------
  private positionForReturn(dt: number, ctx: ControlContext): void {
    const sign = sideSign(this.side) // -1(opponent)
    // 受けるサービスボックスは「サーバーの対角」。
    // servingFromRight(世界 +x 側)のとき、対角ボックスは -x 側(main の規約と一致)。
    const boxSign = this.servingFromRight ? -1 : 1
    const wideX = boxSign * COURT_HALF_WIDTH // ボックスのサイドライン側(ワイド)
    const tX = 0 // センターライン側(T)

    // 代表的なサーブ着地深さ(サービスライン手前)と、レシーバーの構え深さ(ベースライン後方)
    const boxZ = sign * (SERVICE_LINE_Z - 0.5)
    const rz = sign * (COURT_HALF_LENGTH + 0.3)

    const s = ctx.rival.pos // サーバー(プレイヤー)の現在位置
    // サーバー → ボックス隅 の直線を、レシーバー構え深さ rz まで延長した x を求める
    const projectX = (cornerX: number): number => {
      const dz = boxZ - s.z
      if (Math.abs(dz) < 1e-4) return cornerX
      const t = (rz - s.z) / dz
      return s.x + t * (cornerX - s.x)
    }
    const idealX = (projectX(wideX) + projectX(tX)) / 2 // 両極の二等分点

    // 汎用の定位置(下手な AI のデフォルト)。reset と同じ ±half*0.5。
    const genericX = boxSign * COURT_HALF_WIDTH * 0.5

    const skill = clamp(this.profile.returnPositioning, 0, 1)
    let targetX = lerp(genericX, idealX, skill)
    targetX = clamp(targetX, -MOVE_X_LIMIT, MOVE_X_LIMIT)

    // 目標を更新して移動(歩行で寄せる。距離が小さいのでスプリントはしない)
    this.targetPos.set(targetX, 0, rz)
    this.mode = 'intercept'
    this.moveToward(dt)
  }

  // -------------------------------------------------------------------------
  // 反応遅延の管理(相手が打った瞬間に reactionDelay をセット)
  // -------------------------------------------------------------------------
  private updateReaction(dt: number, ctx: ControlContext): void {
    const hitBy = ctx.ball.lastHitBy
    const rival = otherSide(this.side) // 'player'
    // 相手(プレイヤー)が新たに打球したことを lastHitBy の遷移で検出
    if (hitBy === rival && this.lastSeenHitBy !== rival) {
      this.reactionTimer = this.profile.reactionDelay
      this.mode = 'intercept'
      // 新しい相手打球 → 見送り判定とスタンス判断をリセット(次の判定機会で再評価)
      this.leaveDecided = false
      this.leaveCurrentBall = false
      this.stanceDecided = false
      this.chaseLogged = false
    }
    // 自分が打った直後はホームへ戻るモードへ
    if (hitBy === this.side && this.lastSeenHitBy !== this.side) {
      this.mode = 'returning'
      this.reactionTimer = 0
      this.leaveDecided = false
      this.leaveCurrentBall = false
      this.stanceDecided = false
    }
    this.lastSeenHitBy = hitBy

    if (this.reactionTimer > 0) this.reactionTimer -= dt
  }

  // -------------------------------------------------------------------------
  // 移動目標の決定
  // -------------------------------------------------------------------------
  private decideTarget(ctx: ControlContext): void {
    const sign = sideSign(this.side) // -1
    // リカバリ(ホーム)位置: 直前が net スタンス(前へ詰めた)ならベースラインまで戻らず
    // 前目の待機位置 AI_NET_READY_Z で中央に構える。深い次球が来れば intercept 時に baseline
    // スタンスへ切り替わって後退するので、毎球の「ベースライン↔ネット」往復による消耗を避ける。
    const readyDepth = this.stance === 'net' ? AI_NET_READY_Z : HOME_POS_Z
    const homeZ = sign * readyDepth

    // 反応遅延中は目標を更新しない(直前の目標へ動き続ける)
    if (this.reactionTimer > 0) return

    // 既定では到達余裕を無効化。自分側へ来る intercept のときだけ下で正値を入れる。
    this.interceptTimeAvail = -1
    let goalX = 0
    let goalZ = homeZ

    if (this.leaveCurrentBall) {
      // 見送ると決めた球は追わず、ホーム(やや前)へ戻って次に備える
      goalX = 0
      goalZ = homeZ
    } else if (this.mode === 'intercept') {
      const pred = ctx.predictLanding()
      if (pred && this.isOwnSide(pred.pos.z)) {
        // 自分側に来る予測点へ。スタンス(baseline/net)で前後の構え位置を変える。
        this.decideStance(ctx, pred)
        goalX = pred.pos.x
        goalZ = this.stanceGoalZ(pred.pos.z)
        // スプリント判断用に着地までの残り時間を保存(moveToward で参照)
        this.interceptTimeAvail = pred.time
        // 追走診断ログ(入射球ごとに1回)。ドロップ見送り等の事後分析用(?debug)。
        // 予測着地への距離・到達ETA・スタミナ・スプリント可否を残し、
        // 「届かなかったのか/見送ったのか/スタミナ切れか」を判別できるようにする。
        if (!this.chaseLogged) {
          this.chaseLogged = true
          const distToLanding = Math.hypot(pred.pos.x - this.pos.x, pred.pos.z - this.pos.z)
          const sprintSpeed = SPRINT_SPEED * this.profile.speedScale * this.mods.moveSpeedMul
          const reachEta = sprintSpeed > 0 ? distToLanding / sprintSpeed : Infinity
          const staminaPct = this.effStaminaMax > 0 ? this.stamina / this.effStaminaMax : 0
          ctx.logDebug?.({
            kind: 'note',
            msg: `chase land=(${round2(pred.pos.x)},${round2(pred.pos.z)}) ai=(${round2(this.pos.x)},${round2(this.pos.z)}) dist=${round2(distToLanding)} eta=${round2(reachEta)}s sprintMax=${round2(sprintSpeed)} stamina=${round2(staminaPct)} stance=${this.stance}`,
            data: {
              landX: round2(pred.pos.x),
              landZ: round2(pred.pos.z),
              aiX: round2(this.pos.x),
              aiZ: round2(this.pos.z),
              goalZ: round2(goalZ),
              dist: round2(distToLanding),
              reachEta: round2(reachEta),
              sprintMax: round2(sprintSpeed),
              staminaPct: round2(staminaPct),
              canSprint: this.stamina > 0,
              stance: this.stance,
            },
          })
        }
      } else if (pred && !this.isOwnSide(pred.pos.z)) {
        // 相手側に落ちる予測(=自分が打った後など)→ホームへ戻る
        this.mode = 'returning'
        goalX = 0
        goalZ = homeZ
      } else {
        // 予測なし(ネット衝突予測など)→ ホーム寄りで様子見
        goalX = 0
        goalZ = homeZ
      }
    } else {
      // returning / recover: ホームポジションへ
      goalX = 0
      goalZ = homeZ
    }

    // 可動域クランプ(AI 側は z 符号反転)
    goalX = clamp(goalX, -MOVE_X_LIMIT, MOVE_X_LIMIT)
    // z は [sign*MOVE_Z_MAX, sign*MOVE_Z_MIN] の範囲(opponent では負)
    const zLo = Math.min(sign * MOVE_Z_MIN, sign * MOVE_Z_MAX)
    const zHi = Math.max(sign * MOVE_Z_MIN, sign * MOVE_Z_MAX)
    goalZ = clamp(goalZ, zLo, zHi)

    // ヒステリシス: 小さな目標変化は無視してガクつきを抑える
    if (Math.abs(goalX - this.targetPos.x) > AI_HYSTERESIS) this.targetPos.x = goalX
    if (Math.abs(goalZ - this.targetPos.z) > AI_HYSTERESIS) this.targetPos.z = goalZ
  }

  // -------------------------------------------------------------------------
  // 戦術スタンス判断(ベースラインで打ち合う / 前へ詰めてボレー)— GAME_DESIGN §7.1
  // 既定はベースラインのラリー。短い球(チャンス)が来たときだけ前へ詰める。
  // chance(浅い球で+/速球で−)が、ペルソナ性格 netRushTendency から決まる need を超えたら net。
  // ネット型ほど need が小さく小さなチャンスでも前へ、グラインダーは実質ベースライン専。
  // -------------------------------------------------------------------------
  private decideStance(ctx: ControlContext, pred: LandingPrediction): void {
    if (this.stanceDecided) return
    this.stanceDecided = true

    // 性格: ネット型ほど前へ出やすい(= 必要チャンス need が小さい)
    const tendency = this.mods.netRushTendency

    // 局面1: 短い球(着地がネット寄り)ほど詰めの好機。深い球は負に効く(詰めにくい)。
    // shortFactor: 着地がネット際(depth 0)で +1、AI_SHORT_BALL_Z で 0、深いほど負(下限 -1)。
    const landingDepth = Math.abs(pred.pos.z) // ネットからの距離
    const shortFactor = clamp((AI_SHORT_BALL_Z - landingDepth) / AI_SHORT_BALL_Z, -1, 1)

    // 局面2: 速球は前で捌きにくい。RETURN_PACE_THRESH 超過分を 0..1 に正規化して減点。
    const pace = Math.hypot(ctx.ball.vel.x, ctx.ball.vel.y, ctx.ball.vel.z)
    const paceFactor = clamp((pace - RETURN_PACE_THRESH) / 20, 0, 1)

    // チャンス量と、性格で決まる必要チャンス need を比較。
    const chance = shortFactor - AI_NET_PACE_W * paceFactor
    const need = lerp(AI_APPROACH_NEED_MAX, AI_APPROACH_NEED_MIN, tendency)
    this.stance = chance > need ? 'net' : 'baseline'
    const score = chance - need // ログ用(>0 で net)

    ctx.logDebug?.({
      kind: 'note',
      msg: `stance ${this.stance} (score=${round2(score)} tend=${round2(tendency)} short=${round2(shortFactor)} pace=${round2(paceFactor)})`,
      data: {
        stance: this.stance,
        score: round2(score),
        tendency: round2(tendency),
        shortFactor: round2(shortFactor),
        paceFactor: round2(paceFactor),
        landingDepth: round2(landingDepth),
      },
    })
  }

  /**
   * スタンスに応じた構え深さ(目標 z)を返す。
   * - baseline: 着地点より AI_BASELINE_DROPBACK だけ深く(ネットから遠く)下がり、
   *   バウンド後の上がり際〜頂点で打つ(低いバウンド位置での弱い返球を避ける)。
   * - net: 着地点より AI_NET_ADVANCE だけ前(ネット寄り)に出て、バウンド前=空中で捉える。
   *   ネット際の下限 AI_NET_MIN_Z より前には出ない。
   * 返り値は最終的に decideTarget 側で可動域(MOVE_Z_MIN/MAX)へクランプされる。
   */
  private stanceGoalZ(landingZ: number): number {
    const sign = sideSign(this.side) // opponent => -1
    const depth = Math.abs(landingZ) // ネットからの距離
    if (this.stance === 'net') {
      const advanced = Math.max(AI_NET_MIN_Z, depth - AI_NET_ADVANCE)
      return sign * advanced
    }
    // baseline: 深い球はバウンド後さらに奥へ伸びるので後退して上がり際で打つ。
    // 短い球(ドロップ等)はバウンド後に伸びず着地点付近で失速して死ぬため、後退すると
    // 永久に届かない(BUG-002)。short の度合いで後退量を +DROPBACK→ −SHORT_FORWARD へ補間し、
    // 短い球では着地点よりやや前に出て前進で拾う。
    const shortness = clamp((AI_SHORT_BALL_Z - depth) / AI_SHORT_BALL_Z, 0, 1) // 深い=0, ネット際=1
    const offset = lerp(AI_BASELINE_DROPBACK, -AI_SHORT_FORWARD, shortness)
    const goalDepth = Math.max(AI_NET_MIN_Z, depth + offset)
    return sign * goalDepth
  }

  // -------------------------------------------------------------------------
  // 移動(加速度モデル + スプリント判断 + スタミナ)
  // -------------------------------------------------------------------------
  private moveToward(dt: number): void {
    const dx = this.targetPos.x - this.pos.x
    const dz = this.targetPos.z - this.pos.z
    const dist = Math.hypot(dx, dz)

    if (dist < AI_ARRIVE_EPS) {
      // 到達: 減速して停止
      this.vel.multiplyScalar(Math.max(0, 1 - MOVE_ACCEL * dt / Math.max(WALK_SPEED, 0.001)))
      if (this.vel.lengthSq() < 0.01) this.vel.set(0, 0, 0)
      this.sprinting = false
      this.integrate(dt)
      return
    }

    // スプリント判断: 「歩行では間に合わない」ときだけ走る(体力温存)。
    // 歩行速度はペルソナ補正込みの実速度を使う(素の WALK_SPEED だと足の速い
    // スピードスターも遅い選手と同頻度でスプリントを焚いてしまい、燃費で損をする)。
    let wantSprint = false
    if (this.mode === 'intercept') {
      const effWalkSpeed = WALK_SPEED * this.profile.speedScale * this.mods.moveSpeedMul
      const walkTime = effWalkSpeed > 0 ? dist / effWalkSpeed : Infinity
      if (this.interceptTimeAvail >= 0) {
        // 到達余裕ベース: ボール着地までの残り時間内に歩いて間に合うなら走らない。
        // 余裕があっても遠ければ走っていた旧判定(距離のみ)を是正し、無駄なスプリントを削減。
        wantSprint = walkTime > this.interceptTimeAvail - AI_SPRINT_TIME_MARGIN
      } else {
        // 着地予測が無い場合のフォールバック(従来の距離ベース)。
        wantSprint = walkTime > 0.45
      }
    }
    // スタミナ 0 ならスプリント不可
    if (this.stamina <= 0) wantSprint = false
    this.sprinting = wantSprint

    // スイングロック中は移動速度を SWING_LOCK_MOVE_FACTOR 倍に低下(プレイヤーと同じ挙動)
    const lockFactor = this.swingLockTimer > 0 ? SWING_LOCK_MOVE_FACTOR : 1.0
    // 最高速にペルソナ倍率 moveSpeedMul を乗算(difficulty の speedScale とは独立)
    const maxSpeed =
      (wantSprint ? SPRINT_SPEED : WALK_SPEED) * this.profile.speedScale * this.mods.moveSpeedMul * lockFactor

    // 目標方向への速度を加速度モデルで近づける
    const dirX = dx / dist
    const dirZ = dz / dist
    const desiredVx = dirX * maxSpeed
    const desiredVz = dirZ * maxSpeed

    const accel = MOVE_ACCEL * dt
    this.vel.x = approach(this.vel.x, desiredVx, accel)
    this.vel.z = approach(this.vel.z, desiredVz, accel)

    // 最高速クランプ
    const sp = Math.hypot(this.vel.x, this.vel.z)
    if (sp > maxSpeed) {
      const k = maxSpeed / sp
      this.vel.x *= k
      this.vel.z *= k
    }

    this.integrate(dt)
    // スタミナは update() で一括して加算モデル(updateStamina)で更新する。
  }

  /** 位置積分 + 可動域クランプ */
  private integrate(dt: number): void {
    const sign = sideSign(this.side)
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt
    this.pos.x = clamp(this.pos.x, -MOVE_X_LIMIT, MOVE_X_LIMIT)
    const zLo = Math.min(sign * MOVE_Z_MIN, sign * MOVE_Z_MAX)
    const zHi = Math.max(sign * MOVE_Z_MIN, sign * MOVE_Z_MAX)
    this.pos.z = clamp(this.pos.z, zLo, zHi)
    this.pos.y = 0
  }

  /**
   * 消費倍率 driveMul を返す(IMPROVEMENTS §5.2/5.5)。
   * driveMul = staminaDrainMul · (1 + (pressureDrainMul − 1)·pressure)
   */
  private driveMul(pressure: number): number {
    const p = clamp(pressure, 0, 1)
    return this.mods.staminaDrainMul * (1 + (this.mods.pressureDrainMul - 1) * p)
  }

  /**
   * 加算モデルのスタミナ更新(IMPROVEMENTS §5.2 / ARCHITECTURE §6.5)。
   * dStamina/dt = +STAMINA_REGEN_IDLE·staminaRegenMul·clutchRecoveryMul
   *             − (STAMINA_MOVE_DRAIN_K·speed + STAMINA_SPRINT_EXTRA·[sprinting])·driveMul·moveEconomyMul
   * speed = 現在の水平速度の大きさ。clamp は [0, effStaminaMax]。
   * moveEconomyMul はスピード由来の移動燃費(打球コストには掛けない。STAMINA_MOVE_ECONOMY_K で調整)。
   */
  private updateStamina(dt: number, sprinting: boolean, pressure: number): void {
    const speed = Math.hypot(this.vel.x, this.vel.z)
    const drive = this.driveMul(pressure)
    const regen = STAMINA_REGEN_IDLE * this.mods.staminaRegenMul * this.mods.clutchRecoveryMul
    const drain =
      (STAMINA_MOVE_DRAIN_K * speed + (sprinting ? STAMINA_SPRINT_EXTRA : 0)) *
      drive *
      moveEconomyMul(this.mods.moveSpeedMul)
    this.stamina = clamp(this.stamina + (regen - drain) * dt, 0, this.effStaminaMax)
  }

  // -------------------------------------------------------------------------
  // 打球判定とショット選択
  // -------------------------------------------------------------------------
  private tryHit(ctx: ControlContext): void {
    if (!ctx.ball.inPlay) return
    // 自分が最後に打っていないこと(相手の打球を返す)
    if (ctx.ball.lastHitBy === this.side) return
    // アウトと判断して見送ると決めた球は打たない(GAME_DESIGN §7.1)
    if (this.leaveCurrentBall) return
    // 空振り硬直中(whiff)は打てない
    if (this.swingState === 'whiff') return

    const bpos = ctx.ball.pos
    // 自分側に来ているボールのみ対象
    if (!this.isOwnSide(bpos.z)) return

    // 水平距離・高さチェック(リーチはペルソナ補正済みの effReach)
    const hdist = Math.hypot(bpos.x - this.pos.x, bpos.z - this.pos.z)
    if (hdist > this.effReach || bpos.y > REACH_HEIGHT) return

    // 最接近を待ってから打つ(品質は距離で決まるため、リーチに入った瞬間に
    // 振ると常に最低品質になる)。十分近い(SWEET_DIST 以内)なら即打ち、
    // そうでなければボールが自分から遠ざかり始めた時点(=最接近通過)で打つ。
    const relX = bpos.x - this.pos.x
    const relZ = bpos.z - this.pos.z
    const receding = relX * ctx.ball.vel.x + relZ * ctx.ball.vel.z > 0
    if (hdist > SWEET_DIST && !receding) return

    const quality = this.computeQuality(hdist, ctx)
    const req = this.chooseShot(ctx, quality)
    ctx.logDebug?.({
      kind: 'shot',
      msg: `shot ${req.type} q=${round2(quality)} tgt=(${round2(req.target.x)},${round2(req.target.z)}) vIn=${round2(req.incomingSpeed)}`,
      data: {
        type: req.type,
        quality: round2(quality),
        targetX: round2(req.target.x),
        targetZ: round2(req.target.z),
        incomingSpeed: round2(req.incomingSpeed),
        hitX: round2(ctx.ball.pos.x),
        hitZ: round2(ctx.ball.pos.z),
        hitY: round2(ctx.ball.pos.y),
        stance: this.stance,
        blunder: this.blunderThisPoint,
      },
    })
    ctx.requestShot(req)

    // 打球時のスタミナ消費(インパクト時に1回。IMPROVEMENTS §5.3)。
    // スマッシュ判定は shot.ts と同条件: flat かつ 打点高 ≥ SMASH_MIN_HEIGHT かつ
    // ネットからの距離 |hitPos.z| ≤ SMASH_MAX_DEPTH。
    // AI はチャージ演出がないため charge は 0 を渡す。
    const isSmash =
      req.type === 'flat' &&
      bpos.y >= SMASH_MIN_HEIGHT &&
      Math.abs(bpos.z) <= SMASH_MAX_DEPTH
    const cost = shotStaminaCost(req.type, 0, isSmash) * this.driveMul(ctx.pressure)
    this.stamina = Math.max(0, this.stamina - cost)

    this.lastShot = req.type

    // スイングサイドを決定(演出のみ)。opponent は奥側(z<0)で +z を向き、右利きの
    // 利き手側は世界 −x 方向。player 側(z>0 で −z を向く)は向きが反転するので sign で補正。
    // 打点ボールが利き手側にあれば 'fore'、逆なら 'back'。左利きは反転。
    const handLeftIsWorldNegX = sideSign(this.side) < 0 // opponent のとき true
    const ballOnHandSide =
      bpos.x < this.pos.x === handLeftIsWorldNegX
    const foreSide = this.physique.handedness === 'left' ? !ballOnHandSide : ballOnHandSide
    this.swingSide = foreSide ? 'fore' : 'back'
    // 高い打点はオーバーヘッド(スマッシュ)モーション
    this.swingKind = bpos.y >= SMASH_MOTION_HEIGHT ? 'smash' : 'normal'

    this.swingState = 'swing'
    this.swingTimer = AI_SWING_DISPLAY_TIME

    // スイングロック開始(打球瞬間から SWING_LOCK_TIME 秒間、移動を大幅制限)
    this.swingLockTimer = SWING_LOCK_TIME

    // 打球したのでホームへ戻るモードへ(次フレームで lastHitBy 遷移検出もする)
    this.mode = 'returning'
  }

  /** 品質計算(GAME_DESIGN §4.2)。プレイヤーと同一式 + モメンタム/プレッシャー + 凡ミス */
  private computeQuality(hdist: number, ctx: ControlContext): number {
    // 距離係数: SWEET_DIST 以内で 1.0、effReach で QUALITY_MIN へ線形
    // (REACH 上限はペルソナ補正済みの effReach を使う)
    const reach = this.effReach
    let distFactor: number
    if (hdist <= SWEET_DIST) {
      distFactor = 1.0
    } else if (hdist >= reach) {
      distFactor = QUALITY_MIN
    } else {
      const t = (hdist - SWEET_DIST) / (reach - SWEET_DIST)
      distFactor = lerp(1.0, QUALITY_MIN, t)
    }

    // スタミナ係数: 閾値以上で 1.0、0 で floor へ線形。
    // 低下閾値は有効上限 effStaminaMax に比例させる(中立倍率では従来と同一)。
    const lowThreshold = STAMINA_LOW_THRESHOLD * this.mods.staminaMaxMul
    let staminaFactor: number
    if (this.stamina >= lowThreshold) {
      staminaFactor = 1.0
    } else {
      const t = this.stamina / lowThreshold
      staminaFactor = lerp(STAMINA_QUALITY_FLOOR, 1.0, t)
    }

    let q = distFactor * staminaFactor
    if (this.sprinting) q -= SPRINT_SHOT_PENALTY
    // モメンタム/プレッシャー(既存要素 → momentum → pressure → クランプ)。
    // q *= 1 + MOMENTUM_QUALITY_K·momentum(連続得点 + で微増、連続失点 − で微減)。
    // q *= 1 − PRESSURE_CHOKE_K·(pressureDrainMul − 1)·pressure
    // (低 mental は重圧で choke、高 mental は clutch。中立 mental では影響なし)。
    q *= 1 + MOMENTUM_QUALITY_K * ctx.momentum
    q *= 1 - PRESSURE_CHOKE_K * (this.mods.pressureDrainMul - 1) * ctx.pressure
    q = clamp(q, QUALITY_MIN, 1.0)

    // 凡ミス: このポイントで抽選済みなら大幅低下(0.4 倍程度)
    if (this.blunderThisPoint) {
      q = clamp(q * AI_BLUNDER_QUALITY, QUALITY_MIN, 1.0)
    }
    return q
  }

  // -------------------------------------------------------------------------
  // ショット選択(重み評価)— GAME_DESIGN §7.1
  // (shot × コース候補)を評価して最大スコアを選ぶ
  // -------------------------------------------------------------------------
  private chooseShot(ctx: ControlContext, quality: number): ShotRequest {
    const rivalView = ctx.rival // プレイヤー
    const mySign = sideSign(this.side) // -1
    const rivalSign = sideSign(otherSide(this.side)) // +1(プレイヤー側)
    const rivalPos = rivalView.pos

    // 打点の高さとレバレッジ(ARCHITECTURE §6.1)
    const h = ctx.ball.pos.y
    const lev = clamp((h - CONTACT_PIVOT_HEIGHT) / CONTACT_PIVOT_HEIGHT, -1, 1)
    const low  = Math.max(0, -lev)  // 低い打点の度合い(0..1)
    const high = Math.max(0, +lev)  // 高い打点の度合い(0..1)

    // ネットからの距離(自分の z 座標の絶対値)
    const depth = Math.abs(this.pos.z)

    // スマッシュ条件(高打点 × 前寄り × flat)—GAME_DESIGN §4.5
    const smashCondition = h >= SMASH_MIN_HEIGHT && depth <= SMASH_MAX_DEPTH

    // 相手の前後位置: ネットからの距離(|z|)で判定する(相手は常に自陣側 = rivalSign 側に
    // いるので side 非依存になる)。ネット寄り(|z|小)なら「前」、深い(|z|大)なら「後ろ」。
    // 注: かつて rivalZ を直接 frontThreshold と比較していたが、それは相手が +z 前提で、
    // player 側 AI から見た相手(z<0)では常に「前」と誤判定し、ロブを乱発していた。
    const rivalDistFromNet = Math.abs(rivalPos.z)
    const rivalIsForward = rivalDistFromNet < frontThreshold() // ネット〜サービスライン付近以前
    const rivalIsDeep = rivalDistFromNet > COURT_HALF_LENGTH - 1.5 // ベースライン付近

    // 自分の走らされ度: 速度の大きさ(と残り反応的余裕)。速いほど安全策。
    const mySpeed = Math.hypot(this.vel.x, this.vel.z)
    const stretched = clamp(mySpeed / SPRINT_SPEED, 0, 1) // 0..1

    // 高打点トップスピン時の横オフセット拡大(ARCHITECTURE §6.1、コントローラ側の処理)
    // 拡大後の ±xOffset を x 候補として使い、相手コート内にクランプする
    const highTopspin = high > 0
    const expandedOffset = AIM_OFFSET_X * (1 + HIGH_TOPSPIN_ANGLE_BONUS * high)

    // コース候補(x オフセット): ライン際左右・中央。z は深め/浅め。
    const xCandidates = [-AIM_OFFSET_X, 0, AIM_OFFSET_X]
    const xCandidatesTopspin = highTopspin
      ? [-expandedOffset, 0, expandedOffset]  // 高打点トップスピン用の広い候補
      : xCandidates
    const zCandidates: Array<{ dz: number; label: 'deep' | 'mid' | 'short' }> = [
      { dz: -AIM_OFFSET_Z, label: 'short' }, // 浅く(ネット寄り)
      { dz: 0, label: 'mid' },
      { dz: AIM_OFFSET_Z, label: 'deep' }, // 深く(ベースライン寄り)
    ]
    const shotTypes: ShotType[] = ['flat', 'topspin', 'slice', 'lob', 'drop']

    // 打球直前のボール速度の大きさ(incomingSpeed)。
    // ショット選択(evaluateShot)と ShotRequest の両方で使うためここで計算。
    const incomingSpeed = Math.hypot(ctx.ball.vel.x, ctx.ball.vel.y, ctx.ball.vel.z)

    let best: { score: number; type: ShotType; targetX: number; targetZ: number } | null = null

    for (const type of shotTypes) {
      const param = SHOT_PARAMS[type]
      // 基準ターゲット深さ: 相手(プレイヤー)ベースラインからの手前距離
      // プレイヤーベースラインは z = +COURT_HALF_LENGTH。手前(ネット側)へ baseDepth。
      const baseZ = rivalSign * COURT_HALF_LENGTH - rivalSign * param.baseDepthFromBaseline

      // トップスピンのとき、高打点なら広い x 候補を使う
      const usedXCandidates = type === 'topspin' ? xCandidatesTopspin : xCandidates

      for (const xc of usedXCandidates) {
        for (const zc of zCandidates) {
          // x は常に相手コート内にクランプ(拡大後オフセットでもライン内に収める)
          const targetX = clamp(xc, -COURT_HALF_WIDTH + TARGET_CLAMP_MARGIN, COURT_HALF_WIDTH - TARGET_CLAMP_MARGIN)
          const targetZ = baseZ + rivalSign * zc.dz

          const score = this.evaluateShot(type, targetX, targetZ, {
            rivalPos,
            rivalIsForward,
            rivalIsDeep,
            stretched,
            low,
            smashCondition,
            incomingSpeed,
          })

          if (!best || score > best.score) {
            best = { score, type, targetX, targetZ }
          }
        }
      }
    }

    // best は必ず非 null(候補が存在)
    const chosen = best as { score: number; type: ShotType; targetX: number; targetZ: number }

    // ターゲットに extraAimNoise を加算誤差として乗せる
    let tx = chosen.targetX + (Math.random() * 2 - 1) * this.profile.extraAimNoise
    let tz = chosen.targetZ + (Math.random() * 2 - 1) * this.profile.extraAimNoise

    // リスク管理(GAME_DESIGN §4.2 の意図): ソルバ側で乗る品質ノイズ
    // (1-q)·AIM_NOISE_R と自身の狙い誤差の期待値ぶんだけライン内側へ寄せる。
    // 強気な AI(aggressiveness 高)ほどマージンを薄くしてライン際のリスクを残す。
    const expectedNoise =
      (1 - quality) * AIM_NOISE_R * 0.85 + this.profile.extraAimNoise * 0.6
    const riskMargin =
      TARGET_CLAMP_MARGIN + expectedNoise * (1 - 0.45 * this.profile.aggressiveness)

    // 相手コート内にクランプ(マージン込み)。相手コートは rivalSign 側(opponent AI なら z>0、
    // player 側 AI なら z<0)。z は符号付きで [ネット際, 相手ベースライン手前] に収める。
    tx = clamp(tx, -COURT_HALF_WIDTH + riskMargin, COURT_HALF_WIDTH - riskMargin)
    const tzNear = rivalSign * TARGET_CLAMP_MARGIN // ネット際
    const tzFar = rivalSign * (COURT_HALF_LENGTH - riskMargin) // 相手ベースライン手前
    tz = clamp(tz, Math.min(tzNear, tzFar), Math.max(tzNear, tzFar))

    // チャージ量の決定: 体勢ベース。余裕があるほど高チャージ、走らされているほど低チャージ。
    // 低い打点では強打(高チャージ)を避ける(GAME_DESIGN §4.5: 低打点の無理打ちは自滅)。
    // AI はオーバーチャージ(>1)しないため clamp 上限は 1.0。
    const chargeBase = 0.3 + 0.7 * quality * (1 - stretched) * (0.6 + 0.4 * this.profile.aggressiveness)
    // 低打点ペナルティ: low が 1 のとき最大 0.4 下げる(高チャージ抑制)
    const lowChargeReducer = low * 0.4
    const charge = clamp(chargeBase - lowChargeReducer, 0, 1.0)

    return {
      type: chosen.type,
      hitter: this.side,
      hitPos: new Vector3(ctx.ball.pos.x, ctx.ball.pos.y, ctx.ball.pos.z),
      target: new Vector3(tx, 0, tz),
      quality,
      charge,
      incomingSpeed,
      // 自分のペルソナ倍率を添付(ソルバが初速・狙い等に乗算)
      mods: this.mods,
    }
  }

  /** 個別ショット候補のスコアリング(重み合算 + ノイズ) */
  private evaluateShot(
    type: ShotType,
    targetX: number,
    targetZ: number,
    ctxInfo: {
      rivalPos: Readonly<Vector3>
      rivalIsForward: boolean
      rivalIsDeep: boolean
      stretched: number
      /** 低い打点の度合い(0..1)。高いほど強打を避ける */
      low: number
      /** スマッシュ条件(高打点 × 前寄り)が成立しているか */
      smashCondition: boolean
      /** 打球直前のボール速度の大きさ(m/s)。速球への対応選択に使う */
      incomingSpeed: number
    },
  ): number {
    const { rivalPos, rivalIsForward, rivalIsDeep, stretched, low, smashCondition, incomingSpeed } = ctxInfo
    const aggr = this.profile.aggressiveness

    let score = 0

    // --- オープンコート項: 相手位置から x が遠いほど高評価 ---
    const openX = Math.abs(targetX - rivalPos.x) // 0..~8
    score += openX * 0.9

    // 相手の逆を突く: 相手の現在の移動方向と逆サイドはさらに加点(横速度から推定)
    // rivalPos には速度がないためここでは x 距離のみで近似(decisions に記録)

    // --- 体勢項: 走らされているほど安全ショットを高評価、危険ショットを減点 ---
    const safe = type === 'topspin' || type === 'slice' || type === 'lob'
    const risky = type === 'flat' || type === 'drop'
    if (safe) score += stretched * 2.2
    if (risky) score -= stretched * 2.6

    // --- スマッシュ機会項: 高打点 × 前寄りのとき flat を大幅加点(叩く) ---
    // GAME_DESIGN §4.5: 高く弾む球や短いロブを前で仕留める決め球
    if (smashCondition && type === 'flat') {
      score += 6.0 + aggr * 2.0 // 他のどのショットよりも高くなるよう大きく加点
    }

    // --- 低打点での強打ペナルティ ---
    // GAME_DESIGN §4.5: 低打点でのパワーはアウト/ネットになりやすい
    // low > 0 のとき flat/drop(risky)にペナルティを加算してリスクを回避
    if (type === 'flat') score -= low * 2.5
    if (type === 'drop') score -= low * 1.0

    // --- 相手前後位置項 ---
    if (rivalIsForward) {
      // 相手が前: ロブで頭上を抜く / サイド強打(フラットの大角度)
      if (type === 'lob') score += 2.6
      if (type === 'flat') score += 1.2 + openX * 0.3 // パッシング
      if (type === 'drop') score -= 2.0 // 前にいる相手にドロップは無意味
    } else if (rivalIsDeep) {
      // 相手が深い: ドロップで前へ走らせる
      if (type === 'drop') score += 2.4
      if (type === 'lob') score -= 1.5
    } else {
      // 中間: 標準ラリー。トップスピンを基軸に。
      if (type === 'topspin') score += 0.8
    }

    // --- tendency 項(aggressiveness): フラット/ライン際の重み増 ---
    if (type === 'flat') score += aggr * 1.8
    // ライン際(x が端に近い)は強気度に応じて加点
    const edgeness = Math.abs(targetX) / COURT_HALF_WIDTH // 0..1
    score += edgeness * aggr * 1.5
    // 深いターゲットも攻撃的: ベースライン際
    const depthness = Math.abs(targetZ) / COURT_HALF_LENGTH
    score += depthness * aggr * 0.6

    // ドロップは消極側がやや使う(aggr が低いと相対的に上げない)。基本は前後項で制御。

    // --- 速球の返球(GAME_DESIGN §4.6 / ARCHITECTURE §6.2): 速いボールが来るほど
    // スライス(ブロック)を選びやすくし、topspin/flat は差し込まれリスクがあるため減点。
    // stretched(走らされ度合い)が大きいほど体勢が崩れているので効果を強める。
    // 通常ラリーの球速(≤ RETURN_PACE_THRESH ≈ 26 m/s)では影響なし。 ---
    const paceExcess = Math.max(0, incomingSpeed - RETURN_PACE_THRESH)
    if (paceExcess > 0) {
      // 速球超過を 0..1 に正規化(RETURN_OVERWHELM_RANGE=22 を参照; AI 評価では
      // 超過量をそのまま重みのスケールとして使い、飽和を避けるため /30 で正規化)
      const paceRatio = Math.min(paceExcess / 30, 1.0)
      // 体勢が悪い(stretched大)ほどスライスの優先度をさらに上げる
      const bodyFactor = 1.0 + stretched * 0.8
      if (type === 'slice') {
        // スライス/ブロックは速球に最も強い → 加点
        score += paceRatio * bodyFactor * 2.5
      } else if (type === 'topspin') {
        // トップスピンは速球に最も弱い → 減点
        score -= paceRatio * bodyFactor * 2.0
      } else if (type === 'flat') {
        // フラットは中間。タイミングがシビアなので体勢が悪い時は減点
        score -= paceRatio * stretched * 1.2
      }
    }

    // --- ペルソナ別ショット嗜好(IMPROVEMENTS §4中 / GAME_DESIGN §7.1) ---
    // 難易度=上手さ、ペルソナ=好み、の分離を保つ控えめな加点。
    // 各係数の「中立からのずれ」だけを使うため、中立(全mul=1.0)では全て0になる。

    // 技巧型 (touchNoiseMul < 1.0): finesse 由来の noiseMul が低いほど技巧高い。
    // drop/lob/鋭角(|targetX| が大きい=ライン際への角度)を好む。
    const finesseBonus = Math.max(0, 1.0 - this.mods.touchNoiseMul) // 中立1.0→0、最高finesse→0.36
    if (type === 'drop') score += finesseBonus * PERSONA_FINESSE_W
    if (type === 'lob') score += finesseBonus * PERSONA_FINESSE_W * 0.7
    // 鋭角アングル: edgeness はすでに上で計算済み(const edgeness = ...)
    score += edgeness * finesseBonus * PERSONA_FINESSE_W * 0.5

    // スピン/安定型 (aimNoiseMul < 1.0): spin 由来の noiseMul が低いほどスピン/安定高い。
    // topspin を好む(深く粘る)。
    const spinBonus = Math.max(0, 1.0 - this.mods.aimNoiseMul) // 中立1.0→0、最高spin→0.36
    if (type === 'topspin') score += spinBonus * PERSONA_SPIN_W

    // パワー型 (shotSpeedMul > 1.0): power 由来の speedMul が高いほどパワー高い。
    // flat を好む(攻撃的)。
    const powerBonus = Math.max(0, this.mods.shotSpeedMul - 1.0) // 中立1.0→0、最高power→0.135
    if (type === 'flat') score += powerBonus * PERSONA_POWER_W

    // ネット志向型 (netRushTendency > PERSONA_NETRUSH_NEUTRAL): 前寄り時に flat/決め球に加点。
    // 既存のネットラッシュ戦術(decideStance)と整合し、二重に強くしすぎない控えめな加点。
    const rushBonus = Math.max(0, this.mods.netRushTendency - PERSONA_NETRUSH_NEUTRAL) // 中立0.3→0
    // 自分が前寄りかどうかはここでは depth(自分の z)で判断する(chooseShot 内と同じ変数群から取れないため
    // ctxInfo を使わず evaluateShot の引数内で推定: smashCondition は前寄り×高打点で成立するので
    // 「前寄りかつスマッシュ以外」のボレー的状況も考慮したいが、ここでは smashCondition と stretched の
    // 組み合わせで近似する)。smashCondition=true はスマッシュ大加点が別途乗るため重複を避けて除外。
    if (!smashCondition && type === 'flat') {
      // 前寄り状況で flat/ボレー気味の決め球を選びたがる
      score += rushBonus * PERSONA_NETRUSH_W * (1.0 - stretched)
    }

    // --- ノイズ ---
    score += (Math.random() * 2 - 1) * 1.0

    return score
  }

  /** 与えられた z が自分(opponent)側コートか */
  private isOwnSide(z: number): boolean {
    return sideSign(this.side) > 0 ? z >= 0 : z <= 0
  }
}

// ---------------------------------------------------------------------------
// 補助: 値を目標へ最大ステップで近づける
// ---------------------------------------------------------------------------
function approach(cur: number, target: number, maxStep: number): number {
  const d = target - cur
  if (Math.abs(d) <= maxStep) return target
  return cur + Math.sign(d) * maxStep
}
