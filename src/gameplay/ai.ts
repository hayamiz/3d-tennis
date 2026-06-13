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
  PlayerView,
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
  AI_SERVE_DELAY_MAX,
  AI_SERVE_DELAY_MIN,
  CONTACT_PIVOT_HEIGHT,
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  HIGH_TOPSPIN_ANGLE_BONUS,
  HOME_POS_Z,
  MOVE_ACCEL,
  MOVE_X_LIMIT,
  MOVE_Z_MAX,
  MOVE_Z_MIN,
  QUALITY_MIN,
  REACH,
  REACH_HEIGHT,
  SERVE_X_MARGIN_CENTER,
  SERVICE_LINE_Z,
  SHOT_PARAMS,
  SMASH_MAX_DEPTH,
  SMASH_MIN_HEIGHT,
  SPRINT_SHOT_PENALTY,
  SPRINT_SPEED,
  STAMINA_LOW_THRESHOLD,
  STAMINA_MAX,
  STAMINA_QUALITY_FLOOR,
  STAMINA_REGEN,
  STAMINA_SPRINT_DRAIN,
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
const AI_BLUNDER_QUALITY = 0.4 // 凡ミス時に品質に乗算する係数
const AI_SERVE_AIM_WIDE_PROB = 0.55 // サーブでワイド/センター(端)を狙う確率
/** スイング演出の表示時間(秒) */
const AI_SWING_DISPLAY_TIME = 0.3

// 相手が「前」と判断する z 閾値(プレイヤー側コートでネット〜サービスライン付近)。
// プレイヤーコートは z>0 なので SERVICE_LINE_Z を境界に使う。
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

// ---------------------------------------------------------------------------
// AIController
// ---------------------------------------------------------------------------

export class AIController implements Controller {
  readonly side: Side = 'opponent'
  private readonly profile: AIProfile

  // 物理状態
  private readonly pos = new Vector3(0, 0, -HOME_POS_Z)
  private readonly vel = new Vector3(0, 0, 0)
  private stamina = STAMINA_MAX
  private sprinting = false
  private swingState: SwingState = 'idle'
  private lastShot: ShotType | null = null
  private swingTimer = 0 // スイング/空振り演出の残り時間
  /** 打球時に設定するフォア/バック種別(表示用) */
  private swingSide: 'fore' | 'back' | null = null
  /** スイングロック残り時間(SWING_LOCK_TIME 秒間は移動速度を低下) */
  private swingLockTimer = 0

  // 行動状態
  private mode: AiMode = 'returning'
  private readonly targetPos = new Vector3(0, 0, -HOME_POS_Z) // 現在の移動目標
  private reactionTimer = 0 // 相手打球後の反応遅延の残り時間
  private lastSeenHitBy: Side | null = null // 直近に観測した lastHitBy(打球検出用)
  private blunderThisPoint = false // このポイントで凡ミスするか

  // サーブ状態
  private serveDelayTimer = 0
  private serveArmed = false // サーブ待機中(遅延カウント中)か
  private hasServedThisPhase = false

  // ビュー(参照は固定。中身を更新する)
  private readonly _view: PlayerView
  private readonly _serveMeter: ServeMeterView = { active: false, value: 0 }

  constructor(profile: AIProfile) {
    this.profile = profile
    this._view = {
      side: 'opponent',
      pos: this.pos,
      vel: this.vel,
      stamina: this.stamina,
      sprinting: this.sprinting,
      swing: this.swingState,
      lastShot: this.lastShot,
      // AI はチャージ演出なし: 常に false / 0 / null
      charging: false,
      charge: 0,
      swingSide: null,
    }
  }

