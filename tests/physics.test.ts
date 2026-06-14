// =============================================================================
// 物理エンジン・ショットソルバの単体テスト(docs/ARCHITECTURE.md §16)
// =============================================================================
import { describe, it, expect } from 'vitest'
import { Vector3 } from 'three'
import { BallSim } from '../src/physics/ball'
import { solveShot, solveServe } from '../src/gameplay/shot'
import type { ServeType, ShotRequest, ShotType } from '../src/types'
import {
  PHYS_DT,
  BALL_RADIUS,
  REST,
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  SHOT_PARAMS,
  SERVICE_LINE_Z,
  NEUTRAL_PERSONA_MODIFIERS,
  setSurface,
  VOLLEY_SPEED_CAP,
} from '../src/constants'
import type { PersonaModifiers } from '../src/types'

/** ボールが地面で次にバウンドする位置と、そのときの上昇後の最高到達高さを得る補助。 */
function runUntilBounce(sim: BallSim, maxSteps = 2000): { pos: Vector3; step: number } | null {
  for (let s = 0; s < maxSteps; s++) {
    const events = sim.step(PHYS_DT)
    for (const e of events) {
      if (e.kind === 'bounce') return { pos: e.pos.clone(), step: s }
    }
  }
  return null
}

/** 打ち上げて落とし、1バウンド後の最高到達高さを返す。 */
function peakAfterBounce(sim: BallSim): number {
  // 1回目のバウンドまで進める
  let bounced = false
  let peak = 0
  for (let s = 0; s < 4000; s++) {
    const events = sim.step(PHYS_DT)
    for (const e of events) if (e.kind === 'bounce') bounced = true
    if (bounced) {
      peak = Math.max(peak, sim.state.pos.y)
      // 2回目のバウンドで終了
      const ev2 = sim.step(PHYS_DT)
      if (ev2.some((e) => e.kind === 'bounce')) break
    }
  }
  return peak
}

describe('BallSim 積分とバウンス', () => {
  it('自由落下で地面にバウンドし、反発で上向き速度になる', () => {
    const sim = new BallSim()
    sim.launch(new Vector3(0, 3, 0), new Vector3(0, 0, 0), new Vector3(), 'player')
    const r = runUntilBounce(sim)
    expect(r).not.toBeNull()
    // バウンド直後は vy > 0
    expect(sim.state.vel.y).toBeGreaterThan(0)
    expect(sim.state.bounceCount).toBe(1)
  })

  it('バウンド後の到達高さが落下高さより低い(反発係数による減衰)', () => {
    const dropHeight = 3
    const sim = new BallSim()
    sim.launch(new Vector3(0, dropHeight, 0), new Vector3(), new Vector3(), 'player')
    const peak = peakAfterBounce(sim)
    // 反発 REST=0.75 なので理想で 0.75²≒0.56 倍、空気抵抗でさらに低い
    expect(peak).toBeLessThan(dropHeight * REST * REST + 0.1)
    expect(peak).toBeGreaterThan(0.2) // ある程度は跳ねる
  })

  it('REST により連続バウンドの高さが単調に減衰する', () => {
    const sim = new BallSim()
    sim.launch(new Vector3(0, 4, 0), new Vector3(), new Vector3(), 'player')
    const peaks: number[] = []
    let curPeak = 0
    let bounces = 0
    for (let s = 0; s < 8000 && bounces < 4; s++) {
      const before = sim.state.vel.y
      const events = sim.step(PHYS_DT)
      curPeak = Math.max(curPeak, sim.state.pos.y)
      if (events.some((e) => e.kind === 'bounce')) {
        if (bounces > 0) peaks.push(curPeak)
        curPeak = 0
        bounces++
      }
      void before
    }
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i]).toBeLessThan(peaks[i - 1])
    }
  })
})

describe('スピンとマグナス効果', () => {
  // 同一初速で、トップスピンはフラットより手前に着地し、スライスは奥に伸びる
  function landingZ(type: ShotType): number {
    const sim = new BallSim()
    const hitPos = new Vector3(0, 1.0, 10)
    const vel = new Vector3(0, 6, -22) // 共通初速(奥=z- 方向)
    const param = SHOT_PARAMS[type]
    // 規約 ω = spinScalar·(ŷ × d)。d は水平進行方向(0,0,-1)
    const d = new Vector3(0, 0, -1)
    const spin = new Vector3(0, 1, 0).cross(d).multiplyScalar(param.spinScalar)
    sim.launch(hitPos, vel, spin, 'player')
    const r = runUntilBounce(sim)
    return r ? r.pos.z : NaN
  }

  it('トップスピンはフラットより手前に着地する(沈む)', () => {
    const flatZ = landingZ('flat') // spinScalar=0
    const topZ = landingZ('topspin') // spinScalar>0
    // z- 方向に飛ぶので「手前」= より大きい z(0 に近い)
    expect(topZ).toBeGreaterThan(flatZ)
  })

  it('スライスはフラットより奥へ伸びる(浮く)', () => {
    const flatZ = landingZ('flat')
    const sliceZ = landingZ('slice') // spinScalar<0
    // 浮くので飛距離が伸びる = より小さい z(より奥)
    expect(sliceZ).toBeLessThan(flatZ)
  })
})

