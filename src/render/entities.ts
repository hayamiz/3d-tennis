// =============================================================================
// ボール・プレイヤー・AI エンティティのレンダリング
// ボール: 黄スフィア(BALL_VISUAL_SCALE 倍)+ 発光ハロー(加算合成)
//        + 長く太い残像トレイル(加算合成)+ 着地予測リング + 強調グラウンドマーカー
// プレイヤー/AI: 頭・胴体・腰・両腕(上腕+前腕)・両脚を持つローポリ人型。
//        利き手(右)にラケット。フォア/バックの振り分け・チャージテイクバック・走り footwork。
//        ペルソナの体格・外見・チームカラーでパラメータ化(IMPROVEMENTS §3.6-3.7)。
//        発汗パーティクル + 疲労サイン(IMPROVEMENTS §5.8(B))。
// =============================================================================
import * as THREE from 'three'
import type { WorldView, PlayerView, Side, PersonaPhysique, PersonaAppearance } from '../types'
import {
  BALL_RADIUS, BALL_VISUAL_SCALE, CHARGE_MAX, BASE_HEIGHT_M, TEAM_PALETTE,
  STAMINA_SWEAT_START, STAMINA_SWEAT_MAX_RATE,
} from '../constants'

// ボール描画半径(視認性のため実寸より大きく描く)
const BALL_DRAW_RADIUS = BALL_RADIUS * BALL_VISUAL_SCALE

// トレイル残像の最大数(長く見せるため増量)
const TRAIL_LENGTH = 26
// 1トレイル要素の最大持続時間(秒)
const TRAIL_LIFETIME = 0.16
// トレイル要素の基準太さ(ボール描画半径に対する倍率)
const TRAIL_BASE_RADIUS = BALL_DRAW_RADIUS * 0.85

// 発光ハロー半径(ボール描画半径の倍率)
const HALO_RADIUS = BALL_DRAW_RADIUS * 2.8

// 着地予測リングの基準半径(m)
const LANDING_RING_RADIUS = 0.4

// ジャストミート飛行着色(§6.1.1 (B))。既定色 ↔ 金色を timer で補間する。
const JUST_BALL_FLASH_TIME = 0.35 // 秒
const JUST_GOLD = new THREE.Color(0xffcf6a)
const BALL_EMISSIVE_DEFAULT = new THREE.Color(0xb8d000) // 本体 emissive 既定
const HALO_COLOR_DEFAULT = new THREE.Color(0xffffff) // ハロー Sprite の color 既定(白×金テクスチャ)
const TRAIL_COLOR_DEFAULT = new THREE.Color(0xeaff5a) // トレイル既定色

// ---------------------------------------------------------------------------
// プレイヤーモデルの基準寸法(m)。これらが「r=3(標準)時の形状」。
// 実際には PersonaPhysique(heightM/build)をもとにスケール値を求め、
// ジオメトリ生成時に乗算することで体格差を出す。
// ---------------------------------------------------------------------------
const HIP_Y       = 0.92  // 腰(脚と胴の境)の高さ
const TORSO_H     = 0.52  // 胴体の高さ
const TORSO_R     = 0.16  // 胴体の半径
const HIP_R       = 0.17  // 腰の半径
const HEAD_R      = 0.13  // 頭半径
const NECK_H      = 0.06  // 首の高さ
const SHOULDER_Y  = HIP_Y + TORSO_H  // 肩の高さ
const SHOULDER_X  = 0.19  // 肩の左右オフセット
const UPPER_ARM_LEN = 0.26  // 上腕長
const FORE_ARM_LEN  = 0.24  // 前腕長
const ARM_R       = 0.045 // 腕の太さ
const HIP_X       = 0.1   // 股関節の左右オフセット
const THIGH_LEN   = 0.46  // 大腿長
const SHIN_LEN    = 0.44  // 下腿長
const LEG_R       = 0.06  // 脚の太さ
const RACKET_RING_R    = 0.13  // ラケットフレーム半径
const RACKET_HANDLE_LEN = 0.22 // グリップ長

// ---------------------------------------------------------------------------
// 体格(build)→ 太さスケール係数。胴・手足の半径系に乗算する。
// slim は細く、stocky は太く、athletic は基準(1.0)。
// ---------------------------------------------------------------------------
const BUILD_GIRTH: Record<PersonaPhysique['build'], number> = {
  slim:     0.82,
  athletic: 1.0,
  stocky:   1.22,
}

/** トレイル要素(プールで使い回す) */
interface TrailPoint {
  mesh: THREE.Mesh
  life: number
}

/** ボール + ハロー + トレイル + 着地マーカー + 強調グラウンドマーカーのグループ */
export class BallEntity {
  readonly group: THREE.Group
  private readonly scene: THREE.Scene
  private readonly sphere: THREE.Mesh
  private readonly halo: THREE.Sprite
  // 真下グラウンドマーカー: 塗り潰し丸影 + 輪郭リング
  private readonly shadow: THREE.Mesh
  private readonly shadowRing: THREE.Mesh
  // 着地予測リング(脈動)
  private readonly landingRing: THREE.Mesh
  private trail: TrailPoint[] = []
  // トレイルジオメトリ/マテリアルは使い回す(フレーム毎生成しない)
  private readonly trailGeo: THREE.SphereGeometry
  private readonly trailMat: THREE.MeshBasicMaterial
  private pulse = 0 // 着地リングの脈動位相
  // ジャストミート(§6.1.1 (B)): 成立打球は飛行中ハロー/本体/トレイルを金色に着色
  private justFlashTimer = 0

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.group = new THREE.Group()
    scene.add(this.group)

    // -------------------------------------------------------------------------
    // ボール本体(黄色、発光気味の emissive)。BALL_VISUAL_SCALE 倍で描画。
    // -------------------------------------------------------------------------
    const geo = new THREE.SphereGeometry(BALL_DRAW_RADIUS, 16, 12)
    const mat = new THREE.MeshStandardMaterial({
      color: 0xe6f24a,
      emissive: 0xb8d000,
      emissiveIntensity: 0.6,
      roughness: 0.55,
    })
    this.sphere = new THREE.Mesh(geo, mat)
    this.sphere.castShadow = true
    this.group.add(this.sphere)

    // -------------------------------------------------------------------------
    // 発光ハロー(加算合成の円形グラデーション Sprite)
    // -------------------------------------------------------------------------
    const haloTex = makeRadialTexture(0xfff4a0)
    const haloMat = new THREE.SpriteMaterial({
      map: haloTex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
    })
    this.halo = new THREE.Sprite(haloMat)
    this.halo.scale.setScalar(HALO_RADIUS * 2)
    this.group.add(this.halo)

