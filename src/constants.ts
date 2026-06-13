// =============================================================================
// 定数(凍結) — コート寸法・物理定数・ゲームパラメータ
// 詳細仕様は docs/ARCHITECTURE.md / docs/GAME_DESIGN.md を参照。
// =============================================================================
import type { AIProfile, Difficulty, ServeType, ShotType } from './types'

// ---------------------------------------------------------------------------
// コート寸法(m)。ネットが z=0、プレイヤー側が z>0。
// ---------------------------------------------------------------------------
export const COURT_LENGTH = 23.77
export const COURT_HALF_LENGTH = COURT_LENGTH / 2 // 11.885
export const COURT_WIDTH = 8.23 // シングルス
export const COURT_HALF_WIDTH = COURT_WIDTH / 2 // 4.115
export const SERVICE_LINE_Z = 6.4 // ネットからの距離
export const NET_HEIGHT = 0.914
export const NET_HALF_WIDTH = 5.0 // ネット自体の横幅(コートより広い)

// 場外境界(これを超えたらボール消失扱い)
export const OUT_BOUND_X = 9.0
export const OUT_BOUND_Z = 16.0

// ---------------------------------------------------------------------------
// 物理
// ---------------------------------------------------------------------------
export const PHYS_DT = 1 / 120
export const GRAVITY = 9.81
export const BALL_RADIUS = 0.033
export const KD = 0.02 // 空気抵抗係数(2次): a -= KD*|v|*v
export const KM = 4.0e-4 // マグナス係数: a += KM*(ω×v)
export const SPIN_DECAY = 0.1 // ω減衰 /s
export const REST = 0.75 // バウンス反発係数
export const BOUNCE_FRICTION = 0.18 // バウンス水平減速
export const SPIN_BOUNCE = 0.0045 // バウンス時スピン→水平速度変換
export const SPIN_BOUNCE_DECAY = 0.6 // バウンス時のω残存率
export const NET_RESTITUTION = 0.12 // ネット衝突の vz 反発
export const NET_DAMP = 0.25 // ネット衝突の vx,vy 残存率

// ---------------------------------------------------------------------------
// ショットソルバ
// ---------------------------------------------------------------------------
export interface ShotParam {
  /** 基準初速 m/s */
  speed: number
  /** 軌道頂点の目安高さ(m)。ソルバが飛行時間決定に使う */
  apex: number
  /** スピンスカラー rad/s(正=トップスピン) */
  spinScalar: number
  /** 基準ターゲット深さ: 相手ベースラインからの手前距離(m) */
  baseDepthFromBaseline: number
  /** ネット越えマージン(m)。小さいほどネットリスク */
  netMargin: number
}

export const SHOT_PARAMS: Record<ShotType, ShotParam> = {
  flat:    { speed: 30, apex: 1.6, spinScalar: 0,    baseDepthFromBaseline: 1.8, netMargin: 0.15 },
  topspin: { speed: 24, apex: 2.6, spinScalar: 260,  baseDepthFromBaseline: 1.8, netMargin: 0.5 },
  slice:   { speed: 18, apex: 1.5, spinScalar: -180, baseDepthFromBaseline: 3.5, netMargin: 0.3 },
  lob:     { speed: 16, apex: 7.0, spinScalar: 60,   baseDepthFromBaseline: 1.2, netMargin: 3.0 },
  drop:    { speed: 12, apex: 3.0, spinScalar: -120, baseDepthFromBaseline: 9.4, netMargin: 0.5 },
}
// drop の baseDepthFromBaseline 9.4m ≒ ネットから 2.5m(浅すぎるとネット直撃リスクが過大)

/** 品質→狙い誤差半径: (1-q) * AIM_NOISE_R */
export const AIM_NOISE_R = 2.2
/** 品質→威力: speed *= QUALITY_POWER_MIN + (1-QUALITY_POWER_MIN)*q */
export const QUALITY_POWER_MIN = 0.75
/** ターゲットをコート内にクランプするマージン */
export const TARGET_CLAMP_MARGIN = 0.3
/** コース打ち分けオフセット(GAME_DESIGN §4.3) */
export const AIM_OFFSET_X = 2.6
export const AIM_OFFSET_Z = 2.0

