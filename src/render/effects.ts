// =============================================================================
// エフェクト: バウンスダストリング・ヒットフラッシュ
// SceneApi.spawnBounceFx / spawnHitFx を実装する。
// メッシュはオブジェクトプールで使い回す。
// =============================================================================
import * as THREE from 'three'
import type { SceneApi } from '../types'

// リングエフェクトのパラメータ
const BOUNCE_FX_DURATION = 0.45  // 秒
const BOUNCE_FX_MAX_SCALE = 3.0  // 最大スケール倍率
const BOUNCE_FX_POOL_SIZE = 6

// フラッシュエフェクトのパラメータ
const HIT_FX_DURATION = 0.22
const HIT_FX_MAX_SCALE = 1.2
const HIT_FX_POOL_SIZE = 4

// ジャストミート発光(金白)のパラメータ(IMPROVEMENTS §6.1.1 (A))
const JUST_FX_DURATION = 0.28
const JUST_FX_POOL_SIZE = 4
const JUST_FX_SPARK_COUNT = 6
const JUST_FX_RING_MAX = 1.1 // リング最大半径相当スケール(m)
const JUST_FX_SPARK_DIST = 0.9 // スパークが飛ぶ距離(m)
const JUST_FX_COLOR = 0xffe6a0 // 金白(チーム青赤・ボール黄と被らない特別色)

interface FxInstance {
  mesh: THREE.Mesh
  active: boolean
  timer: number
  duration: number
  startPos: THREE.Vector3
}

interface JustFxInstance {
  group: THREE.Group
  ring: THREE.Mesh
  sparks: THREE.Mesh[]
  /** スパークの放射方向(x-y 平面、初期化時に等間隔で固定) */
  sparkDirs: THREE.Vector3[]
  active: boolean
  timer: number
  startPos: THREE.Vector3
}