    // -------------------------------------------------------------------------
    // 真下グラウンドマーカー(塗り潰し丸影 + 輪郭リングで視認性アップ)
    // -------------------------------------------------------------------------
    const shadowGeo = new THREE.CircleGeometry(BALL_DRAW_RADIUS * 3, 20)
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    })
    this.shadow = new THREE.Mesh(shadowGeo, shadowMat)
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.position.y = 0.005
    scene.add(this.shadow)

    const ringGeo = new THREE.RingGeometry(BALL_DRAW_RADIUS * 3, BALL_DRAW_RADIUS * 3.8, 24)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xfffbe0,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    this.shadowRing = new THREE.Mesh(ringGeo, ringMat)
    this.shadowRing.rotation.x = -Math.PI / 2
    this.shadowRing.position.y = 0.006
    scene.add(this.shadowRing)

    // -------------------------------------------------------------------------
    // 着地予測リング(WorldView.landing 非 null 時のみ表示・脈動)
    // -------------------------------------------------------------------------
    const landGeo = new THREE.RingGeometry(LANDING_RING_RADIUS * 0.62, LANDING_RING_RADIUS, 32)
    const landMat = new THREE.MeshBasicMaterial({
      color: 0xffe24a,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.landingRing = new THREE.Mesh(landGeo, landMat)
    this.landingRing.rotation.x = -Math.PI / 2
    this.landingRing.position.y = 0.012
    this.landingRing.visible = false
    scene.add(this.landingRing)

    // -------------------------------------------------------------------------
    // トレイル用ジオメトリ/マテリアル(加算合成)。clone せず共有して使い回す。
    // -------------------------------------------------------------------------
    this.trailGeo = new THREE.SphereGeometry(TRAIL_BASE_RADIUS, 8, 6)
    this.trailMat = new THREE.MeshBasicMaterial({
      color: 0xeaff5a,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  }

  /**
   * ジャストミート成立打球の発光開始(§6.1.1 (B))。一定時間ハロー/本体/トレイルを金色に。
   * main が打球時に呼ぶ。
   */
  flashJust(): void {
    this.justFlashTimer = JUST_BALL_FLASH_TIME
  }

  /** ジャスト着色の適用(timer>0 の間、金色へ寄せる。0 で既定色へ戻す) */
  private applyJustTint(dt: number): void {
    if (this.justFlashTimer > 0) this.justFlashTimer = Math.max(0, this.justFlashTimer - dt)
    const k = this.justFlashTimer > 0 ? this.justFlashTimer / JUST_BALL_FLASH_TIME : 0
    const sphereMat = this.sphere.material as THREE.MeshStandardMaterial
    const haloMat = this.halo.material as THREE.SpriteMaterial
    if (k > 0) {
      sphereMat.emissive.lerpColors(BALL_EMISSIVE_DEFAULT, JUST_GOLD, k)
      sphereMat.emissiveIntensity = 0.6 + 0.5 * k
      haloMat.color.lerpColors(HALO_COLOR_DEFAULT, JUST_GOLD, k)
      this.trailMat.color.lerpColors(TRAIL_COLOR_DEFAULT, JUST_GOLD, k)
    } else {
      sphereMat.emissive.copy(BALL_EMISSIVE_DEFAULT)
      sphereMat.emissiveIntensity = 0.6
      haloMat.color.copy(HALO_COLOR_DEFAULT)
      this.trailMat.color.copy(TRAIL_COLOR_DEFAULT)
    }
  }

  /** ワールドビューでボール位置を更新し、各種マーカー・トレイルを更新 */
  update(dt: number, world: WorldView): void {
    const bpos = world.ball.pos
    this.group.position.set(bpos.x, bpos.y, bpos.z)
    this.applyJustTint(dt)

    // 擬似影 + 輪郭リングをボール真下に投影(高さに応じ縮小・淡化)
    const shadowScale = Math.max(0.25, 1.0 - bpos.y * 0.07)
    this.shadow.position.set(bpos.x, 0.005, bpos.z)
    this.shadow.scale.set(shadowScale, shadowScale, 1)
    ;(this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.06, 0.4 * shadowScale)
    this.shadowRing.position.set(bpos.x, 0.006, bpos.z)
    this.shadowRing.scale.set(shadowScale, shadowScale, 1)
    ;(this.shadowRing.material as THREE.MeshBasicMaterial).opacity = Math.max(0.1, 0.55 * shadowScale)

    // 着地予測リング: landing 非 null のとき表示し脈動
    this.updateLandingRing(dt, world)

    // 速度に応じたトレイル(速いほど太く長く明るい)
    if (world.ball.inPlay) {
      const speed = Math.sqrt(world.ball.vel.x ** 2 + world.ball.vel.y ** 2 + world.ball.vel.z ** 2)
      this.addTrailPoint(bpos, speed)
    }
    this.updateTrail(dt)
  }

  /** 着地予測リングの更新。ボールが近づくほどリングが縮み明滅が速くなる */
  private updateLandingRing(dt: number, world: WorldView): void {
    const landing = world.landing
    if (!landing) {
      this.landingRing.visible = false
      return
    }
    this.landingRing.visible = true
    const lp = landing.pos
    this.landingRing.position.set(lp.x, 0.012, lp.z)

    // 相手の打球か自分の打球かで色を変える(player=青寄り, opponent=赤寄り)
    const mat = this.landingRing.material as THREE.MeshBasicMaterial
    if (world.ball.lastHitBy === 'opponent') {
      mat.color.setHex(0xff5a4a) // 相手の打球: 警告寄りの赤
    } else {
      mat.color.setHex(0x5ad0ff) // 自分の打球: 青系
    }

    // 着地までの時間が短いほど脈動を速く・リングを小さく
    const t = Math.max(0, Math.min(1, landing.time / 1.2)) // 1.2秒で正規化
    const pulseSpeed = THREE.MathUtils.lerp(14, 5, t) // 近いほど速い
    this.pulse += dt * pulseSpeed
    const blink = 0.5 + 0.5 * Math.sin(this.pulse)
    // 近いほどリングを縮める(0.6〜1.0 倍)
    const ringScale = THREE.MathUtils.lerp(0.6, 1.0, t)
    this.landingRing.scale.set(ringScale, ringScale, 1)
    mat.opacity = 0.35 + 0.5 * blink
  }

  private addTrailPoint(pos: THREE.Vector3, speed: number): void {
    // プールが上限を超えたら最古を再利用(ジオメトリ/マテリアルは共有)
    let tp: TrailPoint
    if (this.trail.length >= TRAIL_LENGTH) {
      tp = this.trail.shift()!
      tp.life = TRAIL_LIFETIME
      tp.mesh.position.set(pos.x, pos.y, pos.z)
    } else {
      const mesh = new THREE.Mesh(this.trailGeo, this.trailMat)
      mesh.position.set(pos.x, pos.y, pos.z)
      mesh.renderOrder = -1
      this.scene.add(mesh)
      tp = { mesh, life: TRAIL_LIFETIME }
    }
    // 速度に応じて太く(20m/s で約 1.6 倍まで)
    const speedFactor = 1.0 + Math.min(speed / 20, 1.0) * 0.6
    ;(tp.mesh as THREE.Mesh).userData.speedFactor = speedFactor
    this.trail.push(tp)
  }

  private updateTrail(dt: number): void {
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const tp = this.trail[i]
      tp.life -= dt
      if (tp.life <= 0) {
        this.scene.remove(tp.mesh)
        this.trail.splice(i, 1)
      } else {
        const alpha = tp.life / TRAIL_LIFETIME
        // 加算合成のため scale で明るさ・太さを表現、マテリアルは共有なので
        // 各メッシュ個別の透明度は scale で擬似的に表現する
        const speedFactor = (tp.mesh.userData.speedFactor as number) ?? 1.0
        const s = (0.35 + 0.65 * alpha) * speedFactor
        tp.mesh.scale.setScalar(s)
        tp.mesh.visible = alpha > 0.04
      }
    }
  }

  /** シーンから全要素を除去 */
  dispose(scene: THREE.Scene): void {
    scene.remove(this.group)
    scene.remove(this.shadow)
    scene.remove(this.shadowRing)
    scene.remove(this.landingRing)
    for (const tp of this.trail) {
      scene.remove(tp.mesh)
    }
    this.trail = []
  }
}

// ---------------------------------------------------------------------------
// 円形グラデーションテクスチャ生成(発光ハロー用)。1度だけ生成する。
// ---------------------------------------------------------------------------
function makeRadialTexture(colorHex: number): THREE.Texture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const c = new THREE.Color(colorHex)
  const r = Math.round(c.r * 255)
  const g = Math.round(c.g * 255)
  const b = Math.round(c.b * 255)
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0.0, `rgba(${r},${g},${b},0.9)`)
  grad.addColorStop(0.35, `rgba(${r},${g},${b},0.45)`)
  grad.addColorStop(1.0, `rgba(${r},${g},${b},0.0)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------
// 発汗パーティクル定数(IMPROVEMENTS §5.8(B))
// ---------------------------------------------------------------------------
/** 発汗滴プールの最大数。高い pct のときは大半が非アクティブ */
const SWEAT_POOL_SIZE = 48
/** 滴1粒の最大生存時間(秒)。重力で落ちながらフェード */
const SWEAT_DROP_LIFETIME = 0.75
/** 重力加速度(滴にだけ効く。通常重力より少し弱く "水滴が飛ぶ" 感) */
const SWEAT_GRAVITY = 6.5
/** 放出時の初速(m/s)の乱数範囲。頭・肩から外側へ散らす */
const SWEAT_INIT_SPEED = 0.9

/** 汗滴1粒の状態 */
interface SweatDrop {
  mesh: THREE.Mesh
  active: boolean
  /** 現在位置(ワールド座標) */
  pos: THREE.Vector3
  /** 速度(ワールド座標) */
  vel: THREE.Vector3
  /** 残り生存時間(秒) */
  life: number
  /** 最大生存時間(初期化時に設定) */
  maxLife: number
}

// ---------------------------------------------------------------------------
// CharacterEntity 構築用オプション型
// ---------------------------------------------------------------------------
export interface CharacterEntityOptions {
  /** 陣営(1P=player/青系、2P=opponent/赤系) */
  team: Side
  /** 体格パラメータ(身長・体格・利き手) */
  physique: PersonaPhysique
  /** 外見パラメータ(髪型・袖・アクセント色) */
  appearance: PersonaAppearance
}

/**
 * プレイヤー / AI キャラクターのエンティティ。
 * 頭・胴体・腰・両腕(上腕+前腕)・両脚を持つ人型。利き手(右)にラケット。
 *
 * コンストラクタは `{ team, physique, appearance }` を受け取り、
 * チームカラー・体格(身長/体格)・外見(髪/袖/アクセント)を反映する。
 * ARCHITECTURE §12 / IMPROVEMENTS §3.6-3.7 参照。
 */
export class CharacterEntity {
  readonly group: THREE.Group

  // 体の各パーツ
  private readonly torso: THREE.Mesh
  private readonly hips: THREE.Mesh
  private readonly head: THREE.Group // 首から上をまとめて傾けられるよう Group

  // 利き腕(右): 肩ピボット → 上腕 → 肘ピボット → 前腕 → 手(ラケット)
  private readonly rShoulder: THREE.Group
  private readonly rElbow: THREE.Group
  private readonly racketPivot: THREE.Group

  // 非利き腕(左)
  private readonly lShoulder: THREE.Group
  private readonly lElbow: THREE.Group

  // 両脚: 股関節ピボット → 大腿 → 膝ピボット → 下腿
  private readonly rHip: THREE.Group
  private readonly lHip: THREE.Group
  private readonly rKnee: THREE.Group
  private readonly lKnee: THREE.Group

  // スイングアニメ進行
  private swingPhase = 0 // 0=idle, 0..1 テイクバック→フォロースルーの正規化進行
  private swinging = false
  private swingDir: 'fore' | 'back' = 'fore'
  private swingSmash = false // このスイングがスマッシュ(オーバーヘッド)か
  private whiffAngle = 0
  private footCycle = 0 // 走りモーションの位相
  private chargeShake = 0 // オーバーチャージの震え位相

  // ---------------------------------------------------------------------------
  // 発汗エミッタ(IMPROVEMENTS §5.8(B))
  // ---------------------------------------------------------------------------
  /** 汗滴1粒の状態(プール) */
  private sweatDrops: SweatDrop[] = []
  /** 汗滴の共有ジオメトリ(コンストラクタで1回生成) */
  private readonly sweatGeo: THREE.SphereGeometry
  /** 汗滴の共有マテリアル(加算合成。コンストラクタで1回生成) */
  private readonly sweatMat: THREE.MeshBasicMaterial
  /** 発汗タイマー: 次の放出までの残り秒数 */
  private sweatTimer = 0
  /** 疲労呼吸位相(胴体上下脈動) */
  private breathPhase = 0
  /** キャラの肩高さ(発汗放出位置の計算用。コンストラクタで設定) */
  private readonly shoulderWorldY: number
  /** キャラの頭頂高さ(発汗放出位置の計算用) */
  private readonly headTopWorldY: number
  /** 体格に応じた肩幅オフセット(発汗放出位置の計算用) */
  private readonly shoulderWorldX: number
  /** 胴体の初期 y 位置(呼吸脈動の基準値) */
  private readonly torsoBaseY: number

  constructor(scene: THREE.Scene, opts: CharacterEntityOptions) {
    this.group = new THREE.Group()
    scene.add(this.group)

    // -------------------------------------------------------------------------
    // スケール値の計算
    // heightScale: heightM/BASE_HEIGHT_M を縦方向スケール比として全パーツ高さに乗算
    // girthScale: build に基づく太さスケール(ジオメトリ半径系に乗算)
    // -------------------------------------------------------------------------
    const heightScale = opts.physique.heightM / BASE_HEIGHT_M
    const girthScale  = BUILD_GIRTH[opts.physique.build]

    // スケール後の局所寸法
    const hipY      = HIP_Y      * heightScale
    const torsoH    = TORSO_H    * heightScale
    const torsoR    = TORSO_R    * girthScale
    const hipR      = HIP_R      * girthScale
    const headR     = HEAD_R     * heightScale
    const neckH     = NECK_H     * heightScale
    const shoulderY = hipY + torsoH
    const shoulderX = SHOULDER_X * girthScale
    const upperArmLen = UPPER_ARM_LEN * heightScale
    const foreArmLen  = FORE_ARM_LEN  * heightScale
    const armR      = ARM_R     * girthScale
    const hipX      = HIP_X     * girthScale
    const thighLen  = THIGH_LEN * heightScale
    const shinLen   = SHIN_LEN  * heightScale
    const legR      = LEG_R     * girthScale
    const racketRingR    = RACKET_RING_R     // ラケットはモデル寸法に依存しないため固定
    const racketHandleLen = RACKET_HANDLE_LEN // 同上

    // -------------------------------------------------------------------------
    // チームカラー: TEAM_PALETTE[team] から body/limb/trim を取得
    // -------------------------------------------------------------------------
    const palette  = TEAM_PALETTE[opts.team]
    const skinColor  = 0xf0d090
    const accentColor = opts.appearance.accent

    const bodyMat   = new THREE.MeshLambertMaterial({ color: palette.body })
    const limbMat   = new THREE.MeshLambertMaterial({ color: palette.limb })
    const skinMat   = new THREE.MeshLambertMaterial({ color: skinColor })
    const accentMat = new THREE.MeshLambertMaterial({ color: accentColor })
    // 上腕の素材: sleeved=ユニ色(limb)、sleeveless=肌色
    const upperArmMat = opts.appearance.sleeves === 'sleeved' ? limbMat : skinMat

    // -------------------------------------------------------------------------
    // 胴体・腰
    // -------------------------------------------------------------------------
    const torsoGeo = new THREE.CylinderGeometry(torsoR * 0.85, torsoR, torsoH, 12)
    this.torso = new THREE.Mesh(torsoGeo, bodyMat)
    this.torso.position.y = hipY + torsoH / 2
    this.torso.castShadow = true
    this.group.add(this.torso)

    const hipsGeo = new THREE.SphereGeometry(hipR, 12, 8)
    this.hips = new THREE.Mesh(hipsGeo, bodyMat)
    this.hips.position.y = hipY
    this.hips.scale.set(1, 0.7, 0.8)
    this.hips.castShadow = true
    this.group.add(this.hips)

    // -------------------------------------------------------------------------
    // 首 + 頭(Group でまとめる)
    // -------------------------------------------------------------------------
    this.head = new THREE.Group()
    this.head.position.y = shoulderY
    this.group.add(this.head)

    const neckGeo = new THREE.CylinderGeometry(0.05 * heightScale, 0.06 * heightScale, neckH, 8)
    const neck = new THREE.Mesh(neckGeo, skinMat)
    neck.position.y = neckH / 2
    this.head.add(neck)

    const headGeo = new THREE.SphereGeometry(headR, 14, 10)
    const headMesh = new THREE.Mesh(headGeo, skinMat)
    headMesh.position.y = neckH + headR
    headMesh.castShadow = true
    this.head.add(headMesh)

    // 髪型フィーチャーを headMesh の位置基準で追加
    this.buildHair(opts.appearance.hair, headR, neckH, accentMat, accentColor)

    // -------------------------------------------------------------------------
    // 両腕(利き手=右=世界 +x 側を肩オフセット +shoulderX で表現)
    // 肩ピボット(group)→上腕メッシュ(下向き)→肘ピボット(下端)→前腕メッシュ
    // -------------------------------------------------------------------------
    const rArm = this.buildArm(upperArmMat, skinMat, +shoulderX, shoulderY, upperArmLen, foreArmLen, armR)
    this.rShoulder = rArm.shoulder
    this.rElbow    = rArm.elbow
    this.group.add(this.rShoulder)

    const lArm = this.buildArm(upperArmMat, skinMat, -shoulderX, shoulderY, upperArmLen, foreArmLen, armR)
    this.lShoulder = lArm.shoulder
    this.lElbow    = lArm.elbow
    this.group.add(this.lShoulder)

    // リストバンド(アクセント色の細い帯)を前腕の先端近くに追加
    this.buildWristband(this.rElbow, foreArmLen, armR, accentMat)
    this.buildWristband(this.lElbow, foreArmLen, armR, accentMat)

    // 利き手(前腕の先)にラケット
    this.racketPivot = new THREE.Group()
    this.racketPivot.position.y = -foreArmLen // 前腕の先端(手)
    this.rElbow.add(this.racketPivot)
    this.buildRacket(this.racketPivot, racketRingR, racketHandleLen, accentColor)

    // -------------------------------------------------------------------------
    // 両脚: 股関節ピボット→大腿(下向き)→膝ピボット→下腿
    // -------------------------------------------------------------------------
    const rLeg = this.buildLeg(limbMat, accentMat, +hipX, hipY, thighLen, shinLen, legR)
    this.rHip  = rLeg.hip
    this.rKnee = rLeg.knee
    this.group.add(this.rHip)

    const lLeg = this.buildLeg(limbMat, accentMat, -hipX, hipY, thighLen, shinLen, legR)
    this.lHip  = lLeg.hip
    this.lKnee = lLeg.knee
    this.group.add(this.lHip)

    // -------------------------------------------------------------------------
    // 左利き: y 軸まわりに鏡像化(利き腕を左側に)。
    // group.scale.x = -1 を使うと内部の法線が反転して見た目が崩れるため、
    // y 軸 180° 回転で鏡像を実現する。
    // -------------------------------------------------------------------------
    if (opts.physique.handedness === 'left') {
      this.group.rotation.y = Math.PI
    }

    // -------------------------------------------------------------------------
    // 発汗エミッタ用の共有ジオメトリ/マテリアルを1回だけ生成。
    // 小さな球体(半径 0.018m)を加算合成の半透明で水色に。
    // -------------------------------------------------------------------------
    // 視認性重視: 大きめ・明るい水色で通常合成(加算合成は明るいコート上で
    // 飛んでしまい見えにくいため)。やや不透明にして「汗が飛ぶ」のを分かりやすく。
    this.sweatGeo = new THREE.SphereGeometry(0.045, 8, 6)
    this.sweatMat = new THREE.MeshBasicMaterial({
      color: 0xdaf2ff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    })

    // 汗滴プールを事前確保(最大 SWEAT_POOL_SIZE 個)
    for (let i = 0; i < SWEAT_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(this.sweatGeo, this.sweatMat)
      mesh.visible = false
      mesh.renderOrder = 5
      scene.add(mesh)
      this.sweatDrops.push({
        mesh,
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 0,
      })
    }

    // 発汗放出位置の計算に使う高さ・幅を記録(ワールド座標 = group.position.y + ローカル高さ)
    // ここでは group は y=0 に置かれるので、ローカル高さがそのまま使える。
    this.shoulderWorldY = shoulderY
    this.headTopWorldY  = shoulderY + neckH + headR * 2.0
    this.shoulderWorldX = shoulderX
    // 胴体の初期 y(呼吸脈動の基準)
    this.torsoBaseY = this.torso.position.y
  }

  // ---------------------------------------------------------------------------
  // 髪型フィーチャーの構築
  // ---------------------------------------------------------------------------
  /**
   * 髪型に応じたメッシュを head グループへ追加する。
   * bald は何も追加しない(肌色のまま)。
   */
  private buildHair(
    hair: PersonaAppearance['hair'],
    headR: number,
    neckH: number,
    accentMat: THREE.MeshLambertMaterial,
    accentColor: number,
  ): void {
    const hairColor  = 0x2a1a08 // 黒茶の髪色(共通)
    const hairMat    = new THREE.MeshLambertMaterial({ color: hairColor })
    const headTopY   = neckH + headR * 2  // 頭頂の y 座標(head グループ内)

    switch (hair) {
      case 'short': {
        // 短髪: 頭部上半分を覆う薄い半球キャップ
        const capGeo = new THREE.SphereGeometry(headR * 1.04, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)
        const capMesh = new THREE.Mesh(capGeo, hairMat)
        capMesh.position.y = neckH + headR
        this.head.add(capMesh)
        break
      }
      case 'bald': {
        // 禿げ: 髪メッシュなし(肌色のまま)
        break
      }
      case 'headband': {
        // ヘッドバンド: 頭部赤道付近にトーラス(アクセント色)
        const torusR  = headR * 0.96
        const tubeR   = headR * 0.10
        const bandGeo = new THREE.TorusGeometry(torusR, tubeR, 8, 24)
        const bandMesh = new THREE.Mesh(bandGeo, accentMat)
        // 頭頂から少し下(赤道付近)に配置し、xz 平面に水平に
        bandMesh.position.y = neckH + headR + headR * 0.18
        bandMesh.rotation.x = Math.PI / 2
        this.head.add(bandMesh)
        break
      }
      case 'long': {
        // 長髪: 短髪キャップ + 後頭部に箱状の塊
        const capGeo = new THREE.SphereGeometry(headR * 1.04, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)
        const capMesh = new THREE.Mesh(capGeo, hairMat)
        capMesh.position.y = neckH + headR
        this.head.add(capMesh)

        // 後頭部のポニーテール塊(小さな箱/球)
        const tailGeo  = new THREE.BoxGeometry(headR * 0.55, headR * 0.65, headR * 0.45)
        const tailMesh = new THREE.Mesh(tailGeo, hairMat)
        tailMesh.position.set(0, neckH + headR * 0.9, -headR * 1.0)
        this.head.add(tailMesh)
        break
      }
      case 'cap': {
        // キャップ: 半球ブリム + 前つば(薄い箱)
        const capGeo  = new THREE.SphereGeometry(headR * 1.06, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.52)
        // キャップの色はアクセント色
        const capMat  = new THREE.MeshLambertMaterial({ color: accentColor })
        const capMesh = new THREE.Mesh(capGeo, capMat)
        capMesh.position.y = neckH + headR
        this.head.add(capMesh)

        // つば: 薄い円盤
        const brimGeo  = new THREE.CylinderGeometry(headR * 1.35, headR * 1.35, 0.025, 16)
        const brimMesh = new THREE.Mesh(brimGeo, capMat)
        brimMesh.position.set(0, neckH + headR * 0.5, headR * 0.5)
        this.head.add(brimMesh)
        break
      }
    }
  }

  // ---------------------------------------------------------------------------
  // リストバンドの構築(アクセント色の細いリング)
  // ---------------------------------------------------------------------------
  private buildWristband(
    elbowGroup: THREE.Group,
    foreArmLen: number,
    armR: number,
    accentMat: THREE.MeshLambertMaterial,
  ): void {
    // 前腕の先端(肘ピボットから -foreArmLen)近くに細いリングを追加
    const bandGeo  = new THREE.CylinderGeometry(armR * 1.15, armR * 1.15, foreArmLen * 0.12, 10)
    const bandMesh = new THREE.Mesh(bandGeo, accentMat)
    bandMesh.position.y = -(foreArmLen * 0.88)
    elbowGroup.add(bandMesh)
  }

  /** 片腕を組み立てて肩・肘ピボットを返す。shoulderX は肩の左右オフセット */
  private buildArm(
    upperArmMat: THREE.Material,
    skinMat: THREE.Material,
    shoulderX: number,
    shoulderY: number,
    upperArmLen: number,
    foreArmLen: number,
    armR: number,
  ): { shoulder: THREE.Group; elbow: THREE.Group } {
    const shoulder = new THREE.Group()
    shoulder.position.set(shoulderX, shoulderY - 0.04, 0)

    // 上腕(肩から下向き)。sleeveless 時は skinMat が渡される。
    const upperGeo = new THREE.CylinderGeometry(armR, armR * 0.9, upperArmLen, 8)
    const upper = new THREE.Mesh(upperGeo, upperArmMat)
    upper.position.y = -upperArmLen / 2
    upper.castShadow = true
    shoulder.add(upper)

    // 肘ピボット(上腕の先端)
    const elbow = new THREE.Group()
    elbow.position.y = -upperArmLen
    shoulder.add(elbow)

    // 前腕(肘から下向き)
    const foreGeo = new THREE.CylinderGeometry(armR * 0.9, armR * 0.8, foreArmLen, 8)
    const fore = new THREE.Mesh(foreGeo, skinMat)
    fore.position.y = -foreArmLen / 2
    fore.castShadow = true
    elbow.add(fore)

    return { shoulder, elbow }
  }

  /** 片脚を組み立てて股・膝ピボットを返す */
  private buildLeg(
    limbMat: THREE.Material,
    accentMat: THREE.MeshLambertMaterial,
    hipX: number,
    hipY: number,
    thighLen: number,
    shinLen: number,
    legR: number,
  ): { hip: THREE.Group; knee: THREE.Group } {
    const hip = new THREE.Group()
    hip.position.set(hipX, hipY, 0)

    const thighGeo = new THREE.CylinderGeometry(legR, legR * 0.85, thighLen, 8)
    const thigh = new THREE.Mesh(thighGeo, limbMat)
    thigh.position.y = -thighLen / 2
    thigh.castShadow = true
    hip.add(thigh)

    const knee = new THREE.Group()
    knee.position.y = -thighLen
    hip.add(knee)

    const shinGeo = new THREE.CylinderGeometry(legR * 0.85, legR * 0.7, shinLen, 8)
    const shin = new THREE.Mesh(shinGeo, limbMat)
    shin.position.y = -shinLen / 2
    shin.castShadow = true
    knee.add(shin)

    // 足(小さな箱)。シューズのライン部分にアクセント色を一点追加。
    const footGeo  = new THREE.BoxGeometry(legR * 1.6, 0.05, legR * 3)
    const foot     = new THREE.Mesh(footGeo, limbMat)
    foot.position.set(0, -shinLen + 0.02, legR * 0.8)
    knee.add(foot)

    // シューズのアクセントライン(薄いスラブ)
    const shoeLineGeo  = new THREE.BoxGeometry(legR * 1.7, 0.018, legR * 0.6)
    const shoeLine     = new THREE.Mesh(shoeLineGeo, accentMat)
    shoeLine.position.set(0, -shinLen + 0.04, legR * 1.3)
    knee.add(shoeLine)

    return { hip, knee }
  }

  /** ラケットを pivot 配下に組み立てる。accentColor はガットの発光色に使う */
  private buildRacket(pivot: THREE.Group, racketRingR: number, racketHandleLen: number, accentColor: number): void {
    const frameMat  = new THREE.MeshLambertMaterial({ color: 0xddbb44 })
    const handleMat = new THREE.MeshLambertMaterial({ color: 0x553311 })
    const stringMat = new THREE.MeshBasicMaterial({
      color: accentColor !== 0x000000 ? accentColor : 0xffffff, // accent=黒の場合は白ガット
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false,
    })

    // グリップ(手から下向きに伸ばす)
    const handleGeo = new THREE.CylinderGeometry(0.018, 0.02, racketHandleLen, 8)
    const handle = new THREE.Mesh(handleGeo, handleMat)
    handle.position.y = -racketHandleLen / 2
    pivot.add(handle)

    // フレーム(リング)はグリップの先
    const frameGeo = new THREE.TorusGeometry(racketRingR, 0.014, 6, 22)
    const frame = new THREE.Mesh(frameGeo, frameMat)
    frame.position.y = -racketHandleLen - racketRingR
    pivot.add(frame)

    // ガット面(半透明の円)
    const faceGeo = new THREE.CircleGeometry(racketRingR * 0.92, 20)
    const face = new THREE.Mesh(faceGeo, stringMat)
    face.position.y = -racketHandleLen - racketRingR
    pivot.add(face)
  }

  /** 毎フレーム呼ぶ。位置・向き・スイング・走り・発汗/疲労を更新 */
  update(dt: number, view: PlayerView): void {
    // キャラクター位置
    this.group.position.set(view.pos.x, 0, view.pos.z)

    // 進行方向に向く + 前傾(従来挙動を踏襲)
    const speed = Math.sqrt(view.vel.x ** 2 + view.vel.z ** 2)
    if (speed > 0.5) {
      const dir = Math.atan2(view.vel.x, view.vel.z)
      // 左利きの場合は group.rotation.y が Math.PI にオフセットされているため、
      // 進行方向角度に Math.PI を加算して向きを合わせる
      const baseRot = this.group.scale.x < 0 ? Math.PI : 0
      this.group.rotation.y = THREE.MathUtils.lerp(this.group.rotation.y, dir + baseRot, 8 * dt)
      const tilt = Math.min(speed / 8.0, 1.0) * 0.12
      this.group.rotation.z = THREE.MathUtils.lerp(
        this.group.rotation.z,
        -tilt * Math.sign(view.vel.x || 0.001),
        8 * dt,
      )
    } else {
      this.group.rotation.z = THREE.MathUtils.lerp(this.group.rotation.z, 0, 5 * dt)
    }

    this.updateSwingState(view)
    this.updateLegs(dt, speed, view)
    this.updateArms(dt, view)

    // 発汗エフェクト・疲労サイン(スタミナ pct による。pct=1 では何もしない)
    this.updateSweat(dt, view)
    this.updateFatiguePose(dt, view)
  }

  /** スイング状態の遷移管理 */
  private updateSwingState(view: PlayerView): void {
    if (view.swing === 'swing') {
      if (!this.swinging) {
        // 新しいスイング開始
        this.swinging = true
        this.swingPhase = 0
        // swingSide が決まっていればそれを使う(なければフォア)
        this.swingDir = view.swingSide ?? 'fore'
        // 高い打点はオーバーヘッド(スマッシュ)モーションで振る
        this.swingSmash = view.swingKind === 'smash'
      }
    } else {
      this.swinging = false
    }
  }

  /** 脚: 移動方向に応じた走り footwork、静止時は軽い構え */
  private updateLegs(dt: number, speed: number, view: PlayerView): void {
    // チャージ中・スイング中はスタンスを広げて構える
    const planted = view.charging || this.swinging

    if (speed > 0.6 && !planted) {
      // 走り: 脚を交互に前後へ振る
      this.footCycle += dt * (4 + speed * 1.1)
      const swingAmt = Math.min(speed / 8, 1) * 0.7
      const a = Math.sin(this.footCycle) * swingAmt
      this.rHip.rotation.x = THREE.MathUtils.lerp(this.rHip.rotation.x, a, 12 * dt)
      this.lHip.rotation.x = THREE.MathUtils.lerp(this.lHip.rotation.x, -a, 12 * dt)
      // 後ろに振った脚の膝を曲げる
      this.rKnee.rotation.x = THREE.MathUtils.lerp(this.rKnee.rotation.x, Math.max(0, -a) * 1.2, 12 * dt)
      this.lKnee.rotation.x = THREE.MathUtils.lerp(this.lKnee.rotation.x, Math.max(0, a) * 1.2, 12 * dt)
    } else {
      // 構え: 軽く膝を曲げ、スタンスを少し開く
      const bend = planted ? 0.35 : 0.12
      this.rHip.rotation.x = THREE.MathUtils.lerp(this.rHip.rotation.x, -bend * 0.4, 8 * dt)
      this.lHip.rotation.x = THREE.MathUtils.lerp(this.lHip.rotation.x, -bend * 0.4, 8 * dt)
      this.rKnee.rotation.x = THREE.MathUtils.lerp(this.rKnee.rotation.x, bend, 8 * dt)
      this.lKnee.rotation.x = THREE.MathUtils.lerp(this.lKnee.rotation.x, bend, 8 * dt)
    }
  }

  /** 腕・ラケット: スイング(フォア/バック)・チャージテイクバック・走り腕振り */
  private updateArms(dt: number, view: PlayerView): void {
    // 空振り進行
    if (view.swing === 'whiff') {
      this.whiffAngle = Math.min(this.whiffAngle + dt * 12, 1.0)
    } else {
      this.whiffAngle = THREE.MathUtils.lerp(this.whiffAngle, 0, 5 * dt)
    }

    if (view.charging) {
      // -----------------------------------------------------------------------
      // チャージ中: ボール側へテイクバックして静止。引きの深さ ∝ charge。
      // -----------------------------------------------------------------------
      const c = Math.min(view.charge / Math.max(1, CHARGE_MAX), 1)
      const depth = 0.4 + c * 0.9 // テイクバックの深さ
      // swingSide が未確定でも、チャージ中はフォア構えをデフォルトに
      const dir = view.swingSide ?? 'fore'
      this.applyTakeback(dt, dir, depth)
      this.swingPhase = 0

      // オーバーチャージ(charge>1)の小刻みな震え
      if (view.charge > 1.0) {
        this.chargeShake += dt * 40
        const tremor = (view.charge - 1.0) * 0.08 * Math.sin(this.chargeShake)
        this.rShoulder.rotation.z += tremor
        this.torso.rotation.y += tremor * 0.5
      }
    } else if (this.swinging) {
      // -----------------------------------------------------------------------
      // スイング進行: テイクバック→フォワード→フォロースルー(約0.3秒)
      // -----------------------------------------------------------------------
      this.swingPhase = Math.min(this.swingPhase + dt / 0.3, 1.0)
      if (this.swingSmash) this.applySmashSwing(this.swingPhase)
      else this.applySwing(this.swingDir, this.swingPhase)
    } else {
      // -----------------------------------------------------------------------
      // 通常: 走り腕振り or 構えへ戻す
      // -----------------------------------------------------------------------
      this.relaxArms(dt, view)
    }

    // 空振りの上方持ち上げを重畳
    if (this.whiffAngle > 0.01) {
      this.rShoulder.rotation.x -= this.whiffAngle * Math.PI * 0.4
    }
  }

  /** チャージのテイクバック姿勢を適用(静止保持) */
  private applyTakeback(dt: number, dir: 'fore' | 'back', depth: number): void {
    const k = 10 * dt
    if (dir === 'fore') {
      // フォア: 利き手を体の利き手側後方へ引く
      this.rShoulder.rotation.x = THREE.MathUtils.lerp(this.rShoulder.rotation.x, -0.3, k)
      this.rShoulder.rotation.z = THREE.MathUtils.lerp(this.rShoulder.rotation.z, depth, k)
      this.rElbow.rotation.x = THREE.MathUtils.lerp(this.rElbow.rotation.x, -0.6, k)
      this.torso.rotation.y = THREE.MathUtils.lerp(this.torso.rotation.y, -depth * 0.5, k)
    } else {
      // バック: 体を逆へ捻り、利き手を反対側へ持っていく
      this.rShoulder.rotation.x = THREE.MathUtils.lerp(this.rShoulder.rotation.x, -0.2, k)
      this.rShoulder.rotation.z = THREE.MathUtils.lerp(this.rShoulder.rotation.z, -depth * 1.1, k)
      this.rElbow.rotation.x = THREE.MathUtils.lerp(this.rElbow.rotation.x, -0.9, k)
      this.torso.rotation.y = THREE.MathUtils.lerp(this.torso.rotation.y, depth * 0.6, k)
    }
    // 非利き手は軽く前へ(バランス)
    this.lShoulder.rotation.z = THREE.MathUtils.lerp(this.lShoulder.rotation.z, -depth * 0.4, k)
  }

  /**
   * スイングを進行 p(0..1)で適用。
   * p<0.3: テイクバック、0.3..0.6: フォワードスイング、0.6..1: フォロースルー
   */
  private applySwing(dir: 'fore' | 'back', p: number): void {
    // 振り角: テイクバック側(+)→インパクト(0)→フォロースルー(−)
    // フォア/バックで z 軸の符号を反転させて振りの向きを描き分ける
    let arm: number
    let torso: number
    if (p < 0.3) {
      // テイクバック(深く引く)
      const u = p / 0.3
      arm   = THREE.MathUtils.lerp(0.2, 1.0, u)
      torso = THREE.MathUtils.lerp(0, 0.6, u)
    } else if (p < 0.6) {
      // フォワードスイング(一気に振り抜く)
      const u = (p - 0.3) / 0.3
      arm   = THREE.MathUtils.lerp(1.0, -0.9, u)
      torso = THREE.MathUtils.lerp(0.6, -0.4, u)
    } else {
      // フォロースルー(振り切って戻す)
      const u = (p - 0.6) / 0.4
      arm   = THREE.MathUtils.lerp(-0.9, -0.3, u)
      torso = THREE.MathUtils.lerp(-0.4, -0.1, u)
    }

    const sign = dir === 'fore' ? 1 : -1
    // 肩を横方向(z軸)に振る + 縦の振り上げ/振り下ろし(x軸)
    this.rShoulder.rotation.z = arm * sign
    this.rShoulder.rotation.x = -0.4 + Math.abs(arm) * 0.3
    this.rElbow.rotation.x = -0.7 * (1 - Math.abs(arm) * 0.5)
    this.torso.rotation.y = torso * sign * 0.8
    // バックハンドは非利き手も添える
    if (dir === 'back') {
      this.lShoulder.rotation.z = arm * 0.6
    } else {
      this.lShoulder.rotation.z = -arm * 0.3
    }
  }

  /**
   * スマッシュ/サーブのオーバーヘッドモーションを進行 p(0..1)で適用。
   * p<0.4: 利き腕を頭上後方へ引き上げ(肘を曲げてラケットを背中へ)、非利き手を上げて照準。
   * p≥0.4: 一気に振り下ろし、肘を伸ばして頭上で捉え→前方へフォロースルー。
   * 横振り(フォア/バック)と違い、肩の縦回転(x 軸)が主役で「上から叩く」動きになる。
   */
  private applySmashSwing(p: number): void {
    let shoulderX: number
    let elbow: number
    let torso: number
    let lArmUp: number
    if (p < 0.4) {
      const u = p / 0.4
      shoulderX = THREE.MathUtils.lerp(-0.4, -2.6, u) // 頭上後方へ引き上げ
      elbow = THREE.MathUtils.lerp(-0.3, -1.7, u) // 肘を曲げてラケットを背中へ
      torso = THREE.MathUtils.lerp(0, 0.25, u)
      lArmUp = THREE.MathUtils.lerp(0, -1.3, u) // 非利き手を上げる(照準)
    } else {
      const u = (p - 0.4) / 0.6
      shoulderX = THREE.MathUtils.lerp(-2.6, 0.5, u) // 一気に振り下ろす
      elbow = THREE.MathUtils.lerp(-1.7, -0.2, u) // 肘を伸ばして打点→フォロー
      torso = THREE.MathUtils.lerp(0.25, -0.15, u)
      lArmUp = THREE.MathUtils.lerp(-1.3, 0, u) // 非利き手を下ろす
    }
    this.rShoulder.rotation.x = shoulderX
    this.rShoulder.rotation.z = 0.12 // ほぼ正面(横に振らない)
    this.rElbow.rotation.x = elbow
    this.torso.rotation.y = torso * 0.3
    this.lShoulder.rotation.x = lArmUp
    this.lShoulder.rotation.z = 0
  }

  /** スイング/チャージ外: 走り腕振り or ニュートラルへ戻す */
  private relaxArms(dt: number, view: PlayerView): void {
    const k = 8 * dt
    const speed = Math.sqrt(view.vel.x ** 2 + view.vel.z ** 2)
    this.torso.rotation.y = THREE.MathUtils.lerp(this.torso.rotation.y, 0, k)

    if (speed > 0.6) {
      // 走り: 腕を脚と逆位相で前後に振る(非利き手を主に)
      const a = Math.sin(this.footCycle + Math.PI) * Math.min(speed / 8, 1) * 0.5
      this.lShoulder.rotation.x = THREE.MathUtils.lerp(this.lShoulder.rotation.x, a, 12 * dt)
      this.lShoulder.rotation.z = THREE.MathUtils.lerp(this.lShoulder.rotation.z, 0.1, k)
      this.lElbow.rotation.x = THREE.MathUtils.lerp(this.lElbow.rotation.x, -0.5, k)
      // 利き手はラケットを軽く構えながら逆位相
      this.rShoulder.rotation.x = THREE.MathUtils.lerp(this.rShoulder.rotation.x, -a * 0.6, 12 * dt)
      this.rShoulder.rotation.z = THREE.MathUtils.lerp(this.rShoulder.rotation.z, 0.25, k)
      this.rElbow.rotation.x = THREE.MathUtils.lerp(this.rElbow.rotation.x, -0.8, k)
    } else {
      // 構え: ラケットを前に立てて待つ
      this.rShoulder.rotation.x = THREE.MathUtils.lerp(this.rShoulder.rotation.x, -0.3, k)
      this.rShoulder.rotation.z = THREE.MathUtils.lerp(this.rShoulder.rotation.z, 0.2, k)
      this.rElbow.rotation.x = THREE.MathUtils.lerp(this.rElbow.rotation.x, -1.0, k)
      this.lShoulder.rotation.x = THREE.MathUtils.lerp(this.lShoulder.rotation.x, -0.1, k)
      this.lShoulder.rotation.z = THREE.MathUtils.lerp(this.lShoulder.rotation.z, 0.15, k)
      this.lElbow.rotation.x = THREE.MathUtils.lerp(this.lElbow.rotation.x, -0.7, k)
    }
  }

  /** シーンから除去(発汗プールのメッシュも含む) */
  dispose(scene: THREE.Scene): void {
    scene.remove(this.group)
    for (const drop of this.sweatDrops) {
      scene.remove(drop.mesh)
    }
    this.sweatDrops = []
  }

  // ---------------------------------------------------------------------------
  // 発汗エミッタ(IMPROVEMENTS §5.8(B))
  // ---------------------------------------------------------------------------

  /**
   * 発汗パーティクルを更新する。
   * - pct < STAMINA_SWEAT_START のとき放出を開始し、pct が低いほど放出レートを増やす。
   * - 既存の滴を重力で落としながらフェードアウトさせる。
   * - pct = 1(満タン)では放出しない。
   */
  private updateSweat(dt: number, view: PlayerView): void {
    const pct = view.staminaPct

    // 既存の滴の物理更新(重力 + フェード)
    for (const drop of this.sweatDrops) {
      if (!drop.active) continue
      drop.vel.y -= SWEAT_GRAVITY * dt
      drop.pos.addScaledVector(drop.vel, dt)
      drop.life -= dt
      if (drop.life <= 0) {
        drop.active = false
        drop.mesh.visible = false
        continue
      }
      const alpha = drop.life / drop.maxLife
      drop.mesh.position.copy(drop.pos)
      // スケールは生存中盤まで保ち、末期に縮む
      const s = Math.min(1.0, alpha * 3.0) * (0.5 + 0.5 * alpha)
      drop.mesh.scale.setScalar(s)
      drop.mesh.visible = true
    }

    // pct が満タン(1.0)か、発汗閾値以上ならここで終了(放出なし)
    if (pct >= STAMINA_SWEAT_START || pct >= 1.0) return

    // 放出レートを計算: pct=SWEAT_START(50%)で 0、pct→0 で STAMINA_SWEAT_MAX_RATE。
    // 線形に増やす(以前は二乗で終盤に偏り「ゼロ近くで急増」していたため)。
    const t = 1.0 - pct / STAMINA_SWEAT_START // 0(閾値直前)→1(枯渇)
    const rate = STAMINA_SWEAT_MAX_RATE * t // 線形(25%で約10/s、0%で20/s)

    this.sweatTimer -= dt
    if (this.sweatTimer > 0) return

    // 次の放出インターバルを設定
    const interval = rate > 0 ? 1.0 / rate : 999
    this.sweatTimer = interval + (Math.random() - 0.5) * interval * 0.4

    // フリーの滴を取得して放出
    const drop = this.getFreeSweatDrop()
    if (!drop) return

    // 放出位置: 頭/肩をランダムに選ぶ。ワールド座標 = group.position + ローカルオフセット
    const gp = this.group.position
    const emitHead = Math.random() < 0.5
    if (emitHead) {
      // 頭頂付近(±小さいオフセット)
      drop.pos.set(
        gp.x + (Math.random() - 0.5) * 0.1,
        this.headTopWorldY * 0.9,
        gp.z + (Math.random() - 0.5) * 0.1,
      )
    } else {
      // 肩付近(左右どちらか)
      const side = Math.random() < 0.5 ? 1 : -1
      drop.pos.set(
        gp.x + side * this.shoulderWorldX * (0.8 + Math.random() * 0.4),
        this.shoulderWorldY * (0.95 + Math.random() * 0.1),
        gp.z + (Math.random() - 0.5) * 0.15,
      )
    }

    // 初速: 外方向 + 小さなランダム成分
    const spreadX = (Math.random() - 0.5) * SWEAT_INIT_SPEED
    const spreadZ = (Math.random() - 0.5) * SWEAT_INIT_SPEED
    const upY     = 0.2 + Math.random() * 0.5
    drop.vel.set(spreadX, upY, spreadZ)

    drop.maxLife = SWEAT_DROP_LIFETIME * (0.7 + Math.random() * 0.6)
    drop.life    = drop.maxLife
    drop.active  = true
    drop.mesh.position.copy(drop.pos)
    drop.mesh.scale.setScalar(1.0)
    drop.mesh.visible = true
  }

  /** フリーの汗滴インスタンスを返す。全部アクティブなら最古を再利用 */
  private getFreeSweatDrop(): SweatDrop | null {
    for (const d of this.sweatDrops) {
      if (!d.active) return d
    }
    // プール満杯: 最古(残り life が最小)を再利用
    let oldest: SweatDrop | null = null
    let minLife = Infinity
    for (const d of this.sweatDrops) {
      if (d.life < minLife) {
        minLife = d.life
        oldest = d
      }
    }
    return oldest
  }

  // ---------------------------------------------------------------------------
  // 疲労サイン(呼吸上下脈動 + 前傾姿勢, IMPROVEMENTS §5.8(B) 補助的な疲労サイン)
  // ---------------------------------------------------------------------------

  /**
   * 低スタミナ時の疲労ポーズを駆動する。
   * - pct < STAMINA_SWEAT_START(0.45): 胴体をゆっくり上下に脈動(呼吸)。
   * - pct < 0.25: さらに前傾(やや猫背ぎみに)。
   * - pct >= 1.0(満タン): 何もしない(従来と同じ見た目を保証)。
   * - スイング/チャージ中は既存アニメを壊さないよう疲労ポーズ量を抑制。
   */
  private updateFatiguePose(dt: number, view: PlayerView): void {
    const pct = view.staminaPct
    if (pct >= 1.0) return // 満タンでは何もしない

    // 疲労度(0=閾値、1=完全枯渇)。発汗閾値より少し緩く(0.55から効き始める)
    const FATIGUE_START = 0.55
    if (pct >= FATIGUE_START) return

    const fatigue = 1.0 - pct / FATIGUE_START // 0..1

    // スイング/チャージ中は疲労ポーズを 30% に抑制して既存アニメを壊さない
    const suppress = (view.charging || view.swing === 'swing') ? 0.3 : 1.0

    // 呼吸上下(胴体を y 方向に脈動。torsoBaseY を基準に上下させる)
    this.breathPhase += dt * (0.8 + fatigue * 1.5) // 疲れるほど呼吸が速くなる
    const breathAmt = fatigue * 0.025 * suppress
    this.torso.position.y = this.torsoBaseY +
      Math.sin(this.breathPhase * 2.0 * Math.PI) * breathAmt

    // 低スタミナ時の前傾(腰が下がる感じ)
    if (fatigue > 0.4) {
      const sag = (fatigue - 0.4) / 0.6 // 0..1
      const forwardLean = sag * 0.08 * suppress
      this.torso.rotation.x = THREE.MathUtils.lerp(
        this.torso.rotation.x,
        forwardLean,
        5 * dt,
      )
    } else {
      // 閾値以下では通常姿勢へ戻す
      this.torso.rotation.x = THREE.MathUtils.lerp(this.torso.rotation.x, 0, 5 * dt)
    }
  }
}