describe('predictLanding', () => {
  it('予測着地点が実バウンド位置と一致する(誤差 < 0.1m)', () => {
    const sim = new BallSim()
    const hitPos = new Vector3(1, 1.2, 10)
    const vel = new Vector3(-2, 5, -20)
    const spin = new Vector3(0, 1, 0).cross(new Vector3(0, 0, -1)).multiplyScalar(200)
    sim.launch(hitPos, vel, spin, 'player')
    const pred = sim.predictLanding()
    expect(pred).not.toBeNull()
    const actual = runUntilBounce(sim)
    expect(actual).not.toBeNull()
    if (pred && actual) {
      const dx = pred.pos.x - actual.pos.x
      const dz = pred.pos.z - actual.pos.z
      expect(Math.hypot(dx, dz)).toBeLessThan(0.1)
      // time も近い
      expect(pred.time).toBeGreaterThan(0)
    }
  })

  it('ネットに突っ込む軌道では null を返す', () => {
    const sim = new BallSim()
    // ネット直前から低い弾道で速く打つ(z=0 をネット高未満で横切る → 衝突)
    sim.launch(new Vector3(0, 0.5, 1.5), new Vector3(0, 0, -12), new Vector3(), 'player')
    const pred = sim.predictLanding()
    expect(pred).toBeNull()
  })
})

describe('solveShot 着地精度', () => {
  const shotTypes: ShotType[] = ['flat', 'topspin', 'slice', 'lob', 'drop']

  for (const type of shotTypes) {
    it(`${type}: 品質1.0 で目標着地点に収束する`, () => {
      const hitPos = new Vector3(0, 1.0, 10)
      // flat は速度優先のドライブ(GAME_DESIGN §4.5)で「深く速く」飛ぶため、
      // 中コートの浅い目標には収束しない(=浅く置けないのが仕様)。深い目標で
      // 評価し、許容もドライブ特性に合わせてやや緩める。それ以外の control 系は
      // 着地点へ高精度収束する。
      const target =
        type === 'flat' ? new Vector3(1.5, 0, -9.0) : new Vector3(1.5, 0, -5)
      const tol = type === 'flat' ? 2.0 : 0.5
      const req: ShotRequest = {
        type,
        hitter: 'player',
        hitPos,
        target,
        quality: 1.0, // ノイズなし
        // チャージ 0 で純粋な収束を検証する。チャージはトップスピンの横角度・浅さや
        // スライスの深さで「狙って目標をずらす」仕様(GAME_DESIGN §4.5)になったため、
        // 収束テストでは無チャージで base 着地点への収束のみを見る。
        charge: 0,
        incomingSpeed: 18, // 中庸な球威(修飾がほぼ無効になる帯)
      }
      const sol = solveShot(req)
      const sim = new BallSim()
      sim.launch(hitPos, sol.vel, sol.spin, 'player')
      const land = runUntilBounce(sim)
      expect(land).not.toBeNull()
      if (land) {
        const err = Math.hypot(land.pos.x - target.x, land.pos.z - target.z)
        expect(err).toBeLessThanOrEqual(tol)
        // 相手コート内(ネット〜ベースライン、シングルス幅)に収まること
        expect(land.pos.z).toBeLessThan(0)
        expect(land.pos.z).toBeGreaterThan(-COURT_HALF_LENGTH)
        expect(Math.abs(land.pos.x)).toBeLessThan(COURT_HALF_WIDTH + 0.1)
      }
    })
  }

  it('解はネットを越える(z=0 でネット高以上)', () => {
    const hitPos = new Vector3(0, 1.0, 10)
    const target = new Vector3(0, 0, -6)
    const sol = solveShot({ type: 'topspin', hitter: 'player', hitPos, target, quality: 1.0, charge: 0.5, incomingSpeed: 18 })
    const sim = new BallSim()
    sim.launch(hitPos, sol.vel, sol.spin, 'player')
    // ネットイベントが起きないこと
    let netHit = false
    for (let s = 0; s < 2000; s++) {
      const events = sim.step(PHYS_DT)
      if (events.some((e) => e.kind === 'net')) netHit = true
      if (events.some((e) => e.kind === 'bounce')) break
    }
    expect(netHit).toBe(false)
  })
})

