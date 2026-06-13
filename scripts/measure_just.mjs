// ジャストミート(§6.1.1・リリース方式)の検証:
// チャージ保持中に「離した瞬間」打球。離した時 hDist≤JUST_SWEET_DIST なら just。
// 離さずにいるとスイートゾーンを抜けて遠ざかった瞬間にセーフティ打球(just なし)。
// リーチ外で離すと空振り(打球なし)。
import { Vector3 } from 'three'
import { PlayerController } from '../src/gameplay/player.ts'
import { PLAYER_PERSONAS, personaModifiers, REACH, JUST_SWEET_DIST } from '../src/constants.ts'

const DT = 1 / 120
const p = PLAYER_PERSONAS['federun']
const mods = personaModifiers(p.ratings, p.mental)
const reach = REACH * mods.reachMul

function fakeInput(states) {
  let i = 0
  const blank = { moveX: 0, moveZ: 0, sprint: false, shotPressed: null, shotHeld: null, shotReleased: null, servePressed: false, serveReleased: false, escPressed: false }
  return { poll: () => ({ ...blank, ...(states[Math.min(i++, states.length - 1)] ?? {}) }) }
}

// frames: { input, dist, vz }  vz>0=遠ざかる(receding), vz<0=近づく
function run(label, frames) {
  let shot = null, trigger = null, hitHDist = null
  const player = new PlayerController(fakeInput(frames.map((f) => f.input)), mods, p.physique)
  player.resetForPoint('opponent', true)
  const px = player.view.pos.x, pz = player.view.pos.z
  const ctx = {
    phase: 'rally', isServing: false,
    ball: { pos: new Vector3(px, 1.0, pz + 5), vel: new Vector3(0, 0, -8), lastHitBy: 'opponent', inPlay: true },
    self: player.view, rival: { pos: new Vector3() },
    requestShot: (r) => { if (!shot) shot = r },
    requestServe: () => {}, predictLanding: () => null,
    logDebug: (e) => { if (e.data && 'trigger' in e.data && !trigger) { trigger = e.data.trigger; hitHDist = e.data.hDist } },
    serveNumber: 1, pressure: 0, momentum: 0,
  }
  for (const f of frames) {
    ctx.ball.pos.set(px, f.y ?? 1.0, pz + f.dist)
    ctx.ball.vel.set(0, f.vy ?? 0, f.vz ?? -8)
    player.update(DT, ctx)
    if (shot) break
  }
  console.log(`${label}: hit=${shot ? 'yes' : 'NO'} just=${shot ? shot.just : '-'} trigger=${trigger ?? '-'} hDist=${hitHDist ?? '-'}`)
}

const press = { shotPressed: 'topspin', shotHeld: 'topspin' }
const hold = { shotHeld: 'topspin' }
const release = { shotReleased: 'topspin', shotHeld: null }
const FAR = reach + 2

// (1) スイートゾーン(芯)で離す → just=true(release)
run('(1) 芯でリリース', [
  { input: press, dist: FAR, vz: -8 }, ...Array(6).fill({ input: hold, dist: FAR, vz: -8 }),
  { input: hold, dist: 0.5, vz: -8 }, // リーチ&スイート内に到達
  { input: release, dist: 0.5, vz: -8 },
])
// (2) リーチ内だがスイート外で離す → just=false(release)
run('(2) リーチ内・芯外でリリース', [
  { input: press, dist: FAR, vz: -8 }, ...Array(6).fill({ input: hold, dist: FAR, vz: -8 }),
  { input: hold, dist: 1.6, vz: -8 },
  { input: release, dist: 1.6, vz: -8 },
])
// (3) 離さずホールド → スイート抜けて遠ざかった瞬間にセーフティ(just=false, safety)
run('(3) 未リリース(セーフティ)', [
  { input: press, dist: FAR, vz: -8 }, ...Array(6).fill({ input: hold, dist: FAR, vz: -8 }),
  { input: hold, dist: 0.5, vz: -8 }, // 芯(近づき中)→ まだ打たない(待ち)
  { input: hold, dist: 1.4, vz: 8 },  // 芯を抜けて遠ざかり出した → セーフティ
])
// (4) リーチ外で離す → 空振り(打球なし)
run('(4) リーチ外でリリース', [
  { input: press, dist: FAR, vz: -8 }, { input: hold, dist: FAR, vz: -8 },
  { input: release, dist: FAR, vz: -8 },
])
// (5) 山なり/ロブが真下に落下(水平速度小)、未リリース → 垂直セーフティで打てる(空振りしない)
run('(5) 落下ロブ・未リリース(垂直セーフティ)', [
  { input: press, dist: 0.4, y: 2.8, vy: -5, vz: -0.5 }, // 高すぎて打てない(y>2.9 ではないが…)
  { input: hold, dist: 0.4, y: 2.2, vy: -5, vz: -0.5 },  // 打てる・高い → 待ち
  { input: hold, dist: 0.4, y: 1.5, vy: -5, vz: -0.5 },  // 打てる・y>1.2 → 待ち
  { input: hold, dist: 0.4, y: 1.0, vy: -5, vz: -0.5 },  // y≤1.2・ほぼ真下 → 垂直セーフティ
])
// (6) 低い「下降」球が速く近づく・未リリース → 近づき中は垂直セーフティを出さず、最接近(hDist小)で発動
//     旧コードはリーチ端(hDist≈2)で即セーフティしていた回帰の確認(low dipping topspin 相当)。
run('(6) 低い下降近づき球・未リリース(最接近で safety)', [
  { input: press, dist: 2.05, y: 1.2, vy: -3, vz: -12 },
  { input: hold, dist: 1.4, y: 1.1, vy: -3, vz: -12 },  // 近づき中(closingRate大)→ まだ出さない
  { input: hold, dist: 0.6, y: 1.0, vy: -3, vz: -12 },  // まだ近づき中 → 出さない
  { input: hold, dist: 0.5, y: 1.0, vy: -3, vz: -1 },   // 近づき止む → ここで safety(芯近く)
])
// (7) 低い下降近づき球を芯でリリース → just
run('(7) 低い下降近づき球・芯でリリース(just)', [
  { input: press, dist: 2.05, y: 1.2, vy: -3, vz: -12 },
  { input: hold, dist: 1.4, y: 1.1, vy: -3, vz: -12 },
  { input: release, dist: 0.6, y: 1.0, vy: -3, vz: -12 }, // 芯(≤1.0)でリリース → just
])
console.log(`(reach=${reach.toFixed(2)}m, sweet=${JUST_SWEET_DIST}m)`)
