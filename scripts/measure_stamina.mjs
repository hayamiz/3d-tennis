// 新スタミナシステム(クールダウン制)の主要シナリオを数値で検証・出力する診断スクリプト。
// 新モデルの仕様: GAME_DESIGN.md §6 / ARCHITECTURE.md §6.5
//
// 実行方法: npx tsx scripts/measure_stamina.mjs

import {
  PLAYER_PERSONAS,
  PERSONA_ORDER,
  personaModifiers,
  STAMINA_MAX,
  STAMINA_COOLDOWN,
  STAMINA_REGEN,
  STRONG_SHOT_COST_MAX,
  CHARGE_STRONG_THRESHOLD,
  STAMINA_SPRINT_DRAIN,
  SPRINT_STOP_PCT,
  SPRINT_RESUME_PCT,
  CHARGE_ENABLE_PCT,
  chargeShotCost,
  isStrongCharge,
} from '../src/constants.ts'

// ============================================================
// ヘルパー
// ============================================================
const hr = (char = '─', n = 70) => console.log(char.repeat(n))
const row = (...cols) => console.log(cols.join(''))
const pad = (s, w, right = true) => {
  const str = String(s)
  return right ? str.padStart(w) : str.padEnd(w)
}

// ============================================================
// §1  ペルソナ別 effStock と最大強打何発打てるか
// ============================================================
console.log('\n▼ §1  ペルソナ別 effStock と最大強打(c=CHARGE_MAX)での発数')
console.log('  ペルソナの staminaMaxMul はストック量(上限)にのみ影響する。')
console.log('  消費・回復・クールダウンは全員共通(旧モデルの三重取りを廃止)。')
console.log()
console.log(
  pad('ペルソナ', 16, false) +
  pad('stamina', 9) +
  pad('staminaMaxMul', 15) +
  pad('effStock', 10) +
  pad('最大強打(回)', 14),
)
hr()
for (const id of PERSONA_ORDER) {
  const p = PLAYER_PERSONAS[id]
  const m = personaModifiers(p.ratings, p.mental)
  const effStock = STAMINA_MAX * m.staminaMaxMul
  const shots = effStock / STRONG_SHOT_COST_MAX
  console.log(
    pad(id, 16, false) +
    pad(p.ratings.stamina, 9) +
    pad(m.staminaMaxMul.toFixed(2), 15) +
    pad(effStock.toFixed(0), 10) +
    pad(shots.toFixed(1) + ' 発', 14),
  )
}
console.log()
console.log(`  基準: STAMINA_MAX=${STAMINA_MAX}, STRONG_SHOT_COST_MAX=${STRONG_SHOT_COST_MAX}`)

// ============================================================
// §2  最大強打を2秒間隔で連打すると何発でスタミナが尽きるか
// ============================================================
console.log('\n▼ §2  最大強打を2秒間隔で連打 → 何発でスタミナが尽きるか')
console.log(`  連打間隔=2s < STAMINA_COOLDOWN(${STAMINA_COOLDOWN}s) のため回復は挟まらない。`)
console.log(`  各打球で STRONG_SHOT_COST_MAX(${STRONG_SHOT_COST_MAX})を消費し続けるので effStock/10 発になる。`)
console.log()
console.log(
  pad('ペルソナ', 16, false) +
  pad('effStock', 10) +
  pad('理論値(発)', 12) +
  pad('シミュレーション(発)', 20),
)
hr()
for (const id of PERSONA_ORDER) {
  const p = PLAYER_PERSONAS[id]
  const m = personaModifiers(p.ratings, p.mental)
  const effStock = STAMINA_MAX * m.staminaMaxMul
  const theoryShots = Math.floor(effStock / STRONG_SHOT_COST_MAX)

  // シミュレーション: 毎2秒に最大チャージ強打を打ち、スタミナがゼロ以下になったら終了
  // クールダウン2.5s > 打球間隔2s → 前の打球クールダウンが終わる前に次が来る → 回復なし
  let stamina = effStock
  let cooldownRemaining = 0
  let shots = 0
  const INTERVAL = 2.0          // 連打間隔(秒)
  const DT = 1 / 120            // 物理タイムステップ
  const MAX_TIME = 300          // 最大シミュレーション秒(無限ループ防止)
  let time = 0

  while (time < MAX_TIME) {
    // 物理ステップ: クールダウン消化・回復
    cooldownRemaining = Math.max(0, cooldownRemaining - DT)
    if (cooldownRemaining <= 0) {
      stamina = Math.min(effStock, stamina + STAMINA_REGEN * DT)
    }

    // 2秒ごとに最大チャージ強打
    const shotStep = Math.round(INTERVAL / DT)
    const currentStep = Math.round(time / DT)
    if (currentStep % shotStep === 0 && time > 0) {
      stamina -= STRONG_SHOT_COST_MAX
      cooldownRemaining = STAMINA_COOLDOWN
      shots++
      if (stamina <= 0) break
    }
    time += DT
  }

  const theoryStr = `${theoryShots} 発`
  const simStr = `${shots} 発`
  console.log(
    pad(id, 16, false) +
    pad(effStock.toFixed(0), 10) +
    pad(theoryStr, 12) +
    pad(simStr, 20),
  )
}

