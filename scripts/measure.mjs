// solveShot を直接呼び、文脈ごとの初速・着地を計測する診断
import { Vector3 } from 'three'
import { solveShot } from '../src/gameplay/shot.ts'
import { BallSim } from '../src/physics/ball.ts'
import { COURT_HALF_LENGTH, COURT_HALF_WIDTH } from '../src/constants.ts'

function landOf(hitPos, sol, hitter) {
  const sim = new BallSim()
  sim.launch(hitPos.clone(), sol.vel.clone(), sol.spin.clone(), hitter)
  let t = 0
  while (t < 8) {
    const evs = sim.step(1/120); t += 1/120
    for (const e of evs) {
      if (e.kind === 'net') return { net: true }
      if (e.kind === 'bounce') {
        const inX = Math.abs(e.pos.x) <= COURT_HALF_WIDTH + 0.05
        const inZ = e.pos.z < 0 && e.pos.z > -COURT_HALF_LENGTH - 0.05
        return { net:false, x:e.pos.x, z:e.pos.z, in: inX && inZ }
      }
    }
  }
  return { timeout: true }
}

// N回試行して初速平均、ネット率、アウト率を集計
function trial(label, mk, n=300) {
  let v=0, net=0, out=0, inn=0
  let lastVel=0
  for (let i=0;i<n;i++){
    const req = mk()
    const sol = solveShot(req)
    const speed = Math.hypot(sol.vel.x, sol.vel.y, sol.vel.z)
    v += speed; lastVel = speed
    const r = landOf(req.hitPos, sol, req.hitter)
    if (r.net) net++; else if (r.in) inn++; else out++
  }
  console.log(`${label.padEnd(42)} v=${(v/n).toFixed(1)} m/s  in=${(100*inn/n).toFixed(0)}% out=${(100*out/n).toFixed(0)}% net=${(100*net/n).toFixed(0)}%`)
}

const P='player'
// 共通の深め中央ターゲット
const deepTarget = () => new Vector3(0,0,-COURT_HALF_LENGTH+2)
function base(over){ return { type:'flat', hitter:P, hitPos:new Vector3(0,0.9,10), target:deepTarget(), quality:0.9, charge:0, incomingSpeed:18, ...over } }

console.log('=== 同じ深め中央ターゲットへ、文脈だけ変えて打つ ===')
trial('通常フラット(中打点h0.9 ベースライン)', ()=>base({}))
trial('低打点フラット h0.3 charge0', ()=>base({hitPos:new Vector3(0,0.3,10), charge:0}))
trial('低打点フラット h0.3 charge1.0(強打)', ()=>base({hitPos:new Vector3(0,0.3,10), charge:1.0}))
trial('前寄り低打点フラット z3 h0.4 charge1.0', ()=>base({hitPos:new Vector3(0,0.4,3), charge:1.0}))
trial('スマッシュ(h2.0 前z4 flat)', ()=>base({hitPos:new Vector3(0,2.0,4)}))
trial('スマッシュ+charge1.0', ()=>base({hitPos:new Vector3(0,2.0,4), charge:1.0}))
trial('高打点フラット but 後方z10(非スマ)', ()=>base({hitPos:new Vector3(0,2.0,10)}))

console.log('\n=== リダイレクト(球威):同条件で incomingSpeed だけ変える ===')
trial('フラット vIn=5(遅球)', ()=>base({incomingSpeed:5}))
trial('フラット vIn=20', ()=>base({incomingSpeed:20}))
trial('フラット vIn=38(速球)', ()=>base({incomingSpeed:38}))

console.log('\n=== トップスピンの角度(クロス浅め):打点高さを変える ===')
const crossT = () => new Vector3(COURT_HALF_WIDTH-0.4,0,-5) // 浅いクロス
trial('topspin 中打点h0.9 → 鋭角クロス', ()=>base({type:'topspin', target:crossT()}))
trial('topspin 高打点h1.8 → 鋭角クロス', ()=>base({type:'topspin', hitPos:new Vector3(0,1.8,8), target:crossT()}))

console.log('\n=== タッチショット(緩急吸収):球威を変えてドロップ ===')
const dropT=()=>new Vector3(0,0,-2.5)
trial('drop vIn=8(遅球から)', ()=>base({type:'drop', target:dropT(), incomingSpeed:8}))
trial('drop vIn=35(速球から)', ()=>base({type:'drop', target:dropT(), incomingSpeed:35}))
