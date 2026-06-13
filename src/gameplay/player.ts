// =============================================================================
// PlayerController — プレイヤー制御
// 移動(加速度モデル)・スタミナ管理・スイング判定・サーブメーターを実装する。
// InputSource を DI として受け取り、ControlContext 経由で外界と相互作用する。
// =============================================================================
import { Vector3 } from 'three'
import type {
  Controller,
  ControlContext,
  InputSource,
  PersonaModifiers,
  PersonaPhysique,
  PlayerView,
  ServeType,
  ServeMeterView,
  Side,
  ShotType,
} from '../types'
import {
  MOVE_ACCEL,
  WALK_SPEED,
  SPRINT_SPEED,
  MOVE_X_LIMIT,
  MOVE_Z_MIN,
  MOVE_Z_MAX,
  STAMINA_MAX,
  STAMINA_SPRINT_DRAIN,
  STAMINA_REGEN,
  STAMINA_POINT_RECOVERY,
  STAMINA_LOW_THRESHOLD,
  STAMINA_QUALITY_FLOOR,
  REACH,
  REACH_HEIGHT,
  SWEET_DIST,
  QUALITY_MIN,
  SPRINT_SHOT_PENALTY,
  SHOT_PARAMS,
  AIM_OFFSET_X,
  AIM_OFFSET_Z,
  TARGET_CLAMP_MARGIN,
  COURT_HALF_WIDTH,
  COURT_HALF_LENGTH,
  SERVE_METER_PERIOD,
  CHARGE_TIME,
  CHARGE_MAX,
  CHARGE_MOVE_FACTOR,
  SWING_LOCK_TIME,
  SWING_LOCK_MOVE_FACTOR,
  CHARGE_RELEASE_COOLDOWN,
  SERVE_X_MARGIN_CENTER,
  SERVE_Z_MIN_BEHIND,
  SERVE_Z_MAX_BEHIND,
  CONTACT_PIVOT_HEIGHT,
  HIGH_TOPSPIN_ANGLE_BONUS,
} from '../constants'

// ---------------------------------------------------------------------------
// 内部定数
// ---------------------------------------------------------------------------

/** スイング表示を維持する秒数 */
const SWING_DISPLAY_DURATION = 0.3

// ---------------------------------------------------------------------------
// プレイヤーのサーブ位置 x 座標
// ---------------------------------------------------------------------------

/**
 * サーブ位置を返す。
 * GAME_DESIGN §2: ポイント合計が偶数ならデュースサイド(右)、奇数ならアドサイド(左)。
 * serveFromRight が true なら右側(x > 0)、false なら左側(x < 0)。
 * プレイヤーはベースライン直後(z = COURT_HALF_LENGTH + 0.5)に配置。
 */
function calcServePos(side: Side, serveFromRight: boolean): Vector3 {
  const sign = side === 'player' ? 1 : -1
  // デュースサイド(右)は x = +2.06、アドサイド(左)は x = -2.06(センターマーク付近)
  const x = serveFromRight ? 2.06 : -2.06
  const z = sign * (COURT_HALF_LENGTH + 0.5)
  return new Vector3(x, 0, z)
}

/**
 * レシーバーの初期位置を返す。
 * サーバーの対角側ベースライン後方(z の符号はレシーバー側、x はサーバーと逆)。
 */
function calcReceivePos(side: Side, serveFromRight: boolean): Vector3 {
  const sign = side === 'player' ? 1 : -1
  // レシーバーはサーバーの対角に立つ(x はサーバーと逆)
  const x = serveFromRight ? -2.06 : 2.06
  const z = sign * (COURT_HALF_LENGTH + 0.5)
  return new Vector3(x, 0, z)
}

// ---------------------------------------------------------------------------
// PlayerController
// ---------------------------------------------------------------------------

export class PlayerController implements Controller {
  // 所属サイド(プレイヤーは常に 'player')
  private readonly side: Side = 'player'

  // 位置・速度
  private pos = new Vector3(0, 0, COURT_HALF_LENGTH + 0.5)
  private vel = new Vector3(0, 0, 0)

  // スタミナ
  private stamina = STAMINA_MAX

