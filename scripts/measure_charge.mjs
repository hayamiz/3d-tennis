// チャージによるトップスピン/スライスの特徴強化(GAME_DESIGN §4.5)の検証。
// 同一の打点・目標・品質で charge を変え、着地点(x,z)・1stバウンド後のピーク高さ・
// 初速・回転量を比較する。トップスピン=横角度↑/浅く↓/回転↑/跳ね↑、
// スライス=深さ↑/回転↑/低い(跳ねない)を確認する。
import { Vector3 } from 'three'
import { solveShot } from '../src/gameplay/shot.ts'
import { BallSim } from '../src/physics/ball.ts'
import { COURT_HALF_LENGTH, COURT_HALF_WIDTH } from '../src/constants.ts'

const PHYS_DT = 1 / 120

// 実ゲームに近い設定: 既定のトップスピン目標は深い(baseDepthFromBaseline=1.8 → z≒-10.085)。
// 横は右いっぱい(A/D 相当 = AIM_OFFSET_X=2.6)。打点高 h と相手球速 vIn を変えて条件を再現する。
const DEEP_Z = -(COURT_HALF_LENGTH - 1.8) // 既定のトップスピン着地目標 z
const AIM_X = 2.6 // 右いっぱいの横入力相当

function run(type, charge, h = 1.0, vIn = 18) {
  const hitPos = new Vector3(0, h, 10)
  const target = new Vector3(AIM_X, 0, DEEP_Z)
  const sol = solveShot({
    type, hitter: 'player', hitPos: hitPos.clone(), target: target.clone(),
    quality: 1.0, charge, incomingSpeed: vIn,
  })
  const sim = new BallSim()
  sim.launch(hitPos.clone(), sol.vel.clone(), sol.spin.clone(), 'player')
  let land = null
  let postBouncePeak = -Infinity
  let bounced = false
  let netCrossY = NaN
  let prev = sim.state.pos.clone()
  for (let s = 0; s < 2000; s++) {
    const events = sim.step(PHYS_DT)
    const cur = sim.state.pos
    // z=0(ネット)を横切るフレームの y を線形補間で記録(低い弾道かの確認)
    if (Number.isNaN(netCrossY) && prev.z > 0 && cur.z <= 0) {
      const f = prev.z / (prev.z - cur.z)
      netCrossY = prev.y + (cur.y - prev.y) * f
    }
    prev = cur.clone()
    for (const e of events) {
      if (e.kind === 'bounce' && !bounced) { bounced = true; land = e.pos.clone() }
    }
    if (bounced) {
      postBouncePeak = Math.max(postBouncePeak, sim.state.pos.y)
      if (sim.state.bounceCount >= 2) break
    }
  }
  return {
    speed: sol.vel.length(),
    spin: sol.spin.length(),
    netY: netCrossY,
    landX: land ? land.x : NaN,
    landZ: land ? land.z : NaN,
    depthFromBaseline: land ? COURT_HALF_LENGTH + land.z : NaN, // ベースライン(z=-HALF)からの距離
    peak: postBouncePeak,
  }
}

function fmt(n) { return (Number.isFinite(n) ? n.toFixed(2) : '----').padStart(7) }

function fmtRow(c, r, inCourt) {
  return `${c.toFixed(2).padStart(5)}  ${fmt(r.speed)} ${fmt(r.spin)}  ${fmt(r.netY)}    ${fmt(r.landX)} ${fmt(r.landZ)} ${fmt(r.depthFromBaseline)} ${fmt(r.peak)}   ${inCourt ? 'in' : 'OUT'}`
}
function table(type, h, vIn) {
  console.log(`\n=== ${type}(右いっぱい x=${AIM_X}, 既定深さ z=${DEEP_Z.toFixed(1)}, 打点高 h=${h}, 相手球速 vIn=${vIn}, 品質1.0)===`)
  console.log('charge   初速    回転    ネット通過  着地X   着地Z  BL距離  跳ねピーク')
  console.log('──────────────────────────────────────────────────────────────────────')
  for (const c of [0, 0.2, 0.5, 1.0]) {
    const r = run(type, c, h, vIn)
    const inCourt = Math.abs(r.landX) < COURT_HALF_WIDTH && r.landZ < 0 && r.landZ > -COURT_HALF_LENGTH
    console.log(fmtRow(c, r, inCourt))
  }
}

// トップスピン: 通常打点(条件ふつう)/ 高い打点(好条件)/ 差し込まれ(速い球)
table('topspin', 1.0, 18)
table('topspin', 1.4, 18) // 高い打点=好条件 → 短い鋭角(中央寄り)が出るはず
table('topspin', 1.0, 34) // 差し込まれ → 引かず深く返すはず
// スライス: 深く伸びる
table('slice', 1.0, 18)
console.log(`\n参考: コート半幅=${COURT_HALF_WIDTH.toFixed(2)}, 半長=${COURT_HALF_LENGTH.toFixed(2)}, サービスライン≒ネットから6.40m(z≒-5.49), ベースライン z=${(-COURT_HALF_LENGTH).toFixed(2)}`)
