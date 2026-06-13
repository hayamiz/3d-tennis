// =============================================================================
// ショットソルバ(docs/ARCHITECTURE.md §6)
// 目標着地点に向けた初速・スピンを「解析初期解 → 前方シミュレーション補正 →
// ネット越え検証」の三段で求める。前方シミュレーションは BallSim と同一積分を
// 使うため ../physics/ball.ts を import する(本モジュールのみ許可された例外)。
// =============================================================================
import { Vector3 } from 'three'
import type { ShotRequest, ShotSolution, ShotType, ServeType, Side } from '../types'
import { sideSign } from '../types'
import { BallSim } from '../physics/ball'
import {
  SHOT_PARAMS,
  AIM_NOISE_R,
  QUALITY_POWER_MIN,
  GRAVITY,
  NET_HEIGHT,
  SERVE_HIT_HEIGHT,
  SERVE_SPEED_MIN,
  SERVE_SPEED_MAX,
  SERVE_SWEET_MIN,
  SERVE_SWEET_MAX,
  BALL_RADIUS,
  CHARGE_MAX,
  CHARGE_POWER_MIN,
  CHARGE_POWER_GAIN,
  OVERCHARGE_NOISE,
  OVERCHARGE_NET_SHRINK,
  SERVICE_LINE_Z,
  CONTACT_PIVOT_HEIGHT,
  SMASH_MIN_HEIGHT,
  SMASH_MAX_DEPTH,
  SMASH_SPEED,
  SMASH_QUALITY_FLOOR,
  SMASH_CHARGE_GAIN,
  SMASH_NET_MARGIN,
  SMASH_AIM_NOISE_MUL,
  LOW_POWER_OVERSHOOT,
  LOW_CONTACT_SPRAY,
  LOW_CONTACT_NET_RISK,
  FORECOURT_LOW_AMP,
  FORECOURT_FLAT_OVERSHOOT,
  HIGH_CONTACT_SPEED_GAIN,
  HIGH_CONTACT_SPIN_GAIN,
  PACE_REDIRECT_FLAT,
  PACE_REDIRECT_SPIN,
  PACE_CONTROL_THRESH,
  PACE_CONTROL_K,
  PACE_TOUCH_PENALTY,
  RETURN_PACE_THRESH,
  RETURN_OVERWHELM_RANGE,
  RETURN_WEAKNESS_SLICE,
  RETURN_WEAKNESS_FLAT,
  RETURN_WEAKNESS_TOPSPIN,
  RETURN_WEAKNESS_TOUCH,
  RETURN_CHARGE_MITIGATION,
  WEAK_RETURN_SPEED,
  RETURN_FLOAT_APEX,
  RETURN_MISHIT_SHORT,
  RETURN_MISHIT_SPRAY,
  MISHIT_ACTIVE_EPS,
  SERVE_TYPE_PARAMS,
} from '../constants'

// 補正反復・検証回数の上限(§6 手順4・5)
const CORRECTION_ITERS = 4
const CORRECTION_GAIN = 0.7
// ネット越え検証の再 solve 上限。低速球(ドロップ)でも確実にネットを越える
// 解へ収束できるよう余裕を持たせる(物理的に届かない要求 apex からの引き上げを
// 何度か許す)。
const NET_RETRIES = 6
const SIM_DT = 1 / 120
const SIM_MAX_TIME = 8

/**
 * スピン規約(docs/ARCHITECTURE.md §5.4 + physics 担当の決定):
 * 水平進行方向 d に対し ω = spinScalar·(ŷ × d)。
 * これにより a += KM·(ω×v) がトップスピン(spinScalar>0)で下向き=沈む、
 * スライス(spinScalar<0)で上向き=浮く、を生む。
 */
function spinVector(horizDir: Vector3, spinScalar: number): Vector3 {
  // ŷ × d
  const yhat = new Vector3(0, 1, 0)
  return yhat.clone().cross(horizDir).multiplyScalar(spinScalar)
}

/**
 * 無抵抗の放物線で from → to を結ぶ初速を解析的に求める。
 * 水平速度は飛行時間 T から、鉛直速度は y 変位と T から決める。
 * T は基準速度 speed と頂点高さ apex から推定する。
 */
