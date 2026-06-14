// =============================================================================
// カメラ制御
// - ゲーム中: プレイヤー後方上空からの追従カメラ(lerp)
// - メニュー中: コート全景をゆっくり旋回する俯瞰カメラ
// =============================================================================
import * as THREE from 'three'
import type { WorldView } from '../types'

// 追従カメラのオフセット(プレイヤーに対する相対位置)
// 'far' = 従来の俯瞰寄り、'near' = プレイヤー直後の主観寄り(視点切替)。
const FOLLOW_OFFSET_Y = 6.5
const FOLLOW_OFFSET_Z = 9.0
const NEAR_OFFSET_Y = 2.2
const NEAR_OFFSET_Z = 2.8

// lerp 係数: 位置
const POS_LERP = 3.0
// lerp 係数: 注視点
const TARGET_LERP = 5.0

// ボールと注視点の混合率(0=プレイヤーのみ、1=ボールのみ)
const BALL_LOOK_MIX = 0.35
// 主観視点はコート前方(ボール)寄りを多めに見る
const NEAR_BALL_LOOK_MIX = 0.6

export type CameraView = 'far' | 'near'

// メニュー旋回カメラのパラメータ
const MENU_RADIUS = 22.0
const MENU_HEIGHT = 14.0
const MENU_ORBIT_SPEED = 0.15  // rad/s

export class CameraController {
  private readonly camera: THREE.PerspectiveCamera
  private menuAngle = 0
  private view: CameraView = 'far'

  // 補間用の現在値
  private currentPos = new THREE.Vector3(0, FOLLOW_OFFSET_Y, FOLLOW_OFFSET_Z)
  private currentTarget = new THREE.Vector3(0, 0, 0)

  constructor(canvas: HTMLCanvasElement) {
    const aspect = canvas.width / canvas.height
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 500)
    this.camera.position.set(0, MENU_HEIGHT, MENU_RADIUS)
    this.camera.lookAt(0, 0, 0)
  }

  get threeCamera(): THREE.PerspectiveCamera {
    return this.camera
  }

  /** 視点モードを設定('far'=俯瞰寄り / 'near'=主観寄り) */
  setView(view: CameraView): void {
    this.view = view
  }

  getView(): CameraView {
    return this.view
  }

  /** キャンバスリサイズ時にアスペクト比を更新 */
  resize(canvas: HTMLCanvasElement): void {
    this.camera.aspect = canvas.clientWidth / canvas.clientHeight
    this.camera.updateProjectionMatrix()
  }

  /** 毎フレーム呼ぶ。WorldView に基づいてカメラを更新 */
  update(dt: number, world: WorldView): void {
    if (world.phase === 'menu') {
      this.updateMenuCamera(dt)
    } else {
      this.updateFollowCamera(dt, world)
    }
  }

  /** メニュー中: コートを俯瞰してゆっくり旋回 */
  private updateMenuCamera(dt: number): void {
    this.menuAngle += MENU_ORBIT_SPEED * dt
    const x = Math.sin(this.menuAngle) * MENU_RADIUS
    const z = Math.cos(this.menuAngle) * MENU_RADIUS

    const targetPos = new THREE.Vector3(x, MENU_HEIGHT, z)
    this.currentPos.lerp(targetPos, 0.8 * dt)
    this.currentTarget.lerp(new THREE.Vector3(0, 0, 0), 2 * dt)

    this.camera.position.copy(this.currentPos)
    this.camera.lookAt(this.currentTarget)
  }

  /** ゲーム中: プレイヤー後方追従カメラ */
  private updateFollowCamera(dt: number, world: WorldView): void {
    const playerPos = world.player.pos
    const ballPos = world.ball.pos
    const near = this.view === 'near'

    // 目標カメラ位置: プレイヤーの後方。near はすぐ後ろ・低め(主観寄り)、far は後方上空。
    const offY = near ? NEAR_OFFSET_Y : FOLLOW_OFFSET_Y
    const offZ = near ? NEAR_OFFSET_Z : FOLLOW_OFFSET_Z
    const followX = near ? 1.0 : 0.5 // near はプレイヤー真後ろ、far は横揺れを半分に抑える
    const desiredPos = new THREE.Vector3(
      playerPos.x * followX,
      offY,
      playerPos.z + offZ,
    )

    // 注視点: プレイヤーとボールの混合(near はコート前方=ボール寄りを多めに見る)
    const lookMix = near ? NEAR_BALL_LOOK_MIX : BALL_LOOK_MIX
    const lookX = playerPos.x + (ballPos.x - playerPos.x) * lookMix
    const lookY = near
      ? 1.1 + ballPos.y * 0.15 // 主観: コート前方をやや見下ろす高さ
      : (playerPos.y + ballPos.y) * 0.5 * BALL_LOOK_MIX + 0.5
    const lookZ = playerPos.z + (ballPos.z - playerPos.z) * lookMix
    const desiredTarget = new THREE.Vector3(lookX, lookY, lookZ)

    // lerp 補間
    this.currentPos.lerp(desiredPos, POS_LERP * dt)
    this.currentTarget.lerp(desiredTarget, TARGET_LERP * dt)

    this.camera.position.copy(this.currentPos)
    this.camera.lookAt(this.currentTarget)
    this.camera.updateProjectionMatrix()
  }
}
