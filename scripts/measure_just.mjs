// ジャストミート(§6.1.1)コア機構の検証:
// チャージ保持中、接触の窓内に「もう一度タップ」が入れば just=true、無ければ false、
// 早すぎる(窓外)タップは false になることを確認する。
import { Vector3 } from 'three'
import { PlayerController } from '../src/gameplay/player.ts'
import { PLAYER_PERSONAS, personaModifiers, REACH, JUST_WINDOW_BASE } from '../src/constants.ts'

const DT = 1 / 120

// スクリプト化した入力を返す簡易 InputSource
function fakeInput(states) {
  let i = 0
  const blank = { moveX: 0, moveZ: 0, sprint: false, shotPressed: null, shotHeld: null, shotReleased: null, servePressed: false, serveReleased: false, escPressed: false }
  return { poll: () => ({ ...blank, ...(states[Math.min(i++, states.length - 1)] ?? {}) }) }
}

// scenario: 各フレームの {input, ballDist} を与え、requestShot の just を観測
function run(label, frames) {
  const p = PLAYER_PERSONAS['federun']
  let captured = null
  const input = fakeInput(frames.map((f) => f.input))
  const player = new PlayerController(input, personaModifiers(p.ratings, p.mental), p.physique)
  player.resetForPoint('opponent', true) // プレイヤー=レシーバー(ラリー想定)
  const playerX = player.view.pos.x, playerZ = player.view.pos.z
  const ctx = {
    phase: 'rally', isServing: false,
    ball: { pos: new Vector3(playerX, 1.0, playerZ + 5), vel: new Vector3(0, 0, 8), lastHitBy: 'opponent', inPlay: true },
    self: player.view, rival: { pos: new Vector3() },
    requestShot: (r) => { if (!captured) captured = r },
    requestServe: () => {}, predictLanding: () => null, serveNumber: 1, pressure: 0, momentum: 0,
  }
  for (const f of frames) {
    // ball を player からの距離 dist に配置(reach 内/外を制御)
    ctx.ball.pos.set(playerX, 1.0, playerZ + f.ballDist)
    player.update(DT, ctx)
    if (captured) break
  }
  console.log(`${label}: hit=${captured ? 'yes' : 'NO'} just=${captured ? captured.just : '-'}`)
  return captured
}

const reach = REACH * personaModifiers(PLAYER_PERSONAS['federun'].ratings, PLAYER_PERSONAS['federun'].mental).reachMul
const FAR = reach + 2, NEAR = 0.4
const press = { shotPressed: 'topspin', shotHeld: 'topspin' }
const hold = { shotHeld: 'topspin' }
const retap = { shotPressed: 'topspin', shotHeld: 'topspin' }

// (1) タップ無し: チャージ保持のまま接触 → just=false
run('(1) タップ無し', [
  { input: press, ballDist: FAR }, ...Array(20).fill({ input: hold, ballDist: FAR }),
  { input: hold, ballDist: NEAR },
])
// (2) 接触直前に再タップ(窓内) → just=true
run('(2) 窓内で再タップ', [
  { input: press, ballDist: FAR }, ...Array(20).fill({ input: hold, ballDist: FAR }),
  { input: retap, ballDist: FAR }, // 再タップ(この後すぐ接触)
  { input: hold, ballDist: NEAR },
])
// (3) 早すぎる再タップ(窓の何倍も前) → just=false
const earlyGap = Math.round((JUST_WINDOW_BASE / DT) * 4) // 窓の4倍前にタップ
run('(3) 早すぎる再タップ', [
  { input: press, ballDist: FAR }, { input: retap, ballDist: FAR },
  ...Array(earlyGap).fill({ input: hold, ballDist: FAR }),
  { input: hold, ballDist: NEAR },
])
console.log(`(窓 base=${JUST_WINDOW_BASE}s, reach=${reach.toFixed(2)}m)`)