function analyticInitial(
  from: Vector3,
  to: Vector3,
  speed: number,
  apex: number,
): Vector3 {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const horizDist = Math.hypot(dx, dz)
  const dy = to.y - from.y

  // 頂点高さ apex を満たす上昇初速 vy0 を推定(打点からの相対上昇)。
  // 頂点 = from.y + vy0²/(2g) ≒ apex → vy0 = sqrt(2g·max(apex-from.y, 0.1))
  const rise = Math.max(apex - from.y, 0.1)
  let vy0 = Math.sqrt(2 * GRAVITY * rise)

  // 飛行時間 T: vy0 で打ち上げ、着地 dy までの放物線の時間。
  // dy = vy0·T - 0.5 g T²  → 0.5 g T² - vy0 T + dy = 0
  const a = 0.5 * GRAVITY
  const b = -vy0
  const c = dy
  const disc = b * b - 4 * a * c
  let T: number
  if (disc >= 0) {
    // 大きい方の根(下降側の着地)を採る
    T = (-b + Math.sqrt(disc)) / (2 * a)
  } else {
    // 頂点が dy に届かない場合は speed から水平飛行時間で代替
    T = horizDist / Math.max(speed, 1)
    vy0 = dy / T + 0.5 * GRAVITY * T
  }
  if (!(T > 1e-3)) T = horizDist / Math.max(speed, 1)

  const vel = new Vector3()
  vel.x = dx / T
  vel.z = dz / T
  vel.y = vy0
  return vel
}

/** state コピーを前方シミュレーションして最初の着地点を返す(ネット衝突なら null)。 */
function simulateLanding(
  hitPos: Vector3,
  vel: Vector3,
  spin: Vector3,
  hitter: Side,
): Vector3 | null {
  const sim = new BallSim()
  sim.launch(hitPos, vel, spin, hitter)
  let t = 0
  while (t < SIM_MAX_TIME) {
    const events = sim.step(SIM_DT)
    t += SIM_DT
    for (const e of events) {
      if (e.kind === 'net') return null
      if (e.kind === 'bounce') return e.pos.clone()
    }
  }
  return null
}

/**
 * 軌道が z=0 平面を越える際の高さを前方シミュレーションで調べる。
 * ネット位置での y を返す(z=0 を越えなければ null)。
 */
function netCrossHeight(
  hitPos: Vector3,
  vel: Vector3,
  spin: Vector3,
  hitter: Side,
): number | null {
  const sim = new BallSim()
  sim.launch(hitPos, vel, spin, hitter)
  let prev = sim.state.pos.clone()
  let t = 0
  while (t < SIM_MAX_TIME) {
    sim.step(SIM_DT)
    t += SIM_DT
    const cur = sim.state.pos
    if (prev.z !== 0 && Math.sign(cur.z) !== Math.sign(prev.z)) {
      const f = prev.z / (prev.z - cur.z)
      return prev.y + (cur.y - prev.y) * f
    }
    if (sim.state.bounceCount > 0) break // ネットを越えずに着地
    prev = cur.clone()
  }
  return null
}

/**
 * solveShot: ShotRequest → ShotSolution。
 * 手順は docs/ARCHITECTURE.md §6 に従う。
 */