describe('チャージショット', () => {
  it('charge 1.0 のフラットは charge 0 より初速が大きい(同一品質・同一目標)', () => {
    // フラットは速度優先(solveDrive)なのでチャージは初速に直結する(GAME_DESIGN §4.5)。
    // ノイズの影響を避けるため品質 1.0(狙いノイズ 0)で比較。深い目標で評価する。
    const hitPos = new Vector3(0, 1.0, 10)
    const target = new Vector3(1.0, 0, -9)
    const base: Omit<ShotRequest, 'charge'> = {
      type: 'flat',
      hitter: 'player',
      hitPos,
      target,
      quality: 1.0,
      incomingSpeed: 18,
    }
    const noCharge = solveShot({ ...base, charge: 0 })
    const fullCharge = solveShot({ ...base, charge: 1.0 })
    expect(fullCharge.vel.length()).toBeGreaterThan(noCharge.vel.length())
  })

  it('charge 1.0 のトップスピンは charge 0 より回転が強い(沈み込み強化)', () => {
    // トップスピンのチャージは初速ではなく回転量(沈み込み+跳ね)を強化する(GAME_DESIGN §4.5)。
    // x=0 の目標で横角度・浅さのシフトを排除し、回転量だけを比較する。
    const hitPos = new Vector3(0, 1.0, 10)
    const target = new Vector3(0, 0, -6)
    const base: Omit<ShotRequest, 'charge'> = {
      type: 'topspin',
      hitter: 'player',
      hitPos,
      target,
      quality: 1.0,
      incomingSpeed: 18,
    }
    const noCharge = solveShot({ ...base, charge: 0 })
    const fullCharge = solveShot({ ...base, charge: 1.0 })
    expect(fullCharge.spin.length()).toBeGreaterThan(noCharge.spin.length())
  })

  it('charge 1.0 のスライスは charge 0 より着地が深い(ベースライン寄り)', () => {
    // スライスのチャージは着地をベースライン側へ伸ばす(相手を貼り付ける。GAME_DESIGN §4.5)。
    const hitPos = new Vector3(0, 1.0, 10)
    const target = new Vector3(0, 0, -5)
    const base: Omit<ShotRequest, 'charge'> = {
      type: 'slice',
      hitter: 'player',
      hitPos,
      target,
      quality: 1.0,
      incomingSpeed: 18,
    }
    function landZ(charge: number): number {
      const sol = solveShot({ ...base, charge })
      const sim = new BallSim()
      sim.launch(hitPos, sol.vel, sol.spin, 'player')
      const land = runUntilBounce(sim)
      return land ? land.pos.z : 0
    }
    // 深い = z がより負(ベースライン z=-COURT_HALF_LENGTH 方向)
    expect(landZ(1.0)).toBeLessThan(landZ(0))
  })

  it('オーバーチャージ(1.25)は通常チャージより着地のばらつきが大きい', () => {
    // 統計的検証: 多数試行で着地点の標準偏差を比較する。
    function landingSpread(charge: number): number {
      const hitPos = new Vector3(0, 1.0, 10)
      const target = new Vector3(1.0, 0, -5)
      const xs: number[] = []
      const zs: number[] = []
      for (let i = 0; i < 120; i++) {
        const sol = solveShot({
          type: 'topspin',
          hitter: 'player',
          hitPos,
          target,
          quality: 1.0, // 品質ノイズは 0 に固定し、チャージ誤差のみを見る
          charge,
          incomingSpeed: 18,
        })
        const sim = new BallSim()
        sim.launch(hitPos, sol.vel, sol.spin, 'player')
        const land = runUntilBounce(sim)
        if (land) {
          xs.push(land.pos.x)
          zs.push(land.pos.z)
        }
      }
      const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
      const variance = (a: number[]) => {
        const m = mean(a)
        return a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length
      }
      return Math.sqrt(variance(xs) + variance(zs))
    }
    const normalSpread = landingSpread(1.0) // 誤差加算なし
    const overSpread = landingSpread(1.25) // オーバーチャージ: 誤差大
    expect(overSpread).toBeGreaterThan(normalSpread)
  })
})

describe('ドロップショットのネット越え頑健性', () => {
  it('ベースライン付近からのドロップは 95% 以上ネットを越える', () => {
    // 実プレイ条件を再現: z≈10〜12、q∈{0.5,0.8,1.0}、charge∈{0,0.5}。
    // 乱数ノイズがあるため多数試行で統計的に検証する。
    let netHits = 0
    let total = 0
    for (const z of [10, 11, 12]) {
      for (const q of [0.5, 0.8, 1.0]) {
        for (const c of [0, 0.5]) {
          for (let i = 0; i < 30; i++) {
            total++
            const hitPos = new Vector3(0, 1.0, z)
            const target = new Vector3(0, 0, -2.4) // ネット手前のドロップ目標
            const sol = solveShot({
              type: 'drop',
              hitter: 'player',
              hitPos,
              target,
              quality: q,
              charge: c,
              incomingSpeed: 12, // 緩い球からのドロップ(タッチペナルティを避ける)
            })
            const sim = new BallSim()
            sim.launch(hitPos, sol.vel, sol.spin, 'player')
            let hitNet = false
            for (let s = 0; s < 2000; s++) {
              const events = sim.step(PHYS_DT)
              if (events.some((e) => e.kind === 'net')) {
                hitNet = true
                break
              }
              if (events.some((e) => e.kind === 'bounce')) break
            }
            if (hitNet) netHits++
          }
        }
      }
    }
    const passRate = 1 - netHits / total
    expect(passRate).toBeGreaterThanOrEqual(0.95)
  })

  it('ドロップは相手コート側(z<0)のネット近くに落ちる', () => {
    const hitPos = new Vector3(0, 1.0, 11)
    const target = new Vector3(0, 0, -2.4)
    const sol = solveShot({
      type: 'drop',
      hitter: 'player',
      hitPos,
      target,
      quality: 1.0,
      charge: 0,
      incomingSpeed: 12,
    })
    const sim = new BallSim()
    sim.launch(hitPos, sol.vel, sol.spin, 'player')
    const land = runUntilBounce(sim)
    expect(land).not.toBeNull()
    if (land) {
      expect(land.pos.z).toBeLessThan(0) // 相手コート側
      expect(land.pos.z).toBeGreaterThan(-6) // ネット近くの浅い落とし
    }
  })
})

