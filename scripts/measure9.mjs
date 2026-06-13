// BUG-002 検証: 深い位置の AI へドロップを打ち、AI が前進して拾える(shot を出す)か
import { Vector3 } from 'three'
import { AIController } from '../src/gameplay/ai.ts'
import { solveShot } from '../src/gameplay/shot.ts'
import { BallSim } from '../src/physics/ball.ts'
import { AI_PROFILES, PLAYER_PERSONAS, personaModifiers, COURT_HALF_LENGTH } from '../src/constants.ts'

function run(profileName, personaId){
  const p = PLAYER_PERSONAS[personaId]
  const ai = new AIController(AI_PROFILES[profileName], personaModifiers(p.ratings, p.mental), p.physique)
  ai.resetForPoint('player', true) // player サーブ=AIレシーバー。AIはホーム(深い ~-12.9)
  // プレイヤーがドロップを打つ: ベースライン(z=10)から AI コートのネット際(z=-3)へ
  const req = { type:'drop', hitter:'player', hitPos:new Vector3(0,0.9,10),
    target:new Vector3(0,0,-3), quality:0.9, charge:0, incomingSpeed:18 }
  const sol = solveShot(req)
  const ball = new BallSim()
  ball.launch(req.hitPos.clone(), sol.vel, sol.spin, 'player')
  // ハンドオフ: hit イベントを AI に観測させるためのフラグ管理は ai 内部の lastHitBy で行う
  let hit=false, landZ=null, secondBounce=false, bounces=0
  const pv=(side,pos)=>({side,pos,vel:new Vector3(),stamina:100,sprinting:false,swing:'idle',
    lastShot:null,staminaPct:1,charging:false,charge:0,swingSide:null})
  const ctx={ phase:'rally', ball: ball.state,
    self: ai.view, rival: pv('player', new Vector3(0,0,10)),
    predictLanding:()=>ball.predictLanding(), requestShot:()=>{hit=true},
    requestServe:()=>{}, isServing:false, serveNumber:1, pressure:0, momentum:0 }
  let t=0
  while(t<6 && !hit){
    const evs=ball.step(1/120); t+=1/120
    for(const e of evs){ if(e.kind==='bounce'){ bounces++; if(bounces===1) landZ=e.pos.z; if(bounces>=2) secondBounce=true } }
    ai.update(1/120, ctx)
    if(secondBounce) break
  }
  const aiPos = ai.view.pos
  return { hit, landZ: landZ?.toFixed(2), bounces, aiZ: aiPos.z.toFixed(2), t: t.toFixed(2) }
}

for(const [prof,pid] of [['hard','jokovin'],['hard','nadau'],['normal','agachi'],['hard','sambrant']]){
  console.log(`${prof}/${pid}:`, JSON.stringify(run(prof,pid)))
}