export function solveShot(req: ShotRequest): ShotSolution {
  const param = SHOT_PARAMS[req.type]
  const q = Math.max(0, Math.min(1, req.quality))

  // --- 手順2b: チャージ適用(GAME_DESIGN §4.4 / ARCHITECTURE §6 2b) ---
  // c は 0..CHARGE_MAX。1.0 超はオーバーチャージ。
  const c = Math.max(0, Math.min(CHARGE_MAX, req.charge))
  // 威力係数は min(c,1) で頭打ち(オーバーチャージで初速は増えない)。
  const chargePower = CHARGE_POWER_MIN + CHARGE_POWER_GAIN * Math.min(c, 1)
  const over = Math.max(0, c - 1) // オーバーチャージ量(0..CHARGE_MAX-1)
  // オーバーチャージの狙い誤差加算 (c-1)·OVERCHARGE_NOISE
  const chargeNoiseR = over * OVERCHARGE_NOISE
  // オーバーチャージのネット越えマージン縮小率
  const netMarginScale =
    1 - OVERCHARGE_NET_SHRINK * (over / Math.max(CHARGE_MAX - 1, 1e-6))

  // --- 手順2: 品質適用(狙いノイズ + 威力スケール) ---
  // 品質由来の狙いノイズ半径(オーバーチャージ分を含む)。文脈修飾の前に確定。
  const baseNoiseR = (1 - q) * AIM_NOISE_R + chargeNoiseR
  const powerScale = QUALITY_POWER_MIN + (1 - QUALITY_POWER_MIN) * q

  // --- 手順2.5: 接触コンテキスト(ARCHITECTURE §6.1 / GAME_DESIGN §4.5) ---
  // 打点の高さ・コート位置(ネットからの距離)・相手球速で打球を修飾する。
  // 通常のベースラインラリー(中打点・中庸な球威・無チャージ)は low≈0・fore≈0・
  // powerExcess 小 のため修飾がほぼ無効となり、従来どおり安定して目標へ入る。
  const h = req.hitPos.y // 打点の高さ
  const depth = Math.abs(req.hitPos.z) // ネットからの距離
  const vIn = Math.max(0, req.incomingSpeed) // 相手球の勢い
  // lev: 低い打点で負・通常で0・高い打点で正(clamp −1..+1)
  const lev = Math.max(-1, Math.min(1, (h - CONTACT_PIVOT_HEIGHT) / CONTACT_PIVOT_HEIGHT))
  const low = Math.max(0, -lev) // 低い打点の度合い
  const high = Math.max(0, lev) // 高い打点の度合い
  // fore: 前寄り度(サービスラインより前で増加)
  const fore = Math.max(0, Math.min(1, (SERVICE_LINE_Z - depth) / SERVICE_LINE_Z))
  // パワーの乗り具合(チャージ威力 + クリーンヒット)
  const powerExcess = Math.max(0, chargePower - 1) + 0.5 * Math.max(0, q - 0.6)
  // 前寄りでの低打点リスク増幅係数(fore=0 で 1、fore=1 で FORECOURT_LOW_AMP)
  const foreLowAmp = 1 + FORECOURT_LOW_AMP * fore - fore

  // 修飾後の目標。文脈ノイズ・depthBias を反映する基点として複製。
  const target = req.target.clone()
  target.y = 0

  // --- (A) スマッシュ分岐(高い打点 × 前寄り × フラット)---
  if (req.type === 'flat' && h >= SMASH_MIN_HEIGHT && depth <= SMASH_MAX_DEPTH) {
    // 初速: 品質ペナルティを緩和、チャージで増速
    const smashSpeed =
      SMASH_SPEED *
      (SMASH_QUALITY_FLOOR + (1 - SMASH_QUALITY_FLOOR) * q) *
      (1 + SMASH_CHARGE_GAIN * Math.min(c, 1))
    // 狙いは正確(基本ノイズ × MUL + チャージノイズ)。高さノイズは drive 側の
    // 仰角探索に委ねる(平坦・下降軌道で叩き込むため apex 指定は不要)。
    const smashNoiseR = (1 - q) * AIM_NOISE_R * SMASH_AIM_NOISE_MUL + chargeNoiseR
    if (smashNoiseR > 0) {
      const ang = Math.random() * Math.PI * 2
      const r = Math.sqrt(Math.random()) * smashNoiseR
      target.x += Math.cos(ang) * r
      target.z += Math.sin(ang) * r
    }
    // 速度優先ソルバで叩き込む(SMASH_SPEED が初速にそのまま乗る)。
    return solveDrive(
      req.hitPos,
      target,
      smashSpeed,
      param.spinScalar,
      SMASH_NET_MARGIN,
      req.hitter,
    )
  }

  // --- (B) 通常: 基準値に文脈修飾を合成 ---
  // 速度倍率: 高打点で flat/topspin を速く打てる
  const speedMul =
    req.type === 'flat' || req.type === 'topspin'
      ? 1 + HIGH_CONTACT_SPEED_GAIN * high
      : 1
  // リダイレクト: 相手球速の何割かを初速に上乗せ
  const paceRedirect =
    req.type === 'flat' || req.type === 'slice'
      ? PACE_REDIRECT_FLAT
      : req.type === 'topspin'
        ? PACE_REDIRECT_SPIN
        : 0
  const speedAdd = paceRedirect * vIn
  // スピン倍率: 高打点トップスピンは回転増(角度を保って沈む)
  const spinMul = req.type === 'topspin' ? 1 + HIGH_CONTACT_SPIN_GAIN * high : 1

  // depthBias(m): 打点→目標の水平方向に「より深く」加算 → アウト方向
  const flatSliceWeight = req.type === 'flat' ? 1 : req.type === 'slice' ? 0.5 : 0
  const depthBias =
    LOW_POWER_OVERSHOOT * low * powerExcess * foreLowAmp +
    FORECOURT_FLAT_OVERSHOOT * fore * (1 - high) * flatSliceWeight

  // aimNoiseAdd(m): ランダム誤差半径に加算
  let aimNoiseAdd =
    LOW_CONTACT_SPRAY * low * powerExcess * foreLowAmp +
    PACE_CONTROL_K * Math.max(0, vIn - PACE_CONTROL_THRESH) * (1.2 - q)
  if (req.type === 'drop' || req.type === 'lob') {
    aimNoiseAdd += PACE_TOUCH_PENALTY * Math.max(0, vIn - PACE_CONTROL_THRESH)
  }

  // netMarginMul: 低打点フラットはネット掛かりやすく、topspin/slice は持ち上げる
  let netMarginMul = 1
  if (req.type === 'flat') {
    netMarginMul = 1 - LOW_CONTACT_NET_RISK * low
  } else if (req.type === 'topspin' || req.type === 'slice') {
    netMarginMul = 1 + 0.5 * low
  }

  // --- 合成 ---
  const speed = param.speed * powerScale * chargePower * speedMul + speedAdd
  let spinScalar = param.spinScalar * spinMul
  let netMargin = param.netMargin * netMarginScale * netMarginMul

  // 目標を「打点→目標の水平方向」へ depthBias だけ深くずらす(アウト方向)。
  // mishit の手前引きより先に適用し、clean な目標を確定させておく。
  if (depthBias !== 0) {
    const dirX = target.x - req.hitPos.x
    const dirZ = target.z - req.hitPos.z
    const horiz = Math.hypot(dirX, dirZ)
    if (horiz > 1e-6) {
      target.x += (dirX / horiz) * depthBias
      target.z += (dirZ / horiz) * depthBias
    }
  }

  // --- 手順2.6: 速球の返球(差し込まれ / mishit) — ARCHITECTURE §6.2 / GAME_DESIGN §4.6 ---
  // スマッシュ分岐(上で return 済み)以外の全ショットで、相手球が速いと芯で
  // 捉えにくく「差し込まれて」山なりの弱い返球(チャンスボール)になる。
  // 通常ラリー(vIn ≤ RETURN_PACE_THRESH=26)は paceExcess=0 → mishit=0 で影響なし。
  const paceExcess = Math.max(0, vIn - RETURN_PACE_THRESH)
  const typeWeak =
    req.type === 'slice'
      ? RETURN_WEAKNESS_SLICE
      : req.type === 'flat'
        ? RETURN_WEAKNESS_FLAT
        : req.type === 'topspin'
          ? RETURN_WEAKNESS_TOPSPIN
          : RETURN_WEAKNESS_TOUCH // lob / drop
  const chargeMit = 1 - RETURN_CHARGE_MITIGATION * Math.min(c, 1)
  const posMit = Math.max(0.35, Math.min(1.0, 1.3 - q))
  const mishit = Math.max(
    0,
    Math.min(1, (paceExcess / RETURN_OVERWHELM_RANGE) * typeWeak * chargeMit * posMit),
  )

  // 弱返球パラメータ(clean な打球と山なり sitter を mishit で線形補間)。
  // cleanSpeed は §6.1 までで算出した本来の初速(= speed)。
  let floatSpeed = speed
  let floatApex = param.apex
  let aimNoiseMishit = aimNoiseAdd
  if (mishit > MISHIT_ACTIVE_EPS) {
    // 遅く・高く(山なり)・回転を失う
    floatSpeed = speed + (WEAK_RETURN_SPEED - speed) * mishit
    floatApex = param.apex + (RETURN_FLOAT_APEX - param.apex) * mishit
    spinScalar *= 1 - 0.7 * mishit
    aimNoiseMishit += RETURN_MISHIT_SPRAY * mishit
    // netMargin は安全側(山なりで apex が高いので自然にネットを越えやすい)。

    // 目標を「打点→目標の水平方向」に RETURN_MISHIT_SHORT·mishit だけ手前へ引く
    // (浅い sitter)。打点側へ戻す = ネット側へ寄せる。
    const dirX = target.x - req.hitPos.x
    const dirZ = target.z - req.hitPos.z
    const horiz = Math.hypot(dirX, dirZ)
    if (horiz > 1e-6) {
      const pull = RETURN_MISHIT_SHORT * mishit
      target.x -= (dirX / horiz) * pull
      target.z -= (dirZ / horiz) * pull
    }
  }

  // 狙いノイズ半径 = 従来(品質+チャージ) + 文脈分(+ mishit のスプレー)
  const noiseR = baseNoiseR + aimNoiseMishit
  if (noiseR > 0) {
    const ang = Math.random() * Math.PI * 2
    const r = Math.sqrt(Math.random()) * noiseR
    target.x += Math.cos(ang) * r
    target.z += Math.sin(ang) * r
  }

  // 差し込まれ時(mishit > EPS)は、flat も含めて山なりの収束経路で返す
  // (ドライブではなく floatSpeed/floatApex の弱い sitter)。
  if (mishit > MISHIT_ACTIVE_EPS) {
    return solveToTarget(
      req.hitPos,
      target,
      floatSpeed,
      floatApex,
      spinScalar,
      netMargin,
      req.hitter,
      req.type,
    )
  }

  // フラットは速度優先(ドライブ)ソルバで打つ。speed(高打点ゲイン・球威
  // リダイレクト・チャージ込み)が初速にそのまま乗り、速すぎる球は深さが
  // オーバーしてアウト、低い打点からの強打はネット/アウトに転ぶ(§4.5)。
  // ネット越えマージンは従来どおりフラットのみ ×0.5 してリスクを残す。
  if (req.type === 'flat') {
    return solveDrive(
      req.hitPos,
      target,
      speed,
      spinScalar,
      netMargin * 0.5,
      req.hitter,
    )
  }

  // topspin/slice/lob/drop は着地点へ収束する control ソルバ(正確さが持ち味)。
  // チャージ威力に応じて apex を僅かに下げ、飛行時間短縮で初速を増やす
  // (収束ソルバは弾道形状が apex と目標で決まるため、speed 乗算だけでは
  // 初速に乗らないことへの対処)。弾道の高さが本質の lob/drop では平坦化しない。
  let apex = param.apex
  if (req.type === 'topspin') {
    const apexCharge = 1 - 0.18 * (chargePower - 1)
    apex *= apexCharge
    const baseSpeed = param.speed * powerScale * chargePower
    const speedBoostRatio = baseSpeed > 1e-6 ? speed / baseSpeed : 1
    const boost = Math.max(0, speedBoostRatio - 1)
    apex *= 1 - 0.3 * boost
    apex = Math.max(apex, req.hitPos.y + 0.4, NET_HEIGHT + 0.2)
  }

  return solveToTarget(
    req.hitPos,
    target,
    speed,
    apex,
    spinScalar,
    netMargin,
    req.hitter,
    req.type,
  )
}

