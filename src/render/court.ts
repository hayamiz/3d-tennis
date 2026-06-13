// =============================================================================
// コート・ネット・スタンド・背景の生成
// Three.js プリミティブと CanvasTexture のみ使用。外部アセットなし。
// =============================================================================
import * as THREE from 'three'
import {
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  COURT_WIDTH,
  COURT_LENGTH,
  SERVICE_LINE_Z,
  NET_HEIGHT,
  NET_HALF_WIDTH,
} from '../constants'

// コートライン幅(m)
const LINE_WIDTH = 0.05
const LINE_RAISE = 0.002 // z ファイティング防止

/** シングルスコートのすべてのジオメトリを scene に追加し、Group を返す */
export function buildCourt(scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group()
  scene.add(group)

  // -------------------------------------------------------------------------
  // 外周グラウンド(暗い土色の広大な平面)
  // -------------------------------------------------------------------------
  const groundGeo = new THREE.PlaneGeometry(80, 80)
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1a })
  const ground = new THREE.Mesh(groundGeo, groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  group.add(ground)

  // -------------------------------------------------------------------------
  // クレーコート面(レンガ色)
  // -------------------------------------------------------------------------
  const courtMat = new THREE.MeshLambertMaterial({ color: 0xb85c2a })
  const courtGeo = new THREE.PlaneGeometry(COURT_WIDTH + 2.0, COURT_LENGTH + 2.0)
  const court = new THREE.Mesh(courtGeo, courtMat)
  court.rotation.x = -Math.PI / 2
  court.position.y = 0.001
  court.receiveShadow = true
  group.add(court)

  // -------------------------------------------------------------------------
  // コートライン(白い細長い PlaneGeometry)
  // -------------------------------------------------------------------------
  const lineMat = new THREE.MeshLambertMaterial({ color: 0xffffff })

  /** 横方向(x 軸)の白ライン */
  function addHLine(z: number, width: number): void {
    const geo = new THREE.PlaneGeometry(width, LINE_WIDTH)
    const mesh = new THREE.Mesh(geo, lineMat)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(0, LINE_RAISE, z)
    group.add(mesh)
  }

  /** 縦方向(z 軸)の白ライン */
  function addVLine(x: number, zFrom: number, zTo: number): void {
    const len = Math.abs(zTo - zFrom)
    const geo = new THREE.PlaneGeometry(LINE_WIDTH, len)
    const mesh = new THREE.Mesh(geo, lineMat)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(x, LINE_RAISE, (zFrom + zTo) / 2)
    group.add(mesh)
  }

  // ベースライン(プレイヤー側 / AI 側)
  addHLine(+COURT_HALF_LENGTH, COURT_WIDTH)
  addHLine(-COURT_HALF_LENGTH, COURT_WIDTH)

  // サイドライン(両側、全長)
  addVLine(+COURT_HALF_WIDTH, -COURT_HALF_LENGTH, +COURT_HALF_LENGTH)
  addVLine(-COURT_HALF_WIDTH, -COURT_HALF_LENGTH, +COURT_HALF_LENGTH)

  // サービスライン(プレイヤー側 z=+6.4、AI 側 z=-6.4)
  addHLine(+SERVICE_LINE_Z, COURT_WIDTH)
  addHLine(-SERVICE_LINE_Z, COURT_WIDTH)

  // センターライン(サービスラインとネット間を繋ぐ)
  addVLine(0, -SERVICE_LINE_Z, +SERVICE_LINE_Z)

  // センターマーク(ベースライン中央の短い縦線)
  addVLine(0, +COURT_HALF_LENGTH - 0.2, +COURT_HALF_LENGTH)
  addVLine(0, -COURT_HALF_LENGTH, -COURT_HALF_LENGTH + 0.2)

  // -------------------------------------------------------------------------
  // ネット
  // -------------------------------------------------------------------------
  buildNet(group)

  // -------------------------------------------------------------------------
  // 簡易スタンド(両サイドに段々の箱)
  // -------------------------------------------------------------------------
  buildStands(group)

  return group
}

