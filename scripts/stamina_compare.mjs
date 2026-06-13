// スタミナ影響度の調整前後比較(各ペルソナ)。実コードは変更せず、式だけここで再現して比較する。
// 現状 vs 調整案で effMax / drainMul / regenMul と「全力追走の持続秒」を出す。
import { PLAYER_PERSONAS, STAMINA_MAX, STAMINA_MOVE_DRAIN_K, STAMINA_SPRINT_EXTRA, STAMINA_REGEN_IDLE } from '../src/constants.ts'

// --- 現状の式(constants.ts personaModifiers) ---
const CUR = {
  maxMul: (s) => 0.7 + 0.12 * s,
  drainMul: (s) => 1.2 - 0.1 * s,
  regenMul: (s) => 0.8 + 0.1 * s,
}
// --- 案A: レーティングの効き幅を圧縮(影響度そのものを緩和。上位も少し下がる) ---
const PROP_A = {
  maxMul: (s) => 0.80 + 0.10 * s,   // s2:0.94→1.00 / s5:1.30→1.30
  drainMul: (s) => 1.14 - 0.08 * s, // s2:1.00→0.98 / s5:0.70→0.74
  regenMul: (s) => 0.84 + 0.09 * s, // s2:1.00→1.02 / s5:1.30→1.29
}
// --- 案B: 上位(s5)は据え置き、低スタミナ側だけ底上げ(ニシゴオリ重視・グラインダー不変) ---
const PROP_B = {
  maxMul: (s) => 0.80 + 0.10 * s,       // s2:0.94→1.00 / s5:1.30(不変)
  drainMul: (s) => 1.067 - 0.0733 * s,  // s2:1.00→0.92 / s5:0.70(不変)
  regenMul: (s) => 0.883 + 0.0833 * s,  // s2:1.00→1.05 / s5:1.30(不変)
}
const clutch = (m) => 0.85 + 0.07 * m // 回復に乗る精神力係数

// 全力追走(speed=5 m/s, スプリント, pressure=0)での正味消費と持続秒
function enduranceSec(maxMul, drainMul, regenMul, mental) {
  const effMax = STAMINA_MAX * maxMul
  const drain = (STAMINA_MOVE_DRAIN_K * 5 + STAMINA_SPRINT_EXTRA) * drainMul
  const regen = STAMINA_REGEN_IDLE * regenMul * clutch(mental)
  const net = drain - regen
  return net > 0 ? effMax / net : Infinity
}

const f1 = (x) => (x === Infinity ? '∞' : x.toFixed(1))
const pct = (a, b) => `${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(0)}%`
const sec = (M, m) => (s, mental) => enduranceSec(M.maxMul(s), M.drainMul(s), M.regenMul(s), mental)
const secCur = sec(CUR), secA = sec(PROP_A), secB = sec(PROP_B)
console.log('ペルソナ          stam  effMax 現→A→B       全力追走 持続秒  現 → 案A → 案B   (対現状)')
for (const id of Object.keys(PLAYER_PERSONAS)) {
  const p = PLAYER_PERSONAS[id]
  const s = p.ratings.stamina, m = p.mental
  const c = secCur(s, m), a = secA(s, m), b = secB(s, m)
  const name = (p.name + '　　　　　').slice(0, 9)
  console.log(
    `${name} s=${s}  ${f1(STAMINA_MAX * CUR.maxMul(s))}→${f1(STAMINA_MAX * PROP_A.maxMul(s))}→${f1(STAMINA_MAX * PROP_B.maxMul(s))}   ` +
    `${f1(c)}s → ${f1(a)}s(${pct(c, a)}) → ${f1(b)}s(${pct(c, b)})`,
  )
}