/**
 * 共通の着地点ソルバ本体: 解析初期解 → シミュレート補正 → ネット越え検証。
 */
function solveToTarget(
  hitPos: Vector3,
  target: Vector3,
  speed: number,
  apex0: number,
  spinScalar: number,
  netMargin: number,
  hitter: Side,
  type: ShotType | 'serve',
): ShotSolution {
  // 着地は地面(y=BALL_RADIUS 付近)。target.y は 0 だが着地判定面に合わせる。
  const goal = new Vector3(target.x, BALL_RADIUS, target.z)
  let apex = apex0

  for (let retry = 0; retry <= NET_RETRIES; retry++) {
    // --- 手順3: 解析初期解 ---
    let vel = analyticInitial(hitPos, goal, speed, apex)
    // スピンは水平進行方向から決める
    let horizDir = new Vector3(vel.x, 0, vel.z)
    if (horizDir.lengthSq() < 1e-8) horizDir.set(0, 0, -sideSign(hitter))
    horizDir.normalize()
    let spin = spinVector(horizDir, spinScalar)

    // --- 手順4: 前方シミュレーション補正(誤差の水平成分をフィードバック) ---
    for (let i = 0; i < CORRECTION_ITERS; i++) {
      const land = simulateLanding(hitPos, vel, spin, hitter)
      if (!land) break // ネット衝突はここでは無視(手順5で対処)
      const errX = goal.x - land.x
      const errZ = goal.z - land.z
      if (Math.hypot(errX, errZ) < 0.2) break
      // 着地までの飛行時間を再推定し、水平速度を誤差ぶん補正(ゲイン0.7)
      const flightT = estimateFlightTime(hitPos, vel)
      vel.x += (errX / flightT) * CORRECTION_GAIN
      vel.z += (errZ / flightT) * CORRECTION_GAIN
      // スピン方向も新しい進行方向へ追従
      horizDir = new Vector3(vel.x, 0, vel.z)
      if (horizDir.lengthSq() < 1e-8) horizDir.set(0, 0, -sideSign(hitter))
      horizDir.normalize()
      spin = spinVector(horizDir, spinScalar)
    }

    // --- 手順5: ネット越え検証 ---
    const crossY = netCrossHeight(hitPos, vel, spin, hitter)
    // フラットのみマージンを小さくしてリスクを残す
    const margin = type === 'flat' ? netMargin * 0.5 : netMargin
    // crossY === null は「ネットに到達せず手前で着地」= ネットは越えていない
    // が、ここでは少なくとも z=0 を越えてほしい場合(相手コートが目標)に
    // 該当する。crossY が得られかつネット高+マージン以上なら採用。
    if (crossY !== null && crossY >= NET_HEIGHT + margin) {
      return { vel, spin }
    }
    if (retry === NET_RETRIES) break // 反復上限。下でフォールバックを保証する
    // loft/apex を引き上げて再 solve(必要高さを上回るよう増やす)。
    // crossY が得られない(手前で着地/ネット衝突)場合も apex を確実に増やす。
    const deficit =
      crossY !== null ? NET_HEIGHT + margin - crossY : NET_HEIGHT + margin
    apex += Math.max(deficit + 0.6, 0.8)
  }

  // --- フォールバック: 通常の補正ループでネットを越えられなかった場合、
  // 「目標 x 方向は維持しつつ、ネットを確実に越える仰角」を直接探索する。
  // 低速のドロップショットで打点〜ネットが遠いと要求 apex では物理的に
  // 届かないことがあるため、解が不可能なら「届く解」に自動フォールバックする。
  return clearNetFallback(hitPos, goal, speed, spinScalar, netMargin, hitter, type)
}