// ============================================================
// §3  スプリントを連続したときの持続秒
// ============================================================
console.log('\n▼ §3  スプリント連続時の持続秒(effStock / STAMINA_SPRINT_DRAIN)')
console.log(`  スプリント消費: STAMINA_SPRINT_DRAIN=${STAMINA_SPRINT_DRAIN} /s(全員共通、ペルソナ差なし)。`)
console.log()
console.log(
  pad('ペルソナ', 16, false) +
  pad('effStock', 10) +
  pad('スプリント持続(秒)', 20),
)
hr()
for (const id of PERSONA_ORDER) {
  const p = PLAYER_PERSONAS[id]
  const m = personaModifiers(p.ratings, p.mental)
  const effStock = STAMINA_MAX * m.staminaMaxMul
  const durSec = effStock / STAMINA_SPRINT_DRAIN
  console.log(
    pad(id, 16, false) +
    pad(effStock.toFixed(0), 10) +
    pad(durSec.toFixed(1) + ' 秒', 20),
  )
}

// ============================================================
// §4  クールダウン経過後に満タンまで回復する秒数
// ============================================================
console.log('\n▼ §4  クールダウン経過後の回復速度(effStock / STAMINA_REGEN)')
console.log(`  STAMINA_REGEN=${STAMINA_REGEN} /s(全員共通)。`)
console.log(`  STAMINA_COOLDOWN=${STAMINA_COOLDOWN} s の後から回復が再開する。`)
console.log()
console.log(
  pad('ペルソナ', 16, false) +
  pad('effStock', 10) +
  pad('回復時間(秒)', 14) +
  pad('合計(CD込み,秒)', 18),
)
hr()
for (const id of PERSONA_ORDER) {
  const p = PLAYER_PERSONAS[id]
  const m = personaModifiers(p.ratings, p.mental)
  const effStock = STAMINA_MAX * m.staminaMaxMul
  const regenSec = effStock / STAMINA_REGEN
  const totalSec = STAMINA_COOLDOWN + regenSec
  console.log(
    pad(id, 16, false) +
    pad(effStock.toFixed(0), 10) +
    pad(regenSec.toFixed(1) + ' 秒', 14) +
    pad(totalSec.toFixed(1) + ' 秒', 18),
  )
}

