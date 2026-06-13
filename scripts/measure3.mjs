import { Vector3 } from 'three'
import { AIController } from '../src/gameplay/ai.ts'
import { AI_PROFILES, COURT_HALF_LENGTH } from '../src/constants.ts'

// AI に「相手の打球(着地予測 predZ)」を与え、見送る(打たない)割合を計測
function leaveRate(profileName, predZ, trials=400) {
  let leaves = 0
  for (let t=0; t<trials; t++) {
    const ai = new AIController(AI_PROFILES[profileName])
    const ball = { pos:new Vector3(0,0.5,-12), vel:new Vector3(0,0,1), spin:new Vector3(),
      bounceCount:0, lastHitBy:'player', inPlay:true }
    const pred = { pos:new Vector3(0,0,predZ), time:0.5 }
    const pv = (side,z)=>({side,pos:new Vector3(0,0,z),vel:new Vector3(),stamina:100,
      sprinting:false,swing:'idle',lastShot:null,charging:false,charge:0,swingSide:null})
    let hit=false
    const ctx = { phase:'rally', ball, self:pv('opponent',-12), rival:pv('player',10),
      predictLanding:()=>pred, requestShot:()=>{hit=true}, requestServe:()=>{},
      isServing:false, serveNumber:1 }
    for (let s=0;s<50;s++){
      ball.pos.copy(ai.view.pos); ball.pos.y=0.5  // 常にリーチ内に保つ
      ai.update(1/120, ctx)
      if (hit) break
    }
    if (!hit) leaves++
  }
  return (100*leaves/trials).toFixed(0)+'%'
}

const baseline = COURT_HALF_LENGTH // 11.885
const cases = {
  '明らかにアウト(1.0m深い)':  -(baseline+1.0),
  'きわどいアウト(0.1m)':      -(baseline+0.1),
  'ライン内(0.5m内側)':        -(baseline-0.5),
  'コート中央(in)':            -(baseline-4),
}
console.log('見送り率(打たずにアウトを見送った割合)')
console.log('case'.padEnd(26), 'hard'.padStart(6), 'normal'.padStart(8), 'easy'.padStart(7))
for (const [label, z] of Object.entries(cases)) {
  console.log(label.padEnd(24), leaveRate('hard',z).padStart(7), leaveRate('normal',z).padStart(8), leaveRate('easy',z).padStart(7))
}