/**
 * ネット越えを最優先するフォールバックソルバ。
 * 速度の大きさを保ったまま射出仰角だけを掃引し、
 * (1) ネットを (NET_HEIGHT + margin) 以上で越え、
 * (2) 相手コート側 (z=0 の向こう) に着地する
 * 解のうち、目標着地点に最も近いものを選ぶ。
 * どれも越えられない場合は、最もネット通過高が大きい仰角を返す
 * (= 物理的に可能な範囲で最大限ネットを越える解)。
 */
function clearNetFallback(
  hitPos: Vector3,
  goal: Vector3,
  speed: number,
  spinScalar: number,
  netMargin: number,
  hitter: Side,
  type: ShotType | 'serve',
): ShotSolution {
  const margin = type === 'flat' ? netMargin * 0.5 : netMargin
  const sign = sideSign(hitter)

  // 水平進行方向は打点→目標で固定
  const dx = goal.x - hitPos.x
  const dz = goal.z - hitPos.z
  const horiz = Math.hypot(dx, dz)
  let dirX = 0
  let dirZ = -sign
  if (horiz > 1e-6) {
    dirX = dx / horiz
    dirZ = dz / horiz
  }
  const horizDir = new Vector3(dirX, 0, dirZ)
  const spin = spinVector(horizDir, spinScalar)

  let bestClear: Vector3 | null = null
  let bestClearErr = Infinity
  let bestAnyVel: Vector3 | null = null
  let bestAnyCross = -Infinity

  // 仰角を低→高で掃引(速度の大きさは保持して初速感を維持)。
  for (let deg = 4; deg <= 70; deg += 1) {
    const th = (deg * Math.PI) / 180
    const vy = speed * Math.sin(th)
    const vh = speed * Math.cos(th)
    const vel = new Vector3(dirX * vh, vy, dirZ * vh)

    const crossY = netCrossHeight(hitPos, vel, spin, hitter)
    if (crossY !== null && crossY > bestAnyCross) {
      bestAnyCross = crossY
      bestAnyVel = vel.clone()
    }
    if (crossY === null || crossY < NET_HEIGHT + margin) continue

    // ネットは越えた。相手コート側に着地するかを確認し、目標との誤差を測る。
    const land = simulateLanding(hitPos, vel, spin, hitter)
    if (!land) continue
    const err = Math.hypot(land.x - goal.x, land.z - goal.z)
    if (err < bestClearErr) {
      bestClearErr = err
      bestClear = vel.clone()
    }
  }

  if (bestClear) return { vel: bestClear, spin }
  // ネットを越える解が皆無でも、最もネット通過高が大きい仰角を返す
  // (現実的に可能な限りネットを越える)。
  if (bestAnyVel) return { vel: bestAnyVel, spin }

  // 念のための最終フォールバック(理論上ここには来ない)。
  const vel = analyticInitial(hitPos, goal, speed, 3.0)
  return { vel, spin }
}