export class EffectSystem implements SceneApi {
  private readonly scene: THREE.Scene
  private bouncePool: FxInstance[] = []
  private hitPool: FxInstance[] = []
  private justPool: JustFxInstance[] = []

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.initBouncePool()
    this.initHitPool()
    this.initJustPool()
  }

  // ---------------------------------------------------------------------------
  // バウンスリングプール
  // ---------------------------------------------------------------------------
  private initBouncePool(): void {
    const ringGeo = new THREE.RingGeometry(0.08, 0.22, 20)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xd4956a,  // クレーコートの土埃色
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
    })

    for (let i = 0; i < BOUNCE_FX_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(ringGeo, ringMat.clone())
      mesh.rotation.x = -Math.PI / 2
      mesh.visible = false
      mesh.renderOrder = 10
      this.scene.add(mesh)
      this.bouncePool.push({
        mesh,
        active: false,
        timer: 0,
        duration: BOUNCE_FX_DURATION,
        startPos: new THREE.Vector3(),
      })
    }
  }

  // ---------------------------------------------------------------------------
  // ヒットフラッシュプール
  // ---------------------------------------------------------------------------
  private initHitPool(): void {
    const sphereGeo = new THREE.SphereGeometry(0.12, 8, 6)
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })

    for (let i = 0; i < HIT_FX_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(sphereGeo, flashMat.clone())
      mesh.visible = false
      mesh.renderOrder = 20
      this.scene.add(mesh)
      this.hitPool.push({
        mesh,
        active: false,
        timer: 0,
        duration: HIT_FX_DURATION,
        startPos: new THREE.Vector3(),
      })
    }
  }

  // ---------------------------------------------------------------------------
  // ジャストミート発光プール(金白のリング + スパーク。x-y 平面=カメラ向き)
  // ---------------------------------------------------------------------------
  private initJustPool(): void {
    const ringGeo = new THREE.RingGeometry(0.05, 0.13, 28)
    const sparkGeo = new THREE.SphereGeometry(0.035, 6, 5)
    const mat = new THREE.MeshBasicMaterial({
      color: JUST_FX_COLOR,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })

    for (let i = 0; i < JUST_FX_POOL_SIZE; i++) {
      const group = new THREE.Group()
      group.visible = false
      group.renderOrder = 25
      const ring = new THREE.Mesh(ringGeo, mat.clone())
      group.add(ring)
      const sparks: THREE.Mesh[] = []
      const dirs: THREE.Vector3[] = []
      for (let s = 0; s < JUST_FX_SPARK_COUNT; s++) {
        const sp = new THREE.Mesh(sparkGeo, mat.clone())
        group.add(sp)
        sparks.push(sp)
        const ang = (s / JUST_FX_SPARK_COUNT) * Math.PI * 2
        dirs.push(new THREE.Vector3(Math.cos(ang), Math.sin(ang), 0))
      }
      this.scene.add(group)
      this.justPool.push({ group, ring, sparks, sparkDirs: dirs, active: false, timer: 0, startPos: new THREE.Vector3() })
    }
  }

  // ---------------------------------------------------------------------------
  // SceneApi 実装
  // ---------------------------------------------------------------------------

  /** バウンド時のダストリングを発生させる */
  spawnBounceFx(pos: THREE.Vector3): void {
    const inst = this.getFreeInstance(this.bouncePool)
    if (!inst) return
    inst.active = true
    inst.timer = 0
    inst.startPos.copy(pos)
    inst.mesh.position.set(pos.x, 0.01, pos.z)
    inst.mesh.scale.setScalar(0.2)
    inst.mesh.visible = true
  }

  /** ヒット時の小フラッシュを発生させる */
  spawnHitFx(pos: THREE.Vector3): void {
    const inst = this.getFreeInstance(this.hitPool)
    if (!inst) return
    inst.active = true
    inst.timer = 0
    inst.startPos.copy(pos)
    inst.mesh.position.copy(pos)
    inst.mesh.scale.setScalar(0.1)
    inst.mesh.visible = true
  }

  /** ジャストミート成立時の発光リング+スパーク(金白)を接触点に発生させる */
  spawnJustMeetFx(pos: THREE.Vector3): void {
    let inst: JustFxInstance | null = null
    for (const x of this.justPool) {
      if (!x.active) { inst = x; break }
    }
    if (!inst) {
      // 満杯なら最古を再利用
      let maxT = -1
      for (const x of this.justPool) if (x.timer > maxT) { maxT = x.timer; inst = x }
    }
    if (!inst) return
    inst.active = true
    inst.timer = 0
    inst.startPos.copy(pos)
    inst.group.position.copy(pos)
    inst.group.visible = true
    inst.ring.scale.setScalar(0.4)
    for (const sp of inst.sparks) sp.position.set(0, 0, 0)
  }

  // ---------------------------------------------------------------------------
  // 毎フレーム更新
  // ---------------------------------------------------------------------------
  update(dt: number): void {
    this.updatePool(this.bouncePool, dt, BOUNCE_FX_DURATION, BOUNCE_FX_MAX_SCALE)
    this.updatePool(this.hitPool, dt, HIT_FX_DURATION, HIT_FX_MAX_SCALE)
    this.updateJustPool(dt)
  }

  /** ジャスト発光の更新: リングが急拡大して薄れ、スパークが外へ飛んで薄れる */
  private updateJustPool(dt: number): void {
    for (const inst of this.justPool) {
      if (!inst.active) continue
      inst.timer += dt
      const t = inst.timer / JUST_FX_DURATION
      if (t >= 1.0) {
        inst.active = false
        inst.group.visible = false
        continue
      }
      // イーズアウト気味の拡大(序盤に速く広がる)
      const ease = 1 - (1 - t) * (1 - t)
      const ringScale = 0.4 + JUST_FX_RING_MAX * ease
      inst.ring.scale.setScalar(ringScale)
      const opacity = 1.0 - t
      ;(inst.ring.material as THREE.MeshBasicMaterial).opacity = opacity
      const sparkDist = JUST_FX_SPARK_DIST * ease
      const sparkScale = 1.0 - t
      for (let s = 0; s < inst.sparks.length; s++) {
        const d = inst.sparkDirs[s]
        const sp = inst.sparks[s]
        sp.position.set(d.x * sparkDist, d.y * sparkDist, d.z * sparkDist)
        sp.scale.setScalar(Math.max(0.01, sparkScale))
        ;(sp.material as THREE.MeshBasicMaterial).opacity = opacity
      }
    }
  }

  private updatePool(
    pool: FxInstance[],
    dt: number,
    duration: number,
    maxScale: number,
  ): void {
    for (const inst of pool) {
      if (!inst.active) continue
      inst.timer += dt
      const t = inst.timer / duration
      if (t >= 1.0) {
        inst.active = false
        inst.mesh.visible = false
        continue
      }
      // スケールは 0→max(線形)、透明度は 1→0(線形フェードアウト)
      const scale = 0.2 + (maxScale - 0.2) * t
      inst.mesh.scale.setScalar(scale)
      const mat = inst.mesh.material as THREE.MeshBasicMaterial
      mat.opacity = (1.0 - t) * (inst.duration === BOUNCE_FX_DURATION ? 0.75 : 0.9)
    }
  }

  private getFreeInstance(pool: FxInstance[]): FxInstance | null {
    for (const inst of pool) {
      if (!inst.active) return inst
    }
    // プールが満杯の場合は最古の(timer 最大)ものを再利用
    let oldest: FxInstance | null = null
    let maxTimer = -1
    for (const inst of pool) {
      if (inst.timer > maxTimer) {
        maxTimer = inst.timer
        oldest = inst
      }
    }
    return oldest
  }
}
