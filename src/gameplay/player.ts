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
  STAMINA_REGEN_IDLE,
  STAMINA_MOVE_DRAIN_K,
  STAMINA_SPRINT_EXTRA,
  moveEconomyMul,
  STAMINA_POINT_RECOVERY,
  STAMINA_LOW_THRESHOLD,
  STAMINA_QUALITY_FLOOR,
  REACH,
  REACH_HEIGHT,
  SWEET_DIST,
  QUALITY_MIN,
  SPRINT_SHOT_PENALTY,
  SHOT_PARAMS,
  SMASH_MIN_HEIGHT,
  SMASH_MOTION_HEIGHT,
  SMASH_MAX_DEPTH,
  MOMENTUM_QUALITY_K,
  PRESSURE_CHOKE_K,
  shotStaminaCost,
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
  JUST_SWEET_DIST,
  SAFETY_DROP_Y,
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
  private swingKind: 'normal' | 'smash' = 'normal' // 高い打点のオーバーヘッド表示用

  // チャージ状態管理
  private charging = false
  private charge = 0 // 0..CHARGE_MAX
  private chargeShot: ShotType | null = null // チャージ中のショット種(最初に押したキー)
  private chargeCooldown = 0 // 空チャージ後の再チャージ不可残り秒数
  private swingLockTimer = 0 // 打球後の移動ロック残り秒数
  // 見送り/空振り診断(?debug): 相手球の最接近を記録し、返せず終わったらログ
  private missTrack: { minH: number; ball: Vector3; me: Vector3; everHittable: boolean } | null = null
  private missArmed = false

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
    staminaPct: 1,
    sprinting: false,
    swing: 'idle',
    lastShot: null,
    charging: false,
    charge: 0,
    swingSide: null,
    swingKind: 'normal',
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
    // スタミナ回復(ポイント間)。回復量にクラッチ回復倍率を反映。上限は effStaminaMax。
    this.stamina = Math.min(
      this.effStaminaMax,
      this.stamina + STAMINA_POINT_RECOVERY * this.mods.clutchRecoveryMul,
    )

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

    // スタミナ更新(常時微回復 − 移動量比例消費 − スプリント追加消費。
    // プレッシャー(ctx.pressure)で消費倍率が変動する。IMPROVEMENTS §5.2/5.5)
    this.updateStamina(dt, inp.sprint && this.isActuallyMoving(), ctx.pressure)

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
        this.swingKind = 'smash' // サーブは頭上のオーバーヘッドモーション
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

    // ---- 見送り/未到達の診断ログ(?debug) ----
    this.trackMiss(ctx)

    // ---- 打球(リリースで打つ。§4.4)----
    // チャージキーを離した瞬間にリーチ内なら打球。スイートゾーン(芯)で離すとジャスト。
    // 離さずにいてもボールがスイートゾーンを抜けて遠ざかり出したらセーフティ打球。
    if (this.charging && this.chargeShot !== null) {
      this.resolveRelease(this.chargeShot, inp, ctx, isSprinting)
    }
  }

  /**
   * リリース打球・セーフティ打球・空振りの解決(§4.4 リリース方式)。
   * - チャージキーを離した(shotHeld が null)→ リーチ内なら打球(芯なら just)、外なら空振り。
   * - 離していない → ボールがスイートゾーンを抜けて遠ざかり出したらセーフティ打球(just なし)。
   */
  private resolveRelease(
    shotType: ShotType,
    inp: import('../types').InputState,
    ctx: ControlContext,
    isSprinting: boolean,
  ): void {
    const ball = ctx.ball
    const dx = ball.pos.x - this.pos.x
    const dz = ball.pos.z - this.pos.z
    const hDist = Math.sqrt(dx * dx + dz * dz)
    const hittable =
      hDist <= this.effReach &&
      ball.pos.y <= REACH_HEIGHT &&
      ball.lastHitBy !== this.side &&
      ball.inPlay

    const released = inp.shotHeld === null // チャージキーを離した(全ショットキー非保持)

    if (released) {
      if (hittable) {
        // 芯(スイートゾーン)で離せばジャスト。外で離すと通常打球(ペナルティなし)。
        const just = hDist <= JUST_SWEET_DIST
        this.executeShot(shotType, inp, ctx, isSprinting, just, hDist, 'release')
      } else {
        // リーチ外で離した = 空振り。再チャージ不可時間に入る。
        // 診断ログ(?debug): 何がズレて空振りしたか(ボール位置・自位置・距離・高さ)。
        const tooFar = hDist > this.effReach
        const tooHigh = ball.pos.y > REACH_HEIGHT
        const reason = !ball.inPlay
          ? 'no-ball'
          : ball.lastHitBy === this.side
            ? 'own-ball'
            : `${tooFar ? 'TOO-FAR' : ''}${tooHigh ? (tooFar ? '+HIGH' : 'TOO-HIGH') : ''}` || 'in-reach?'
        ctx.logDebug?.({
          kind: 'note',
          msg: `whiff(${reason}) ball=(${ball.pos.x.toFixed(2)},${ball.pos.y.toFixed(2)},${ball.pos.z.toFixed(2)}) me=(${this.pos.x.toFixed(2)},${this.pos.z.toFixed(2)}) hDist=${hDist.toFixed(2)}/${this.effReach.toFixed(2)} y=${ball.pos.y.toFixed(2)}/${REACH_HEIGHT}`,
          data: {
            reason,
            ballX: Math.round(ball.pos.x * 100) / 100,
            ballY: Math.round(ball.pos.y * 100) / 100,
            ballZ: Math.round(ball.pos.z * 100) / 100,
            meX: Math.round(this.pos.x * 100) / 100,
            meZ: Math.round(this.pos.z * 100) / 100,
            hDist: Math.round(hDist * 100) / 100,
            effReach: Math.round(this.effReach * 100) / 100,
            reachHeight: REACH_HEIGHT,
          },
        })
        this.charging = false
        this.charge = 0
        this.chargeShot = null
        this.chargeCooldown = CHARGE_RELEASE_COOLDOWN
        this.swingState = 'whiff'
        this.swingTimer = SWING_DISPLAY_DURATION
        this.swingSide = null
      }
      return
    }

    // 未リリース: セーフティ打球(リリース方式の保険)。スイートゾーンにいる間は待ち
    // (リリースで just を狙える)、リーチを抜ける直前に受動的に打つ(ジャストなし)。
    // 「抜ける」を2軸で判定する:
    //   水平: 遠ざかり(receding)かつ芯の外(hDist > sweet)。横に通過する通常のラリー球用。
    //   垂直: 下降中かつ低い(y ≤ SAFETY_DROP_Y)。真下に落ちてくる山なり/ロブ/スマッシュ用。
    //         水平には遠ざからない(真下に落ちる)ため、これがないと空振りしていた(回帰修正)。
    if (hittable) {
      const recedingH = dx * ball.vel.x + dz * ball.vel.z > 0
      const droppingLow = ball.vel.y < 0 && ball.pos.y <= SAFETY_DROP_Y
      if (droppingLow || (recedingH && hDist > JUST_SWEET_DIST)) {
        this.executeShot(shotType, inp, ctx, isSprinting, false, hDist, 'safety')
      }
    }
  }

  /**
   * 見送り/未到達の診断(?debug)。相手から来ている球の「最接近(hDist 最小)」を記録し、
   * その球を返せずに終わったら(自分が打たないまま消えた)、最接近時のボール位置・自位置・
   * 距離・到達可否(everHittable)・理由(TOO-FAR/TOO-HIGH/in-reach未打)をログ出力する。
   * チャージで前に走れず届かない(=最接近が effReach 超)等の原因切り分けに使う。
   */
  private trackMiss(ctx: ControlContext): void {
    const b = ctx.ball
    const incoming = b.inPlay && b.lastHitBy !== this.side
    if (incoming) {
      const hd = Math.hypot(b.pos.x - this.pos.x, b.pos.z - this.pos.z)
      const hittable = hd <= this.effReach && b.pos.y <= REACH_HEIGHT
      if (!this.missTrack) {
        this.missTrack = { minH: Infinity, ball: new Vector3(), me: new Vector3(), everHittable: false }
      }
      if (hd < this.missTrack.minH) {
        this.missTrack.minH = hd
        this.missTrack.ball.copy(b.pos)
        this.missTrack.me.copy(this.pos)
      }
      if (hittable) this.missTrack.everHittable = true
      this.missArmed = true
    } else if (this.missArmed) {
      // 来ていた相手球が終わった。自分が打っていなければ「返せず=見送り/未到達」
      const t = this.missTrack
      if (b.lastHitBy !== this.side && t) {
        const reason = t.everHittable ? 'in-reach-未打' : t.minH > this.effReach ? 'TOO-FAR' : 'TOO-HIGH'
        ctx.logDebug?.({
          kind: 'note',
          msg: `miss(${reason}) closest hDist=${t.minH.toFixed(2)}/${this.effReach.toFixed(2)} ball=(${t.ball.x.toFixed(2)},${t.ball.y.toFixed(2)},${t.ball.z.toFixed(2)}) me=(${t.me.x.toFixed(2)},${t.me.z.toFixed(2)})`,
          data: {
            reason,
            minHDist: Math.round(t.minH * 100) / 100,
            effReach: Math.round(this.effReach * 100) / 100,
            ballX: Math.round(t.ball.x * 100) / 100,
            ballY: Math.round(t.ball.y * 100) / 100,
            ballZ: Math.round(t.ball.z * 100) / 100,
            meX: Math.round(t.me.x * 100) / 100,
            meZ: Math.round(t.me.z * 100) / 100,
          },
        })
      }
      this.missArmed = false
      this.missTrack = null
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
  // ショット実行
  // ---------------------------------------------------------------------------

  /**
   * 実際に打球する(リリース打球 or セーフティ打球から呼ばれる)。
   * 打球条件チェックや just 判定は呼び出し側(resolveRelease)で済ませている。
   * @param just    ジャストミート成立フラグ(§6.1.1)
   * @param hDist   打点距離(ログ用)
   * @param trigger 'release'(離して打つ) | 'safety'(抜ける直前の受動打球)
   */
  private executeShot(
    shotType: ShotType,
    inp: import('../types').InputState,
    ctx: ControlContext,
    isSprinting: boolean,
    just: boolean,
    hDist: number,
    trigger: 'release' | 'safety',
  ): void {
    const ball = ctx.ball

    // 品質計算 (GAME_DESIGN §4.2)
    // 既存要素(距離・スタミナ・スプリント)→ モメンタム/プレッシャー → クランプ の順。
    const distFactor = this.calcDistFactor(hDist)
    const staminaFactor = this.calcStaminaFactor()
    const sprintPenalty = isSprinting ? SPRINT_SHOT_PENALTY : 0
    let q = distFactor * staminaFactor - sprintPenalty
    q = this.applyMomentumPressure(q, ctx)
    const quality = Math.max(QUALITY_MIN, Math.min(1.0, q))

    // ターゲット決定 (GAME_DESIGN §4.3)。打球の瞬間の移動キー状態と打点高さを使う
    const target = this.calcTarget(shotType, inp, ball.pos.y)

    // 打球直前のボール速度の大きさ(m/s)。相手球の勢いをソルバへ渡す(GAME_DESIGN §4.5)
    const incomingSpeed = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z)

    // デバッグログ(?debug): 毎打のジャスト判定。芯距離・スイート閾値・トリガを残す。
    ctx.logDebug?.({
      kind: 'note',
      msg: `just ${just ? 'OK' : '--'} hDist=${hDist.toFixed(2)} sweet=${JUST_SWEET_DIST.toFixed(2)} vIn=${incomingSpeed.toFixed(1)} q=${quality.toFixed(2)} (${trigger})`,
      data: {
        just,
        trigger,
        hDist: Math.round(hDist * 100) / 100,
        sweetDist: JUST_SWEET_DIST,
        incomingSpeed: Math.round(incomingSpeed * 10) / 10,
        quality: Math.round(quality * 100) / 100,
        shot: shotType,
      },
    })

    // 打球要求(チャージ量・相手球速を添付)
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
      just,
      safety: trigger === 'safety',
    })

    // 打球時のスタミナ消費(インパクト時に1回。IMPROVEMENTS §5.3)。
    // スマッシュ判定は shot.ts と同条件: flat かつ 打点高 ≥ SMASH_MIN_HEIGHT かつ
    // ネットからの距離 |hitPos.z| ≤ SMASH_MAX_DEPTH。
    const isSmash =
      shotType === 'flat' &&
      ball.pos.y >= SMASH_MIN_HEIGHT &&
      Math.abs(ball.pos.z) <= SMASH_MAX_DEPTH
    const cost = shotStaminaCost(shotType, this.charge, isSmash) * this.driveMul(ctx.pressure)
    this.stamina = Math.max(0, this.stamina - cost)

    // swingSide: 打点(ボール)がプレイヤーから見て利き手側(右利きの player は
    // 世界 +x 側)なら 'fore'、逆なら 'back'。左利きは不等号を反転する。
    const ballOnRight = ball.pos.x >= this.pos.x
    const foreSide = this.physique.handedness === 'left' ? !ballOnRight : ballOnRight
    this.swingSide = foreSide ? 'fore' : 'back'
    // 高い打点はオーバーヘッド(スマッシュ)モーションで表示する
    this.swingKind = ball.pos.y >= SMASH_MOTION_HEIGHT ? 'smash' : 'normal'

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

  /**
   * モメンタム(勢い)とプレッシャー時の品質変動を q に乗算する
   * (GAME_DESIGN §6.2 / IMPROVEMENTS §4 高)。クランプは呼び出し側で行う。
   * - q *= 1 + MOMENTUM_QUALITY_K·momentum(連続得点 + で微増、連続失点 − で微減)
   * - q *= 1 − PRESSURE_CHOKE_K·(pressureDrainMul − 1)·pressure
   *   (低 mental は pressureDrainMul>1 → 重圧で品質低下=choke、
   *    高 mental は <1 → 重圧で品質微上昇=clutch)
   * momentum=0 かつ pressure=0(または中立 mental で pressureDrainMul=1)では従来と完全一致。
   */
  private applyMomentumPressure(q: number, ctx: ControlContext): number {
    q *= 1 + MOMENTUM_QUALITY_K * ctx.momentum
    q *= 1 - PRESSURE_CHOKE_K * (this.mods.pressureDrainMul - 1) * ctx.pressure
    return q
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

  /**
   * 消費倍率 driveMul を返す(IMPROVEMENTS §5.2/5.5)。
   * driveMul = staminaDrainMul · (1 + (pressureDrainMul − 1)·pressure)
   * 移動・スプリント・打球コストの消費すべてに乗算する。
   */
  private driveMul(pressure: number): number {
    const p = Math.max(0, Math.min(1, pressure))
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
    const speed = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z)
    const drive = this.driveMul(pressure)
    // 基礎回復(クラッチ回復ボーナス込み)
    const regen = STAMINA_REGEN_IDLE * this.mods.staminaRegenMul * this.mods.clutchRecoveryMul
    // 移動量比例消費 + スプリント追加消費(スピード由来の移動燃費 moveEconomyMul を乗算)
    const drain =
      (STAMINA_MOVE_DRAIN_K * speed + (sprinting ? STAMINA_SPRINT_EXTRA : 0)) *
      drive *
      moveEconomyMul(this.mods.moveSpeedMul)
    const next = this.stamina + (regen - drain) * dt
    this.stamina = Math.max(0, Math.min(this.effStaminaMax, next))
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
      staminaPct: this.effStaminaMax > 0 ? this.stamina / this.effStaminaMax : 0,
      sprinting,
      swing: this.swingState,
      lastShot: this.lastShot,
      charging: this.charging,
      charge: this.charge,
      swingSide: this.swingSide,
      swingKind: this.swingKind,
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
