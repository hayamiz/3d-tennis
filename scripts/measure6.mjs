import { Vector3 } from 'three'
import { solveServe } from '../src/gameplay/shot.ts'
import { BallSim } from '../src/physics/ball.ts'
import { COURT_HALF_WIDTH, SERVICE_LINE_Z, COURT_HALF_LENGTH, SERVE_HIT_HEIGHT } from '../src/constants.ts'

function landOf(hp, sol){ const sim=new BallSim(); sim.launch(hp.clone(),sol.vel.clone(),sol.spin.clone(),'player')
  let t=0; while(t<6){ const evs=sim.step(1/120); t+=1/120
    for(const e of evs){ if(e.kind==='net')return{net:true}; if(e.kind==='bounce')return{x:e.pos.x,z:e.pos.z} } }
  return {timeout:true} }

// AI 風に power をサンプル(hard 1st: 平均0.84 σ0.08、時々 >0.88 のオーバーパワー)
function gauss(){let u=0,v=0;while(u===0)u=Math.random();while(v===0)v=Math.random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)}

for (const type of ['flat','slice','kick']) {
  let inbox=0, wild=0, net=0, out=0; const n=500
  for(let i=0;i<n;i++){
    const power=Math.max(0,Math.min(1,0.84+gauss()*0.08))
    const box={zSign:-1,xMin:0,xMax:COURT_HALF_WIDTH}
    const aimX=[-1,0,1][Math.floor(Math.random()*3)]
    const m=0.5, xc=(box.xMin+box.xMax)/2
    const xAim = aimX===0?xc: aimX>0?box.xMax-m:box.xMin+m
    const hp=new Vector3(1.5+Math.random()*1.5,SERVE_HIT_HEIGHT,COURT_HALF_LENGTH+0.5)
    const target=new Vector3(xAim,0,box.zSign*(SERVICE_LINE_Z-1))
    const r=landOf(hp, solveServe(hp,target,power,'player',type))
    if(r.net){net++;continue}
    if(r.timeout){wild++;continue}
    const inB = r.x>=-0.3 && r.x<=COURT_HALF_WIDTH+0.3 && r.z<0 && r.z>=-SERVICE_LINE_Z-0.4
    if(inB) inbox++
    else { out++; // 「的外れ方向」= 狙いと反対サイド(x<-1)や大きく外(|x|>幅+2)
      if (r.x < -1.0 || Math.abs(r.x) > COURT_HALF_WIDTH+2 || r.z < -SERVICE_LINE_Z-3) wild++ }
  }
  console.log(`${type.padEnd(6)} in=${(100*inbox/n).toFixed(0)}% out=${(100*out/n).toFixed(0)}% net=${(100*net/n).toFixed(0)}% 的外れ(wild)=${(100*wild/n).toFixed(1)}%`)
}