/**
 * 速度優先(ドライブ)ソルバ。フラット/スマッシュ用。
 * solveToTarget(着地点へ完全収束)と異なり、speed の大きさを固定したまま
 * 射出仰角だけを掃引し、着地が target に最も近づく解を選ぶ(solveServe と同思想)。
 *
 * これにより速度起因の駆け引き(GAME_DESIGN §4.5)が実際の着地に現れる:
 * - 速い球は速く飛ぶ(スマッシュ・チャージ・リダイレクトが初速にそのまま乗る)
 * - 速すぎる球は近い目標を越えてアウトする(仰角を寝かせても収まらない)
 * - 低い打点から速く打つと、ネットを越える仰角では深さがオーバーしやすい
 *   = ネット/アウトのどちらかに転びやすい(低い球の強打はリスク)
 *
 * 掃引は「ドライブらしい」仰角帯に限定し、速すぎる球が高い放物線(ロブ的)で
 * 都合よく収まってしまうのを防ぐ。ネットを越えて相手コートに収まる解が無ければ、
 * 最も目標に近い(=最小オーバー)解を返す(実際にアウトする)。
 */
function solveDrive(
  hitPos: Vector3,
  target: Vector3,
  speed: number,
  spinScalar: number,
  netMargin: number,
  hitter: Side,
): ShotSolution {
  const goal = new Vector3(target.x, BALL_RADIUS, target.z)
  const sign = sideSign(hitter)
  const dx = goal.x - hitPos.x
  const dz = goal.z - hitPos.z
  const horiz = Math.hypot(dx, dz)
  let dirX = 0
  let dirZ = -sign
  if (horiz > 1e-6) {
    dirX = dx / horiz
    dirZ = dz / horiz
  }
  const horizDir = new Vector3(dirX, 0, dirZ)
  const spin = spinVector(horizDir, spinScalar)

  // ネットを越えて相手コートに収まる解のうち目標最近、を探す。
  let best: Vector3 | null = null
  let bestErr = Infinity
  // ネット越えに失敗しても、最もネット通過高が大きい解を保持(最後の保険)。
  let bestAny: Vector3 | null = null
  let bestAnyCross = -Infinity
  // 着地が得られた解のうち目標最近(ネット越え不問)。ネットを越える解が
  // 一つも無い極端ケースで、せめて目標方向へ飛ばすためのフォールバック。
  let bestLand: Vector3 | null = null
  let bestLandErr = Infinity

  // ドライブらしい仰角帯: 下向き(スマッシュの叩き下ろし)〜中程度の上向き。
  for (let deg = -32; deg <= 34; deg += 1) {
    const th = (deg * Math.PI) / 180
    const vh = speed * Math.cos(th)
    const vy = speed * Math.sin(th)
    const vel = new Vector3(dirX * vh, vy, dirZ * vh)

    const crossY = netCrossHeight(hitPos, vel, spin, hitter)
    if (crossY !== null && crossY > bestAnyCross) {
      bestAnyCross = crossY
      bestAny = vel.clone()
    }
    const land = simulateLanding(hitPos, vel, spin, hitter)
    if (land) {
      const err = Math.hypot(land.x - goal.x, land.z - goal.z)
      if (err < bestLandErr) {
        bestLandErr = err
        bestLand = vel.clone()
      }
      if (crossY !== null && crossY >= NET_HEIGHT + netMargin) {
        if (err < bestErr) {
          bestErr = err
          best = vel.clone()
        }
      }
    }
  }

  if (best) return { vel: best, spin }
  // ネットは越えるが相手コートに収まらない/着地が取れない場合は、
  // 着地が取れた最近解 → 最もネットを越える解、の順でフォールバック。
  if (bestLand) return { vel: bestLand, spin }
  if (bestAny) return { vel: bestAny, spin }
  return { vel: new Vector3(dirX * speed, 4, dirZ * speed), spin }
}