  // スイング状態管理
  private swingState: import('../types').SwingState = 'idle'
  private swingTimer = 0 // スイング表示残り秒数('whiff' は打たずに離した直後の表示)
  private lastShot: ShotType | null = null
  private swingSide: 'fore' | 'back' | null = null

  // チャージ状態管理
  private charging = false
  private charge = 0 // 0..CHARGE_MAX
  private chargeShot: ShotType | null = null // チャージ中のショット種(最初に押したキー)
  private chargeCooldown = 0 // 空チャージ後の再チャージ不可残り秒数
  private swingLockTimer = 0 // 打球後の移動ロック残り秒数

  // サーブメーター
  private meterActive = false
  private meterPhase = 0 // 0..SERVE_METER_PERIOD の累積時間
  // 現在のポイントのサーブサイド(true = 世界座標 +x 側 = right)。サーブ移動のクランプに使う
  private serveFromRight = true
  // 選択中のサーブ種類(初期値 'flat'。J=flat, K=kick, L=slice)
  private serveType: ServeType = 'flat'

  // InputSource(DI)
  private readonly input: InputSource

  // ペルソナ倍率・身体(DI)。未指定相当(全1.0・右利き)では従来と同一挙動。
  private readonly mods: PersonaModifiers
  private readonly physique: PersonaPhysique
  // ペルソナ倍率を反映した有効スタミナ上限(STAMINA_MAX * staminaMaxMul)
  private readonly effStaminaMax: number
  // ペルソナ倍率を反映した有効リーチ(REACH * reachMul)
  private readonly effReach: number

  // 公開ビュー(毎フレーム更新)
  private _view: PlayerView = {
    side: 'player',
    pos: this.pos.clone(),
    vel: this.vel.clone(),
    stamina: STAMINA_MAX,
    sprinting: false,
    swing: 'idle',
    lastShot: null,
    charging: false,
    charge: 0,
    swingSide: null,
  }

  constructor(input: InputSource, mods: PersonaModifiers, physique: PersonaPhysique) {
    this.input = input
    this.mods = mods
    this.physique = physique
    this.effStaminaMax = STAMINA_MAX * mods.staminaMaxMul
    this.effReach = REACH * mods.reachMul
    // スタミナ初期値・ビューを有効上限で満タンに(中立倍率では STAMINA_MAX のまま)
    this.stamina = this.effStaminaMax
    this._view.stamina = this.stamina
  }

  // ---------------------------------------------------------------------------
  // Controller インターフェース
  // ---------------------------------------------------------------------------

  get view(): PlayerView {
    return this._view
  }

  get serveMeter(): ServeMeterView {
    return {
      active: this.meterActive,
      value: this.meterActive ? this.calcMeterValue() : 0,
      // サーブフェーズ中は常に現在の serveType を返す(HUD 表示用)。
      // メーター非アクティブ時も常に有効な値を返す。
      serveType: this.serveType,
    }
  }

  /**
   * ポイント開始時のリセット。
   * - スタミナを STAMINA_POINT_RECOVERY 分回復(上限100)
   * - 定位置に移動
   * - スイング状態をリセット
   */
  /** ゲーム間のスタミナ全回復(GAME_DESIGN §6) */
  recoverFullStamina(): void {
    this.stamina = this.effStaminaMax
  }

  resetForPoint(servingSide: Side, serveFromRight: boolean): void {
    // スタミナ回復(上限はペルソナ補正済みの effStaminaMax)
    this.stamina = Math.min(this.effStaminaMax, this.stamina + STAMINA_POINT_RECOVERY)

    // サーブサイドを保持(サーブ移動のクランプに使用)
    this.serveFromRight = serveFromRight

    // 定位置移動
    if (servingSide === this.side) {
      // プレイヤーがサーバー
      const p = calcServePos(this.side, serveFromRight)
      this.pos.copy(p)
    } else {
      // プレイヤーがレシーバー
      const p = calcReceivePos(this.side, serveFromRight)
      this.pos.copy(p)
    }

    this.vel.set(0, 0, 0)
    this.swingState = 'idle'
    this.swingTimer = 0
    this.swingSide = null
    this.meterActive = false
    this.meterPhase = 0
    this.lastShot = null
    // チャージ/ロック状態をリセット
    this.charging = false
    this.charge = 0
    this.chargeShot = null
    this.chargeCooldown = 0
    this.swingLockTimer = 0
    // サーブ種類をフラット(デフォルト)に戻す(GAME_DESIGN §5.1)
    this.serveType = 'flat'

    this.refreshView(false)
  }

