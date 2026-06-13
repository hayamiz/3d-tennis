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

interface FxInstance {
  mesh: THREE.Mesh
  active: boolean
  timer: number
  duration: number
  startPos: THREE.Vector3
}

export class EffectSystem implements SceneApi {
  private readonly scene: THREE.Scene
  private bouncePool: FxInstance[] = []
  private hitPool: FxInstance[] = []

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.initBouncePool()
    this.initHitPool()
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

  // ---------------------------------------------------------------------------
  // 毎フレーム更新
  // ---------------------------------------------------------------------------
  update(dt: number): void {
    this.updatePool(this.bouncePool, dt, BOUNCE_FX_DURATION, BOUNCE_FX_MAX_SCALE)
    this.updatePool(this.hitPool, dt, HIT_FX_DURATION, HIT_FX_MAX_SCALE)
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