  get view(): PlayerView {
    // 値型フィールドはビューに同期
    this._view.stamina = this.stamina
    this._view.sprinting = this.sprinting
    this._view.swing = this.swingState
    this._view.lastShot = this.lastShot
    // AI はチャージなし。swingSide はスイング中のみセット、終了後 null
    this._view.charging = false
    this._view.charge = 0
    this._view.swingSide = this.swingState === 'swing' ? this.swingSide : null
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

    // サーブ位置はポイント合計の偶奇で決まるが、ここでは serveFromRight を
    // サーバー視点の左右として受け取る。AI(奥側)から見た右はプレイヤーの左。
    // x の配置: デュースサイド(right)は自陣から見て右側、アドサイドは左側。
    // 受け手も対角に構える。プレイヤー視点座標(x)へ写像する。
    let placeX: number
    let placeZ: number

    if (amServing) {
      // サーバーはベースライン後方の対応サイドへ。
      // serveFromRight = サーバー視点の右。opponent のサーバー視点右は x>0 側。
      // サーブサイド半面内 [SERVE_X_MARGIN_CENTER, COURT_HALF_WIDTH] でランダムに配置。
      // ワイド寄り/センター寄りを時々変えることで配球の駆け引きを演出する。
      const xSign = serveFromRight ? 1 : -1
      const xRand = SERVE_X_MARGIN_CENTER + Math.random() * (COURT_HALF_WIDTH - SERVE_X_MARGIN_CENTER)
      placeX = xSign * xRand
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
    this.swingState = 'idle'
    this.swingTimer = 0
    this.swingLockTimer = 0
    this.swingSide = null
    this.reactionTimer = 0
    this.lastSeenHitBy = null

    // 凡ミスをこのポイントで起こすか抽選
    this.blunderThisPoint = Math.random() < this.profile.blunderRate

    // サーブ準備
    this.hasServedThisPhase = false
    if (amServing) {
      this.serveArmed = true
      this.serveDelayTimer = lerp(AI_SERVE_DELAY_MIN, AI_SERVE_DELAY_MAX, Math.random())
    } else {
      this.serveArmed = false
      this.serveDelayTimer = 0
    }
  }

  /** ゲーム間のスタミナ全回復(GAME_DESIGN §6) */
  recoverFullStamina(): void {
    this.stamina = STAMINA_MAX
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
      // サーブ前は定位置で待機(移動しない)
      this.applyStaminaIdle(dt)
      return
    }

    if (ctx.phase !== 'rally') {
      // pointOver / menu / matchOver 中は静止し回復のみ
      this.vel.set(0, 0, 0)
      this.applyStaminaIdle(dt)
      return
    }

    // --- rally 中 ---
    this.updateReaction(dt, ctx)
    this.decideTarget(ctx)
    this.moveToward(dt)
    this.tryHit(ctx)
  }

  // -------------------------------------------------------------------------
  // サーブ処理
  // -------------------------------------------------------------------------
  private updateServe(dt: number, ctx: ControlContext): void {
    if (!ctx.isServing) {
      // 自分がサーバーでない(レシーブ側)。定位置で待つ。
      this.vel.set(0, 0, 0)
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

    ctx.requestServe(power, aimX)
    this.hasServedThisPhase = true
    this.serveArmed = false
    this.swingState = 'swing'
    this.swingTimer = AI_SWING_DISPLAY_TIME
    this.swingLockTimer = SWING_LOCK_TIME
    // サーブは常にフォアハンド(利き手側)とみなす
    this.swingSide = 'fore'
    this.lastShot = 'flat'
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
    }
    // 自分が打った直後はホームへ戻るモードへ
    if (hitBy === this.side && this.lastSeenHitBy !== this.side) {
      this.mode = 'returning'
      this.reactionTimer = 0
    }
    this.lastSeenHitBy = hitBy

    if (this.reactionTimer > 0) this.reactionTimer -= dt
  }

