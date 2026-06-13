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

// ---------------------------------------------------------------------------
// オープンコート床ハイライト(IMPROVEMENTS §4 高)
// WorldView.openCourt が non-null のとき、指定ワールド座標に「光る床グロー」を表示。
// リング(RingGeometry) + ソフトグロー(Sprite) の2層構成で脈動させる。
// メッシュは1つずつ生成し使い回す(毎フレーム生成しない)。
// ---------------------------------------------------------------------------

/** コート面 y 座標(ライン面より僅かに上で z ファイティング防止) */
const OC_Y = 0.022

/** リングの基準外径(m)。strength=1 のときこのサイズになる */
const OC_RING_OUTER = 1.6
/** リングの幅(内径 = 外径 × この係数) */
const OC_RING_INNER_RATIO = 0.68

/** グロー Sprite の基準サイズ(m)。strength=1 のとき */
const OC_GLOW_SIZE = 3.2

/** ハイライトの基色(黄緑〜シアン系の「狙い目」を示す色) */
const OC_COLOR_HEX = 0x40ffcc

/** 脈動の角速度(rad/s)。ゆったりとした周期 */
const OC_PULSE_SPEED = 3.5

/**
 * オープンコートの床ハイライトエンティティ。
 * GameRenderer のコンストラクタで1度だけ生成し、render() ごとに更新する。
 */
class OpenCourtHighlight {
  /** 外側リングメッシュ */
  private readonly ring: THREE.Mesh
  /** 内側ソフトグロー(Sprite) */
  private readonly glow: THREE.Sprite
  /** 脈動の位相(rad) */
  private pulsePhase = 0

  constructor(scene: THREE.Scene) {
    // ----- リング -----
    // RingGeometry(内径, 外径, セグメント数)。内径/外径は後でスケールで調整するため
    // ここでは正規化サイズ(内径比を反映)で生成する。
    const innerR = OC_RING_OUTER * OC_RING_INNER_RATIO
    const ringGeo = new THREE.RingGeometry(innerR, OC_RING_OUTER, 40)
    const ringMat = new THREE.MeshBasicMaterial({
      color: OC_COLOR_HEX,
      transparent: true,
      opacity: 0.0,  // 初期は非表示; update() で設定
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.ring = new THREE.Mesh(ringGeo, ringMat)
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = OC_Y
    this.ring.visible = false
    scene.add(this.ring)

    // ----- ソフトグロー Sprite -----
    const glowTex = makeOpenCourtGlowTexture()
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: OC_COLOR_HEX,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.0,  // 初期は非表示; update() で設定
    })
    this.glow = new THREE.Sprite(glowMat)
    this.glow.scale.setScalar(OC_GLOW_SIZE)
    this.glow.visible = false
    scene.add(this.glow)
  }

  /**
   * 毎フレーム呼ぶ。openCourt が null なら非表示、non-null なら位置・強度・脈動を更新。
   * @param dt フレーム時間(秒)
   * @param openCourt WorldView.openCourt の値
   */
  update(dt: number, openCourt: { x: number; z: number; strength: number } | null): void {
    if (!openCourt) {
      // null: 非表示にして早期リターン
      this.ring.visible = false
      this.glow.visible = false
      return
    }

    const { x, z, strength } = openCourt
    // strength は 0..1。0 に近いほど目立たなく、1 で最大
    const s = Math.max(0, Math.min(1, strength))

    // 脈動: sin 波で不透明度とスケールを緩く上下
    this.pulsePhase += dt * OC_PULSE_SPEED
    const pulse = 0.5 + 0.5 * Math.sin(this.pulsePhase) // 0..1

    // 不透明度: strength × 脈動(リングは強め、グローは柔らかく)
    const ringOpacity = s * (0.55 + 0.35 * pulse)
    const glowOpacity = s * (0.18 + 0.12 * pulse)

    // スケール: strength に応じてリングを拡縮(大きく空くほど目立つ)
    const scaleMul = 0.6 + 0.4 * s + 0.06 * pulse

    // ----- リング更新 -----
    this.ring.position.set(x, OC_Y, z)
    this.ring.scale.setScalar(scaleMul)
    ;(this.ring.material as THREE.MeshBasicMaterial).opacity = ringOpacity
    this.ring.visible = true

    // ----- グロー更新 -----
    // Sprite は y を OC_Y に合わせて浮かせる(Sprite はビルボードなので y も指定)
    this.glow.position.set(x, OC_Y + 0.01, z)
    this.glow.scale.setScalar(OC_GLOW_SIZE * scaleMul)
    ;(this.glow.material as THREE.SpriteMaterial).opacity = glowOpacity
    this.glow.visible = true
  }

  /** シーンから除去 */
  dispose(scene: THREE.Scene): void {
    scene.remove(this.ring)
    scene.remove(this.glow)
  }
}

/** オープンコートグロー用の放射グラデーションテクスチャを生成する(1度だけ呼ぶ) */
function makeOpenCourtGlowTexture(): THREE.Texture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width  = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  // 中心から外へ向かって白→透明の放射グラデーション
  const grad = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2,
  )
  grad.addColorStop(0.0,  'rgba(255,255,255,0.90)')
  grad.addColorStop(0.30, 'rgba(255,255,255,0.45)')
  grad.addColorStop(0.65, 'rgba(255,255,255,0.12)')
  grad.addColorStop(1.0,  'rgba(255,255,255,0.00)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

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

  // オープンコート床ハイライト(IMPROVEMENTS §4 高)
  private readonly openCourtHighlight: OpenCourtHighlight

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

    // -------------------------------------------------------------------------
    // オープンコート床ハイライト(IMPROVEMENTS §4 高)
    // -------------------------------------------------------------------------
    this.openCourtHighlight = new OpenCourtHighlight(this.scene)
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

    // オープンコート床ハイライト更新(IMPROVEMENTS §4 高)
    // WorldView.openCourt が non-null のとき指定位置に光る床グローを表示する。
    this.openCourtHighlight.update(dt, world.openCourt)

    // エフェクト更新
    this.effects.update(dt)

    // 描画
    this.renderer.render(this.scene, this.cameraCtrl.threeCamera)
  }
}
