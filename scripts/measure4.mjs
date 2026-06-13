import { Vector3 } from 'three'
import { AIController } from '../src/gameplay/ai.ts'
import { AI_PROFILES, COURT_HALF_LENGTH } from '../src/constants.ts'

// レシーブ側 AI が、サーバー(プレイヤー)の x 位置に応じてどこに構えるか計測
function receiveX(profileName, serverX, serveFromRight=true, frames=140) {
  const ai = new AIController(AI_PROFILES[profileName])
  ai.resetForPoint('player', serveFromRight) // player がサーブ = AI はレシーバー
  const pv = (side,pos)=>({side,pos,vel:new Vector3(),stamina:100,sprinting:false,
    swing:'idle',lastShot:null,charging:false,charge:0,swingSide:null})
  const server = new Vector3(serverX, 0, COURT_HALF_LENGTH+0.5) // プレイヤーのサーブ位置
  const ball = { pos:new Vector3(serverX,1,COURT_HALF_LENGTH+0.5), vel:new Vector3(),
    spin:new Vector3(), bounceCount:0, lastHitBy:null, inPlay:false }
  const ctx = { phase:'serve', ball, self:pv('opponent',ai.view.pos), rival:pv('player',server),
    predictLanding:()=>null, requestShot:()=>{}, requestServe:()=>{}, isServing:false, serveNumber:1 }
  for (let s=0;s<frames;s++) ai.update(1/120, ctx)
  return ai.view.pos
}

console.log('レシーブ位置(serveFromRight=true: サーバーは +x 側、AIは -x 側のボックスを受ける)')
console.log('serverX'.padStart(8), 'hard.x'.padStart(8), 'normal.x'.padStart(9), 'easy.x'.padStart(8), '  (z≈ベースライン後方)')
for (const sx of [0.5, 2.0, 3.5]) {
  const h=receiveX('hard',sx), n=receiveX('normal',sx), e=receiveX('easy',sx)
  console.log(String(sx).padStart(8), h.x.toFixed(2).padStart(8), n.x.toFixed(2).padStart(9), e.x.toFixed(2).padStart(8), `  z=${h.z.toFixed(2)}`)
}