// ---------------------------------------------------------------------------
// チャージショット(GAME_DESIGN §4.4)
// ---------------------------------------------------------------------------
/** charge 0→1 に要する長押し秒数 */
export const CHARGE_TIME = 0.8
/** チャージ上限(1.0 超はオーバーチャージ) */
export const CHARGE_MAX = 1.25
/** チャージ中の移動速度係数 */
export const CHARGE_MOVE_FACTOR = 0.45
/** 速度係数 = CHARGE_POWER_MIN + CHARGE_POWER_GAIN * min(charge, 1) */
export const CHARGE_POWER_MIN = 0.85
export const CHARGE_POWER_GAIN = 0.4
/** オーバーチャージの狙い誤差加算: (charge-1)^+ * OVERCHARGE_NOISE (m) */
export const OVERCHARGE_NOISE = 2.8
/** オーバーチャージのネット越えマージン縮小率: netMargin *= 1 - SHRINK*(charge-1)/(CHARGE_MAX-1) */
export const OVERCHARGE_NET_SHRINK = 0.5
/** インパクト前後の移動ロック秒数と、その間の移動速度係数 */
export const SWING_LOCK_TIME = 0.35
export const SWING_LOCK_MOVE_FACTOR = 0.12
/** 空チャージ(打たずに離した)後の再チャージ不可秒数 */
export const CHARGE_RELEASE_COOLDOWN = 0.25

// ---------------------------------------------------------------------------
// 接触コンテキスト(打点の高さ・コート位置・相手球の勢いによる打球変化)
// docs/GAME_DESIGN.md §4.5 / docs/ARCHITECTURE.md §6.1
// これらが「コートのどこで・どの高さで・どんな勢いの球を打つか」で打球を
// 大きく変え、ゲームの戦略性(駆け引き)を生む。
// ---------------------------------------------------------------------------

// 打点の高さ(m)とレバレッジ。lev = clamp((h - PIVOT)/PIVOT, -1, 1)。
// lev<0 = 低い打点(持ち上げる必要・パワー時にアウト/ネットしやすい)、
// lev>0 = 高い打点(上から叩ける・角度をつけられる)。
export const CONTACT_PIVOT_HEIGHT = 0.9 // レバレッジ 0 となる基準高さ(通常打点)
export const CONTACT_LOW_HEIGHT = 0.55 // これ未満は明確に「低い打点」
export const CONTACT_HIGH_HEIGHT = 1.5 // これ以上は明確に「高い打点」

// スマッシュ(高い打点 × 前寄り × フラットで成立する決め球)
export const SMASH_MIN_HEIGHT = 1.7 // この高さ以上の打点で成立
export const SMASH_MAX_DEPTH = 8.5 // ネットからこの距離以内(前寄り)で成立
export const SMASH_SPEED = 42 // 基準初速(品質・チャージで増減)
export const SMASH_QUALITY_FLOOR = 0.75 // 品質ペナルティを緩和(0で速度係数の下限)
export const SMASH_CHARGE_GAIN = 0.45 // charge 1 で +45%
export const SMASH_NET_MARGIN = 0.05 // 上から叩くためネット越えは容易
export const SMASH_AIM_NOISE_MUL = 0.5 // 狙いは正確

// 低打点でパワーを乗せたときのリスク(GAME_DESIGN §4.5)
// powerExcess = max(0, chargePower-1) + 0.5·max(0, q-0.6)
export const LOW_POWER_OVERSHOOT = 3.2 // 低打点×パワーの深さバイアス(m)スケール → アウト
export const LOW_CONTACT_SPRAY = 1.2 // 低打点×パワーの追加狙い誤差(m)スケール
export const LOW_CONTACT_NET_RISK = 0.45 // 低打点フラットのネットマージン縮小率
export const FORECOURT_LOW_AMP = 1.6 // 前寄り(forecourt)での低打点リスク増幅

// 前寄りフラットの深さリスク(前に詰めて低〜中打点フラットを強打すると後ろが短くアウト)
export const FORECOURT_FLAT_OVERSHOOT = 1.8 // 深さバイアス(m)スケール

// 高い打点の優位(GAME_DESIGN §4.5)
export const HIGH_CONTACT_SPEED_GAIN = 0.18 // flat/topspin を高打点で速く打てる(lev=1で+18%)
export const HIGH_CONTACT_SPIN_GAIN = 0.5 // 高打点トップスピンの spin 増(角度を保つ dip)
export const HIGH_TOPSPIN_ANGLE_BONUS = 0.85 // 高打点トップスピンの横オフセット拡大(controller)

