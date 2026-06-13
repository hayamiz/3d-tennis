// BUG-002 再発検証: ホーム(復帰位置)を前進させた後、より厳しい「ワイド+ショート」
// ドロップに AI が前進して届く(shot を出す)かを確認する。
// 生ログの configuration(normal/jokovin、深いラリー後のネット際ドロップ)を含む。
import { Vector3 } from 'three'
import { AIController } from '../src/gameplay/ai.ts'
import { solveShot } from '../src/gameplay/shot.ts'
import { BallSim } from '../src/physics/ball.ts'
import { AI_PROFILES, PLAYER_PERSONAS, personaModifiers, HOME_POS_Z } from '../src/constants.ts'

// dropTarget: AI コート側(z<0)のネット際。fromX: プレイヤーの打点 x(クロス/ストレート)
function run(profileName, personaId, dropTarget, fromX) {
  const p = PLAYER_PERSONAS[personaId]
  const ai = new AIController(AI_PROFILES[profileName], personaModifiers(p.ratings, p.mental), p.physique)
  ai.resetForPoint('player', true) // player サーブ=AIレシーバー。AIはホームへ
  const startZ = ai.view.pos.z
  const req = {
    type: 'drop', hitter: 'player', hitPos: new Vector3(fromX, 0.9, 10),
    target: dropTarget, quality: 0.9, charge: 0, incomingSpeed: 16,
  }
  const sol = solveShot(req)
  const ball = new BallSim()
  ball.launch(req.hitPos.clone(), sol.vel, sol.spin, 'player')
  let hit = false, landZ = null, landX = null, bounces = 0, secondBounce = false
  const pv = (side, pos) => ({ side, pos, vel: new Vector3(), stamina: 100, sprinting: false, swing: 'idle',
    lastShot: null, staminaPct: 1, charging: false, charge: 0, swingSide: null })
  const ctx = {
    phase: 'rally', ball: ball.state,
    self: ai.view, rival: pv('player', new Vector3(fromX, 0, 10)),
    predictLanding: () => ball.predictLanding(), requestShot: () => { hit = true },
    requestServe: () => {}, isServing: false, serveNumber: 1, pressure: 0, momentum: 0,
  }
  let t = 0
  while (t < 6 && !hit) {
    const evs = ball.step(1 / 120); t += 1 / 120
    for (const e of evs) { if (e.kind === 'bounce') { bounces++; if (bounces === 1) { landZ = e.pos.z; landX = e.pos.x } if (bounces >= 2) secondBounce = true } }
    ai.update(1 / 120, ctx)
    if (secondBounce) break
  }
  return {
    hit, land: `(${landX?.toFixed(1)},${landZ?.toFixed(1)})`, bounces,
    startZ: startZ.toFixed(2), aiEnd: `(${ai.view.pos.x.toFixed(1)},${ai.view.pos.z.toFixed(1)})`, t: t.toFixed(2),
  }
}

console.log('HOME_POS_Z =', HOME_POS_Z.toFixed(2))
const cases = [
  ['ストレート短', new Vector3(0, 0, -2.6), 0],
  ['クロス ワイド短(左)', new Vector3(-3.0, 0, -2.6), 3],
  ['クロス ワイド短(右)', new Vector3(3.0, 0, -2.6), -3],
  ['ごく短い(ネット際)', new Vector3(-2.0, 0, -2.0), 2.5],
]
for (const [prof, pid] of [['normal', 'jokovin'], ['hard', 'jokovin'], ['normal', 'agachi'], ['hard', 'nadau']]) {
  for (const [label, tgt, fromX] of cases) {
    console.log(`${prof}/${pid} [${label}]:`, JSON.stringify(run(prof, pid, tgt, fromX)))
  }
}