/** 無抵抗近似での着地までの飛行時間(補正の水平速度換算用)。 */
function estimateFlightTime(hitPos: Vector3, vel: Vector3): number {
  // dy = vy·T - 0.5 g T² で着地(y=BALL_RADIUS)する T を解く
  const dy = BALL_RADIUS - hitPos.y
  const a = 0.5 * GRAVITY
  const b = -vel.y
  const c = dy
  const disc = b * b - 4 * a * c
  if (disc >= 0) {
    const T = (-b + Math.sqrt(disc)) / (2 * a)
    if (T > 1e-3) return T
  }
  return 1
}

/**
 * solveServe: サーブ専用ソルバ。
 * 打点 y = SERVE_HIT_HEIGHT、power∈[0,1] を速度へ写像する。
 * ラリーのソルバ(着地点へ完全収束)と異なり、サーブは「power が決めた速度を
 * 保ったまま、射出仰角を探索して指定ボックスに入れる」モデルにする。
 * これにより power が大きいほど確実に初速が速くなる(GAME_DESIGN §5)。
 * スイートゾーン外の誤差則も §5 に従う。
 *
 * serveType(GAME_DESIGN §5.1 / ARCHITECTURE §6.4)で速度・スピン・マージン・
 * フォルト誤差を変える。スライス/キックはサイドスピンで横に曲がるため、
 * 仰角だけでなく水平方向の狙いもシミュレーション補正してボックスに収める。
 */
