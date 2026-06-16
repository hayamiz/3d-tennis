// =============================================================================
// 定数(凍結) — コート寸法・物理定数・ゲームパラメータ
// 詳細仕様は docs/ARCHITECTURE.md / docs/GAME_DESIGN.md を参照。
// =============================================================================
import type {
  AIProfile,
  Difficulty,
  Persona,
  PersonaId,
  PersonaModifiers,
  PersonaRatings,
  ServeType,
  ShotType,
  Surface,
} from './types'

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
// バウンス時スピン→垂直速度(跳ね上がり)。トップスピン(進行方向への射影 proj>0)のみ
// 適用し、着地後に高く跳ねて相手の打点を超える「重い球」を再現する(実テニス理論。
// GAME_DESIGN §5.2)。スライス(proj<0)には効かせない。0 で従来挙動。
export let SPIN_BOUNCE_VERTICAL = 0.004
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
export let CHARGE_POWER_GAIN = 0.4 // 体感調整可(TUNABLES)
/** オーバーチャージの狙い誤差加算: (charge-1)^+ * OVERCHARGE_NOISE (m) */
export const OVERCHARGE_NOISE = 2.8
/** オーバーチャージのネット越えマージン縮小率: netMargin *= 1 - SHRINK*(charge-1)/(CHARGE_MAX-1) */
export const OVERCHARGE_NET_SHRINK = 0.5
/** インパクト前後の移動ロック秒数と、その間の移動速度係数 */
export const SWING_LOCK_TIME = 0.35
export const SWING_LOCK_MOVE_FACTOR = 0.12
/** 空チャージ(打たずに離した)後の再チャージ不可秒数 */
export const CHARGE_RELEASE_COOLDOWN = 0.25

// チャージによるショット特徴の強化(GAME_DESIGN §4.4 / §4.5)。cc = min(charge/CHARGE_MAX, 1)。
// トップスピン: 回転を増やして強く沈ませ、弾道を低く・速くする(apex を下げる)。低い弾道で
//   ネットを越えつつ沈み込みで in に収まるので、他ショットより横の打球角度を大きく取れる。
// スライス: 逆回転を増やして滞空・低い失速バウンドを強め、着地をベースライン側へ深く伸ばす。
/** トップスピンの回転量ゲイン: spinScalar ×(1 + GAIN·cc)。フルで ×1.6(沈み込み+跳ね) */
export let TOPSPIN_CHARGE_SPIN_GAIN = 0.6
/** トップスピンの横オフセット拡大: targetX ×(1 + ANGLE·cc)。フルで +70%(サイドへ角度) */
export let TOPSPIN_CHARGE_ANGLE = 0.7
/** トップスピンの低弾道化: apex ×(1 − FLATTEN·cc)。apex を下げて低く速くする(初速やや増・山なり防止) */
export let TOPSPIN_CHARGE_FLATTEN = 0.5
/** トップスピンの低い通過許可: netMargin ×(1 − NETLOW·cc)。ネット越え検証の余裕を削り低い弾道に */
export let TOPSPIN_CHARGE_NETLOW = 0.7
/** 着地をこの距離(m)以上手前へ引いた「短角アタック」のトップスピンを速度優先ドライブ(低く速い
 *  弾道)で打つ。深い目標(引きが小さい)は従来の収束ソルバで安定したラリー軌道のまま。 */
export let TOPSPIN_DRIVE_MIN_PULL = 1.0
/** トップスピンのドライブ初速倍率。フラットほど速くしないための抑制(initial speed を控えめに) */
export let TOPSPIN_DRIVE_SPEED_MUL = 0.82
// 好条件(打点が低くない・差し込まれていない)で横へ振ったとき、着地を中央寄り(前後の真ん中)へ
// 引いて「左右の端を狙う短い鋭角」を打てるようにする(GAME_DESIGN §4.5)。深い既定目標のままだと
// 山なり&ベースライン際になるので、引くほど低く・浅くなる(solveDrive)。
/** 着地を手前へ引く最大量(m): pull = SHORTEN·cc·heightCond·paceOk·angleFrac */
export let TOPSPIN_ATTACK_SHORTEN = 5.5
/** 短い鋭角の最短着地(ネットからの距離 m)。引きすぎ(ネット手前)を防ぐクランプ */
export const TOPSPIN_ATTACK_MIN_DEPTH = 4.0
/** 好条件判定の打点高ランプ下端(m)。これ以下では短い鋭角を打てない(深く返す) */
export const TOPSPIN_ATTACK_H_LOW = 0.7
/** 好条件判定の打点高ランプ上端(m)。これ以上で短い鋭角を最大限狙える */
export const TOPSPIN_ATTACK_H_GOOD = 1.2
/** スライスの逆回転ゲイン: spinScalar ×(1 + GAIN·cc)。フルで ×1.6(滑り・失速) */
export let SLICE_CHARGE_SPIN_GAIN = 0.6
/** スライスの深さ(m): チャージでベースライン側へ最大 DEPTH·cc 深く伸ばす */
export let SLICE_CHARGE_DEPTH = 2.0

// ---------------------------------------------------------------------------
// ジャストミート(IMPROVEMENTS §6.1.1)— 操作=リリースで打つ(案A)。
// ショットキーを長押しでチャージ → 離した瞬間にリーチ内なら打球。離した時にボールが
// スイートゾーン(芯=JUST_SWEET_DIST 以内)にあれば「ジャストミート」で威力・狙い・回転に
// 控えめなボーナス。速球ほどゾーン通過が速く自然に難しい。未リリースでもボールがスイート
// ゾーンを抜けて遠ざかり出した瞬間にセーフティ打球(ジャストなし)するので返球は途切れない。
// リーチ外で離すと空振り。
// ---------------------------------------------------------------------------
/** ジャスト成立とみなす打点距離(m)。離した瞬間 hDist がこれ以内なら just(芯で捉えた) */
export const JUST_SWEET_DIST = 1.0
/** ジャスト成立時のボーナス(いずれも控えめ。やり過ぎると「ジャスト必須」になる) */
export const JUST_POWER_MUL = 1.08 // 初速 ×
export const JUST_AIM_MUL = 0.6 // 狙い誤差半径 ×(小さいほど正確)
export const JUST_SPIN_MUL = 1.12 // 回転 ×