// ============================================================
// §5  切れペナルティ閾値の絶対値と「CHARGE_ENABLE ≥ 最大強打1発」の確認
// ============================================================
console.log('\n▼ §5  スタミナ切れペナルティ閾値の絶対値(各ペルソナ)')
console.log(`  SPRINT_STOP_PCT=${SPRINT_STOP_PCT}  SPRINT_RESUME_PCT=${SPRINT_RESUME_PCT}  CHARGE_ENABLE_PCT=${CHARGE_ENABLE_PCT}`)
console.log(`  CHARGE_ENABLE の絶対値が STRONG_SHOT_COST_MAX(${STRONG_SHOT_COST_MAX})以上であることを確認する。`)
console.log(`  「チャージを始められた=最後まで打ち切れる」を保証する設計。`)
console.log()
console.log(
  pad('ペルソナ', 16, false) +
  pad('effStock', 10) +
  pad('STOP(絶対値)', 14) +
  pad('RESUME(絶対値)', 16) +
  pad('CHARGE_ENABLE(絶対値)', 22) +
  pad('≥10発OK?', 10),
)
hr()
let allOk = true
for (const id of PERSONA_ORDER) {
  const p = PLAYER_PERSONAS[id]
  const m = personaModifiers(p.ratings, p.mental)
  const effStock = STAMINA_MAX * m.staminaMaxMul
  const stopAbs = effStock * SPRINT_STOP_PCT
  const resumeAbs = effStock * SPRINT_RESUME_PCT
  const chargeEnableAbs = effStock * CHARGE_ENABLE_PCT
  const ok = chargeEnableAbs >= STRONG_SHOT_COST_MAX
  if (!ok) allOk = false
  console.log(
    pad(id, 16, false) +
    pad(effStock.toFixed(0), 10) +
    pad(stopAbs.toFixed(1), 14) +
    pad(resumeAbs.toFixed(1), 16) +
    pad(chargeEnableAbs.toFixed(1), 22) +
    pad(ok ? '✓ OK' : '✗ NG', 10),
  )
}
hr()
console.log(`  全ペルソナ CHARGE_ENABLE ≥ ${STRONG_SHOT_COST_MAX}: ${allOk ? '✓ すべて OK' : '✗ NG あり(要確認)'}`)

// ============================================================
// §6  chargeShotCost() の動作確認(閾値・線形補間)
// ============================================================
console.log('\n▼ §6  chargeShotCost() の動作確認(閾値=CHARGE_STRONG_THRESHOLD=' + CHARGE_STRONG_THRESHOLD + ')')
console.log('  閾値未満は0、閾値で0、c=1(最大)で STRONG_SHOT_COST_MAX(' + STRONG_SHOT_COST_MAX + ')になる線形関数。')
console.log()
// CHARGE_MAX = 1.25 として c = charge/CHARGE_MAX を計算
const CHARGE_MAX_VAL = 1.25
const testCharges = [0, 0.25, CHARGE_STRONG_THRESHOLD * CHARGE_MAX_VAL, 0.5, 0.75, 1.0, 1.25]
console.log(pad('charge(入力)', 16, false) + pad('c(正規化)', 12) + pad('isStrong?', 12) + pad('cost', 10))
hr()
for (const charge of testCharges) {
  const c = charge / CHARGE_MAX_VAL
  const strong = isStrongCharge(charge)
  const cost = chargeShotCost(charge)
  console.log(
    pad(charge.toFixed(2) + ' (c=' + c.toFixed(2) + ')', 16, false) +
    pad(c.toFixed(2), 12) +
    pad(strong ? '強打' : '弱打', 12) +
    pad(cost.toFixed(2), 10),
  )
}

// ============================================================
// §7  サーブのスタミナ消費(power=0.5 / 1.0)
// ============================================================
console.log('\n▼ §7  サーブのスタミナ消費(SERVE_STAMINA_MAX × power。全員共通)')
// SERVE_STAMINA_MAX は import できるため直接使う
import { SERVE_STAMINA_MAX } from '../src/constants.ts'
console.log(`  SERVE_STAMINA_MAX=${SERVE_STAMINA_MAX}`)
for (const power of [0.5, 0.75, 1.0]) {
  const cost = SERVE_STAMINA_MAX * power
  console.log(`  power=${power.toFixed(2)} → 消費 ${cost.toFixed(1)}  クールダウン(${STAMINA_COOLDOWN}s)をリフレッシュ`)
}

console.log()
hr('=')
console.log('  以上、新スタミナシステム(クールダウン制)の主要数値検証完了')
hr('=')
