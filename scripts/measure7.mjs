import { PLAYER_PERSONAS, personaModifiers, shotStaminaCost,
  STAMINA_REGEN_IDLE, STAMINA_MOVE_DRAIN_K, STAMINA_SPRINT_EXTRA,
  WALK_SPEED, SPRINT_SPEED, STAMINA_MAX } from '../src/constants.ts'

const N = personaModifiers({serve:3,power:3,spin:3,speed:3,stamina:3,finesse:3}, 3) // 参考
function net(speed, sprint, m, pressure){
  const drive = m.staminaDrainMul * (1 + (m.pressureDrainMul-1)*pressure)
  return STAMINA_REGEN_IDLE*m.staminaRegenMul*m.clutchRecoveryMul
       - STAMINA_MOVE_DRAIN_K*speed*drive
       - (sprint?STAMINA_SPRINT_EXTRA:0)*drive
}
// 中立(全1.0)
const NEU = {staminaRegenMul:1,staminaDrainMul:1,clutchRecoveryMul:1,pressureDrainMul:1,staminaMaxMul:1}
console.log('=== 中立スタミナ net/s(§5.2 目標と一致するか)===')
console.log('静止       ', net(0,false,NEU,0).toFixed(1))
console.log('歩行(5.5) ', net(WALK_SPEED,false,NEU,0).toFixed(1))
console.log('スプリント ', net(SPRINT_SPEED,true,NEU,0).toFixed(1))

console.log('\n=== ショット消費(中立, driveMul=1)===')
console.log('スライス c0     ', shotStaminaCost('slice',0,false))
console.log('トップスピン c0 ', shotStaminaCost('topspin',0,false))
console.log('フラット c0     ', shotStaminaCost('flat',0,false))
console.log('フラット c1.0   ', shotStaminaCost('flat',1.0,false))
console.log('フラット c1.25  ', shotStaminaCost('flat',1.25,false))
console.log('スマッシュ c1.0 ', shotStaminaCost('flat',1.0,true))

console.log('\n=== ペルソナ別: 歩行net/s・上限・プレッシャー時(p=1)スプリントnet/s ===')
console.log('persona'.padEnd(12),'上限'.padStart(6),'歩行'.padStart(7),'走p0'.padStart(7),'走p1'.padStart(7))
for(const id of ['nishigoori','jokovin','nadau','sambrant']){
  const p=PLAYER_PERSONAS[id]; const m=personaModifiers(p.ratings,p.mental)
  console.log(id.padEnd(12),(STAMINA_MAX*m.staminaMaxMul).toFixed(0).padStart(6),
    net(WALK_SPEED,false,m,0).toFixed(1).padStart(7),
    net(SPRINT_SPEED,true,m,0).toFixed(1).padStart(7),
    net(SPRINT_SPEED,true,m,1).toFixed(1).padStart(7))
}