/**
 * セーフティ打球の落下しきい値(m)。下降中のボールがリーチ内でこの高さ以下になったら、
 * 水平に遠ざかっていなくても受動的に打つ(山なり/ロブが真下に落ちて空振りするのを防ぐ)。
 * リリース方式の保険(§4.4)。
 */
export const SAFETY_DROP_Y = 1.2
/**
 * 垂直セーフティの「近づき過ぎ」抑制しきい値(m/s)。ボールが水平にこの速さより速く
 * 近づいている間は垂直セーフティを発動しない(芯に入れて just を狙う余地を残す)。
 * これが無いと、低い球をノーバウンドで取りに行くとき、まだ遠い(リーチ端)で近づく最中に
 * 即セーフティが出て just がほぼ出せなかった。最接近を過ぎてから発動させる。
 */
export const SAFETY_APPROACH_RATE = 2.0

/** ミートヒント(収束リング)の表示リード時間(秒)。接触のこの秒数前から出す(§6.1.1 F) */
export const MEET_HINT_LEAD = 0.6
/** 収束リングの半径: 接触時(eta=0)= BASE、リード開始時(eta=LEAD)= BASE+RANGE(m) */
export const MEET_HINT_RING_BASE = 0.55
export const MEET_HINT_RING_RANGE = 1.7

// ---------------------------------------------------------------------------
// 練習モード(ボールマシン)— スタートメニューから選択。同じ球を繰り返し出して打ち返す。
// ---------------------------------------------------------------------------
/** マシンの球出し位置(相手ベースライン中央、やや手前) */
export const PRACTICE_MACHINE_Z = -(COURT_HALF_LENGTH - 0.5)
/** 球が「決着」してから次を出すまでの待ち時間(秒) */
export const PRACTICE_FEED_DELAY = 1.1
/** コース別の着地深さ(プレイヤーコート z>0)。front=前(ネット寄り)/ back=後(ベースライン寄り) */
export const PRACTICE_COURSE_FRONT_Z = 3.2
export const PRACTICE_COURSE_BACK_Z = COURT_HALF_LENGTH - 1.6
/** 球出しの横方向ばらつき(±m)。タイミング練習に集中できるよう控えめ */
export const PRACTICE_SPREAD_X = 1.2

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
// この打点高さ以上ならスマッシュ用オーバーヘッドモーションで描画する(見た目のみ。
// ゲーム上のスマッシュ成立条件 SMASH_MIN_HEIGHT より少し低めにして高い球全般を拾う)
export const SMASH_MOTION_HEIGHT = 1.6
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
// 速球リターンのミート timing 増幅(GAME_DESIGN §4.4.1/§4.6・IMPROVEMENTS §5.3)。
// ジャスト(芯で合わせた)か否かを mishit と just 威力に効かせ、相手球速で増幅する。
// すべて paceExcess(=vIn−RETURN_PACE_THRESH)依存なので通常ラリー(vIn≤閾値)では無効。
export const RETURN_JUST_MISHIT_RELIEF = 0.8 // just のとき mishit ×(1−0.8)=差し込まれをほぼ無効化(芯で合わせれば速球も clean に返る)
export const RETURN_NOJUST_MISHIT_AMP = 1.25 // not-just のとき mishit ×1.25=差し込まれ増幅
export const RETURN_JUST_PACE_POWER_K = 0.012 // just 初速ボーナスの傾き(/(m/s) 超過分)
export const RETURN_JUST_PACE_POWER_MAX = 0.25 // just 初速ボーナスの上限(speed 倍率への加算上限)

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
  // フラット: 最速・低い弾道・低く直進するバウンド。ネット上 4cm まで許容してネットすれすれを
  // 通し、軽い順回転(topSpin=60)でようやくサービスラインの手前に落ちるよう調整(GAME_DESIGN §5.1)。
  // リスクは「ネットを越える低さ」ではなく狙いブレ(faultNoiseMul=1.0)に寄せている。
  flat: { speedMul: 1.0, topSpin: 60, sideSpin: 0, netMarginMul: 0.4, faultNoiseMul: 1.0 },
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
// 速度上限。SERVE_SPEED_MAX を 54 にしているのは、ビッグサーバー(serveSpeedMul 最大 1.12)
// の power=1.0 フラットでも 218 km/h に収まり、コート長(net→service line=6.4m)に対して
// 「ネットを越え、なおボックスに落ちる仰角」が存在することを保証するため(GAME_DESIGN §5)。
// 上限を上げ過ぎると幾何条件として全角度がロングフォルトになる(旧 56 で発生)。
export const SERVE_SPEED_MIN = 30
export const SERVE_SPEED_MAX = 54
export const SERVE_SWEET_MIN = 0.7
export const SERVE_SWEET_MAX = 0.88
// サーブ後の硬直(移動が SWING_LOCK_MOVE_FACTOR に低下する秒数)。パワーに比例。
// 強打サーブほど隙が大きく、良いコースにリターンされるとリターンエースになりやすい。
// → 常にコート端からトップスピードで打つことにリスクを生む(GAME_DESIGN §5)。
export const SERVE_RECOVERY_MIN = 0.15 // power=0 の最低硬直(秒)
export const SERVE_RECOVERY_GAIN = 0.72 // power=1 で +0.72秒(計 0.87秒)。強打サーブのリスクを僅かに強化(IMPROVEMENTS §5.2)
export const SERVE_METER_PERIOD = 1.2 // 三角波 0→1→0 の周期(秒)

// 初心者向け補助(easy/normal)で HUD のサーブメーター上に「ここまではほぼ確実に入る」上限
// マークを描くために使う、サーブ種別ごとのパワー上限(0..1)。実測ベース: ピーク球速と
// サービスボックスの幾何条件から、ビッグサーバー級でも入る上限。フラットだけは 0.92 を超えると
// ロングフォルト率が一気に上がる(GAME_DESIGN §5.1)。hard 以上では UI 表示しない。
export const SERVE_SAFE_POWER_MAX: Record<ServeType, number> = {
  flat: 0.92,
  slice: 1.0,
  kick: 1.0,
}
/** サーブ補助(メーター上限マーク+オーバーパワー時の自動減速)を有効にする難易度。 */
export const SERVE_ASSIST_DIFFICULTIES: ReadonlyArray<Difficulty> = ['easy', 'normal']

