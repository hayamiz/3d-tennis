// スタミナ枯渇の影響検証: AI を左右の深いコーナーへ何度も走らせてスタミナを削った後、
// ネット際ドロップに届くか。stamina<=0 でスプリント不可(moveToward)になると、歩行では
// 深い位置からドロップに届かず doubleBounce する仮説の確認。
import { Vector3 } from 'three'
import { AIController } from '../src/gameplay/ai.ts'
import { solveShot } from '../src/gameplay/shot.ts'
import { BallSim } from '../src/physics/ball.ts'
import { AI_PROFILES, PLAYER_PERSONAS, personaModifiers } from '../src/constants.ts'

function run(profileName, personaId, rallyShots) {
  const p = PLAYER_PERSONAS[personaId]
  const ai = new AIController(AI_PROFILES[profileName], personaModifiers(p.ratings, p.mental), p.physique)
  ai.resetForPoint('player', true)
  const ball = new BallSim()
  let shotReq = null
  const pv = (side, pos) => ({ side, pos, vel: new Vector3(), stamina: 100, sprinting: false, swing: 'idle',
    lastShot: null, staminaPct: 1, charging: false, charge: 0, swingSide: null })
  const ctx = {
    phase: 'rally', ball: ball.state, self: ai.view, rival: pv('player', new Vector3(0, 0, 10)),
    predictLanding: () => ball.predictLanding(), requestShot: (r) => { shotReq = r },
    requestServe: () => {}, isServing: false, serveNumber: 1, pressure: 0, momentum: 0,
  }
  let t = 0
  // 長いラリー: 左右の深いコーナーへ交互に打ち、AI を走らせてスタミナを削る
  for (let i = 0; i < rallyShots; i++) {
    const side = i % 2 === 0 ? -1 : 1
    const sol = solveShot({ type: 'topspin', hitter: 'player', hitPos: new Vector3(0, 0.9, 10),
      target: new Vector3(side * 3.2, 0, -10.2), quality: 0.85, charge: 0.3, incomingSpeed: 16 })
    ball.launch(new Vector3(0, 0.9, 10), sol.vel, sol.spin, 'player')
    shotReq = null
    let guard = 0
    while (guard++ < 5 * 120) {
      ball.step(1 / 120); t += 1 / 120; ai.update(1 / 120, ctx)
      if (shotReq) break
      // ボールが相手側へ戻る/落ちたら次へ
      const bz = ball.state.pos.z
      if (bz > 0.5) break
    }
    // 返球(AI 側 → 相手側)。AI はホームへ後退復帰。
    ball.launch(new Vector3(ai.view.pos.x, 0.9, ai.view.pos.z), new Vector3(0, 6, 18), new Vector3(), 'opponent')
    for (let k = 0; k < Math.round(0.5 * 120); k++) { ball.step(1 / 120); t += 1 / 120; ai.update(1 / 120, ctx) }
  }
  const staminaBeforeDrop = ai.view.staminaPct.toFixed(2)
  const posBeforeDrop = `(${ai.view.pos.x.toFixed(1)},${ai.view.pos.z.toFixed(1)})`

  // ドロップ(ネット際)
  shotReq = null
  const drop = solveShot({ type: 'drop', hitter: 'player', hitPos: new Vector3(0, 0.9, 10),
    target: new Vector3(-2.0, 0, -2.55), quality: 0.9, charge: 0, incomingSpeed: 16 })
  ball.launch(new Vector3(0, 0.9, 10), drop.vel, drop.spin, 'player')
  let bounces = 0, hit = false, sawSprint = false
  const tStart = t
  while (t < tStart + 4) {
    const evs = ball.step(1 / 120); t += 1 / 120; ai.update(1 / 120, ctx)
    for (const e of evs) { if (e.kind === 'bounce') bounces++ }
    if (ai.view.sprinting) sawSprint = true
    if (shotReq) { hit = true; break }
    if (bounces >= 2) break
  }
  return { hit, bounces, staminaBeforeDrop, posBeforeDrop, sawSprintDuringChase: sawSprint }
}

for (const shots of [0, 6, 12, 20]) {
  for (const [prof, pid] of [['normal', 'jokovin']]) {
    console.log(`rally=${shots} ${prof}/${pid}:`, JSON.stringify(run(prof, pid, shots)))
  }
}