describe('接触コンテキスト修飾(ARCHITECTURE §6.1 / §16)', () => {
  /** sol を実シミュレートして 1 バウンド目の着地点を得る。ネット衝突なら null。 */
  function landOf(hitPos: Vector3, sol: { vel: Vector3; spin: Vector3 }): Vector3 | null {
    const sim = new BallSim()
    sim.launch(hitPos, sol.vel, sol.spin, 'player')
    for (let s = 0; s < 2000; s++) {
      const events = sim.step(PHYS_DT)
      if (events.some((e) => e.kind === 'net')) return null
      for (const e of events) if (e.kind === 'bounce') return e.pos.clone()
    }
    return null
  }

  it('回帰: 中打点・ベースライン・中庸な球威・無チャージのトップスピンは目標へ高精度で収束', () => {
    // low≈0, fore≈0, powerExcess 小 → 修飾がほぼ無効。従来の安定を維持する。
    const hitPos = new Vector3(0, 0.95, 10)
    const target = new Vector3(1.5, 0, -5)
    const req: ShotRequest = {
      type: 'topspin',
      hitter: 'player',
      hitPos,
      target,
      quality: 1.0,
      charge: 0,
      incomingSpeed: 18,
    }
    // 品質1.0・無チャージで狙いノイズ 0。複数回でも安定して入ること。
    for (let i = 0; i < 20; i++) {
      const land = landOf(hitPos, solveShot(req))
      expect(land).not.toBeNull()
      if (land) {
        const err = Math.hypot(land.x - target.x, land.z - target.z)
        expect(err).toBeLessThanOrEqual(0.5)
      }
    }
  })

  it('スマッシュ: 高打点・前寄り・フラットの初速が通常フラット(低打点)を上回る', () => {
    // 深い目標で比較(着地点へ収束する本ソルバでは、高い打点ほど水平速度の
    // 取り分が増えて初速が速くなる。SMASH_SPEED と低 apex が弾道を平坦化し
    // この効果を強める)。
    const target = new Vector3(0, 0, -10)
    // スマッシュ条件: h≈2.0、前寄り(z≈4)
    const smashPos = new Vector3(0, 2.0, 4)
    const smash = solveShot({
      type: 'flat',
      hitter: 'player',
      hitPos: smashPos,
      target,
      quality: 1.0,
      charge: 0,
      incomingSpeed: 12,
    })
    // 通常フラット(低打点・同目標)
    const flatPos = new Vector3(0, 0.5, 4)
    const flat = solveShot({
      type: 'flat',
      hitter: 'player',
      hitPos: flatPos,
      target,
      quality: 1.0,
      charge: 0,
      incomingSpeed: 12,
    })
    expect(smash.vel.length()).toBeGreaterThan(flat.vel.length())
  })

  it('低打点パワー: チャージフラットは中打点より着地が深い側へばらつく(統計的)', () => {
    const target = new Vector3(0, 0, -6)
    // 多数試行で「目標より深い(z がより負)」着地の平均・最大を比較する。
    function depthStats(hitY: number): { mean: number; max: number } {
      const hitPos = new Vector3(0, hitY, 10)
      const overshoots: number[] = []
      for (let i = 0; i < 200; i++) {
        const sol = solveShot({
          type: 'flat',
          hitter: 'player',
          hitPos,
          target,
          quality: 1.0,
          charge: 1.0, // フルチャージでパワーを乗せる
          incomingSpeed: 12,
        })
        const land = landOf(hitPos, sol)
        if (land) {
          // 目標より奥(z<target.z)に行った量を overshoot とする(正=深い側)
          overshoots.push(target.z - land.z)
        }
      }
      const mean = overshoots.reduce((s, v) => s + v, 0) / overshoots.length
      const max = Math.max(...overshoots)
      return { mean, max }
    }
    const lowStats = depthStats(0.3) // 低打点
    const midStats = depthStats(0.95) // 中打点
    // 低打点フラット強打は中打点より平均・最大とも深い側へずれる(アウト傾向)。
    expect(lowStats.mean).toBeGreaterThan(midStats.mean)
    expect(lowStats.max).toBeGreaterThan(midStats.max)
  })

  it('高打点トップスピン: 横に振った浅めクロスでも相手コート内に着地する', () => {
    // 高打点(h≈1.8)で角度をつけたクロス(浅め)。沈むため相手コート内へ収まる。
    const hitPos = new Vector3(0, 1.8, 10)
    const target = new Vector3(3.0, 0, -4) // クロス浅め
    let inCourt = 0
    const trials = 30
    for (let i = 0; i < trials; i++) {
      const sol = solveShot({
        type: 'topspin',
        hitter: 'player',
        hitPos,
        target,
        quality: 1.0,
        charge: 0,
        incomingSpeed: 18,
      })
      const land = landOf(hitPos, sol)
      if (
        land &&
        land.z < 0 &&
        land.z > -COURT_HALF_LENGTH &&
        Math.abs(land.x) < 4.115 + 0.3
      ) {
        inCourt++
      }
    }
    // 角度がついても大半が相手コート内に収まる。
    expect(inCourt / trials).toBeGreaterThanOrEqual(0.9)
  })

  it('リダイレクト: 速球(vIn 30)のフラットは緩球(vIn 5)より初速が速い', () => {
    const hitPos = new Vector3(0, 0.95, 10)
    const target = new Vector3(0, 0, -6)
    const slow = solveShot({
      type: 'flat',
      hitter: 'player',
      hitPos,
      target,
      quality: 1.0,
      charge: 0,
      incomingSpeed: 5,
    })
    const fast = solveShot({
      type: 'flat',
      hitter: 'player',
      hitPos,
      target,
      quality: 1.0,
      charge: 0,
      incomingSpeed: 30,
    })
    expect(fast.vel.length()).toBeGreaterThan(slow.vel.length())
  })
})

