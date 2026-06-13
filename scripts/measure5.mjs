import { Vector3 } from 'three'
import { solveShot, solveServe } from '../src/gameplay/shot.ts'
import { BallSim } from '../src/physics/ball.ts'
import { PLAYER_PERSONAS, PERSONA_ORDER, personaModifiers, COURT_HALF_LENGTH,
  SERVE_HIT_HEIGHT, SERVICE_LINE_Z, STAMINA_MAX, WALK_SPEED, REACH } from '../src/constants.ts'

function v0(sol){ return Math.hypot(sol.vel.x,sol.vel.y,sol.vel.z) }
function avgServe(mods){ let s=0; const n=40
  for(let i=0;i<n;i++){ const hp=new Vector3(1.5,SERVE_HIT_HEIGHT,COURT_HALF_LENGTH+0.5)
    const t=new Vector3(2,0,-(SERVICE_LINE_Z-1)); s+=v0(solveServe(hp,t,0.8,'player','flat',mods)) } return s/n }
function avgFlat(mods){ let s=0; const n=40
  for(let i=0;i<n;i++){ s+=v0(solveShot({type:'flat',hitter:'player',hitPos:new Vector3(0,0.9,10),
    target:new Vector3(0,0,-COURT_HALF_LENGTH+2),quality:0.9,charge:0,incomingSpeed:18,mods})) } return s/n }
function smashReturnApex(mods){ // vIn=50 を無チャージ topspin で返したときの弾道頂点(山なり度)
  let a=0; const n=60
  for(let i=0;i<n;i++){ const req={type:'topspin',hitter:'player',hitPos:new Vector3(0,0.95,10),
    target:new Vector3(0,0,-COURT_HALF_LENGTH+2),quality:0.85,charge:0,incomingSpeed:50,mods}
    const sol=solveShot(req); const sim=new BallSim(); sim.launch(req.hitPos.clone(),sol.vel,sol.spin,'player')
    let t=0,apex=0.95; while(t<8){ sim.step(1/120); t+=1/120; apex=Math.max(apex,sim.state.pos.y)
      if(sim.state.bounceCount>0)break } a+=apex } return a/n }

console.log('persona'.padEnd(12),'serve'.padStart(7),'flat'.padStart(7),'返球apex'.padStart(8),'走力'.padStart(7),'体力'.padStart(7),'リーチ'.padStart(7))
for(const id of PERSONA_ORDER){
  const p=PLAYER_PERSONAS[id]; const m=personaModifiers(p.ratings)
  console.log(id.padEnd(12),
    avgServe(m).toFixed(1).padStart(7),
    avgFlat(m).toFixed(1).padStart(7),
    smashReturnApex(m).toFixed(2).padStart(8),
    (WALK_SPEED*m.moveSpeedMul).toFixed(2).padStart(7),
    (STAMINA_MAX*m.staminaMaxMul).toFixed(0).padStart(7),
    (REACH*m.reachMul).toFixed(2).padStart(7))
}