  // -------------------------------------------------------------------------
  // 移動目標の決定
  // -------------------------------------------------------------------------
  private decideTarget(ctx: ControlContext): void {
    const sign = sideSign(this.side) // -1
    const homeZ = sign * HOME_POS_Z

    // 反応遅延中は目標を更新しない(直前の目標へ動き続ける)
    if (this.reactionTimer > 0) return

    let goalX = 0
    let goalZ = homeZ

    if (this.mode === 'intercept') {
      const pred = ctx.predictLanding()
      if (pred && this.isOwnSide(pred.pos.z)) {
        // 自分側に来る予測点へ。前後は予測点の少し後方に構える
        goalX = pred.pos.x
        // 着地点で待つが、深さは可動域内にクランプ
        goalZ = pred.pos.z
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
      this.applyStaminaIdle(dt)
      return
    }

    // スプリント判断: 「歩行では間に合わない」と判断したときのみ。
    // 反応遅延後の intercept で、残り時間に対して距離が大きい場合にスプリント。
    let wantSprint = false
    if (this.mode === 'intercept') {
      // 歩行で到達に要する時間と、ボール着地までの余裕を比較したいが、
      // ここでは距離が WALK で 0.45 秒以上かかる遠さなら走る、という簡易判定。
      const walkTime = dist / WALK_SPEED
      if (walkTime > 0.45) wantSprint = true
    }
    // スタミナ 0 ならスプリント不可
    if (this.stamina <= 0) wantSprint = false
    this.sprinting = wantSprint

    // スイングロック中は移動速度を SWING_LOCK_MOVE_FACTOR 倍に低下(プレイヤーと同じ挙動)
    const lockFactor = this.swingLockTimer > 0 ? SWING_LOCK_MOVE_FACTOR : 1.0
    const maxSpeed = (wantSprint ? SPRINT_SPEED : WALK_SPEED) * this.profile.speedScale * lockFactor

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

    // スタミナ更新
    if (wantSprint) {
      this.stamina = clamp(this.stamina - STAMINA_SPRINT_DRAIN * dt, 0, STAMINA_MAX)
    } else {
      this.stamina = clamp(this.stamina + STAMINA_REGEN * dt, 0, STAMINA_MAX)
    }
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

  /** 非スプリント時のスタミナ回復のみ(静止フレーム用) */
  private applyStaminaIdle(dt: number): void {
    this.stamina = clamp(this.stamina + STAMINA_REGEN * dt, 0, STAMINA_MAX)
    this.sprinting = false
  }

  // -------------------------------------------------------------------------
  // 打球判定とショット選択
  // -------------------------------------------------------------------------
  private tryHit(ctx: ControlContext): void {
    if (!ctx.ball.inPlay) return
    // 自分が最後に打っていないこと(相手の打球を返す)
    if (ctx.ball.lastHitBy === this.side) return
    // 空振り硬直中(whiff)は打てない
    if (this.swingState === 'whiff') return

    const bpos = ctx.ball.pos
    // 自分側に来ているボールのみ対象
    if (!this.isOwnSide(bpos.z)) return

    // 水平距離・高さチェック
    const hdist = Math.hypot(bpos.x - this.pos.x, bpos.z - this.pos.z)
    if (hdist > REACH || bpos.y > REACH_HEIGHT) return

    // 最接近を待ってから打つ(品質は距離で決まるため、リーチに入った瞬間に
    // 振ると常に最低品質になる)。十分近い(SWEET_DIST 以内)なら即打ち、
    // そうでなければボールが自分から遠ざかり始めた時点(=最接近通過)で打つ。
    const relX = bpos.x - this.pos.x
    const relZ = bpos.z - this.pos.z
    const receding = relX * ctx.ball.vel.x + relZ * ctx.ball.vel.z > 0
    if (hdist > SWEET_DIST && !receding) return

    const quality = this.computeQuality(hdist)
    const req = this.chooseShot(ctx, quality)
    ctx.requestShot(req)

    this.lastShot = req.type

    // スイングサイドを決定: AI は奥側(z<0)で +z を向く。
    // 利き手=右手側は世界の −x 方向。打点ボールが AI より −x 側なら 'fore'、+x 側なら 'back'。
    this.swingSide = bpos.x < this.pos.x ? 'fore' : 'back'

    this.swingState = 'swing'
    this.swingTimer = AI_SWING_DISPLAY_TIME

    // スイングロック開始(打球瞬間から SWING_LOCK_TIME 秒間、移動を大幅制限)
    this.swingLockTimer = SWING_LOCK_TIME

    // 打球したのでホームへ戻るモードへ(次フレームで lastHitBy 遷移検出もする)
    this.mode = 'returning'
  }

  /** 品質計算(GAME_DESIGN §4.2)。プレイヤーと同一式 + 凡ミス */
  private computeQuality(hdist: number): number {
    // 距離係数: SWEET_DIST 以内で 1.0、REACH で QUALITY_MIN へ線形
    let distFactor: number
    if (hdist <= SWEET_DIST) {
      distFactor = 1.0
    } else if (hdist >= REACH) {
      distFactor = QUALITY_MIN
    } else {
      const t = (hdist - SWEET_DIST) / (REACH - SWEET_DIST)
      distFactor = lerp(1.0, QUALITY_MIN, t)
    }

    // スタミナ係数: 閾値以上で 1.0、0 で floor へ線形
    let staminaFactor: number
    if (this.stamina >= STAMINA_LOW_THRESHOLD) {
      staminaFactor = 1.0
    } else {
      const t = this.stamina / STAMINA_LOW_THRESHOLD
      staminaFactor = lerp(STAMINA_QUALITY_FLOOR, 1.0, t)
    }

    let q = distFactor * staminaFactor
    if (this.sprinting) q -= SPRINT_SHOT_PENALTY
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

    // 相手の前後位置: プレイヤーがネット寄り(z 小)なら「前」、深い(z 大)なら「後ろ」
    const rivalZ = rivalPos.z
    const rivalIsForward = rivalZ < frontThreshold() // ネット〜サービスライン付近以前
    const rivalIsDeep = rivalZ > COURT_HALF_LENGTH - 1.5 // ベースライン付近

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

    // 相手(プレイヤー)コート内にクランプ(マージン込み)。プレイヤーコートは z>0。
    tx = clamp(tx, -COURT_HALF_WIDTH + riskMargin, COURT_HALF_WIDTH - riskMargin)
    tz = clamp(tz, TARGET_CLAMP_MARGIN, COURT_HALF_LENGTH - riskMargin)

    // チャージ量の決定: 体勢ベース。余裕があるほど高チャージ、走らされているほど低チャージ。
    // 低い打点では強打(高チャージ)を避ける(GAME_DESIGN §4.5: 低打点の無理打ちは自滅)。
    // AI はオーバーチャージ(>1)しないため clamp 上限は 1.0。
    const chargeBase = 0.3 + 0.7 * quality * (1 - stretched) * (0.6 + 0.4 * this.profile.aggressiveness)
    // 低打点ペナルティ: low が 1 のとき最大 0.4 下げる(高チャージ抑制)
    const lowChargeReducer = low * 0.4
    const charge = clamp(chargeBase - lowChargeReducer, 0, 1.0)

    // 打球直前のボール速度の大きさ(incomingSpeed — ARCHITECTURE §6.1)
    const incomingSpeed = Math.hypot(ctx.ball.vel.x, ctx.ball.vel.y, ctx.ball.vel.z)

    return {
      type: chosen.type,
      hitter: this.side,
      hitPos: new Vector3(ctx.ball.pos.x, ctx.ball.pos.y, ctx.ball.pos.z),
      target: new Vector3(tx, 0, tz),
      quality,
      charge,
      incomingSpeed,
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
    },
  ): number {
    const { rivalPos, rivalIsForward, rivalIsDeep, stretched, low, smashCondition } = ctxInfo
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