  /**
   * 固定タイムステップで毎物理フレーム呼ばれる。
   * poll() はここで一度だけ呼び、入力を消費する。
   */
  update(dt: number, ctx: ControlContext): void {
    // 入力を取得
    const inp = this.input.poll()

    const phase = ctx.phase
    const isServing = ctx.isServing

    // 各種タイマーを進める
    this.tickSwing(dt)
    this.tickTimers(dt)

    if (phase === 'serve' && isServing) {
      // ---------- サーブフェーズ ----------
      this.updateServe(dt, inp, ctx)
    } else if (phase === 'rally') {
      // ---------- ラリーフェーズ ----------
      this.updateRally(dt, inp, ctx)
    } else {
      // メニュー・pointOver・matchOver — 移動のみ許可(ポーズ中は入力無視でもよいが
      // ここでは慣性減速させる)
      this.applyMovement(dt, inp, false)
    }

    // スタミナ更新
    this.updateStamina(dt, inp.sprint && this.isActuallyMoving())

    // ビュー更新
    this.refreshView(inp.sprint && this.stamina > 0 && this.isActuallyMoving())
  }

  // ---------------------------------------------------------------------------
  // サーブ処理
  // ---------------------------------------------------------------------------

  private updateServe(
    dt: number,
    inp: import('../types').InputState,
    ctx: ControlContext,
  ): void {
    // サーブフェーズ中は J/K/L でサーブ種類を選択(GAME_DESIGN §3, §5.1)
    // shotPressed のエッジ検出を使う: 'flat'→flat, 'topspin'→kick, 'slice'→slice
    // その他のキー(U/I など)は無視する
    if (inp.shotPressed === 'flat') {
      this.serveType = 'flat'
    } else if (inp.shotPressed === 'topspin') {
      this.serveType = 'kick'
    } else if (inp.shotPressed === 'slice') {
      this.serveType = 'slice'
    }
    // U/I など他のキーは無視(上記 if/else if の外なので何もしない)

    if (!this.meterActive) {
      // メーター開始前: サーブサイドの半面内で立ち位置を移動できる(GAME_DESIGN §5)
      this.applyServeMovement(dt, inp)

      // Space 押下でメーター開始(移動停止)
      if (inp.servePressed) {
        this.meterActive = true
        this.meterPhase = 0
        this.vel.set(0, 0, 0)
      }
    } else {
      // メーター中は移動しない(定位置固定)
      this.vel.set(0, 0, 0)

      // メーターを進める
      this.meterPhase += dt

      // Space 離し → サーブ発射
      if (inp.serveReleased) {
        const power = this.calcMeterValue()

        // A/D 入力でコースを決める
        const aimX: -1 | 0 | 1 =
          inp.moveX > 0 ? 1 : inp.moveX < 0 ? -1 : 0

        // 選択中のサーブ種類を渡す(ARCHITECTURE §6.4)
        ctx.requestServe(power, aimX, this.serveType)

        // サーブ後リセット
        this.meterActive = false
        this.meterPhase = 0
        this.swingState = 'swing'
        this.swingTimer = SWING_DISPLAY_DURATION
        this.swingSide = 'fore' // サーブはフォア扱いで表示
        this.lastShot = 'flat' // サーブはフラット扱いで記録
      }
    }
  }