// ---------------------------------------------------------------------------
// プレイヤー
// ---------------------------------------------------------------------------
export const WALK_SPEED = 5.5
export const SPRINT_SPEED = 8.0
export const MOVE_ACCEL = 40
export const REACH = 2.0 // 打球可能な水平距離
// 打球可能なボール高さ上限(m)。オーバーヘッド(ロブ/スマッシュ)の打点に合わせ高め。
// 旧 2.4m は低すぎ、降ってくるロブを少し早めに離すと「TOO-HIGH」で空振りしていた(§4.4)。
// 2.9m はラケットを伸ばしたオーバーヘッドの現実的な到達高で、降下球の打てる窓を広げる。
export const REACH_HEIGHT = 2.9
export const SWEET_DIST = 0.9 // この距離以内なら品質の距離係数 1.0
export const QUALITY_MIN = 0.35
export const WHIFF_COOLDOWN = 0.4 // 空振り硬直(秒)
export const SPRINT_SHOT_PENALTY = 0.15

// 可動域(プレイヤー側。AI 側は z 符号反転)
export const MOVE_X_LIMIT = 6.5
export const MOVE_Z_MIN = 0.4
export const MOVE_Z_MAX = 15.5

// スタミナ ——「強い行動(強打・スプリント)のクールダウン制」(GAME_DESIGN §6 / ARCHITECTURE §6.5)
// 強い行動を起こすと所定量を消費し、同時に回復を STAMINA_COOLDOWN 秒だけ停止する。最後の
// 強い行動からクールダウンが経過して初めて STAMINA_REGEN /s の回復が再開する。クールダウンは
// ラリー1往復程度に設定してあり、毎回強打するとクールダウンが切れる前に次の強打が来て確実に
// 減っていく。歩行移動・繋ぎ・タッチ・セーフティ打球は「強い行動」ではなく無料(回復継続)。
// 注: 体感調整用に一部を `let`(ES module ライブバインディング)にしている。
// デバッグの調整メニュー(§17 / TUNABLES)が実行時に再代入すると、各モジュールの
// 参照(updateStamina 等は毎フレーム読む)にそのまま反映される。
export const STAMINA_MAX = 100 // 基本ストック(= 最大チャージ強打 10 回分)
export let STAMINA_POINT_RECOVERY = 40 // ポイント間の回復量(長丁場では取り切れず蓄積疲労)
export let STAMINA_COOLDOWN = 2.5 // s 最後の強い行動から回復停止する時間(≈ラリー1往復)
export let STAMINA_REGEN = 6 // /s クールダウン経過後の回復レート(満タンまで約17秒)

// 強打(チャージショット)の消費。正規化チャージ c = charge/CHARGE_MAX ∈ [0,1]。
// c ≥ CHARGE_STRONG_THRESHOLD のショットのみ「強打」= 消費&回復停止の対象(弱打は無料)。
// コストはチャージ量に比例し、閾値で 0・最大チャージ(c=1)で STRONG_SHOT_COST_MAX。
// ペルソナによる消費差はなし(誰が打っても同じだけ減る。差はストック量=上限のみ)。
export let STRONG_SHOT_COST_MAX = 10 // c=1 の強打コスト(= STAMINA_MAX の 1/10)
export let CHARGE_STRONG_THRESHOLD = 0.35 // これ未満のチャージは弱打(消費なし・CDなし)
export let STAMINA_SPRINT_DRAIN = 15 // /s スプリント中の消費(移動時間に比例。ペルソナ差なし)
export let SERVE_STAMINA_MAX = 8 // サーブ(power=1)の消費。強い行動扱い(CD をリフレッシュ)

// スタミナ切れペナルティ(能力ゲート)。effStock に対する割合で判定する。
// 品質を下げるのではなく「強打不可・スプリント不可」にする。境界の振動を防ぐため
// スプリントは 2 閾値のヒステリシス(STOP で切れ、RESUME を超えるまで再開不可)。
// CHARGE_ENABLE は最大強打1発分(STRONG_SHOT_COST_MAX)を上回るよう設定し、
// 「チャージを始められた=最後まで打ち切れる」を保証する。
export let SPRINT_STOP_PCT = 0.03 // これ以下でスプリント強制停止
export let SPRINT_RESUME_PCT = 0.18 // これを超えるまでスプリント再開不可
export let CHARGE_ENABLE_PCT = 0.15 // これ以上でのみチャージ開始可(未満は通常打)

/** 強打かどうか(正規化チャージ c = charge/CHARGE_MAX ≥ 閾値) */
export function isStrongCharge(charge: number): boolean {
  return charge / CHARGE_MAX >= CHARGE_STRONG_THRESHOLD
}

/** チャージショットのスタミナ消費(チャージ量に比例。弱打=0。ペルソナ差なし) */
export function chargeShotCost(charge: number): number {
  const c = Math.max(0, Math.min(1, charge / CHARGE_MAX))
  const th = CHARGE_STRONG_THRESHOLD
  if (c < th) return 0
  return STRONG_SHOT_COST_MAX * ((c - th) / Math.max(1 - th, 1e-6))
}

// スタミナ可視化(GAME_DESIGN §6)。pct = stamina/effStock で判定。
export const STAMINA_GAUGE_GREEN = 0.6 // これ以上は緑(余裕)
export const STAMINA_GAUGE_YELLOW = 0.3 // これ以上は黄(注意)
export const STAMINA_SWEAT_START = 0.5 // この割合未満で発汗開始(早めに出して気づきやすく)
export const STAMINA_SWEAT_MAX_RATE = 20 // /s(pct→0 での放出レート。50%→0% を線形に増加)

// ---------------------------------------------------------------------------
// モメンタム(勢い)とプレッシャー時の品質変動(IMPROVEMENTS §4 高 / GAME_DESIGN §6.2)
// ---------------------------------------------------------------------------
/** 連続得点が何点で勢い満タン(momentum=±1)になるか */
export const MOMENTUM_FULL_STREAK = 3
/** momentum=±1 での品質倍率の振れ幅(波に乗ると +、崩れると −) */
export const MOMENTUM_QUALITY_K = 0.06
/**
 * プレッシャー時の品質変動係数。低 mental(pressureDrainMul>1)は重圧で品質が落ち(choke)、
 * 高 mental(<1)は逆に微上昇(clutch)。q *= 1 − PRESSURE_CHOKE_K·(pressureDrainMul−1)·pressure
 */