// 相手球の勢い(incoming pace)
export const PACE_REDIRECT_FLAT = 0.3 // flat/slice: 相手球速の何割を上乗せ(カウンター)
export const PACE_REDIRECT_SPIN = 0.12 // topspin
export const PACE_CONTROL_THRESH = 17 // この球速(m/s)超で制御が難しくなる
export const PACE_CONTROL_K = 0.06 // 追加誤差 = K·max(0,vIn-THRESH)·(1.2-q) (m)
export const PACE_TOUCH_PENALTY = 0.1 // drop/lob を速球から打つ追加誤差 = ·max(0,vIn-THRESH)

// ---------------------------------------------------------------------------
// 速いボールの返球難度(ミート/差し込まれ) — docs/GAME_DESIGN.md §4.6
// スマッシュ等の速球は芯を捉えにくく、準備(チャージ)が浅いと「差し込まれて」
// 山なりの弱い返球(チャンスボール)になる。現実のテニスのセオリー:
//   スライス(ブロック)= 速球に最も強い(短いテイクバック・球威を利用)
//   フラット = 中間  /  トップスピン = 速球に最も弱い(フルスイングと精密な
//   タイミングが必要)。準備(チャージ)が十分なら強い返球も可能。
// ---------------------------------------------------------------------------
// この球速(m/s)を超える相手球で「差し込まれ(mishit)」が発生し始める。
// 通常ラリーの球速(〜25程度)より上、スマッシュ(40〜60)で強く効く帯に設定。
export const RETURN_PACE_THRESH = 26
// mishit が 1.0 に飽和するまでの超過球速幅(m/s)
export const RETURN_OVERWHELM_RANGE = 22
// ショット種ごとの「速球への弱さ」係数(大きいほど差し込まれやすい)
export const RETURN_WEAKNESS_SLICE = 0.35 // スライス/ブロックは速球に強い
export const RETURN_WEAKNESS_FLAT = 0.6
export const RETURN_WEAKNESS_TOPSPIN = 1.0 // トップスピンは速球に弱い
export const RETURN_WEAKNESS_TOUCH = 1.3 // drop/lob は速球から最も難しい
// チャージ(準備)による mishit 軽減: ×(1 − RETURN_CHARGE_MITIGATION·min(charge,1))
export const RETURN_CHARGE_MITIGATION = 0.7
// mishit 時の弱い返球パラメータ(山なりのチャンスボール)
export const WEAK_RETURN_SPEED = 13 // mishit=1 での返球初速(遅い)
export const RETURN_FLOAT_APEX = 4.5 // mishit=1 での弾道頂点(高く=山なり)
export const RETURN_MISHIT_SHORT = 5.0 // mishit=1 で目標を手前へ引く量(m)= 浅いsitter
export const RETURN_MISHIT_SPRAY = 2.0 // mishit=1 での追加狙い誤差(m)
export const MISHIT_ACTIVE_EPS = 0.05 // これ未満の mishit は通常打球(差し込まれなし)

// ---------------------------------------------------------------------------
// サーブの種類(docs/GAME_DESIGN.md §5.1)
// flat=速い/低い弾道・低いバウンド(リスク高)、slice=サイドスピンで曲がり低く滑る
// (ワイドに追い出す)、kick=順回転で高いネットマージン(安全)・高く弾んで跳ねる。
// ---------------------------------------------------------------------------
export interface ServeTypeParam {
  /** サーブ初速の倍率(power→速度に乗算) */
  speedMul: number
  /** 順回転スピン量 rad/s(正=トップスピン→沈んで高く弾む、負=スライス回転で低く滑る) */
  topSpin: number
  /** サイドスピン量 rad/s(縦軸回り)。横に曲がる(0=曲がらない) */
  sideSpin: number
  /** ネット越えマージン倍率(大きいほど安全に高く越える) */
  netMarginMul: number
  /** スイートゾーン外の誤差(フォルト率)倍率。小さいほど安全 */
  faultNoiseMul: number
}

export const SERVE_TYPE_PARAMS: Record<ServeType, ServeTypeParam> = {
  // フラット: 最速・低い弾道・低く直進するバウンド。マージン小でリスク高。
  flat: { speedMul: 1.0, topSpin: 20, sideSpin: 0, netMarginMul: 1.0, faultNoiseMul: 1.0 },
  // スライス: やや遅い・横に曲がる・わずかな逆回転で低く滑る。ワイドに追い出す。
  slice: { speedMul: 0.9, topSpin: -40, sideSpin: 240, netMarginMul: 1.3, faultNoiseMul: 0.8 },
  // キック: 遅いが順回転が重く高いマージンで安全。高く弾んで跳ね上がる(2ndの主軸)。
  kick: { speedMul: 0.8, topSpin: 340, sideSpin: 120, netMarginMul: 2.2, faultNoiseMul: 0.6 },
}

