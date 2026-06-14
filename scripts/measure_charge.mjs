// チャージによるトップスピン/スライスの特徴強化(GAME_DESIGN §4.5)の検証。
// 同一の打点・目標・品質で charge を変え、着地点(x,z)・1stバウンド後のピーク高さ・
// 初速・回転量を比較する。トップスピン=横角度↑/浅く↓/回転↑/跳ね↑、
// スライス=深さ↑/回転↑/低い(跳ねない)を確認する。
import { Vector3 } from 'three'
import { solveShot } from '../src/gameplay/shot.ts'
import { BallSim } from '../src/physics/ball.ts'
import { COURT_HALF_LENGTH, COURT_HALF_WIDTH } from '../src/constants.ts'

const PHYS_DT = 1 / 120

// 打点(自陣ベースライン付近)と「センターやや右」を狙う目標(横入力 = 右へ振った想定)
const hitPos = new Vector3(0, 1.0, 10)
const target = new Vector3(1.5, 0, -5) // x=1.5 で横に振っている → トップスピンの角度・浅さが効く

function run(type, charge) {
  const sol = solveShot({
    type, hitter: 'player', hitPos: hitPos.clone(), target: target.clone(),
    quality: 1.0, charge, incomingSpeed: 18,
  })
  const sim = new BallSim()
  sim.launch(hitPos.clone(), sol.vel.clone(), sol.spin.clone(), 'player')
  let land = null
  let postBouncePeak = -Infinity
  let bounced = false
  for (let s = 0; s < 2000; s++) {
    const events = sim.step(PHYS_DT)
    for (const e of events) {
      if (e.kind === 'bounce' && !bounced) { bounced = true; land = e.pos.clone() }
    }
    if (bounced) {
      postBouncePeak = Math.max(postBouncePeak, sim.state.pos.y)
      // 2nd バウンスで終了
      if (sim.state.bounceCount >= 2) break
    }
  }
  return {
    speed: sol.vel.length(),
    spin: sol.spin.length(),
    landX: land ? land.x : NaN,
    landZ: land ? land.z : NaN,
    depthFromBaseline: land ? COURT_HALF_LENGTH + land.z : NaN, // ベースライン(z=-HALF)からの距離
    peak: postBouncePeak,
  }
}

function fmt(n) { return (Number.isFinite(n) ? n.toFixed(2) : '----').padStart(7) }

for (const type of ['topspin', 'slice']) {
  console.log(`\n=== ${type}(目標 x=${target.x}, z=${target.z}, 品質1.0)===`)
  console.log('charge   初速    回転     着地X   着地Z  BL距離  跳ねピーク')
  console.log('────────────────────────────────────────────────────────────')
  for (const c of [0, 0.5, 1.0]) {
    const r = run(type, c)
    const inCourt = Math.abs(r.landX) < COURT_HALF_WIDTH && r.landZ < 0 && r.landZ > -COURT_HALF_LENGTH
    console.log(
      `${c.toFixed(2).padStart(5)}  ${fmt(r.speed)} ${fmt(r.spin)}  ${fmt(r.landX)} ${fmt(r.landZ)} ${fmt(r.depthFromBaseline)} ${fmt(r.peak)}   ${inCourt ? 'in' : 'OUT'}`,
    )
  }
}
console.log(`\n参考: コート半幅=${COURT_HALF_WIDTH.toFixed(2)}, 半長=${COURT_HALF_LENGTH.toFixed(2)}, サービスライン≒ネットから6.40m(z≒-5.49)`)