export const PRESSURE_CHOKE_K = 0.5

// ---------------------------------------------------------------------------
// オープンコート可視化(IMPROVEMENTS §4 高)
// ---------------------------------------------------------------------------
/** 相手がこの距離(m)以上センターから外れたらオープンコートを表示し始める */
export const OPEN_COURT_MIN_OFFSET = 1.2
/** 前衛(ネットポイント)判定の z 閾値: |z| < これ で前衛とみなす(= サービスライン) */
export const NET_POINT_Z = SERVICE_LINE_Z

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
  // hard の一段上。反応・正確さ・サーブを強化。加えて敵ペルソナの基礎能力に
  // VERYHARD_RATING_BONUS を上乗せする(buildMatch で適用)。
  veryHard: {
    reactionDelay: 0.10, speedScale: 1.10, extraAimNoise: 0.15,
    aggressiveness: 0.85, blunderRate: 0.005, servePower1st: 0.90, servePower2nd: 0.74,
    leaveOutClearProb: 0.99, leaveOutEdgeProb: 0.62, returnPositioning: 1.0,
  },
  // さらに一段上。ほぼノーミスで反応も最速。敵ペルソナ基礎能力に EXTREME_RATING_BONUS。
  extreme: {
    reactionDelay: 0.06, speedScale: 1.12, extraAimNoise: 0.06,
    aggressiveness: 0.92, blunderRate: 0.0, servePower1st: 0.95, servePower2nd: 0.80,
    leaveOutClearProb: 1.0, leaveOutEdgeProb: 0.70, returnPositioning: 1.0,
  },
}

// 高難易度では敵ペルソナの基礎能力値(ratings)に一律ボーナスを上乗せして地力を底上げする
// (GAME_DESIGN §7.2)。一律加算なのでペルソナの個性(相対的な強み弱み)は保たれる。
// ratings は本来 1..5 だが、倍率導出時のみ上限 6 まで拡張を許す(plyaer 側には掛けない)。
export let VERYHARD_RATING_BONUS = 0.75
export let EXTREME_RATING_BONUS = 1.5

/** 難易度に応じた敵ペルソナ ratings ボーナス(easy/normal/hard は 0) */
export function opponentRatingBonus(d: Difficulty): number {
  return d === 'veryHard' ? VERYHARD_RATING_BONUS : d === 'extreme' ? EXTREME_RATING_BONUS : 0
}

/** ratings に一律ボーナスを加える(各軸 [1, 6] にクランプ)。bonus=0 はそのまま返す */
export function boostRatings(r: PersonaRatings, bonus: number): PersonaRatings {
  if (bonus === 0) return r
  const c = (v: number) => Math.max(1, Math.min(6, v + bonus))
  return {
    serve: c(r.serve), power: c(r.power), spin: c(r.spin),
    speed: c(r.speed), stamina: c(r.stamina), finesse: c(r.finesse),
  }
}

/** 難易度の表示ラベル(HUD・メニュー共通) */
export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: 'Easy', normal: 'Normal', hard: 'Hard', veryHard: 'Very Hard', extreme: 'EXTREME',
}

/**
 * AI の「見送り」判定(GAME_DESIGN §7.1 / ARCHITECTURE §11)。
 * 着地予測がコート外に outDist(m)出ているとき、outDist がこの値以上なら
 * 「明らかにアウト」として leaveOutClearProb で見送る。0〜この値の間は
 * leaveOutEdgeProb..leaveOutClearProb を線形補間した確率で見送る。
 */
export const AI_LEAVE_CLEAR_MARGIN = 0.6

/**
 * AI のホーム(復帰)ポジション。z は opponent 側で符号反転して使う。
 * ベースライン際にとる。以前はベースラインより 1.0m 後方(COURT_HALF_LENGTH+1.0)で、
 * 打球後にドロップから遠ざかる方向へ後退復帰してしまい、短い球(ドロップ)に届かず
 * 2バウンドで失点する原因になっていた(BUG-002 の再発)。ベースライン際まで前へ出すことで、
 * 深い球は intercept 時に stanceGoalZ が後退補正するため対応しつつ、ドロップへの初動距離を縮める。
 */
export const HOME_POS_Z = COURT_HALF_LENGTH - 0.3

// ---------------------------------------------------------------------------
// AI 戦術スタンス(ベースライン / ネット)— GAME_DESIGN §7.1 / ARCHITECTURE §11
// 入射球ごとに「後ろで打ち合う(baseline)」か「前へ詰めてボレー(net)」かを判断する。
// 既定はベースラインのラリー。短い球(チャンス)が来たときだけ前へ詰める。
//   chance = shortFactor − AI_NET_PACE_W·paceFactor(浅い球で+、速球で−)
//   need   = lerp(AI_APPROACH_NEED_MAX, AI_APPROACH_NEED_MIN, netRushTendency)
//   chance > need のとき net。ネット型(tendency 大)ほど need が小さく、小さなチャンスでも前へ。
//   グラインダー(tendency≈0)は need が大きく、実質ベースライン専となる。
// 旧実装は score = tendency + 0.5·short − 0.5·pace > 0.62 で、tendency≈0.86 のネット型が
// 中庸な球でも常に net を選び「毎球ネットダッシュ」になっていた(往復で消耗)。
// ---------------------------------------------------------------------------
/** 前へ詰めるのに要するチャンス量。tendency=0(グラインダー)側。実質ほぼ前に出ない */
export const AI_APPROACH_NEED_MAX = 1.1
/** 前へ詰めるのに要するチャンス量。tendency=1(ネット鬼)側。中庸〜やや浅い球で前へ */
export const AI_APPROACH_NEED_MIN = -0.05
/** 着地のネットからの距離がこれ以下なら「短い球」(好機)。超では負に効く(深い球は詰めにくい) */
export const AI_SHORT_BALL_Z = SERVICE_LINE_Z + 1.0 // 7.4m
/** 速球は詰めにくい。RETURN_PACE_THRESH 超過分に応じて減点する重み */
export const AI_NET_PACE_W = 0.5
/** ネットへ詰めた後の待機(リカバリ)深さ(m)。詰めたらベースラインへ戻らずこの前目で構える。
 * 次球が深ければ intercept 時に baseline スタンスへ切り替わり後退する(無駄な往復を避ける)。 */
