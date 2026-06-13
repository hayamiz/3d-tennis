// =============================================================================
// ボール物理エンジン(docs/ARCHITECTURE.md §5)
// 固定タイムステップ(PHYS_DT)でセミインプリシット・オイラー積分を行い、
// バウンス・ネット衝突を処理して BallEvent を返す。着地予測は状態コピーの
// 前方シミュレーションで実装する(解析解は使わない)。
// =============================================================================
import { Vector3 } from 'three'
import type { BallState, BallEvent, LandingPrediction, Side } from '../types'
import {
  GRAVITY,
  KD,
  KM,
  SPIN_DECAY,
  REST,
  BOUNCE_FRICTION,
  SPIN_BOUNCE,
  SPIN_BOUNCE_DECAY,
  NET_HEIGHT,
  NET_HALF_WIDTH,
  NET_RESTITUTION,
  NET_DAMP,
  BALL_RADIUS,
} from '../constants'

// 作業用ベクトル(GC 削減のため使い回す)
const _acc = new Vector3()
const _magnus = new Vector3()
const _prevPos = new Vector3()

/**
 * 1物理ステップぶんの積分・衝突処理を state に対して破壊的に適用し、
 * 発生した BallEvent を events に push する。
 * step() と predictLanding() の両方から呼ぶことで、本シミュレーションと
 * 予測シミュレーションの挙動を完全に一致させる。
 */
function integrate(state: BallState, dt: number, events: BallEvent[]): void {
  if (!state.inPlay) return

  const { pos, vel, spin } = state
  _prevPos.copy(pos)

  // --- 加速度: 重力 − 空気抵抗(2次)+ マグナス ---
  const speed = vel.length()
  // a = (0,-g,0) - KD*|v|*v + KM*(ω×v)
  _acc.set(0, -GRAVITY, 0)
  if (speed > 0) {
    _acc.x -= KD * speed * vel.x
    _acc.y -= KD * speed * vel.y
    _acc.z -= KD * speed * vel.z
  }
  _magnus.copy(spin).cross(vel).multiplyScalar(KM)
  _acc.add(_magnus)

  // セミインプリシット・オイラー: 先に速度、次に位置
  vel.addScaledVector(_acc, dt)
  pos.addScaledVector(vel, dt)

  // スピン減衰(指数)
  spin.multiplyScalar(Math.exp(-SPIN_DECAY * dt))

  // --- ネット衝突: z=0 平面を横切るフレーム ---
  // 前位置と現位置で z の符号が変わった(=横断した)かを判定
  if (_prevPos.z !== 0 && Math.sign(pos.z) !== Math.sign(_prevPos.z)) {
    // 横断点の y を線形補間で求める
    const t = _prevPos.z / (_prevPos.z - pos.z) // 0..1
    const crossY = _prevPos.y + (pos.y - _prevPos.y) * t
    const crossX = _prevPos.x + (pos.x - _prevPos.x) * t
    if (crossY < NET_HEIGHT && Math.abs(crossX) < NET_HALF_WIDTH) {
      // ネットに当たる: 横断点まで戻し、手前へ跳ね返す
      pos.x = crossX
      pos.y = crossY
      pos.z = 0
      vel.z = -NET_RESTITUTION * vel.z
      vel.x *= NET_DAMP
      vel.y *= NET_DAMP
      events.push({ kind: 'net' })
    }
  }

  // --- 地面バウンス: y ≤ BALL_RADIUS かつ vy < 0 ---
  if (pos.y <= BALL_RADIUS && vel.y < 0) {
    pos.y = BALL_RADIUS
    // 反発(鉛直)
    vel.y = -REST * vel.y
    // 水平摩擦
    vel.x *= 1 - BOUNCE_FRICTION
    vel.z *= 1 - BOUNCE_FRICTION
    // スピン→水平速度変換: 進行方向 d に対し (ω × ŷ) の水平成分を加える。
    // 規約 §5.4: ω = spinScalar·(d × ŷ) なので (ω × ŷ) = spinScalar·((d×ŷ)×ŷ) = -spinScalar·d_水平。
    // → トップスピン(spinScalar>0)は前方(d 方向)へ加速する向きになるよう符号を取る。
    const horizSpeed = Math.hypot(vel.x, vel.z)
    if (horizSpeed > 1e-4) {
      const dx = vel.x / horizSpeed
      const dz = vel.z / horizSpeed
      // (ω × ŷ): ŷ=(0,1,0) → ω×ŷ = (-ωz, 0, ωx)
      // 規約 ω = spinScalar·(ŷ × d) の下で、この水平射影は
      // トップスピン(spinScalar>0)で d 方向に正 → バウンド後に前進加速、
      // スライス(spinScalar<0)で負 → 失速、となる(§5.2 の意図どおり)。
      const cx = -spin.z
      const cz = spin.x
      // 水平進行方向への射影成分(トップスピンで前進・バックスピンで失速)
      const proj = cx * dx + cz * dz
      vel.x += dx * proj * SPIN_BOUNCE
      vel.z += dz * proj * SPIN_BOUNCE
    }
    // スピン残存
    spin.multiplyScalar(SPIN_BOUNCE_DECAY)
    state.bounceCount += 1
    // バウンド位置(コート平面上 y=0 として報告)
    events.push({ kind: 'bounce', pos: new Vector3(pos.x, 0, pos.z) })
  }
}

export class BallSim {
  state: BallState

  constructor(initial?: Partial<BallState>) {
    this.state = {
      pos: initial?.pos ? initial.pos.clone() : new Vector3(0, BALL_RADIUS, 0),
      vel: initial?.vel ? initial.vel.clone() : new Vector3(),
      spin: initial?.spin ? initial.spin.clone() : new Vector3(),
      bounceCount: initial?.bounceCount ?? 0,
      lastHitBy: initial?.lastHitBy ?? null,
      inPlay: initial?.inPlay ?? false,
    }
  }

  /** PHYS_DT 単位で呼ぶ。発生イベントの配列を返す。 */
  step(dt: number): BallEvent[] {
    const events: BallEvent[] = []
    integrate(this.state, dt, events)
    return events
  }

  /** 打球: 速度・スピンを設定し bounceCount リセット・inPlay 化・lastHitBy 設定。 */
  launch(pos: Vector3, vel: Vector3, spin: Vector3, hitBy: Side): void {
    this.state.pos.copy(pos)
    this.state.vel.copy(vel)
    this.state.spin.copy(spin)
    this.state.bounceCount = 0
    this.state.lastHitBy = hitBy
    this.state.inPlay = true
  }

  /**
   * 現在状態のコピーを前方シミュレーションし、次の地面バウンド位置と時刻を返す。
   * ネットに先に衝突した場合は null を返す。
   */
  predictLanding(maxTime = 8): LandingPrediction | null {
    // 状態を複製(本シミュレーションを汚さない)
    const sim: BallState = {
      pos: this.state.pos.clone(),
      vel: this.state.vel.clone(),
      spin: this.state.spin.clone(),
      bounceCount: 0,
      lastHitBy: this.state.lastHitBy,
      inPlay: true,
    }
    const dt = 1 / 120
    let t = 0
    const ev: BallEvent[] = []
    while (t < maxTime) {
      ev.length = 0
      integrate(sim, dt, ev)
      t += dt
      for (const e of ev) {
        if (e.kind === 'net') return null
        if (e.kind === 'bounce') {
          return { pos: e.pos.clone(), time: t }
        }
      }
    }
    return null
  }
}
