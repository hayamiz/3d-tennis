import { Vector3 } from 'three'
import { solveShot, solveServe } from '../src/gameplay/shot.ts'
import { BallSim } from '../src/physics/ball.ts'
import { COURT_HALF_LENGTH, COURT_HALF_WIDTH, SERVICE_LINE_Z, SERVE_HIT_HEIGHT } from '../src/constants.ts'

// 打球の初速・弾道頂点・着地を計測
function analyze(hitPos, sol, hitter) {
  const sim = new BallSim()
  sim.launch(hitPos.clone(), sol.vel.clone(), sol.spin.clone(), hitter)
  const v0 = Math.hypot(sol.vel.x, sol.vel.y, sol.vel.z)
  let apex = hitPos.y, t = 0
  while (t < 8) {
    const evs = sim.step(1/120); t += 1/120
    apex = Math.max(apex, sim.state.pos.y)
    for (const e of evs) {
      if (e.kind === 'net') return { v0, apex, net:true }
      if (e.kind === 'bounce') {
        const inX = Math.abs(e.pos.x) <= COURT_HALF_WIDTH + 0.05
        const inZ = e.pos.z < 0 && e.pos.z > -COURT_HALF_LENGTH - 0.05
        return { v0, apex, net:false, lz:e.pos.z, in: inX && inZ }
      }
    }
  }
  return { v0, apex, timeout:true }
}

function trialReturn(label, type, vIn, charge, n=200) {
  let v=0, apex=0, weak=0
  for (let i=0;i<n;i++){
    const req={ type, hitter:'player', hitPos:new Vector3(0,0.95,10), target:new Vector3(0,0,-COURT_HALF_LENGTH+2), quality:0.85, charge, incomingSpeed:vIn }
    const r=analyze(req.hitPos, solveShot(req),'player')
    v+=r.v0; apex+=r.apex
    if (r.apex>3.0) weak++  // 山なり(チャンスボール)判定
  }
  console.log(`${label.padEnd(46)} v0=${(v/n).toFixed(1)} apex=${(apex/n).toFixed(2)}m 山なり率=${(100*weak/n).toFixed(0)}%`)
}

console.log('=== 速球(vIn=50)の返球: ショット種 × チャージ ===')
trialReturn('topspin 無チャージ(差し込まれ)', 'topspin', 50, 0)
trialReturn('topspin フルチャージ', 'topspin', 50, 1.0)
trialReturn('flat 無チャージ', 'flat', 50, 0)
trialReturn('slice 無チャージ(ブロック)', 'slice', 50, 0)
trialReturn('slice フルチャージ', 'slice', 50, 1.0)
console.log('--- 比較: 通常ラリー球速(vIn=20)では差し込まれ無し ---')
trialReturn('topspin 無チャージ vIn20(通常)', 'topspin', 20, 0)

console.log('\n=== サーブ3種(power=0.8, 中央狙い)===')
function trialServe(label, serveType, n=60) {
  let v=0, apex=0, inbox=0, lzx=0, lzz=0
  const box={zSign:-1, xMin:0, xMax:COURT_HALF_WIDTH}
  for (let i=0;i<n;i++){
    const hitPos=new Vector3(1.5,SERVE_HIT_HEIGHT,COURT_HALF_LENGTH+0.5)
    const target=new Vector3((box.xMin+box.xMax)/2,0,box.zSign*(SERVICE_LINE_Z-1.0))
    const sol=solveServe(hitPos, target, 0.8, 'player', serveType)
    // 初速
    v+=Math.hypot(sol.vel.x,sol.vel.y,sol.vel.z)
    // バウンド後の最高到達高 + 着地
    const sim=new BallSim(); sim.launch(hitPos.clone(),sol.vel.clone(),sol.spin.clone(),'player')
    let t=0, firstBounce=null, peakAfter=0, bounced=false
    while(t<6){ const evs=sim.step(1/120); t+=1/120
      if(bounced) peakAfter=Math.max(peakAfter,sim.state.pos.y)
      for(const e of evs){ if(e.kind==='bounce'){ if(!firstBounce){firstBounce=e.pos.clone(); bounced=true} } }
      if(firstBounce && t>2.5) break
    }
    apex+=peakAfter
    if(firstBounce){ lzx+=firstBounce.x; lzz+=firstBounce.z
      const inB = firstBounce.x>=-0.2 && firstBounce.x<=COURT_HALF_WIDTH+0.2 && firstBounce.z<0 && firstBounce.z>=-SERVICE_LINE_Z-0.3
      if(inB) inbox++ }
  }
  console.log(`${label.padEnd(10)} v0=${(v/n).toFixed(1)} バウンド後ピーク=${(apex/n).toFixed(2)}m 着地x=${(lzx/n).toFixed(2)} z=${(lzz/n).toFixed(2)} ボックスin=${(100*inbox/n).toFixed(0)}%`)
}
trialServe('flat','flat')
trialServe('slice','slice')
trialServe('kick','kick')