export const AI_NET_READY_Z = 5.0
/** ベースライン時、着地点より深く(ネットから遠く)下がって構える距離(m)。上がり際で打つ。
 * ただし短い球(ドロップ等)はバウンド後に伸びないので後退せず、着地点よりやや前に出て拾う
 * (BUG-002 対策。short の度合いで後退量を AI_BASELINE_DROPBACK→ −AI_SHORT_FORWARD へ補間)。 */
export const AI_BASELINE_DROPBACK = 1.6
/** 短い球に対し、着地点よりこれだけ前(ネット寄り)に構えて前進で拾う(m) */
export const AI_SHORT_FORWARD = 1.5
/** ネット時、着地点より前(ネット寄り)に出る距離(m)。空中/バウンド前に捉える */
export const AI_NET_ADVANCE = 2.2
/** ネットへ詰めても、ネットからこの距離より前には出ない(ネット際の下限) */
export const AI_NET_MIN_Z = 1.4

// ---------------------------------------------------------------------------
// ゲームフロー
// ---------------------------------------------------------------------------
export const BANNER_SEC = 1.8 // pointOver の表示時間
export const AI_SERVE_DELAY_MIN = 0.8
export const AI_SERVE_DELAY_MAX = 1.2

// ---------------------------------------------------------------------------
// プレイヤーペルソナ(docs/GAME_DESIGN.md §12 / docs/IMPROVEMENTS.md §3)
// 能力値(各1..5)・身体・外見の定義。能力値→倍率は personaModifiers() で導出する。
// ---------------------------------------------------------------------------

/** モデルスケールの基準身長(m)。heightM/この値 が縦スケール比になる */
export const BASE_HEIGHT_M = 1.83

/** チームカラー(1P=青系 / 2P=赤系)。ペルソナの外見とは独立した陣営識別 */
export const TEAM_PALETTE = {
  player: { body: 0x2255cc, limb: 0x1a3f99, trim: 0x6699ff }, // 1P 青系
  opponent: { body: 0xcc2222, limb: 0x991a1a, trim: 0xff7766 }, // 2P 赤系
} as const

export const PLAYER_PERSONAS: Record<PersonaId, Persona> = {
  sambrant: {
    id: 'sambrant',
    name: 'ピート・サンブラント',
    archetype: 'ビッグサーバー / サーブ&ボレー',
    blurb: '一撃必殺のフラットサーブと前への決定力。長い打ち合い・粘りには弱い。',
    ratings: { serve: 5, power: 4, spin: 2, speed: 3, stamina: 3, finesse: 4 },
    physique: { heightM: 1.88, build: 'athletic', handedness: 'right' },
    appearance: { hair: 'short', sleeves: 'sleeved', accent: 0xffffff },
    mental: 4,
  },
  agachi: {
    id: 'agachi',
    name: 'アンドレ・アガチ',
    archetype: 'リターナー / アグレッシブ・ベースライナー',
    blurb: '速球を差し込まれず叩き返すリターンとフラット強打。ネット・タッチが苦手。',
    ratings: { serve: 3, power: 5, spin: 3, speed: 3, stamina: 4, finesse: 2 },
    physique: { heightM: 1.8, build: 'athletic', handedness: 'right' },
    appearance: { hair: 'bald', sleeves: 'sleeved', accent: 0xff8a3d },
    mental: 3,
  },
  jokovin: {
    id: 'jokovin',
    name: 'ノヴァ・ジョコヴィン',
    archetype: 'カウンターパンチャー / オールラウンダー',
    blurb: '最高の安定と粘り、終盤も落ちないスタミナ。一撃の決定力に欠ける。',
    ratings: { serve: 2, power: 3, spin: 5, speed: 4, stamina: 5, finesse: 3 },
    physique: { heightM: 1.88, build: 'slim', handedness: 'right' },
    appearance: { hair: 'headband', sleeves: 'sleeved', accent: 0xc6ff3d },
    mental: 5,
  },
  nishigoori: {
    id: 'nishigoori',
    name: 'ケイ・ニシゴオリ',
    archetype: 'スピードスター / オールコート・テクニシャン',
    blurb: '圧倒的な機動力と多彩なタッチ。スタミナが低く長期戦・高い打点に弱い。',
    ratings: { serve: 2, power: 3, spin: 3, speed: 5, stamina: 2, finesse: 5 },
    physique: { heightM: 1.78, build: 'slim', handedness: 'right' },
    appearance: { hair: 'short', sleeves: 'sleeved', accent: 0xffd23d },
    mental: 2,
  },
  nadau: {
    id: 'nadau',
    name: 'ラファ・ナダウ',
    archetype: 'ヘビートップスピン / グラインダー',
    blurb: '重い順回転と無尽蔵のスタミナで削り倒す。タッチ・ネット・サーブは平凡。',
    ratings: { serve: 2, power: 4, spin: 5, speed: 3, stamina: 5, finesse: 2 },
    physique: { heightM: 1.85, build: 'stocky', handedness: 'left' },
    appearance: { hair: 'long', sleeves: 'sleeveless', accent: 0x33cc66 },
    mental: 5,
  },
  federun: {
    id: 'federun',
    name: 'ロジャー・フェデルン',
    archetype: 'オールラウンド / 攻撃的万能型',
    blurb: '良いサーブ・速い展開・多彩なタッチで主導権を握る。長い我慢比べで消耗。',
    ratings: { serve: 4, power: 4, spin: 2, speed: 4, stamina: 3, finesse: 4 },
    physique: { heightM: 1.85, build: 'athletic', handedness: 'right' },
    appearance: { hair: 'headband', sleeves: 'sleeved', accent: 0x222222 },
    mental: 4,
  },
}

/** ペルソナ選択の巡回順(UI のピッカー順) */
export const PERSONA_ORDER: PersonaId[] = [
  'sambrant',
  'agachi',
  'jokovin',
  'nishigoori',
  'nadau',
  'federun',
]

/**
 * 能力値(1..5)→ 倍率を導出する(docs/ARCHITECTURE.md §6.5)。
 * r=3 を平均(おおむね現状付近)、最強でも 1.1〜1.3 倍程度に抑える。
 */