  /**
   * サーブのメーター開始前の立ち位置移動。
   * 加速度モデルは通常移動と同じだが、可動域をサーブサイドの半面内にクランプする。
   * x: サーブサイド(serveFromRight=true なら +x 側)に応じて
   *    [SERVE_X_MARGIN_CENTER, COURT_HALF_WIDTH] または
   *    [-COURT_HALF_WIDTH, -SERVE_X_MARGIN_CENTER]。
   * z: COURT_HALF_LENGTH + SERVE_Z_MIN_BEHIND .. COURT_HALF_LENGTH + SERVE_Z_MAX_BEHIND。
   */
  private applyServeMovement(
    dt: number,
    inp: import('../types').InputState,
  ): void {
    const isSprinting = inp.sprint && this.stamina > 0
    // 最高速にペルソナ倍率 moveSpeedMul を乗算
    const baseSpeed = (isSprinting ? SPRINT_SPEED : WALK_SPEED) * this.mods.moveSpeedMul
    this.integrateVelocity(dt, inp, baseSpeed, 1)

    // 位置更新
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt

    // サーブサイドの半面内にクランプ
    const xMin = this.serveFromRight ? SERVE_X_MARGIN_CENTER : -COURT_HALF_WIDTH
    const xMax = this.serveFromRight ? COURT_HALF_WIDTH : -SERVE_X_MARGIN_CENTER
    this.pos.x = Math.max(xMin, Math.min(xMax, this.pos.x))

    const zMin = COURT_HALF_LENGTH + SERVE_Z_MIN_BEHIND
    const zMax = COURT_HALF_LENGTH + SERVE_Z_MAX_BEHIND
    this.pos.z = Math.max(zMin, Math.min(zMax, this.pos.z))

    this.pos.y = 0
  }

  // ---------------------------------------------------------------------------
  // ラリー処理
  // ---------------------------------------------------------------------------

  private updateRally(
    dt: number,
    inp: import('../types').InputState,
    ctx: ControlContext,
  ): void {
    // ---- チャージ状態の更新(移動より先に確定させ、移動係数に反映する) ----
    if (this.charging) {
      // チャージ量を増加(CHARGE_TIME 秒で 1.0、CHARGE_MAX まで)
      this.charge = Math.min(CHARGE_MAX, this.charge + dt / CHARGE_TIME)

      // 保持キーを離した → 空チャージ。再チャージ不可時間に入る
      // (shotReleased が「今フレーム離されたキー」、shotHeld が「まだ押下中のキー」)
      const stillHeld = inp.shotHeld !== null
      if (!stillHeld) {
        this.charging = false
        this.charge = 0
        this.chargeShot = null
        this.chargeCooldown = CHARGE_RELEASE_COOLDOWN
        // 打たずに離した直後の表示(旧 whiff 硬直は廃止し、表示用に流用)
        this.swingState = 'whiff'
        this.swingTimer = SWING_DISPLAY_DURATION
        this.swingSide = null
      }
    } else {
      // 新規にショットキーを押した → チャージ開始(再チャージ不可中は不可)
      if (inp.shotPressed !== null && this.chargeCooldown <= 0) {
        this.charging = true
        this.charge = 0
        this.chargeShot = inp.shotPressed
      }
    }

    // ---- 移動(チャージ/ロック中の速度係数は applyMovement 内で適用) ----
    const isSprinting = inp.sprint && this.stamina > 0
    this.applyMovement(dt, inp, isSprinting)

    // ---- 保持中にボールが打球条件を満たした瞬間に自動打球 ----
    if (this.charging && this.chargeShot !== null) {
      this.tryShot(this.chargeShot, inp, ctx, isSprinting)
    }
  }

  // ---------------------------------------------------------------------------
  // 移動
  // ---------------------------------------------------------------------------

  private applyMovement(
    dt: number,
    inp: import('../types').InputState,
    isSprinting: boolean,
  ): void {
    // 移動速度係数: スイングロック中 > チャージ中 の順で支配的に適用する。
    // (打球直後のインパクト硬直が最優先で動きを止める)
    let factor = 1
    if (this.swingLockTimer > 0) {
      factor = SWING_LOCK_MOVE_FACTOR
    } else if (this.charging) {
      factor = CHARGE_MOVE_FACTOR
    }

    // 最高速にペルソナ倍率 moveSpeedMul を乗算(移動係数 factor とは独立)
    const targetSpeed = (isSprinting ? SPRINT_SPEED : WALK_SPEED) * this.mods.moveSpeedMul * factor
    this.integrateVelocity(dt, inp, targetSpeed, factor)

    // 位置更新
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt

    // 可動域クランプ
    this.pos.x = Math.max(-MOVE_X_LIMIT, Math.min(MOVE_X_LIMIT, this.pos.x))
    this.pos.z = Math.max(MOVE_Z_MIN, Math.min(MOVE_Z_MAX, this.pos.z))

    // y は常に 0
    this.pos.y = 0
  }