export function solveServe(
  hitPos: Vector3,
  target: Vector3,
  power: number,
  hitter: Side,
  serveType: ServeType,
): ShotSolution {
  const p = Math.max(0, Math.min(1, power))
  const stp = SERVE_TYPE_PARAMS[serveType]

  // power→速度。p に対し単調増加。p<SWEET_MIN は安全(遅い)側、
  // SWEET 以上は SERVE_SPEED_MIN..MAX をフルに使う。種別倍率を最後に乗算。
  let speed: number
  if (p < SERVE_SWEET_MIN) {
    // 0..SWEET_MIN を SERVE_SPEED_MIN*0.7 .. SERVE_SPEED_MIN に比例
    const lo = SERVE_SPEED_MIN * 0.7
    speed = lo + (SERVE_SPEED_MIN - lo) * (p / SERVE_SWEET_MIN)
  } else {
    // SWEET_MIN..1 を SERVE_SPEED_MIN..MAX に比例
    speed =
      SERVE_SPEED_MIN +
      (SERVE_SPEED_MAX - SERVE_SPEED_MIN) *
        ((p - SERVE_SWEET_MIN) / (1 - SERVE_SWEET_MIN))
  }
  speed *= stp.speedMul

  // 狙い誤差: スイートゾーン外で増大(GAME_DESIGN §5)。種別の faultNoiseMul で増減。
  let aimNoise = 0
  if (p > SERVE_SWEET_MAX) {
    aimNoise = (p - SERVE_SWEET_MAX) * 6.0 // オーバーパワー: 速いが誤差大
  } else if (p < SERVE_SWEET_MIN) {
    aimNoise = (SERVE_SWEET_MIN - p) * 1.2 // 弱め: 誤差はやや増える(安全側)
  }
  aimNoise *= stp.faultNoiseMul

  const aimedTarget = target.clone()
  aimedTarget.y = 0
  if (aimNoise > 0) {
    const ang = Math.random() * Math.PI * 2
    const r = Math.sqrt(Math.random()) * aimNoise
    aimedTarget.x += Math.cos(ang) * r
    aimedTarget.z += Math.sin(ang) * r
  }

  const hp = hitPos.clone()
  hp.y = SERVE_HIT_HEIGHT

  // スピン: 順回転 spinVector(horizDir, topSpin) + サイドスピン sideSpin·ŷ(縦軸回り)。
  // サイドスピンは横へ曲げる Magnus を生むため、着地の水平誤差を dir の回転で
  // フィードバック補正する(数回反復)。slice/kick が常にボックスを外すのを防ぐ。
  const sideSpinVec = new Vector3(0, stp.sideSpin, 0)

  // 初期の水平進行方向(打点→狙い)。曲がり補正でこの方向を回転させる。
  const dx0 = aimedTarget.x - hp.x
  const dz0 = aimedTarget.z - hp.z
  const horiz0 = Math.hypot(dx0, dz0)
  let dirX = 0
  let dirZ = -sideSign(hitter)
  if (horiz0 > 1e-6) {
    dirX = dx0 / horiz0
    dirZ = dz0 / horiz0
  }

  // 要求ネット越え高(キックは高く)。
  const needCross = NET_HEIGHT + 0.15 * stp.netMarginMul

  /** 与えた水平方向 dir で仰角を掃引し、最も狙いに近い解とその着地を返す。 */
  function sweepElevation(
    dX: number,
    dZ: number,
  ): { vel: Vector3; spin: Vector3; land: Vector3 } | null {
    const horizDir = new Vector3(dX, 0, dZ)
    const spin = spinVector(horizDir, stp.topSpin).add(sideSpinVec)
    let best: { vel: Vector3; spin: Vector3; land: Vector3 } | null = null
    let bestErr = Infinity
    // キックは高い弾道が必要なため上限を引き上げる。
    const maxDeg = 18 + 18 * Math.max(0, stp.netMarginMul - 1)
    for (let deg = -18; deg <= maxDeg; deg += 0.5) {
      const th = (deg * Math.PI) / 180
      const vy = speed * Math.sin(th)
      const vh = speed * Math.cos(th)
      const vel = new Vector3(dX * vh, vy, dZ * vh)
      const cross = netCrossHeight(hp, vel, spin, hitter)
      if (cross === null || cross < needCross) continue // ネットを安全に越える仰角のみ
      const land = simulateLanding(hp, vel, spin, hitter)
      if (!land) continue
      const err = Math.hypot(land.x - aimedTarget.x, land.z - aimedTarget.z)
      if (err < bestErr) {
        bestErr = err
        best = { vel, spin: spin.clone(), land: land.clone() }
      }
    }
    return best
  }

  // --- 横曲がり補正: 着地の水平(x)誤差を打ち出し方向の回転にフィードバック ---
  let result = sweepElevation(dirX, dirZ)
  for (let iter = 0; iter < 4; iter++) {
    if (!result) break
    const errX = aimedTarget.x - result.land.x
    if (Math.abs(errX) < 0.15) break
    // 着地が狙いより x+ に流れた(errX<0)なら打ち出しを x- へ回す、の逆。
    // 水平方向ベクトルを errX に比例して回転(ゲイン控えめで発散を防ぐ)。
    const horizDist = Math.max(1, Math.hypot(aimedTarget.x - hp.x, aimedTarget.z - hp.z))
    const dAngle = (errX / horizDist) * 0.7
    const cos = Math.cos(dAngle)
    const sin = Math.sin(dAngle)
    const nX = dirX * cos - dirZ * sin
    const nZ = dirX * sin + dirZ * cos
    dirX = nX
    dirZ = nZ
    const next = sweepElevation(dirX, dirZ)
    if (!next) break
    result = next
  }

  if (result) return { vel: result.vel, spin: result.spin }

  // どの仰角でもネットを越えられない/着地しない場合のフォールバック:
  // やや上向きに打ち上げて最低限ネットを越える解を返す。
  const th = (8 * Math.PI) / 180
  const vy = speed * Math.sin(th)
  const vh = speed * Math.cos(th)
  const horizDir = new Vector3(dirX, 0, dirZ)
  return {
    vel: new Vector3(dirX * vh, vy, dirZ * vh),
    spin: spinVector(horizDir, stp.topSpin).add(sideSpinVec),
  }
}