export function personaModifiers(r: PersonaRatings, mental: number): PersonaModifiers {
  return {
    serveSpeedMul: 0.92 + 0.04 * r.serve,
    serveFaultMul: 1.3 - 0.12 * r.serve,
    shotSpeedMul: 0.9 + 0.045 * r.power,
    chargeGainMul: 0.8 + 0.1 * r.power,
    aimNoiseMul: 1.3 - 0.12 * r.spin,
    netMarginMul: 0.8 + 0.1 * r.spin,
    returnSolidMul: 1.3 - 0.12 * r.spin,
    moveSpeedMul: 0.88 + 0.06 * r.speed,
    reachMul: 0.92 + 0.035 * r.speed,
    // スタミナのペルソナ差は「ストック量(上限)のみ」。消費・回復・クールダウンは全員共通
    // (強打・スプリントのコストはペルソナ非依存)。これで旧モデルの「上限+消費+回復」三重取り
    // による満タン張り付きを解消する。s=3 中心で基本ストック 100(= 最大強打 10 回分)。
    staminaMaxMul: 0.7 + 0.1 * r.stamina, // s1→0.8(8発) / s3→1.0(10発) / s5→1.2(12発)
    touchNoiseMul: 1.3 - 0.12 * r.finesse,
    returnTouchMul: 1.2 - 0.1 * r.finesse,
    // 精神力(隠し mental 由来。IMPROVEMENTS §5.5)
    clutchRecoveryMul: 0.85 + 0.07 * mental, // m5→1.20 / m1→0.92
    pressureDrainMul: 1.3 - 0.1 * mental, // m5→0.80 / m1→1.20
    // ネットへ詰める傾向(AI 戦術スタンス。GAME_DESIGN §7.1)。
    // タッチ(finesse)・サーブ・スピードが高いほど前へ、スタミナ・スピンが高いほど後ろで粘る。
    // r=3 中心で 0.5 付近、最強級のネット型で ~0.9、純グラインダーで ~0。
    // 例: サンブラント≈0.90 / フェデルン≈0.86 / ニシゴオリ≈0.86 / アガチ≈0.28 / ジョコヴィン≈0.10 / ナダウ≈0.00
    netRushTendency: clamp01(
      0.5 + 0.12 * (r.finesse - 3) + 0.1 * (r.serve - 3) + 0.06 * (r.speed - 3)
        - 0.1 * (r.stamina - 3) - 0.08 * (r.spin - 3),
    ),
  }
}

/** 0..1 にクランプ(personaModifiers 内部用) */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** 中立倍率(全 1.0)。ペルソナ未指定(テスト・ダミー)時のフォールバック */
export const NEUTRAL_PERSONA_MODIFIERS: PersonaModifiers = {
  serveSpeedMul: 1, serveFaultMul: 1, shotSpeedMul: 1, chargeGainMul: 1,
  aimNoiseMul: 1, netMarginMul: 1, returnSolidMul: 1, moveSpeedMul: 1,
  reachMul: 1, staminaMaxMul: 1,
  touchNoiseMul: 1, returnTouchMul: 1, clutchRecoveryMul: 1, pressureDrainMul: 1,
  // 中立は控えめなベースライナー寄り(主に静止しているのは着地点付近)
  netRushTendency: 0.3,
}

// ---------------------------------------------------------------------------
// デバッグ調整メニュー用のチューナブル(docs/ARCHITECTURE.md §17)
// 体感に影響するパラメータをスライダーで実行時調整する。set() はこのモジュール内で
// `let` を再代入するため、各モジュールの参照(毎フレーム読む箇所)に即反映される。
// ---------------------------------------------------------------------------
export interface Tunable {
  key: string
  label: string // スライダー名(短い)
  desc: string // ホバー時の説明
  min: number
  max: number
  step: number
  get(): number
  set(v: number): void
}

export const TUNABLES: Tunable[] = [
  {
    key: 'staminaCooldown', label: '回復停止時間', min: 0.5, max: 6, step: 0.1,
    desc: '強い行動(強打・スプリント)後に回復が止まる秒数。ラリー1往復より長いと連打で確実に減る。',
    get: () => STAMINA_COOLDOWN, set: (v) => { STAMINA_COOLDOWN = v },
  },
  {
    key: 'staminaRegen', label: '回復レート', min: 0, max: 20, step: 0.5,
    desc: 'クールダウン経過後の回復 /s。下げると一度バテると立て直しにくい。',
    get: () => STAMINA_REGEN, set: (v) => { STAMINA_REGEN = v },
  },
  {
    key: 'strongShotCostMax', label: '強打消費(最大)', min: 0, max: 30, step: 1,
    desc: '最大チャージ強打1発の消費。基本ストック100をこの値で割った回数だけ強打できる。',
    get: () => STRONG_SHOT_COST_MAX, set: (v) => { STRONG_SHOT_COST_MAX = v },
  },
  {
    key: 'chargeStrongThreshold', label: '強打しきい値', min: 0, max: 1, step: 0.05,
    desc: '正規化チャージがこの値以上で「強打」(消費&回復停止)。未満は無料の繋ぎ。',
    get: () => CHARGE_STRONG_THRESHOLD, set: (v) => { CHARGE_STRONG_THRESHOLD = v },
  },
  {
    key: 'staminaSprintDrain', label: 'スプリント消費', min: 0, max: 40, step: 1,
    desc: 'スプリント中の消費 /s(移動時間に比例)。上げると全力疾走が早く枯れる。',
    get: () => STAMINA_SPRINT_DRAIN, set: (v) => { STAMINA_SPRINT_DRAIN = v },
  },
  {
    key: 'staminaPointRecovery', label: 'ポイント間回復', min: 0, max: 100, step: 1,
    desc: '1ポイント終了ごとに回復する量。下げると長丁場で蓄積疲労が残る。',
    get: () => STAMINA_POINT_RECOVERY, set: (v) => { STAMINA_POINT_RECOVERY = v },
  },
  {
    key: 'chargePowerGain', label: 'チャージ威力', min: 0, max: 1, step: 0.02,
    desc: 'フルチャージ時のショット初速ゲイン。上げると溜め打ちの威力が増す。',
    get: () => CHARGE_POWER_GAIN, set: (v) => { CHARGE_POWER_GAIN = v },
  },
  {
    key: 'spinBounceVertical', label: 'トップ跳ね', min: 0, max: 0.02, step: 0.001,
    desc: 'トップスピンのバウンド後の跳ね上がり量。上げると重い球が高く跳ねて返しにくくなる。',
    get: () => SPIN_BOUNCE_VERTICAL, set: (v) => { SPIN_BOUNCE_VERTICAL = v },
  },
  {
    key: 'topspinChargeSpin', label: 'トップ回転(溜)', min: 0, max: 1.5, step: 0.05,
    desc: 'チャージ時のトップスピン回転ゲイン。上げると溜めるほど強く沈み・高く跳ねる。',
    get: () => TOPSPIN_CHARGE_SPIN_GAIN, set: (v) => { TOPSPIN_CHARGE_SPIN_GAIN = v },
  },
  {
    key: 'topspinChargeAngle', label: 'トップ角度(溜)', min: 0, max: 1.5, step: 0.05,
    desc: 'チャージ時のトップスピン横オフセット拡大。上げると溜めるほどサイドへ角度をつけられる。',
    get: () => TOPSPIN_CHARGE_ANGLE, set: (v) => { TOPSPIN_CHARGE_ANGLE = v },
  },
  {
    key: 'topspinChargeFlatten', label: 'トップ低弾道(溜)', min: 0, max: 0.8, step: 0.05,
    desc: 'チャージ時の弾道の低さ(apex 低減率)。上げるほど低く速い弾道になり山なりを防ぐ。',
    get: () => TOPSPIN_CHARGE_FLATTEN, set: (v) => { TOPSPIN_CHARGE_FLATTEN = v },
  },
  {
    key: 'topspinChargeNetlow', label: 'トップ低通過(溜)', min: 0, max: 0.95, step: 0.05,
    desc: 'チャージ時にネットを低く通過させる度合い(マージン削減)。上げると低い弾道を許可する。',
    get: () => TOPSPIN_CHARGE_NETLOW, set: (v) => { TOPSPIN_CHARGE_NETLOW = v },
  },
  {
    key: 'sliceChargeSpin', label: 'スライス回転(溜)', min: 0, max: 1.5, step: 0.05,
    desc: 'チャージ時のスライス逆回転ゲイン。上げると溜めるほど滑って低く失速する。',
    get: () => SLICE_CHARGE_SPIN_GAIN, set: (v) => { SLICE_CHARGE_SPIN_GAIN = v },
  },
  {
    key: 'sliceChargeDepth', label: 'スライス深さ(溜)', min: 0, max: 4, step: 0.25,
    desc: 'チャージ時にスライスをベースライン側へ伸ばす量(m)。上げると相手を深く貼り付ける。',
    get: () => SLICE_CHARGE_DEPTH, set: (v) => { SLICE_CHARGE_DEPTH = v },
  },
]