describe('solveServe', () => {
  it('スイートゾーンのサーブは対角サービスボックス付近に入る', () => {
    // デュースサイド(右)から相手の左サービスボックスへ
    const hitPos = new Vector3(2, 0, COURT_HALF_LENGTH)
    // 相手サービスボックス内のターゲット(z<0, ネットから 6.4m 以内)
    const target = new Vector3(-1.5, 0, -4)
    const sol = solveServe(hitPos, target, 0.78, 'player', 'flat')
    const sim = new BallSim()
    const hp = hitPos.clone()
    hp.y = 2.6
    sim.launch(hp, sol.vel, sol.spin, 'player')
    const land = runUntilBounce(sim)
    expect(land).not.toBeNull()
    if (land) {
      // 相手コート側に着地する
      expect(land.pos.z).toBeLessThan(0)
      // 目標から大きく外れない(スイートゾーンなので誤差小、シミュレート補正込み)
      const err = Math.hypot(land.pos.x - target.x, land.pos.z - target.z)
      expect(err).toBeLessThan(1.5)
    }
  })

  it('power が高いほどボール初速が速い', () => {
    const hitPos = new Vector3(2, 0, COURT_HALF_LENGTH)
    const target = new Vector3(-1.5, 0, -4)
    const slow = solveServe(hitPos, target, 0.55, 'player', 'flat')
    const fast = solveServe(hitPos, target, 0.85, 'player', 'flat')
    expect(fast.vel.length()).toBeGreaterThan(slow.vel.length())
  })

  it('着地は地面付近(BALL_RADIUS 程度)で報告される', () => {
    const sim = new BallSim()
    sim.launch(new Vector3(0, 3, 0), new Vector3(), new Vector3(), 'player')
    const r = runUntilBounce(sim)
    expect(r).not.toBeNull()
    if (r) expect(Math.abs(r.pos.y)).toBeLessThan(BALL_RADIUS + 1e-6)
  })
})

