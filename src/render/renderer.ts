// =============================================================================
// GameRenderer — Three.js レンダリング全体の入口
// ARCHITECTURE §12 に従い、constructor(canvas)・resize()・render(dt, world) を提供。
// SceneApi(spawnBounceFx / spawnHitFx)も実装して main に公開する。
// setMatchup(player, opponent) でペルソナ変更時にキャラクターを再構成する。
// =============================================================================
import * as THREE from 'three'
import type { SceneApi, WorldView, PersonaPhysique, PersonaAppearance } from '../types'
import { PLAYER_PERSONAS } from '../constants'
import { buildCourt, buildSkyDome } from './court'
import { BallEntity, CharacterEntity } from './entities'
import { CameraController } from './camera'
import { EffectSystem } from './effects'

/** setMatchup に渡すペルソナの見た目情報 */
export interface PersonaVisual {
  physique: PersonaPhysique
  appearance: PersonaAppearance
}

export class GameRenderer {
  // WebGL レンダラ
  private readonly renderer: THREE.WebGLRenderer
  // メインシーン
  private readonly scene: THREE.Scene
  // カメラコントローラ
  private readonly cameraCtrl: CameraController

  // エンティティ(setMatchup で差し替え可能なため readonly をはずす)
  private readonly ballEntity: BallEntity
  private playerEntity: CharacterEntity
  private opponentEntity: CharacterEntity

  // エフェクトシステム(SceneApi を実装)
  private readonly effects: EffectSystem

  constructor(canvas: HTMLCanvasElement) {
    // -------------------------------------------------------------------------
    // WebGLRenderer セットアップ
    // -------------------------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    // -------------------------------------------------------------------------
    // シーン
    // -------------------------------------------------------------------------
    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(0x1a1040, 80, 200)

    // -------------------------------------------------------------------------
    // ライティング
    // -------------------------------------------------------------------------
    // HemisphereLight: 空と地面からの環境光
    const hemi = new THREE.HemisphereLight(0xff9060, 0x443322, 0.6)
    this.scene.add(hemi)

    // DirectionalLight: 夕日方向から(影付き)
    const dirLight = new THREE.DirectionalLight(0xffd080, 1.8)
    dirLight.position.set(-20, 30, 15)
    dirLight.castShadow = true
    dirLight.shadow.mapSize.width = 1024
    dirLight.shadow.mapSize.height = 1024
    dirLight.shadow.camera.near = 0.1
    dirLight.shadow.camera.far = 80
    dirLight.shadow.camera.left = -20
    dirLight.shadow.camera.right = 20
    dirLight.shadow.camera.top = 20
    dirLight.shadow.camera.bottom = -20
    dirLight.shadow.bias = -0.001
    this.scene.add(dirLight)

    // -------------------------------------------------------------------------
    // 背景スカイドームとコート
    // -------------------------------------------------------------------------
    buildSkyDome(this.scene)
    buildCourt(this.scene)

    // -------------------------------------------------------------------------
    // カメラ
    // -------------------------------------------------------------------------
    this.cameraCtrl = new CameraController(canvas)

    // -------------------------------------------------------------------------
    // エンティティ: 初期ペルソナは sambrant(player) / sambrant(opponent) を使用。
    // setMatchup が呼ばれると適切なペルソナで再構成される。
    // -------------------------------------------------------------------------
    const defaultPlayerPersona   = PLAYER_PERSONAS['sambrant']
    const defaultOpponentPersona = PLAYER_PERSONAS['sambrant']

    this.ballEntity    = new BallEntity(this.scene)
    this.playerEntity  = new CharacterEntity(this.scene, {
      team:       'player',
      physique:   defaultPlayerPersona.physique,
      appearance: defaultPlayerPersona.appearance,
    })
    this.opponentEntity = new CharacterEntity(this.scene, {
      team:       'opponent',
      physique:   defaultOpponentPersona.physique,
      appearance: defaultOpponentPersona.appearance,
    })

    // -------------------------------------------------------------------------
    // エフェクトシステム
    // -------------------------------------------------------------------------
    this.effects = new EffectSystem(this.scene)
  }

  // ---------------------------------------------------------------------------
  // SceneApi: main から呼ばれるエフェクト発火
  // ---------------------------------------------------------------------------

  /** GameRenderer が実装する SceneApi を返す */
  get sceneApi(): SceneApi {
    return this.effects
  }

  // ---------------------------------------------------------------------------
  // 公開 API
  // ---------------------------------------------------------------------------

  /** キャンバスリサイズ時に呼ぶ。アスペクト比・サイズを更新する */
  resize(): void {
    const canvas = this.renderer.domElement
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    this.renderer.setSize(w, h, false)
    this.cameraCtrl.resize(canvas)
  }

  /**
   * ワールド座標をキャンバス上の CSS ピクセル座標へ投影する(UI オーバーレイ配置用)。
   * カメラの背後(画面外)にある場合は null を返す。
   */
  worldToScreen(world: THREE.Vector3): { x: number; y: number } | null {
    const cam = this.cameraCtrl.threeCamera
    const ndc = world.clone().project(cam)
    // z>1 はカメラ後方(背後)。画面に映らないので null。
    if (ndc.z > 1) return null
    const canvas = this.renderer.domElement
    const x = (ndc.x * 0.5 + 0.5) * canvas.clientWidth
    const y = (-ndc.y * 0.5 + 0.5) * canvas.clientHeight
    return { x, y }
  }

  /**
   * マッチ開始時に呼ぶ。両キャラクターを指定ペルソナで再構成する。
   * 旧メッシュはシーンから除去して破棄(dispose)し、新しいものを生成・追加する。
   * main.ts がマッチ設定を受け取った直後(startMatch など)に呼ぶ。
   *
   * @param player   プレイヤー側の外見情報(physique + appearance)
   * @param opponent 相手 AI 側の外見情報(physique + appearance)
   */
  setMatchup(player: PersonaVisual, opponent: PersonaVisual): void {
    // 旧エンティティをシーンから除去
    this.playerEntity.dispose(this.scene)
    this.opponentEntity.dispose(this.scene)

    // 新しい外見パラメータでキャラクターを再構成
    this.playerEntity = new CharacterEntity(this.scene, {
      team:       'player',
      physique:   player.physique,
      appearance: player.appearance,
    })
    this.opponentEntity = new CharacterEntity(this.scene, {
      team:       'opponent',
      physique:   opponent.physique,
      appearance: opponent.appearance,
    })
  }

  /**
   * 毎フレーム呼ぶ。WorldView に基づいてシーンを更新してレンダリングする。
   * @param dt 前フレームからの経過時間(秒)
   * @param world ゲームのワールドビュー
   */
  render(dt: number, world: WorldView): void {
    // カメラ更新
    this.cameraCtrl.update(dt, world)

    // エンティティ更新
    this.ballEntity.update(dt, world)
    this.playerEntity.update(dt, world.player)
    this.opponentEntity.update(dt, world.opponent)

    // エフェクト更新
    this.effects.update(dt)

    // 描画
    this.renderer.render(this.scene, this.cameraCtrl.threeCamera)
  }
}