// ---------------------------------------------------------------------------
// コートサーフェス(docs/GAME_DESIGN.md §13 / IMPROVEMENTS §4中)
// バウンドの反発・水平摩擦・空気抵抗を係数でスケールし、球速とバウンド高を変える。
// clay = 遅い/高く跳ねる(グラインダー有利)、grass = 速い/低く滑る(サーバー有利)、
// hard = 中間(基準=全て1.0)。ball.ts が activeSurface を毎バウンド/積分で参照する。
// ---------------------------------------------------------------------------
export interface SurfaceParam {
  label: string
  /** バウンド反発 REST への倍率(高いほど高く跳ねる) */
  restMul: number
  /** バウンド水平摩擦 BOUNCE_FRICTION への倍率(高いほど食いついて減速=遅い) */
  frictionMul: number
  /** 空気抵抗 KD への倍率(高いほど失速=遅いコート) */
  dragMul: number
  /** コート面の色(描画用) */
  courtColor: number
  /** ライン色(描画用) */
  lineColor: number
}

export const SURFACE_PARAMS: Record<Surface, SurfaceParam> = {
  // クレー: 高く跳ね、食いついて減速、やや失速 → 遅く高い(グラインダー有利)
  clay: { label: 'クレー', restMul: 1.12, frictionMul: 1.3, dragMul: 1.12, courtColor: 0xb5532b, lineColor: 0xf0e8d8 },
  // グラス: 低く滑り、摩擦小で速い、失速少 → 速く低い(サーバー有利)
  grass: { label: 'グラス', restMul: 0.82, frictionMul: 0.65, dragMul: 0.92, courtColor: 0x3f7d3a, lineColor: 0xf2f2f2 },
  // ハード: 中間(基準)
  hard: { label: 'ハード', restMul: 1.0, frictionMul: 1.0, dragMul: 1.0, courtColor: 0x2f6db0, lineColor: 0xf2f2f2 },
}

export const SURFACE_ORDER: Surface[] = ['hard', 'clay', 'grass']

/**
 * 現在のサーフェス係数(マッチ開始時に setSurface で確定)。
 * ball.ts はこのオブジェクトのフィールドを毎フレーム参照する(ES module ライブバインディング)。
 */
export let activeSurface: SurfaceParam = SURFACE_PARAMS.hard

/** マッチ開始時にサーフェスを設定(ball.ts の物理スケールへ即反映) */
export function setSurface(s: Surface): void {
  activeSurface = SURFACE_PARAMS[s]
}

// ---------------------------------------------------------------------------
// ボレー(ネットプレー)— docs/GAME_DESIGN.md §4.7 / IMPROVEMENTS §4中
// 前寄り(forecourt)でバウンド前(ボレー)に捉えた flat/slice は、振り抜かない
// ブロック/パンチになる: 威力は控えめだが狙いは正確、チャージ効果は小さい。
// スマッシュ(高い打点)には該当しない。passing/lob の読み合いは既存の lob で成立。
// ---------------------------------------------------------------------------
/** ボレー成立の打点高さ上限(これ未満の前寄り無バウンド flat/slice をボレー扱い) */
export const VOLLEY_MAX_HEIGHT = 1.7
/** ボレーの初速上限(m/s)。振り抜かないため頭打ち */
export const VOLLEY_SPEED_CAP = 26
/** ボレーの狙い誤差倍率(ブロックは正確) */
export const VOLLEY_AIM_MUL = 0.6
/** ボレー時のチャージ威力寄与の倍率(溜めても効きにくい) */
export const VOLLEY_CHARGE_MUL = 0.4