// ---------------------------------------------------------------------------
// サーブ時の立ち位置移動範囲(サーブを打つサイドの半面内)
// ---------------------------------------------------------------------------
/** センターマークからの最小距離(反対サイドに入れない) */
export const SERVE_X_MARGIN_CENTER = 0.25
/** ベースラインからの後方距離の範囲 */
export const SERVE_Z_MIN_BEHIND = 0.2
export const SERVE_Z_MAX_BEHIND = 2.5

// ---------------------------------------------------------------------------
// ボール視認性(描画)
// ---------------------------------------------------------------------------
/** ボールの描画スケール(物理半径に対する倍率。視認性のため実寸より大きく) */
export const BALL_VISUAL_SCALE = 1.35

// サーブ
export const SERVE_HIT_HEIGHT = 2.6
export const SERVE_SPEED_MIN = 28
export const SERVE_SPEED_MAX = 46
export const SERVE_SWEET_MIN = 0.7
export const SERVE_SWEET_MAX = 0.88
export const SERVE_METER_PERIOD = 1.2 // 三角波 0→1→0 の周期(秒)

// ---------------------------------------------------------------------------
// プレイヤー
// ---------------------------------------------------------------------------
export const WALK_SPEED = 5.5
export const SPRINT_SPEED = 8.0
export const MOVE_ACCEL = 40
export const REACH = 2.0 // 打球可能な水平距離
export const REACH_HEIGHT = 2.4 // 打球可能なボール高さ上限
export const SWEET_DIST = 0.9 // この距離以内なら品質の距離係数 1.0
export const QUALITY_MIN = 0.35
export const WHIFF_COOLDOWN = 0.4 // 空振り硬直(秒)
export const SPRINT_SHOT_PENALTY = 0.15

// 可動域(プレイヤー側。AI 側は z 符号反転)
export const MOVE_X_LIMIT = 6.5
export const MOVE_Z_MIN = 0.4
export const MOVE_Z_MAX = 15.5

// スタミナ
export const STAMINA_MAX = 100
export const STAMINA_SPRINT_DRAIN = 18 // /s
export const STAMINA_REGEN = 6 // /s(非スプリント時)
export const STAMINA_POINT_RECOVERY = 40 // ポイント間
export const STAMINA_LOW_THRESHOLD = 30 // これ未満で品質低下開始
export const STAMINA_QUALITY_FLOOR = 0.6 // スタミナ0時の品質係数

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------
export const AI_PROFILES: Record<Difficulty, AIProfile> = {
  easy: {
    reactionDelay: 0.42, speedScale: 0.82, extraAimNoise: 1.4,
    aggressiveness: 0.25, blunderRate: 0.08, servePower1st: 0.65, servePower2nd: 0.5,
    leaveOutClearProb: 0.82, leaveOutEdgeProb: 0.35, returnPositioning: 0.25,
  },
  normal: {
    reactionDelay: 0.28, speedScale: 0.95, extraAimNoise: 0.7,
    aggressiveness: 0.5, blunderRate: 0.04, servePower1st: 0.78, servePower2nd: 0.6,
    leaveOutClearProb: 0.92, leaveOutEdgeProb: 0.45, returnPositioning: 0.6,
  },
  hard: {
    reactionDelay: 0.16, speedScale: 1.05, extraAimNoise: 0.3,
    aggressiveness: 0.75, blunderRate: 0.015, servePower1st: 0.84, servePower2nd: 0.68,
    leaveOutClearProb: 0.98, leaveOutEdgeProb: 0.55, returnPositioning: 1.0,
  },
}

/**
 * AI の「見送り」判定(GAME_DESIGN §7.1 / ARCHITECTURE §11)。
 * 着地予測がコート外に outDist(m)出ているとき、outDist がこの値以上なら
 * 「明らかにアウト」として leaveOutClearProb で見送る。0〜この値の間は
 * leaveOutEdgeProb..leaveOutClearProb を線形補間した確率で見送る。
 */
export const AI_LEAVE_CLEAR_MARGIN = 0.6

/** AI のホームポジション(ベースライン少し後ろ、z は opponent 側で符号反転して使う) */
export const HOME_POS_Z = COURT_HALF_LENGTH + 1.0

// ---------------------------------------------------------------------------
// ゲームフロー
// ---------------------------------------------------------------------------
export const BANNER_SEC = 1.8 // pointOver の表示時間
export const AI_SERVE_DELAY_MIN = 0.8
export const AI_SERVE_DELAY_MAX = 1.2