/** ネット(支柱 + 半透明メッシュ + 白帯)を group に追加 */
function buildNet(group: THREE.Group): void {
  const postMat = new THREE.MeshLambertMaterial({ color: 0xffffff })

  // 支柱(左右各1本)
  const postGeo = new THREE.CylinderGeometry(0.025, 0.025, NET_HEIGHT + 0.05, 8)
  const postL = new THREE.Mesh(postGeo, postMat)
  postL.position.set(-NET_HALF_WIDTH, (NET_HEIGHT + 0.05) / 2, 0)
  postL.castShadow = true
  group.add(postL)

  const postR = new THREE.Mesh(postGeo, postMat)
  postR.position.set(+NET_HALF_WIDTH, (NET_HEIGHT + 0.05) / 2, 0)
  postR.castShadow = true
  group.add(postR)

  // 半透明ネット面(格子模様 CanvasTexture)
  const netTex = buildNetTexture()
  const netMat = new THREE.MeshBasicMaterial({
    map: netTex,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const netGeo = new THREE.PlaneGeometry(NET_HALF_WIDTH * 2, NET_HEIGHT)
  const netMesh = new THREE.Mesh(netGeo, netMat)
  netMesh.position.set(0, NET_HEIGHT / 2, 0)
  group.add(netMesh)

  // 白帯(ネット最上部)
  const bandMat = new THREE.MeshLambertMaterial({ color: 0xffffff })
  const bandGeo = new THREE.BoxGeometry(NET_HALF_WIDTH * 2, 0.04, 0.02)
  const band = new THREE.Mesh(bandGeo, bandMat)
  band.position.set(0, NET_HEIGHT, 0)
  band.castShadow = false
  group.add(band)
}

/** 格子模様のネット用 CanvasTexture を生成 */
function buildNetTexture(): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = 3
  const cells = 16
  const cellSize = size / cells
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath()
    ctx.moveTo(i * cellSize, 0)
    ctx.lineTo(i * cellSize, size)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, i * cellSize)
    ctx.lineTo(size, i * cellSize)
    ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(4, 1)
  return tex
}

/** 両サイドに段々スタンドを設置 */
function buildStands(group: THREE.Group): void {
  const standColor = 0x8b7355
  const seatColor = 0x4a6fa5
  const standMat = new THREE.MeshLambertMaterial({ color: standColor })
  const seatMat = new THREE.MeshLambertMaterial({ color: seatColor })

  const tiers = 4
  const tierHeight = 0.8
  const tierDepth = 1.8
  const standLength = COURT_LENGTH + 4.0
  const standOffsetX = COURT_HALF_WIDTH + 2.5

  for (let side = -1; side <= 1; side += 2) {
    for (let t = 0; t < tiers; t++) {
      // 段のコンクリート部分
      const w = tierDepth
      const h = tierHeight * (t + 1)
      const standGeo = new THREE.BoxGeometry(w, h, standLength)
      const standMesh = new THREE.Mesh(standGeo, standMat)
      standMesh.position.set(
        side * (standOffsetX + t * tierDepth + w / 2),
        h / 2,
        0,
      )
      standMesh.castShadow = true
      standMesh.receiveShadow = true
      group.add(standMesh)

      // 座席面(段の上部に薄い青の板)
      const seatGeo = new THREE.BoxGeometry(w + 0.1, 0.05, standLength)
      const seatMesh = new THREE.Mesh(seatGeo, seatMat)
      seatMesh.position.set(
        side * (standOffsetX + t * tierDepth + w / 2),
        h + 0.025,
        0,
      )
      group.add(seatMesh)
    }
  }

  // 奥(AI 側)と手前(プレイヤー側)のエンドスタンド
  const endStandDepth = 3.0
  const endStandWidth = COURT_WIDTH + 8.0
  const endMat = new THREE.MeshLambertMaterial({ color: standColor })

  for (let side = -1; side <= 1; side += 2) {
    for (let t = 0; t < 3; t++) {
      const h = tierHeight * (t + 1)
      const endGeo = new THREE.BoxGeometry(endStandWidth, h, endStandDepth)
      const endMesh = new THREE.Mesh(endGeo, endMat)
      endMesh.position.set(
        0,
        h / 2,
        side * (COURT_HALF_LENGTH + 2.5 + t * endStandDepth + endStandDepth / 2),
      )
      endMesh.castShadow = true
      endMesh.receiveShadow = true
      group.add(endMesh)
    }
  }
}

/** 夕方グラデーションの背景スフィアを生成して scene に追加 */
export function buildSkyDome(scene: THREE.Scene): THREE.Mesh {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  // 夕方グラデーション(上: 深い青紫 → 下: オレンジ〜ピンク)
  const grad = ctx.createLinearGradient(0, 0, 0, size)
  grad.addColorStop(0.0, '#1a1040')
  grad.addColorStop(0.3, '#3d1f6e')
  grad.addColorStop(0.55, '#c0582a')
  grad.addColorStop(0.75, '#e8834a')
  grad.addColorStop(1.0, '#f0b070')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)

  const tex = new THREE.CanvasTexture(canvas)
  const skyGeo = new THREE.SphereGeometry(200, 32, 16)
  const skyMat = new THREE.MeshBasicMaterial({
    map: tex,
    side: THREE.BackSide,
  })
  const skyMesh = new THREE.Mesh(skyGeo, skyMat)
  scene.add(skyMesh)
  return skyMesh
}