describe('速球の返球(差し込まれ / ARCHITECTURE §6.2 / §16)', () => {
  /** sol を飛ばし、最初のバウンドまでの弾道頂点(最高到達高)を返す。 */
  function flightApex(hitPos: Vector3, sol: { vel: Vector3; spin: Vector3 }): number {
    const sim = new BallSim()
    sim.launch(hitPos, sol.vel, sol.spin, 'player')
    let peak = hitPos.y
    for (let s = 0; s < 2000; s++) {
      const events = sim.step(PHYS_DT)
      peak = Math.max(peak, sim.state.pos.y)
      if (events.some((e) => e.kind === 'bounce')) break
    }
    return peak
  }

  /** 同条件を試行回数ぶん平均した返球初速と弾道頂点。 */
  function avgReturn(
    type: ShotType,
    incomingSpeed: number,
    charge: number,
    trials: number,
  ): { speed: number; apex: number } {
    const hitPos = new Vector3(0, 0.95, 10)
    const target = new Vector3(0, 0, -6)
    let sumSpeed = 0
    let sumApex = 0
    for (let i = 0; i < trials; i++) {
      const sol = solveShot({
        type,
        hitter: 'player',
        hitPos,
        target,
        quality: 1.0,
        charge,
        incomingSpeed,
      })
      sumSpeed += sol.vel.length()
      sumApex += flightApex(hitPos, sol)
    }
    return { speed: sumSpeed / trials, apex: sumApex / trials }
  }

  it('速球(vIn≈50)を無チャージ topspin で返すと vIn≈18 より遅く・頂点が高い', () => {
    const slow = avgReturn('topspin', 18, 0, 40)
    const fast = avgReturn('topspin', 50, 0, 40)
    // 差し込まれて山なりの弱返球 → 初速が遅く、弾道頂点が高い。
    expect(fast.speed).toBeLessThan(slow.speed)
    expect(fast.apex).toBeGreaterThan(slow.apex)
  })

  it('速球(vIn≈50)で full charge slice は topspin より速く・弾道が低い', () => {
    const sliceFC = avgReturn('slice', 50, 1.0, 40)
    const topNC = avgReturn('topspin', 50, 0, 40)
    // ブロックで deep に返せる(速い・低い)。トップスピン無チャージは差し込まれ甘い。
    expect(sliceFC.speed).toBeGreaterThan(topNC.speed)
    expect(sliceFC.apex).toBeLessThan(topNC.apex)
  })

  it('回帰: 通常ラリー球速(vIn≤25)では mishit=0 で従来どおり目標へ収束', () => {
    const hitPos = new Vector3(0, 0.95, 10)
    const target = new Vector3(1.5, 0, -5)
    for (let i = 0; i < 20; i++) {
      const sol = solveShot({
        type: 'topspin',
        hitter: 'player',
        hitPos,
        target,
        quality: 1.0,
        charge: 0,
        incomingSpeed: 25, // しきい値(26)未満 → paceExcess=0 → mishit=0
      })
      const sim = new BallSim()
      sim.launch(hitPos, sol.vel, sol.spin, 'player')
      const land = runUntilBounce(sim)
      expect(land).not.toBeNull()
      if (land) {
        const err = Math.hypot(land.pos.x - target.x, land.pos.z - target.z)
        expect(err).toBeLessThanOrEqual(0.5)
      }
    }
  })
})

describe('サーブの種類(ARCHITECTURE §6.4 / §16)', () => {
  const serveTypes: ServeType[] = ['flat', 'slice', 'kick']

  /** サーブを飛ばし、1バウンド目の着地点を得る(ネット衝突なら null)。 */
  function serveLanding(
    sol: { vel: Vector3; spin: Vector3 },
    hp: Vector3,
  ): Vector3 | null {
    const sim = new BallSim()
    sim.launch(hp, sol.vel, sol.spin, 'player')
    for (let s = 0; s < 2000; s++) {
      const events = sim.step(PHYS_DT)
      if (events.some((e) => e.kind === 'net')) return null
      for (const e of events) if (e.kind === 'bounce') return e.pos.clone()
    }
    return null
  }

  it('3種ともサービスボックス内に着地する(横曲がり補正の確認)', () => {
    // デュースサイド(右)から相手の左サービスボックスへ。
    const hitPos = new Vector3(2, 0, COURT_HALF_LENGTH)
    const target = new Vector3(-1.5, 0, -4)
    for (const st of serveTypes) {
      let inBox = 0
      const trials = 20
      for (let i = 0; i < trials; i++) {
        const sol = solveServe(hitPos, target, 0.78, 'player', st)
        const hp = hitPos.clone()
        hp.y = 2.6
        const land = serveLanding(sol, hp)
        // サービスボックス: 相手コート側(z<0)・ネットからサービスライン以内・
        // 受け側ボックス(x<0 側)。横曲がりが補正されボックスに収まること。
        if (
          land &&
          land.z < 0 &&
          land.z > -SERVICE_LINE_Z &&
          land.x < 0.3 &&
          land.x > -COURT_HALF_WIDTH - 0.3
        ) {
          inBox++
        }
      }
      // スイートゾーンなので大半がボックス内に収まる。
      expect(inBox / trials).toBeGreaterThanOrEqual(0.85)
    }
  })

  it('kick はバウンド後の最高到達高が flat より高い(高く弾む)', () => {
    const hitPos = new Vector3(2, 0, COURT_HALF_LENGTH)
    const target = new Vector3(-1.5, 0, -4)
    function avgBouncePeak(st: ServeType): number {
      let sum = 0
      const trials = 20
      for (let i = 0; i < trials; i++) {
        const sol = solveServe(hitPos, target, 0.78, 'player', st)
        const sim = new BallSim()
        const hp = hitPos.clone()
        hp.y = 2.6
        sim.launch(hp, sol.vel, sol.spin, 'player')
        sum += peakAfterBounce(sim)
      }
      return sum / trials
    }
    expect(avgBouncePeak('kick')).toBeGreaterThan(avgBouncePeak('flat'))
  })

  it('flat は kick より初速が速い', () => {
    const hitPos = new Vector3(2, 0, COURT_HALF_LENGTH)
    const target = new Vector3(-1.5, 0, -4)
    function avgSpeed(st: ServeType): number {
      let sum = 0
      const trials = 20
      for (let i = 0; i < trials; i++) {
        sum += solveServe(hitPos, target, 0.78, 'player', st).vel.length()
      }
      return sum / trials
    }
    expect(avgSpeed('flat')).toBeGreaterThan(avgSpeed('kick'))
  })
})