  /**
   * 入力方向への加速・最高速クランプ・摩擦減速を vel に適用する(位置更新は呼び出し側)。
   * targetSpeed は係数適用済みの最高速。accelFactor は加速度・減速率にかける係数
   * (チャージ/ロック中は鈍く動く)。
   */
  private integrateVelocity(
    dt: number,
    inp: import('../types').InputState,
    targetSpeed: number,
    accelFactor: number,
  ): void {
    const accel = MOVE_ACCEL * accelFactor

    // 入力方向ベクトル(水平面)
    const inputX = inp.moveX
    const inputZ = inp.moveZ // -1 = 前進(z-)
    const hasInput = inputX !== 0 || inputZ !== 0

    if (hasInput) {
      // 入力方向への加速
      const len = Math.sqrt(inputX * inputX + inputZ * inputZ)
      const dirX = inputX / len
      const dirZ = inputZ / len

      this.vel.x += dirX * accel * dt
      this.vel.z += dirZ * accel * dt

      // 最高速クランプ
      const speed = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z)
      if (speed > targetSpeed) {
        const scale = targetSpeed / speed
        this.vel.x *= scale
        this.vel.z *= scale
      }
    } else {
      // 入力なし: 摩擦で減速(加速度を逆方向に適用して停止)
      const speed = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z)
      if (speed > 0) {
        const decel = Math.min(speed, accel * dt)
        const scale = (speed - decel) / speed
        this.vel.x *= scale
        this.vel.z *= scale
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ショット判定
  // ---------------------------------------------------------------------------

  /**
   * チャージ保持中に毎フレーム呼び、打球条件を満たした瞬間に自動打球する。
   * 条件を満たさない場合は何もしない(チャージを継続する。空振り硬直は発生しない)。
   */
  private tryShot(
    shotType: ShotType,
    inp: import('../types').InputState,
    ctx: ControlContext,
    isSprinting: boolean,
  ): void {
    const ball = ctx.ball

    // 打球条件チェック
    const dx = ball.pos.x - this.pos.x
    const dz = ball.pos.z - this.pos.z
    const hDist = Math.sqrt(dx * dx + dz * dz)
    const ballHeight = ball.pos.y

    const canHit =
      hDist <= this.effReach &&
      ballHeight <= REACH_HEIGHT &&
      ball.lastHitBy !== this.side &&
      ball.inPlay

    if (!canHit) {
      // まだ届かない: チャージを保持したまま待つ
      return
    }

    // 品質計算 (GAME_DESIGN §4.2)
    const distFactor = this.calcDistFactor(hDist)
    const staminaFactor = this.calcStaminaFactor()
    const sprintPenalty = isSprinting ? SPRINT_SHOT_PENALTY : 0
    const quality = Math.max(
      QUALITY_MIN,
      Math.min(1.0, distFactor * staminaFactor - sprintPenalty),
    )

    // ターゲット決定 (GAME_DESIGN §4.3)。自動打球の瞬間の移動キー状態と打点高さを使う
    const target = this.calcTarget(shotType, inp, ball.pos.y)

    // 打球直前のボール速度の大きさ(m/s)。相手球の勢いをソルバへ渡す(GAME_DESIGN §4.5)
    const incomingSpeed = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z)

    // 打球要求(チャージ量・相手球速を添付。リーチ内で即打した場合は charge ≈ 0)
    ctx.requestShot({
      type: shotType,
      hitter: this.side,
      hitPos: ball.pos.clone(),
      target,
      quality,
      charge: this.charge,
      incomingSpeed,
      // 自分のペルソナ倍率を添付(ソルバが初速・狙い等に乗算)
      mods: this.mods,
    })

    // swingSide: 打点(ボール)がプレイヤーから見て利き手側(右利きの player は
    // 世界 +x 側)なら 'fore'、逆なら 'back'。左利きは不等号を反転する。
    const ballOnRight = ball.pos.x >= this.pos.x
    const foreSide = this.physique.handedness === 'left' ? !ballOnRight : ballOnRight
    this.swingSide = foreSide ? 'fore' : 'back'

    // スイング状態更新 + チャージ解除 + インパクト硬直開始
    this.swingState = 'swing'
    this.swingTimer = SWING_DISPLAY_DURATION
    this.lastShot = shotType
    this.charging = false
    this.charge = 0
    this.chargeShot = null
    this.swingLockTimer = SWING_LOCK_TIME
  }