// ---------------------------------------------------------------------------
// 打球音(SE)の合成パラメータ — docs/IMPROVEMENTS.md §7 / GAME_DESIGN.md §10
// 実打球音の音響特性(調査): 基音/ボディ 100〜1800Hz・倍音 1800〜2800Hz、衝撃は
// ごく短く鋭い。「深み=低域 / クリスプさ=高域 + 鋭いアタック」で "POCK!" になる。
// これを ① ピッチ降下するボディ(pock の芯)② 明るいクラック(アタック)
// ③ 1.8〜2.8kHz のシマー(クリスプさ)④ 弦面リング ⑤ 擦過ノイズ で再現する。
// `audio/sfx.ts` の playHit() がこの表を参照する。設計方針: 強打ほど明るく鋭く。
// ---------------------------------------------------------------------------

/** 1 ショット種の打球音を決めるパラメータ */
export interface HitSoundParams {
  /** ボディ(pock)の基音 = ピッチ降下の着地周波数(Hz)。打球の音程感の芯(§7.4) */
  bodyHz: number
  /** ピッチ降下の開始倍率(開始 = bodyHz × bodyStartMul)。大きいほど "トッ" と落ちる */
  bodyStartMul: number
  /** 弦面リング共鳴の Q(高いほど締まった澄んだ音。スイートスポット感) */
  q: number
  /** アタック(クラック)の量 0..1。"パッ" の抜け・クリスプ感の核 */
  transient: number
  /** 高倍音シマー(1.8〜2.8kHz 帯)の量 0..1。明るさ・抜けの良さ */
  shimmer: number
  /** 擦過/ブラシノイズ成分の量 0..1(スピンの擦り、スライスの切り) */
  noise: number
  /** ボディ/リングの減衰時間(秒)。30〜100ms 程度 */
  decay: number
  /** 基準音量 0..1(マスターゲイン前) */
  gain: number
  /** ノイズ/ピッチのスイープ方向: +1=上昇(スピンの擦り上げ), -1=下降(スライスの切り), 0=なし */
  sweep: number
}

/**
 * ショット種別ごとの打球音パラメータ(§7.4)。
 * フラット=最も鋭い「パッコーン」、トップスピン=擦って弾く、スライス=薄く滑る、
 * ロブ=柔らかい、ドロップ=触れるだけ。
 */
export const HIT_SOUND_PARAMS: Record<ShotType, HitSoundParams> = {
  flat:    { bodyHz: 920,  bodyStartMul: 2.6, q: 9,  transient: 1.0,  shimmer: 1.0,  noise: 0.25, decay: 0.07,  gain: 0.62, sweep: 0 },
  topspin: { bodyHz: 760,  bodyStartMul: 2.3, q: 8,  transient: 0.75, shimmer: 0.7,  noise: 0.5,  decay: 0.09,  gain: 0.52, sweep: 1 },
  slice:   { bodyHz: 1020, bodyStartMul: 2.1, q: 11, transient: 0.7,  shimmer: 0.9,  noise: 0.55, decay: 0.05,  gain: 0.46, sweep: -1 },
  lob:     { bodyHz: 560,  bodyStartMul: 1.8, q: 6,  transient: 0.4,  shimmer: 0.3,  noise: 0.2,  decay: 0.1,   gain: 0.42, sweep: 0 },
  drop:    { bodyHz: 680,  bodyStartMul: 1.8, q: 7,  transient: 0.4,  shimmer: 0.35, noise: 0.15, decay: 0.035, gain: 0.36, sweep: 0 },
}

/** intensity(球速/チャージ由来 0..1)でボディ周波数を持ち上げる割合。強打ほど明るく鋭く */
export const SFX_HIT_BODY_BRIGHTEN = 0.55
/** シマー帯の中心 = bodyHz × この倍率(1.8〜2.8kHz 付近に置く)。クリスプさの素 */
export const SFX_HIT_SHIMMER_MUL = 2.7
/** クラック(アタック)のハイパス基準カットオフ(Hz)。intensity でさらに上げる */
export const SFX_HIT_CLICK_HZ = 2200
/** ラウンドロビンの微ピッチ揺らぎ幅(±割合)。反復感(マシンガン感)を消す(§7.5) */
export const SFX_HIT_PITCH_JITTER = 0.06
/** サーブはフラットを増強: 音量・余韻の倍率(§7.4 サーブ行) */
export const SFX_SERVE_GAIN_MUL = 1.3
export const SFX_SERVE_DECAY_MUL = 1.4
/** ジャストミート: 共鳴の澄み(Q 倍率)とベル倍音の音量(§7.5) */
export const SFX_JUST_Q_MUL = 1.6
export const SFX_JUST_BELL_GAIN = 0.16
/** 差し込まれ/シャンク: ボディの明るさを鈍く・ノイズ多めにする倍率(詰まった "コツッ", §7.5) */
export const SFX_MISHIT_Q_MUL = 0.4
export const SFX_MISHIT_NOISE_MUL = 1.8
/** 残響(手続き生成 IR + ConvolverNode): ウェット量と IR 長さ(秒)(§7.5) */
export const SFX_REVERB_WET = 0.08
export const SFX_REVERB_SECONDS = 0.2

// ---------------------------------------------------------------------------
// 打球音サンプル(効果音ラボ「テニスラケットで打つ」)の再生パラメータ。
// 実録音の打球音を組み込み、playbackRate(音程)・音量・パン・フィルタで
// ショット種別を描き分ける(規約上、改変利用は可)。サンプル未ロード時は合成にフォールバック。
// 出典・利用条件は src/audio/samples/CREDITS.md を参照。
// ---------------------------------------------------------------------------
/** ショット種別ごとのサンプル再生レート(1.0=原音。高いほど高く鋭い音程) */
export const HIT_SAMPLE_RATE: Record<ShotType, number> = {
  flat: 1.0,
  topspin: 0.96,
  slice: 1.08,
  lob: 0.85,
  drop: 0.92,
}
/** サーブの再生レート(やや低く=重く速い一撃) */
export const HIT_SAMPLE_SERVE_RATE = 0.9
/** 差し込まれ(mishit)時の再生レート低下とローパス(鈍く詰まった「コツッ」) */
export const HIT_SAMPLE_MISHIT_RATE = 0.78
export const HIT_SAMPLE_MISHIT_LPF = 1700
/** サンプル全体の基準音量(マスター前)。intensity を別途乗算する */
export const HIT_SAMPLE_GAIN = 0.95
/** intensity による再生レートの微増(強打ほどわずかに高く鋭く)。基準 0.6 からの偏差に乗算 */
export const HIT_SAMPLE_BRIGHTEN = 0.12