describe('ペルソナ倍率の適用(ARCHITECTURE §6.5)', () => {
  /** NEUTRAL を一部だけ上書きした倍率を作る補助。 */
  function withMods(over: Partial<PersonaModifiers>): PersonaModifiers {
    return { ...NEUTRAL_PERSONA_MODIFIERS, ...over }
  }

  it('回帰: mods 省略時は明示的 NEUTRAL と完全に同一の初速になる', () => {
    // 乱数を含むため品質1.0・無チャージ・中庸球威でノイズ 0 の条件で比較する。
    const hitPos = new Vector3(0, 1.0, 10)
    const target = new Vector3(1.0, 0, -5)
    const base = {
      type: 'topspin' as ShotType,
      hitter: 'player' as const,
      hitPos,
      target,
      quality: 1.0,
      charge: 0.5,
      incomingSpeed: 12, // PACE_CONTROL_THRESH(17)未満 → pace 誤差 0・狙いノイズ 0
    }
    const omitted = solveShot({ ...base })
    const neutral = solveShot({ ...base, mods: NEUTRAL_PERSONA_MODIFIERS })
    // ノイズ 0 条件なので決定的に一致するはず。
    expect(omitted.vel.length()).toBeCloseTo(neutral.vel.length(), 6)
  })

  it('高い shotSpeedMul(パワー型)はショット初速を上げる', () => {
    const hitPos = new Vector3(0, 1.0, 10)
    const target = new Vector3(1.0, 0, -9)
    const base = {
      type: 'flat' as ShotType,
      hitter: 'player' as const,
      hitPos,
      target,
      quality: 1.0,
      charge: 0,
      incomingSpeed: 12,
    }
    const neutral = solveShot({ ...base, mods: NEUTRAL_PERSONA_MODIFIERS })
    const powerful = solveShot({ ...base, mods: withMods({ shotSpeedMul: 1.25 }) })
    expect(powerful.vel.length()).toBeGreaterThan(neutral.vel.length())
  })

  it('高い serveSpeedMul(サーブ型)はサーブ初速を上げる', () => {
    const hitPos = new Vector3(2, 0, COURT_HALF_LENGTH)
    const target = new Vector3(-1.5, 0, -4)
    function avgSpeed(mods: PersonaModifiers): number {
      let sum = 0
      const trials = 20
      for (let i = 0; i < trials; i++) {
        sum += solveServe(hitPos, target, 0.78, 'player', 'flat', mods).vel.length()
      }
      return sum / trials
    }
    const neutral = avgSpeed(NEUTRAL_PERSONA_MODIFIERS)
    const bigServe = avgSpeed(withMods({ serveSpeedMul: 1.12 }))
    expect(bigServe).toBeGreaterThan(neutral)
  })

  it('高い aimNoiseMul(スピン安定が低い)は着地のばらつきを増やす(統計的)', () => {
    function landingSpread(mods: PersonaModifiers): number {
      const hitPos = new Vector3(0, 1.0, 10)
      const target = new Vector3(1.0, 0, -5)
      const xs: number[] = []
      const zs: number[] = []
      for (let i = 0; i < 150; i++) {
        const sol = solveShot({
          type: 'topspin',
          hitter: 'player',
          hitPos,
          target,
          quality: 0.6, // 品質を下げて狙いノイズを発生させ、倍率の効果を可視化
          charge: 0,
          incomingSpeed: 18,
          mods,
        })
        const sim = new BallSim()
        sim.launch(hitPos, sol.vel, sol.spin, 'player')
        const land = runUntilBounce(sim)
        if (land) {
          xs.push(land.pos.x)
          zs.push(land.pos.z)
        }
      }
      const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
      const variance = (a: number[]) => {
        const mm = mean(a)
        return a.reduce((s, v) => s + (v - mm) * (v - mm), 0) / a.length
      }
      return Math.sqrt(variance(xs) + variance(zs))
    }
    const steady = landingSpread(withMods({ aimNoiseMul: 0.7 })) // スピン安定が高い
    const shaky = landingSpread(withMods({ aimNoiseMul: 1.3 })) // スピン安定が低い
    expect(shaky).toBeGreaterThan(steady)
  })
})

