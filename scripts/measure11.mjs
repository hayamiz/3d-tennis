// BUG-002 再発の動的再現: 「AI が深い球を打ち返してホームへ後退している最中に
// プレイヤーがドロップを打つ」状況を再現し、AI がドロップに届く(shot)か検証する。
// 生ログ(normal/jokovin)では AI は後退慣性を抱えたままドロップに届かず doubleBounce した。
import { Vector3 } from 'three'
import { AIController } from '../src/gameplay/ai.ts'
import { solveShot } from '../src/gameplay/shot.ts'
import { BallSim } from '../src/physics/ball.ts'
import { AI_PROFILES, PLAYER_PERSONAS, personaModifiers, HOME_POS_Z } from '../src/constants.ts'

function run(profileName, personaId, dropTarget, fromX) {
  const p = PLAYER_PERSONAS[personaId]
  const ai = new AIController(AI_PROFILES[profileName], personaModifiers(p.ratings, p.mental), p.physique)
  ai.resetForPoint('player', true)
  const ball = new BallSim()

  let shotReq = null
  const pv = (side, pos) => ({ side, pos, vel: new Vector3(), stamina: 100, sprinting: false, swing: 'idle',
    lastShot: null, staminaPct: 1, charging: false, charge: 0, swingSide: null })
  const ctx = {
    phase: 'rally', ball: ball.state, self: ai.view, rival: pv('player', new Vector3(fromX, 0, 10)),
    predictLanding: () => ball.predictLanding(), requestShot: (r) => { shotReq = r },
    requestServe: () => {}, isServing: false, serveNumber: 1, pressure: 0, momentum: 0,
  }

  // フェーズ1: プレイヤーが深い球を AI 奥へ → AI が追って打ち返す
  const deep = solveShot({ type: 'topspin', hitter: 'player', hitPos: new Vector3(fromX, 0.9, 10),
    target: new Vector3(-fromX * 0.5, 0, -10.5), quality: 0.85, charge: 0.3, incomingSpeed: 15 })
  ball.launch(new Vector3(fromX, 0.9, 10), deep.vel, deep.spin, 'player')

  let t = 0
  let deepHit = false
  // 深い球を AI が打つまで進める
  while (t < 5 && !deepHit) {
    ball.step(1 / 120); t += 1 / 120
    ai.update(1 / 120, ctx)
    if (shotReq) { deepHit = true }
  }
  const aiAtDeepHit = `(${ai.view.pos.x.toFixed(1)},${ai.view.pos.z.toFixed(1)})`

  // フェーズ2: AI の返球を相手側へ飛ばす(lastHitBy=AI 側)→ AI はホームへ後退復帰
  shotReq = null
  ball.launch(new Vector3(ai.view.pos.x, 0.9, ai.view.pos.z), new Vector3(0, 6, 18), new Vector3(), 'opponent')
  // 後退復帰させる時間(プレイヤーが次に打つまでの間)
  for (let k = 0; k < Math.round(0.7 * 120); k++) { ball.step(1 / 120); t += 1 / 120; ai.update(1 / 120, ctx) }
  const aiBeforeDrop = `(${ai.view.pos.x.toFixed(1)},${ai.view.pos.z.toFixed(1)})`
  const vzBeforeDrop = ai.view.vel.z.toFixed(2)

  // フェーズ3: プレイヤーがドロップ
  shotReq = null
  const drop = solveShot({ type: 'drop', hitter: 'player', hitPos: new Vector3(fromX, 0.9, 10),
    target: dropTarget, quality: 0.9, charge: 0, incomingSpeed: 16 })
  ball.launch(new Vector3(fromX, 0.9, 10), drop.vel, drop.spin, 'player')
  let bounces = 0, hit = false
  const tStart = t
  while (t < tStart + 4) {
    const evs = ball.step(1 / 120); t += 1 / 120
    for (const e of evs) { if (e.kind === 'bounce') bounces++ }
    ai.update(1 / 120, ctx)
    if (shotReq) { hit = true; break }
    if (bounces >= 2) break
  }
  return { hit, bounces, aiAtDeepHit, aiBeforeDrop, vzBeforeDrop, aiEnd: `(${ai.view.pos.x.toFixed(1)},${ai.view.pos.z.toFixed(1)})` }
}

console.log('HOME_POS_Z =', HOME_POS_Z.toFixed(2))
const cases = [
  ['ストレート短', new Vector3(0, 0, -2.55), 0],
  ['クロス短(左)', new Vector3(-2.8, 0, -2.55), 3],
  ['クロス短(右)', new Vector3(2.8, 0, -2.55), -3],
]
for (const [prof, pid] of [['normal', 'jokovin'], ['hard', 'jokovin']]) {
  for (const [label, tgt, fromX] of cases) {
    console.log(`${prof}/${pid} [${label}]:`, JSON.stringify(run(prof, pid, tgt, fromX)))
  }
}