  // ---------------------------------------------------------------------------
  // ターゲット計算
  // ---------------------------------------------------------------------------

  /**
   * 打球目標点を計算する。
   * @param shotType  ショット種
   * @param inp       打球瞬間の入力スナップショット
   * @param hitHeight 打点の高さ (ball.pos.y)。
   *                  トップスピン × 高い打点では横オフセット最大値を拡大する
   *                  (GAME_DESIGN §4.5 / ARCHITECTURE §6.1)。
   */
  private calcTarget(
    shotType: ShotType,
    inp: import('../types').InputState,
    hitHeight: number,
  ): Vector3 {
    const param = SHOT_PARAMS[shotType]

    // 相手コート(z < 0)側のベースラインから手前に baseDepthFromBaseline の位置
    // 相手ベースライン: z = -COURT_HALF_LENGTH
    const baseZ = -(COURT_HALF_LENGTH - param.baseDepthFromBaseline)

    // W/S で前後オフセット
    // moveZ = -1 が前進(ネット方向 = z-)、W 押下で深く狙う
    // W 押し: moveZ = -1 → 相手コート内でさらに奥(z をより負に)
    // S 押し: moveZ = +1 → 相手コート内で浅く
    const offsetZ = -inp.moveZ * AIM_OFFSET_Z
    const targetZ = baseZ + offsetZ

    // --- 横オフセット計算 ---
    // 通常は AIM_OFFSET_X を使うが、高い打点のトップスピンでは
    // lev = clamp((h − PIVOT)/PIVOT, −1, 1)、high = max(0, lev) として
    // 最大値を AIM_OFFSET_X·(1 + HIGH_TOPSPIN_ANGLE_BONUS·high) まで拡大する
    // (ARCHITECTURE §6.1 / GAME_DESIGN §4.5)。
    let effectiveAimOffsetX = AIM_OFFSET_X
    if (shotType === 'topspin') {
      const lev = Math.max(-1, Math.min(1, (hitHeight - CONTACT_PIVOT_HEIGHT) / CONTACT_PIVOT_HEIGHT))
      const high = Math.max(0, lev)
      effectiveAimOffsetX = AIM_OFFSET_X * (1 + HIGH_TOPSPIN_ANGLE_BONUS * high)
    }

    const targetX = inp.moveX * effectiveAimOffsetX

    // コート内側 TARGET_CLAMP_MARGIN でクランプ
    // 注意: x のクランプはコート幅を保つ。横オフセット拡大はオフセット計算のみで
    // クランプ境界は変えない(ライン際への品質ノイズによるアウトは許容)。
    const minX = -(COURT_HALF_WIDTH - TARGET_CLAMP_MARGIN)
    const maxX = COURT_HALF_WIDTH - TARGET_CLAMP_MARGIN
    // 相手コート: z ∈ [-COURT_HALF_LENGTH, 0]
    const minZ = -(COURT_HALF_LENGTH - TARGET_CLAMP_MARGIN)
    const maxZ = -TARGET_CLAMP_MARGIN

    return new Vector3(
      Math.max(minX, Math.min(maxX, targetX)),
      0,
      Math.max(minZ, Math.min(maxZ, targetZ)),
    )
  }

  // ---------------------------------------------------------------------------
  // 品質計算ヘルパー
  // ---------------------------------------------------------------------------