describe('コートサーフェス(GAME_DESIGN §13 / ARCHITECTURE §5)', () => {
  /** 同一初速の打球を1バウンドさせ、バウンド後の最高到達高を返す。 */
  function bouncePeak(): number {
    const sim = new BallSim()
    // ベースライン付近から相手コートへ。バウンド後のピークを比較する。
    const hitPos = new Vector3(0, 1.0, 10)
    const vel = new Vector3(0, 5, -20)
    sim.launch(hitPos, vel, new Vector3(), 'player')
    return peakAfterBounce(sim)
  }

  it('clay は hard より高く跳ね、grass は低く跳ねる(hard は回帰)', () => {
    // hard(基準=全 mul 1.0)はサーフェス実装前と同一挙動になること。
    setSurface('hard')
    const hardPeak = bouncePeak()
    setSurface('clay')
    const clayPeak = bouncePeak()
    setSurface('grass')
    const grassPeak = bouncePeak()
    // 必ず hard に戻す(他テストへの汚染防止)。
    setSurface('hard')
    const hardPeak2 = bouncePeak()
    setSurface('hard')

    // clay は高反発、grass は低反発。
    expect(clayPeak).toBeGreaterThan(hardPeak)
    expect(grassPeak).toBeLessThan(hardPeak)
    // hard は決定的なので前後で完全一致(回帰)。
    expect(hardPeak2).toBeCloseTo(hardPeak, 10)
  })
})

describe('ボレー(ネットプレー / GAME_DESIGN §4.7)', () => {
  /** sol を実シミュレートして 1 バウンド目の着地点を得る(ネット衝突なら null)。 */
  function landOf(hitPos: Vector3, sol: { vel: Vector3; spin: Vector3 }): Vector3 | null {
    const sim = new BallSim()
    sim.launch(hitPos, sol.vel, sol.spin, 'player')
    for (let s = 0; s < 2000; s++) {
      const events = sim.step(PHYS_DT)
      if (events.some((e) => e.kind === 'net')) return null
      for (const e of events) if (e.kind === 'bounce') return e.pos.clone()
    }
    return null
  }

  it('前寄り中打点の flat ボレーはベースライン flat より初速が低い(VOLLEY_SPEED_CAP 頭打ち)', () => {
    const target = new Vector3(0, 0, -9)
    // ベースライン(z≈10)の通常フラット。
    const baselinePos = new Vector3(0, 1.0, 10)
    const baseline = solveShot({
      type: 'flat',
      hitter: 'player',
      hitPos: baselinePos,
      target,
      quality: 1.0,
      charge: 1.0, // 溜めて強打
      incomingSpeed: 12,
    })
    // 前寄り(z≈3)・中打点(y≈1.0)のボレー。
    const volleyPos = new Vector3(0, 1.0, 3)
    const volley = solveShot({
      type: 'flat',
      hitter: 'player',
      hitPos: volleyPos,
      target,
      quality: 1.0,
      charge: 1.0,
      incomingSpeed: 12,
    })
    // ボレーは振り抜かないため初速が低く、上限以下に収まる。
    expect(volley.vel.length()).toBeLessThan(baseline.vel.length())
    expect(volley.vel.length()).toBeLessThanOrEqual(VOLLEY_SPEED_CAP + 0.5)
  })

  it('ボレー(flat)は同位置・同目標の非ボレー(topspin)より着地が安定する', () => {
    // 同一の前寄り打点・同一目標で比較し、幾何条件を揃えて VOLLEY_AIM_MUL の
    // 効果のみを見る。flat は前寄り中打点なのでボレー(狙い誤差を縮小)、
    // topspin はボレー対象外(flat/slice のみ)なので通常の狙い誤差。
    // どちらも狙い誤差倍率は aimNoiseMul 系で同条件なので、差はボレー補正のみ。
    const hitPos = new Vector3(0, 1.0, 3) // 前寄り中打点
    const target = new Vector3(0, 0, -8)
    function landingSd(type: 'flat' | 'topspin'): number {
      const xs: number[] = []
      const zs: number[] = []
      for (let i = 0; i < 200; i++) {
        const sol = solveShot({
          type,
          hitter: 'player',
          hitPos,
          target,
          quality: 0.5, // ノイズ発生
          charge: 0,
          incomingSpeed: 12,
        })
        const land = landOf(hitPos, sol)
        if (land) {
          xs.push(land.x)
          zs.push(land.z)
        }
      }
      const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
      const variance = (a: number[]) => {
        const mm = mean(a)
        return a.reduce((s, v) => s + (v - mm) * (v - mm), 0) / a.length
      }
      return Math.sqrt(variance(xs) + variance(zs))
    }
    const volleySd = landingSd('flat') // ボレー(正確)
    const normalSd = landingSd('topspin') // 非ボレー(通常の狙い誤差)
    expect(volleySd).toBeLessThan(normalSd)
  })
})
