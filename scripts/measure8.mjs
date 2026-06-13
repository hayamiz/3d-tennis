import { Vector3 } from 'three'
import { BallSim } from '../src/physics/ball.ts'
import { setSurface } from '../src/constants.ts'

// 同一初速で打ち出し、1バウンド後のピーク高さと、バウンド直後の水平速度を測る
function test(surface){
  setSurface(surface)
  const sim = new BallSim()
  sim.launch(new Vector3(0,1.0,10), new Vector3(0,5,-22), new Vector3(), 'player')
  let t=0, bounced=false, peak=0, hSpeedAfter=0
  while(t<6){
    const evs=sim.step(1/120); t+=1/120
    for(const e of evs){ if(e.kind==='bounce' && !bounced){ bounced=true
      hSpeedAfter=Math.hypot(sim.state.vel.x, sim.state.vel.z) } }
    if(bounced){ peak=Math.max(peak, sim.state.pos.y)
      if(sim.state.bounceCount>=2) break }
  }
  return { peak, hSpeedAfter }
}
for(const s of ['hard','clay','grass']){
  const r=test(s)
  console.log(s.padEnd(6), 'バウンド後ピーク高=', r.peak.toFixed(3), 'm  バウンド後水平速度=', r.hSpeedAfter.toFixed(1), 'm/s')
}
setSurface('hard')