  /** 距離係数: SWEET_DIST 以内で 1.0、effReach で 0.35 へ線形減衰 */
  private calcDistFactor(hDist: number): number {
    // REACH 上限はペルソナ補正済みの effReach を使う(中立倍率では従来と同一)
    const reach = this.effReach
    if (hDist <= SWEET_DIST) return 1.0
    if (hDist >= reach) return QUALITY_MIN
    // SWEET_DIST..effReach を 1.0..QUALITY_MIN に線形補間
    const t = (hDist - SWEET_DIST) / (reach - SWEET_DIST)
    return 1.0 - t * (1.0 - QUALITY_MIN)
  }

  /** スタミナ係数: 30% 以上で 1.0、0% で STAMINA_QUALITY_FLOOR へ線形減衰 */
  private calcStaminaFactor(): number {
    // 低下閾値判定は有効上限 effStaminaMax を基準にする(中立倍率では従来と同一)
    const pct = this.stamina / this.effStaminaMax
    if (pct >= STAMINA_LOW_THRESHOLD / STAMINA_MAX) return 1.0
    // 0..STAMINA_LOW_THRESHOLD を STAMINA_QUALITY_FLOOR..1.0 に線形補間
    const t = pct / (STAMINA_LOW_THRESHOLD / STAMINA_MAX)
    return STAMINA_QUALITY_FLOOR + t * (1.0 - STAMINA_QUALITY_FLOOR)
  }

  // ---------------------------------------------------------------------------
  // スタミナ更新
  // ---------------------------------------------------------------------------

  private updateStamina(dt: number, sprinting: boolean): void {
    if (sprinting) {
      // 消耗にペルソナ倍率 staminaDrainMul を乗算
      this.stamina = Math.max(0, this.stamina - STAMINA_SPRINT_DRAIN * this.mods.staminaDrainMul * dt)
    } else {
      // 回復にペルソナ倍率 staminaRegenMul を乗算。上限は effStaminaMax
      this.stamina = Math.min(this.effStaminaMax, this.stamina + STAMINA_REGEN * this.mods.staminaRegenMul * dt)
    }
  }

  // ---------------------------------------------------------------------------
  // スイングタイマー
  // ---------------------------------------------------------------------------

  private tickSwing(dt: number): void {
    if (this.swingState !== 'idle') {
      this.swingTimer -= dt
      if (this.swingTimer <= 0) {
        this.swingState = 'idle'
        this.swingTimer = 0
        // スイング表示が終わったら swingSide を null に戻す
        this.swingSide = null
      }
    }
  }

  /** チャージ再充填クールダウンとインパクト硬直タイマーを進める */
  private tickTimers(dt: number): void {
    if (this.chargeCooldown > 0) {
      this.chargeCooldown = Math.max(0, this.chargeCooldown - dt)
    }
    if (this.swingLockTimer > 0) {
      this.swingLockTimer = Math.max(0, this.swingLockTimer - dt)
    }
  }

  // ---------------------------------------------------------------------------
  // サーブメーター値の計算
  // ---------------------------------------------------------------------------

  /**
   * 三角波(0→1→0、周期 SERVE_METER_PERIOD)を現在の meterPhase から計算する。
   * 値は 0..1 に収まる。
   */
  private calcMeterValue(): number {
    // 周期内での位置 (0..SERVE_METER_PERIOD)
    const t = this.meterPhase % SERVE_METER_PERIOD
    const half = SERVE_METER_PERIOD / 2
    if (t <= half) {
      return t / half // 0→1
    } else {
      return 1.0 - (t - half) / half // 1→0
    }
  }

  // ---------------------------------------------------------------------------
  // ビュー更新
  // ---------------------------------------------------------------------------

  private refreshView(sprinting: boolean): void {
    this._view = {
      side: this.side,
      pos: this.pos.clone(),
      vel: this.vel.clone(),
      stamina: this.stamina,
      sprinting,
      swing: this.swingState,
      lastShot: this.lastShot,
      charging: this.charging,
      charge: this.charge,
      swingSide: this.swingSide,
    }
  }

  // ---------------------------------------------------------------------------
  // ユーティリティ
  // ---------------------------------------------------------------------------

  /** 実際に移動中(速度がほぼ 0 でない)かどうか */
  private isActuallyMoving(): boolean {
    const speedSq = this.vel.x * this.vel.x + this.vel.z * this.vel.z
    return speedSq > 0.01
  }
}
