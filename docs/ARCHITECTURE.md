# ARCHITECTURE — 3D Tennis 詳細設計書

実装はこの文書と `src/types.ts` / `src/constants.ts` を契約とする。
各モジュールは **`three`・`src/types.ts`・`src/constants.ts` 以外を import しない**。
モジュール間連携は `types.ts` のインターフェースによる依存性注入で行い、
`src/main.ts` のみが全モジュールを import して結線する。

## 1. 技術スタック

- TypeScript (strict) / Vite / Three.js(npm の `three`)
- テスト: Vitest(DOM 不要な physics / scoring / rally が対象)
- 外部アセットなし。ジオメトリはプリミティブ、テクスチャは CanvasTexture、音は WebAudio 合成。

## 2. 座標系・単位

- 右手系。**y が上**。単位はメートル・秒・ラジアン。
- **ネットが z = 0**。プレイヤー側コートは z > 0、AI(相手)側は z < 0。
- x はサイドライン方向。コート中央が x = 0。
- コート(シングルス): 全長 23.77m(z ∈ [−11.885, +11.885])、
  幅 8.23m(x ∈ [−4.115, +4.115])。
  サービスライン: ネットから 6.40m(z = ±6.40)。センターラインで左右2分割。
- ネット高さ: 0.914m(全幅均一に簡略化)。
- `Side` 型: `'player'`(z>0)| `'opponent'`(z<0)。

## 3. ディレクトリ構成と所有

| パス | 内容 | 担当エージェント |
|---|---|---|
| `src/types.ts` `src/constants.ts` | 共有契約 | 統括(凍結済み・変更禁止) |
| `src/physics/ball.ts` | ボール積分・バウンス・着地予測・ショットソルバ | physics |
| `src/gameplay/shot.ts` | ショット種パラメータ・目標決定・品質適用 | physics |
| `src/core/scoring.ts` `src/core/rally.ts` | スコアリング・ラリー判定 | rules |
| `src/gameplay/input.ts` `src/gameplay/player.ts` | 入力・プレイヤー制御 | player |
| `src/gameplay/ai.ts` | AI 制御 | ai |
| `src/render/*.ts` | Three.js シーン・コート・エンティティ・カメラ・エフェクト | render |
| `src/ui/*.ts` `src/ui/styles.css` | HUD・メニュー(DOM) | ui |
| `src/audio/sfx.ts` | 効果音合成 | audio |
| `src/main.ts` | 結線・ゲームループ | 統括 |
| `tests/*.test.ts` | 単体テスト | 各担当 |

## 4. 共有型

完全な定義は `src/types.ts` を参照(凍結済み)。中核のみ抜粋:

```ts
type Side = 'player' | 'opponent'
type ShotType = 'flat' | 'topspin' | 'slice' | 'lob' | 'drop'

interface BallState {
  pos: Vector3; vel: Vector3
  spin: Vector3            // 角速度 rad/s。+x 軸回り正 = トップスピン(z− 方向への打球時)
  bounceCount: number      // 最後の打球以降のバウンド数
  lastHitBy: Side | null
  inPlay: boolean
}

type BallEvent =
  | { kind: 'bounce'; pos: Vector3 }   // 地面バウンド(位置はコート平面上)
  | { kind: 'net' }                     // ネットに衝突した(跳ね返った)
  | { kind: 'hit'; by: Side; shot: ShotType }
```

## 5. 物理仕様(`src/physics/ball.ts`)

### 5.1 積分

固定タイムステップ `PHYS_DT = 1/120`。セミインプリシット・オイラー:

```
a = GRAVITY(0,−9.81,0) − KD·|v|·v + KM·(ω × v)
v ← v + a·dt ;  p ← p + v·dt
```

- `KD = 0.020`(空気抵抗、2次)
- `KM = 4.0e-4`(マグナス係数)
- スピン減衰: `ω ← ω · exp(−SPIN_DECAY·dt)`、`SPIN_DECAY = 0.10`

### 5.2 バウンス(y ≤ BALL_RADIUS かつ vy < 0 で発生)

```
vy ← −REST · vy                       (REST = 0.75)
v_xz ← v_xz · (1 − FRICTION)          (FRICTION = 0.18)
v_xz ← v_xz + SPIN_BOUNCE · (ω × ŷ)成分の水平射影
       (トップスピン → 前へ加速して低く速く、バックスピン → 失速して止まる)
ω ← ω · 0.6
```

簡略式: 進行方向単位ベクトル d に対し `v_xz += d · (ωx成分 · SPIN_BOUNCE)`、
`SPIN_BOUNCE = 0.0045`。スピンの符号は §5.4 の規約に従う。

**トップスピンの垂直キック(バウンド後の高い跳ね)**:

バウンド時、進行方向水平単位ベクトル `dir_xz` に対するスピン射影 `proj = dot(ω, dir_xz)` が
正(トップスピン)のとき、垂直速度に上乗せする:

```
proj = dot(ω, dir_xz)
if proj > 0:
    vel.y += proj · SPIN_BOUNCE_VERTICAL   // SPIN_BOUNCE_VERTICAL = 0.004
```

トップスピン球が着地後に高く跳ねる「kick」効果を生む(実テニスのクレーコートの跳ね)。
スライス(proj < 0)には適用しない。チャージが大きいほど回転が強くなり(§6 手順2b)、
このキックも強くなる。

### 5.3 ネット衝突

ボールが z=0 平面を横切るフレームで、横断点の y < NET_HEIGHT かつ
|x| < NET_HALF_WIDTH(5.0m)なら衝突:
`vz ← −0.12·vz`、`v_x,v_y ← 0.25倍`、`net` イベントを発火(ボールは手前に落ちる)。

### 5.4 スピン符号の規約

打球方向(±z)に依存しない扱いにするため、ソルバは「打球の水平進行方向 d」
に対して `ω = spinScalar · (ŷ × d)` を設定する。spinScalar > 0 がトップスピン。
これにより §5.1 のマグナス項 `a += KM·(ω×v)` が「トップスピン=沈む」
「スライス=浮く」を生む(`d × ŷ` だと符号が逆になり浮いてしまうことに注意)。

### 5.5 公開 API

```ts
class BallSim {
  state: BallState
  step(dt: number): BallEvent[]                    // PHYS_DT 単位で呼ぶ
  launch(pos, vel, spin, hitBy: Side): void        // 打球(bounceCount リセット)
  predictLanding(maxTime?: number): LandingPrediction | null
       // 現在状態のコピーを前方シミュレーションし、次の地面バウンド位置と時刻を返す
       // ネット衝突した場合は null
}
```

`predictLanding` は状態コピーに対する同じ積分の反復で実装(解析解は使わない)。

## 6. ショットソルバ(`src/gameplay/shot.ts`)

**入力**: `ShotRequest { type, hitPos, target, quality, hitter, powerScale? }`
**出力**: `ShotSolution { vel: Vector3, spin: Vector3 }`

手順:
1. ショット種パラメータ表(下表)から基準速度 `speed`・射出仰角 `loft`・
   `spinScalar` を得る。
2. 品質適用: `target` に半径 `(1−q)·AIM_NOISE_R` の一様円ノイズ(+フラットは
   y 方向の高さノイズ → ネットリスク)、`speed ×= (0.75 + 0.25q)`。
2b. チャージ適用(GAME_DESIGN §4.4): `c = req.charge` として
   `speed ×= CHARGE_POWER_MIN + CHARGE_POWER_GAIN·min(c,1)`。
   c > 1 のとき狙い誤差半径に `(c−1)·OVERCHARGE_NOISE` を加算し、
   `netMargin ×= 1 − OVERCHARGE_NET_SHRINK·(c−1)/(CHARGE_MAX−1)`。
2c. トップスピン/スライスのチャージ強化(GAME_DESIGN §4.4.2):
   `cc = min(c, 1)` として、トップスピン/スライスの特性をさらに変化させる。
   フラット・ロブ・ドロップは変化なし。

   **spinScalar のチャージスケール**:
   - トップスピン: `spinScalar = 260 × (1 + TOPSPIN_CHARGE_SPIN_GAIN·cc)`
     (`TOPSPIN_CHARGE_SPIN_GAIN` = 0.6)
   - スライス:     `spinScalar = −180 × (1 + SLICE_CHARGE_SPIN_GAIN·cc)`
     (`SLICE_CHARGE_SPIN_GAIN` = 0.6)

   **トップスピンの着地目標・弾道調整**:
   ```
   xLimit   = COURT_HALF_WIDTH − TARGET_CLAMP_MARGIN
   targetX *= (1 + TOPSPIN_CHARGE_ANGLE·cc)         // 横角度拡大 (TOPSPIN_CHARGE_ANGLE=0.7)
   targetX  = clamp(targetX, −xLimit, xLimit)

   // 好条件ゲート付き「短角アタック」: 打点高・差し込まれなし・横振りのときだけ着地を手前へ引く
   heightCond = clamp01((hitPos.y − TOPSPIN_ATTACK_H_LOW) / (TOPSPIN_ATTACK_H_GOOD − TOPSPIN_ATTACK_H_LOW))
                // TOPSPIN_ATTACK_H_LOW=0.7, TOPSPIN_ATTACK_H_GOOD=1.2
   paceOk     = clamp01(1 − max(0, vIn − RETURN_PACE_THRESH) / RETURN_OVERWHELM_RANGE)
   angleFrac  = min(1, |targetX| / xLimit)
   pull       = TOPSPIN_ATTACK_SHORTEN(5.5m) · cc · heightCond · paceOk · angleFrac
   targetZ   += pull · sign(targetZ)              // ネット側(中央方向)へ引く
   targetZ    = clamp(targetZ, sign·TOPSPIN_ATTACK_MIN_DEPTH(4.0m), …)  // ネット手前寄りすぎ防止

   // pull ≥ TOPSPIN_DRIVE_MIN_PULL(1.0m): 速度優先ドライブソルバへ切替え(低く速い弾道)
   if pull >= TOPSPIN_DRIVE_MIN_PULL:
     speed     = param.speed · powerScale · chargePower · … · TOPSPIN_DRIVE_SPEED_MUL(0.82)
     netMargin ×= (1 − TOPSPIN_CHARGE_NETLOW·cc)  // ネット通過を低く (TOPSPIN_CHARGE_NETLOW=0.7)
     → solveDrive(hitPos, target, speed, spinScalar, netMargin, …)
   else:
     // 深い/守りのトップスピン: 収束ソルバで安定ラリー軌道
     apex ×= (1 − TOPSPIN_CHARGE_FLATTEN·cc)      // 山なりを僅かに抑える (TOPSPIN_CHARGE_FLATTEN=0.5)
     → solveToTarget(hitPos, target, speed, apex, spinScalar, netMargin, …)
   ```
   短角アタック成立(高打点・余裕あり・横振り) → 低く速いドライブ弾道でサービスライン付近に鋭く落とす。
   条件が揃わない場合(低打点・差し込まれ・正面) → pull≈0 で深い既定目標のまま安定した収束ラリー軌道。
   深さ(z)の基準はいずれも W/S キーで制御し、pull による引き込みがその上に乗る。

   **スライスの着地目標調整**:
   ```
   targetZ -= SLICE_CHARGE_DEPTH · cc · sign(d)     // ベースライン側へ伸ばす
   // SLICE_CHARGE_DEPTH=2.0m; COURT_HALF_LENGTH − TARGET_CLAMP_MARGIN でクランプ
   ```
   相手をベースラインに貼り付けて牽制。AI もソルバを共有するため `req.charge` を渡せば自動適用。

3. 初期解: 無抵抗の放物線で hitPos → target を時間 T で結ぶ初速を解析的に算出
   (T は水平距離 / 水平速度から)。
4. **シミュレート補正**: その初速で `BallSim` と同一の積分を前方実行して着地点
   を求め、誤差ベクトルの水平成分を初速にフィードバック(ゲイン 0.7)して
   最大 4 回反復。ドラッグ・マグナス込みでも目標±0.2m に収束する。
5. ネット越え検証: 軌道が z=0 でネット高+マージンを下回る場合は loft を増やして
   再solve(最大2回)。フラットのみマージンを小さくしてリスクを残す。

| type | speed (m/s) | loft | spinScalar (rad/s) | 基準ターゲット深さ |
|---|---|---|---|---|
| flat | 30 | 低(自動solve) | 0 | 相手コート深め(ベースライン−1.8m) |
| topspin | 24 | 中 | +260 | 深め |
| slice | 18 | 低 | −180 | 中間 |
| lob | 16 | 高(頂点 ~7m) | +60 | ベースライン−1.2m |
| drop | 10 | 中 | −120 | ネット+1.8m |

サーブ用に `solveServe(hitPos, target, power)` も提供
(打点 y=2.6m の上打ち。power∈[0,1] → 速度 28〜46 m/s、§GAME_DESIGN 5 の誤差則)。

### 6.1 接触コンテキスト修飾(GAME_DESIGN §4.5 の実装)

`solveShot` は手順2の品質・チャージ適用の後、手順3の solve に渡す前に、
打点の高さ・コート位置・相手球速に基づく修飾を適用する。これがゲームの
戦略性の核。**修飾後の(誤差・バイアス込みの)目標へ収束させる**ことで、
不利な状況では実際にアウト/ネット/精度低下が起きる(従来は常に目標へ
完全収束していたため位置・高さが結果に影響しなかった)。

入力: `h = hitPos.y`、`depth = |hitPos.z|`、`vIn = req.incomingSpeed`、
`q`(品質)、`c`(charge)、`type`。

```
lev   = clamp((h − CONTACT_PIVOT_HEIGHT)/CONTACT_PIVOT_HEIGHT, −1, +1)
low   = max(0, −lev)            // 低い打点の度合い
high  = max(0, +lev)            // 高い打点の度合い
fore  = clamp((SERVICE_LINE_Z − depth)/SERVICE_LINE_Z, 0, 1)   // 前寄り度
chargePower = CHARGE_POWER_MIN + CHARGE_POWER_GAIN·min(c,1)     // 既存
powerExcess = max(0, chargePower−1) + 0.5·max(0, q−0.6)         // パワーの乗り具合
```

**(A) スマッシュ分岐**(`type==='flat' && h ≥ SMASH_MIN_HEIGHT && depth ≤ SMASH_MAX_DEPTH`):
通常パイプラインを置き換える。
```
speed   = SMASH_SPEED · (SMASH_QUALITY_FLOOR + (1−SMASH_QUALITY_FLOOR)·q) · (1 + SMASH_CHARGE_GAIN·min(c,1))
apex    = param.apex · 0.45            // 上から叩き下ろす(低い弾道)
netMargin = SMASH_NET_MARGIN
狙いノイズ半径 = (基本ノイズ)·SMASH_AIM_NOISE_MUL + chargeNoiseR
depthBias = 0
```
打点が高く前寄りなので低い弾道でも容易にネットを越える。solveToTarget に渡す。

**(B) 通常**(スマッシュでない場合)、基準値に以下を合成:
```
speedMul = 1 + HIGH_CONTACT_SPEED_GAIN·high            （flat/topspin のみ。他は1）
speedAdd = paceRedirect(type)·vIn
           paceRedirect: flat/slice=PACE_REDIRECT_FLAT, topspin=PACE_REDIRECT_SPIN, lob/drop=0
spinMul  = (type==='topspin') ? 1 + HIGH_CONTACT_SPIN_GAIN·high : 1

depthBias(m, 打点→目標の水平方向に「より深く」加算 → アウト方向):
  + LOW_POWER_OVERSHOOT · low · powerExcess · (1 + FORECOURT_LOW_AMP·fore − fore)   ※前寄りで増幅
  + FORECOURT_FLAT_OVERSHOOT · fore · (1−high) · (flat?1 : slice?0.5 : 0)

aimNoiseAdd(m, ランダム誤差半径に加算):
  + LOW_CONTACT_SPRAY · low · powerExcess · (1 + FORECOURT_LOW_AMP·fore − fore)
  + PACE_CONTROL_K · max(0, vIn − PACE_CONTROL_THRESH) · (1.2 − q)
  + (type∈{drop,lob}) ? PACE_TOUCH_PENALTY · max(0, vIn − PACE_CONTROL_THRESH) : 0

netMarginMul:
  flat:            × (1 − LOW_CONTACT_NET_RISK·low)      // 低打点フラットはネット掛かりやすい
  topspin/slice:   × (1 + 0.5·low)                        // 低打点は持ち上げる(安全側にロフト)
  その他:          × 1
```
合成後:
```
speed    = param.speed · powerScale · chargePower · speedMul + speedAdd
spinScalar = param.spinScalar · spinMul
netMargin  = param.netMargin · netMarginScale(overcharge) · netMarginMul
目標 = req.target を「打点→目標の水平方向」に depthBias だけ深くずらす
ノイズ半径 = (1−q)·AIM_NOISE_R + chargeNoiseR + aimNoiseAdd     （従来 + 文脈分）
```
注意: `(1 + FORECOURT_LOW_AMP·fore − fore)` は fore=0 で 1、fore=1 で
FORECOURT_LOW_AMP となる「前寄りでの増幅」係数。

**較正の指針**: 中くらいの打点(h≈0.8〜1.1)・ベースライン・中庸な球威
(vIn≈15〜20)・無チャージのトップスピンは従来とほぼ同じ精度を保つこと
(low≈0, fore≈0, powerExcess小 のため修飾がほぼ無効)。極端な状況だけが
大きく変わるように。テストで両端を検証する(§16)。

コントローラ側(player/ai)は `ShotRequest.incomingSpeed = |ball.vel|` を設定し、
高い打点のトップスピン時は横の狙いオフセットを最大
`AIM_OFFSET_X·(1 + HIGH_TOPSPIN_ANGLE_BONUS·high)` まで拡大する。

### 6.2 速球の返球(差し込まれ / mishit)— GAME_DESIGN §4.6

`solveShot` は接触コンテキスト合成の後、`incomingSpeed` が速い場合の
「差し込まれ」を計算する。スマッシュ等の強打を不用意に返すと山なりの弱い
返球(チャンスボール)になる仕組み。スマッシュ分岐(§6.1 A)には適用しない
(スマッシュは自分が叩く側)。

```
paceExcess = max(0, vIn − RETURN_PACE_THRESH)
typeWeak   = { slice: RETURN_WEAKNESS_SLICE, flat: RETURN_WEAKNESS_FLAT,
               topspin: RETURN_WEAKNESS_TOPSPIN, lob/drop: RETURN_WEAKNESS_TOUCH }[type]
chargeMit  = 1 − RETURN_CHARGE_MITIGATION · min(c, 1)
posMit     = clamp(1.3 − q, 0.35, 1.0)
mishit = clamp( (paceExcess / RETURN_OVERWHELM_RANGE) · typeWeak · chargeMit · posMit, 0, 1 )
```

`mishit > MISHIT_ACTIVE_EPS` のとき、その打球は「山なりの弱い返球」へ差し替える
(clean な打球パラメータと弱返球を mishit で線形補間):
```
floatSpeed = lerp(cleanSpeed, WEAK_RETURN_SPEED, mishit)
floatApex  = lerp(param.apex,  RETURN_FLOAT_APEX,  mishit)
目標を「打点→目標の水平方向」に RETURN_MISHIT_SHORT·mishit だけ手前へ引く(浅いsitter)
狙いノイズ半径 += RETURN_MISHIT_SPRAY · mishit
spinScalar *= (1 − 0.7·mishit)          // 回転を失う(floaty)
netMargin は安全側(山なりなので越えやすい)
→ solveToTarget(hitPos, target, floatSpeed, floatApex, spinScalar, netMargin, hitter, type)
  (flat も mishit 時はドライブではなくこの収束経路で山なりに返る)
```
mishit ≤ EPS のときは §6.1 の通常経路(flat→solveDrive、他→solveToTarget)。

較正: 通常ラリー(vIn ≤ 25)は paceExcess=0 で mishit=0 → 影響なし。
スマッシュ(vIn 40〜60)を不用意な topspin で返すと mishit 大 → 弱い山なり。
チャージ済みスライスなら mishit 小 → deep にブロック返球できる。

### 6.4 サーブの種類(solveServe)— GAME_DESIGN §5.1

`solveServe(hitPos, target, power, hitter, serveType)` は `SERVE_TYPE_PARAMS`
を用いる:
- `speed = (power→速度) · param.speedMul`
- スピン = 順回転 `spinVector(horizDir, param.topSpin)` + サイドスピン
  `param.sideSpin · ŷ`(縦軸回り → 横へ曲がる Magnus)。スライスは topSpin<0 で
  低く滑り、キックは topSpin 大で高く弾む(バウンド物理 §5.2 が自然に再現)。
- `faultNoiseMul` でスイートゾーン外の誤差(フォルト率)を増減(キック=安全)。
- `netMarginMul` で要求ネット越え高を増減(キックは高く安全に越える)。

重要: サイドスピンで横に曲がるため、**仰角だけでなく水平方向の狙いも
シミュレーション補正**して、曲がりを見込んでサービスボックスに収める
(従来の仰角掃引に加え、着地の水平誤差をフィードバックする)。
さもないとスライス/キックが常にボックスを外す。

### 6.5 ペルソナ倍率の適用(GAME_DESIGN §12 / IMPROVEMENTS §3.4)

ペルソナ能力値(1..5)は `constants.ts` の `personaModifiers(ratings)` で
`PersonaModifiers`(倍率の束)に変換され、**既存定数に掛けるだけ**で個性を表現する。
依存ルールを保つため、倍率は各モジュールへ「注入」される:
- `solveShot` は `req.mods`(無ければ `NEUTRAL_PERSONA_MODIFIERS`)を読む。
- `solveServe` は引数 `mods?` を読む。
- `PlayerController` / `AIController` はコンストラクタで `mods` と `physique` を受け取る。
- `main.ts` が選択ペルソナから倍率を算出して結線する。

**ソルバ(shot.ts)での適用点**(`m = req.mods ?? NEUTRAL`):
```
ground stroke 初速  : speed *= m.shotSpeedMul              (スマッシュ speed にも適用)
チャージ威力        : chargePower = CHARGE_POWER_MIN + CHARGE_POWER_GAIN*m.chargeGainMul*min(c,1)
狙いノイズ(一般)   : flat/topspin の noiseR *= m.aimNoiseMul
狙いノイズ(タッチ) : slice/drop/lob の noiseR *= m.touchNoiseMul
ネット越えマージン  : netMargin *= m.netMarginMul
差し込まれ(§6.2)  : mishit *= m.returnSolidMul、pace 由来の aimNoiseAdd *= m.returnTouchMul
```
**サーブ(solveServe)**: `speed *= m.serveSpeedMul`、スイートゾーン外の `aimNoise *= m.serveFaultMul`。

**コントローラ(player.ts / ai.ts)での適用点**:
```
最高速        : (WALK/SPRINT)_SPEED *= m.moveSpeedMul
リーチ        : effReach = REACH * m.reachMul(打球可否ゲートと距離品質係数の両方で使う)
スタミナ上限  : effStock = STAMINA_MAX * m.staminaMaxMul(clamp/全回復/ポイント回復で使う)
利き手        : physique.handedness==='left' なら swingSide(fore/back)判定を左右反転
戦術スタンス  : ai.ts のみ。m.netRushTendency(0..1、倍率でなく傾向値)が前へ出やすさ(必要チャンス量)を決める(§11)

スタミナ消費・回復モデル — 「強い行動のクールダウン制」(GAME_DESIGN §6):
  effStock = STAMINA_MAX · m.staminaMaxMul
  cooldownRemaining: 最後の強い行動からの経過を追うカウンタ(秒)

  毎フレーム(dt):
    cooldownRemaining = max(0, cooldownRemaining − dt)
    if cooldownRemaining == 0:
      stamina = min(effStock, stamina + STAMINA_REGEN · dt)   // 回復はクールダウン経過後のみ

  強い行動が発生したとき(1回のみ):
    強打(チャージショット, isStrongCharge(charge) == true):
      stamina −= chargeShotCost(charge)                       // ペルソナ差なし
      cooldownRemaining = STAMINA_COOLDOWN
    スプリント中の毎フレーム:
      stamina −= STAMINA_SPRINT_DRAIN · dt                    // ペルソナ差なし
      cooldownRemaining = STAMINA_COOLDOWN                     // スプリント中は常にリフレッシュ
    サーブ(power > 0):
      stamina −= SERVE_STAMINA_MAX · power                    // ペルソナ差なし
      cooldownRemaining = STAMINA_COOLDOWN

  歩行移動・繋ぎ・弱打(isStrongCharge==false)・セーフティ打球: 消費なし、回復継続。

  ポイント間回復: stamina += STAMINA_POINT_RECOVERY · m.clutchRecoveryMul, 上限 effStock。
  ポイント間にクールダウンとスプリントロックは解除。
  view.staminaPct = stamina / effStock を毎フレーム公開(ゲージ・発汗用)。

スタミナ切れペナルティ — 能力ゲート(品質低下は廃止):
  canCharge:  stamina >= effStock · CHARGE_ENABLE_PCT でのみチャージ開始可
              (未満=強打不可、通常打のみ。閾値は最大強打1発分を上回り「打ち切れる」を保証)
  canSprint:  ヒステリシス
              stamina <= effStock · SPRINT_STOP_PCT    → sprintLocked = true(強制停止)
              stamina >  effStock · SPRINT_RESUME_PCT  → sprintLocked = false(再開許可)
              スプリント中は毎フレーム cooldown をリフレッシュし続ける
```
各 ShotRequest には自分の `mods` を添付してソルバへ渡す。

較正方針: r=3 でほぼ現状、最強でも 1.1〜1.3 倍程度。難易度(AIProfile)との二重
スケールで過剰にならないよう、ペルソナ同士の勝率が拮抗することを scripts/ で確認する。

## 7. マッチフロー状態機械(`src/main.ts` が駆動)

```
menu → serve → rally → pointOver → (serve | gameOver → serve | matchOver → menu)
```

- `serve`: サーバーを定位置へ。プレイヤーサーブ時はメーター操作待ち。
  AI サーブ時は 0.8〜1.2 秒後に自動サーブ(難易度に応じた power 選択)。
  なお `serveFromRight` は実装上「世界座標で +x 側」を指す統一規約とする
  (AI 側の左右が実テニスと鏡映になるが、対角サーブの幾何は保たれる)。
- `rally`: 物理・両コントローラ・ラリー判定を更新。
- `pointOver`: 判定理由をバナー表示、BANNER_SEC(1.8秒)後にスコア反映済みの
  次状態へ。
- フォルト時は `serve` に戻る(`faultCount` 管理。2回目で失点)。

## 8. ラリー判定(`src/core/rally.ts`)

`RallyJudge` は BallEvent ストリームとボール状態から決着を判定する:

```ts
class RallyJudge {
  reset(server: Side, serveTargetBox: ServiceBox): void
  onEvent(e: BallEvent, ball: BallState): RallyVerdict | null
  update(ball: BallState): RallyVerdict | null   // 毎フレーム(場外飛出し検出)
}
type RallyVerdict = { winner: Side; reason: 'winner'|'out'|'net'|'doubleBounce'|'fault'|'doubleFault' }
```

判定規則(`lastHitBy = H`、相手 = R):
1. `bounce` 1回目が H 自陣側(z が H 側)→ H の失点(ネットを越えていない)。
2. `bounce` 1回目が R 側コート外 → `out`、H の失点。コート内 → 継続。
3. `bounce` 2回目(どこであれ)→ R の失点(`doubleBounce`)。
4. `net` イベント → 即決着にはしない(落下後の規則1で決まる)。
5. ボールが場外境界(|x|>9 or |z|>16)に出た/静止した → 1バウンド済みでなければ `out` で H の失点。
6. **サーブ専用**: 1バウンド目が指定サービスボックス外 → `fault`(失点ではなく
   verdict として返し、main がフォルト処理)。ボックス内なら通常ラリーに移行。

イン/アウトはボール中心 x,z がライン外縁 + BALL_RADIUS 以内ならイン。

## 9. スコアリング(`src/core/scoring.ts`)

```ts
class MatchScore {
  constructor(gamesToWin: 1|2|4)
  addPoint(side: Side): void
  readonly view: ScoreView   // { points:['40','Ad'…], games:[n,n], server, gameJustWon, matchWinner }
}
```

15/30/40/デュース/アドバンテージ、ゲーム取得で games 加算・サーブ権交代。
`gamesToWin` 先取でマッチ終了。`tests/scoring.test.ts` でデュース往復・マッチ決着を網羅。

## 10. プレイヤー制御(`src/gameplay/player.ts` + `input.ts`)

- `InputManager`: keydown/keyup を購読し `InputState`(types.ts)スナップショットを返す。
  ショットキーは「押した瞬間」をエッジ検出でキューイング(1フレーム1発)。
- `PlayerController.update(dt, ctx: ControlContext)`:
  - 移動: 加速度モデル(加速 40 m/s²、最高速 WALK 5.5 / SPRINT 8.0 m/s)。
    可動域: 自陣側 z ∈ [0.4, 15.5]、x ∈ [−6.5, 6.5](コート外まで追える)。
  - スタミナ: GAME_DESIGN §6 の則。
  - スイング(チャージ方式、GAME_DESIGN §3, §4.4):
    - ショットキー押下で**チャージ開始**(`charging=true`)。チャージ量は
      `CHARGE_TIME` 秒で 1.0、以後 `CHARGE_MAX` まで増加。チャージ中は
      移動速度 ×`CHARGE_MOVE_FACTOR`。
    - 保持中にボールが打球条件(水平距離 ≤ REACH、ボール高 ≤ REACH_HEIGHT、
      `lastHitBy ≠ self`、inPlay)を満たした瞬間に**自動で打球**。
      品質 q(§4.2)と狙い(§4.3)を決め、`charge` を添えて
      `ctx.requestShot(ShotRequest)`。最初に押したキーのショット種を使う。
    - ボールが既にリーチ内のときに押せば即打(charge ≈ 0)。
    - 打たずに離した場合は `CHARGE_RELEASE_COOLDOWN` 秒チャージ不可。
    - **スイングロック**: 打球の瞬間から `SWING_LOCK_TIME` 秒は移動速度
      ×`SWING_LOCK_MOVE_FACTOR`(インパクト中に走り抜けない)。
    - `swingSide` を設定: 打点がプレイヤーの利き手側(player は世界 +x)なら
      'fore'、逆側なら 'back'(描画用)。
  - サーブ: `ctx.phase === 'serve'` のとき、メーター開始前は自陣サーブサイド
    範囲内で移動可能(x はセンターマーク±SERVE_X_MARGIN_CENTER から
    シングルスライン、z はベースライン後方 SERVE_Z_MIN_BEHIND..MAX_BEHIND)。
    Space でメーター開始(移動停止)/離して発射。メーター値は
    `ServeMeterView` として HUD へ公開。

`ControlContext`(types.ts)が DI の核:

```ts
interface ControlContext {
  ball: Readonly<BallState>
  phase: GamePhase
  self: PlayerView; rival: PlayerView      // 位置・スタミナ等の読み取りビュー
  predictLanding(): LandingPrediction | null
  requestShot(req: ShotRequest): void      // main が shot.ts ソルバ → BallSim.launch に接続
  requestServe(power: number, aimX: -1|0|1): void
}
```

## 11. AI(`src/gameplay/ai.ts`)

`AIController.update(dt, ctx: ControlContext)`。`AIProfile`(難易度パラメータ、
GAME_DESIGN §7.2 の表が constants.ts にある)で挙動を決める。

- **状態**: `returning`(ホームへ)/ `intercept`(予測点へ)/ `recover`。
- **戦術スタンス**(GAME_DESIGN §7.1): `stance: 'baseline' | 'net'`。相手の新しい打球ごとに
  一度だけ `decideStance` で決定(`stanceDecided` でガード、`updateReaction` の打者遷移で解除)。
  **既定はベースラインのラリー。短い球(チャンス)が来たときだけ前へ詰める**。
  `chance = shortFactor − AI_NET_PACE_W·paceFactor` が、性格で決まる必要量
  `need = lerp(AI_APPROACH_NEED_MAX, AI_APPROACH_NEED_MIN, netRushTendency)` を超えたら `net`。
  ネット型(tendency 大)ほど `need` が小さく小さなチャンスでも前へ、グラインダー(tendency≈0)は
  `need` が大きく実質ベースライン専。`shortFactor` は着地のネットからの距離が `AI_SHORT_BALL_Z`
  以内で正(短い球=好機)、深いほど負。`paceFactor` は `RETURN_PACE_THRESH` 超過球速の正規化値。
  `intercept` の移動目標 z は `stanceGoalZ` で算出: **baseline** は着地点 |z| + `AI_BASELINE_DROPBACK`
  だけ深く、**net** は着地点 |z| − `AI_NET_ADVANCE` だけ前(下限 `AI_NET_MIN_Z`)。最終的に可動域
  (`MOVE_Z_MIN/MAX`)へクランプ。`netRushTendency` は `personaModifiers()` がペルソナ能力値
  (finesse/serve/speed 高で前、stamina/spin 高で後ろ)から導出する(§6.5)。
- **リカバリ位置のスタンス連動**: 打球後の `returning`/見送り時のホーム z は、直前が `net` スタンス
  なら前目の待機位置 `AI_NET_READY_Z`(中央へ recenter)、`baseline` ならベースライン `HOME_POS_Z`。
  次球が深ければ `intercept` で baseline へ切り替わり後退するため、毎球「ベースライン↔ネット」を
  往復して消耗する挙動を避ける。
- **アウトの見送り**(GAME_DESIGN §7.1): 相手の新しい打球ごとに一度だけ判定。
  `predictLanding()` の着地が自陣コート外なら、はみ出し距離 `outDist` に応じて
  `leaveOutEdgeProb`(ライン際)〜`leaveOutClearProb`(`AI_LEAVE_CLEAR_MARGIN` 超)を
  補間した確率で「見送り」を決定。見送る球は `tryHit` で打たず、移動目標もホームに戻す。
  バウンド済み(`bounceCount>0`)やコート内予測の球は見送らない。判定は着地予測が
  得られ次第(反応遅延を待たず)行い、速いアウト球を反応前に打ってしまうのを防ぐ。
- **レシーブ位置取り**(GAME_DESIGN §7.1): サーブフェーズでレシーブ側のとき、
  `positionForReturn` がサーバー(`ctx.rival.pos`)から対角サービスボックスの両極
  (ワイド/センターT)への軌道を構え深さ(ベースライン後方)まで延長した x の
  二等分点を求め、汎用定位置との間を `returnPositioning`(難易度)で補間した位置へ
  歩いて移動する。サーバーの x に追従するため、プレイヤーがサーブ位置を変えると
  受け位置も変わる。
- 相手が打ってから `reactionDelay` 秒は旧目標のまま(反応遅延)。
- 予測点 ± 到達余裕で移動。スプリントは「間に合わない時だけ」使用(スタミナ管理)。
  判断は**到達余裕ベース**: 歩行到達時間 `dist / (WALK_SPEED·speedScale·moveSpeedMul)` が
  `predictLanding().time − AI_SPRINT_TIME_MARGIN`(着地までの残り時間)を超える=歩きでは
  間に合わない時だけ走る。着地予測が無い時のみ旧来の距離ベース(0.45 秒)へフォールバック。
  これにより「余裕があるのに遠いから走る」無駄を排し、足の速いスピードスターほど歩いて
  しのげる場面が増えて消耗を抑える(コート到達性は維持。間に合わない球では従来どおり走る)。
- ショット選択: 重みベースのスコアリング
  `score(shot, targetX) = openCourt項 + 体勢項 + 相手前後位置項 + tendency項 + ノイズ`
  を全(shot×コース)候補に対し評価して最大を選ぶ。難易度で aggressiveness と
  追加誤差・凡ミス率(品質に乗算)を変える。
- AI のサーブ: 難易度に応じ power を正規分布からサンプル(2nd は安全側)。

## 12. レンダリング(`src/render/`)

```ts
class GameRenderer {
  constructor(canvas: HTMLCanvasElement)
  readonly sceneApi: SceneApi          // types.ts。effects 用
  resize(): void
  render(dt: number, world: WorldView): void   // WorldView = ball + 両プレイヤー + phase
}
```

- `court.ts`: コート平面(クレー色)+ ライン(白の細い PlaneGeometry)、ネット
  (支柱2本 + 半透明メッシュ + 白帯)、外周グラウンド、簡易スタンド(箱の段々)。
- `entities.ts`:
  - ボール: 黄スフィア(描画スケール BALL_VISUAL_SCALE)+発光ハロー
    (加算合成 billboard)+長い残像トレイル+真下のグラウンドマーカー。
  - **着地予測マーカー**: `WorldView.landing` が非 null のとき着地点に
    脈動リングを表示。
  - プレイヤー/AI: 頭・胴・両腕・両脚の人型。利き手(右)にラケット。
    `view.swingSide` で フォア/バック の腕の振りを描き分け、
    `view.charging` 中はボール側へテイクバック(深さ ∝ `view.charge`)。
    移動方向へ傾き、`whiff` は別モーション。
  - **ペルソナのパラメータ化**(GAME_DESIGN §12 / IMPROVEMENTS §3.6-3.7):
    `CharacterEntity` は `{ team: Side; physique: PersonaPhysique; appearance: PersonaAppearance }`
    を受け取り、`TEAM_PALETTE[team]`(1P青/2P赤)で配色、`physique.heightM/BASE_HEIGHT_M` で
    縦・`build` で太さをスケール、`hair`/`sleeves`/`accent` で識別フィーチャー(髪・袖・小物)を
    付ける。利き手はモデルの鏡像化で表現: ベース形状は左手持ち向きのため、**右利きを
    `group.scale.x = -1`** で鏡像化して右手持ちに(左利きはベースのまま左手持ち)。スイングも
    左右反転して追従する。body 系マテリアルは `side: DoubleSide` で負スケールでも面が崩れない。
    向き(rotation.y)は鏡像でも movement 方向のままでよい。スケールは
    ジオメトリ寸法側に適用しスイング/走りアニメ階層を壊さない。物理 `REACH` とは独立。
    `GameRenderer.setMatchup(player, opponent)`(各 `{physique, appearance}`)で
    マッチ開始時に両キャラを再構成する。
- `camera.ts`: 追従カメラ。位置 `playerPos + (0, 6.5, 9)` へ lerp(係数 3·dt)、
  注視 `mix(playerPos, ballPos, 0.35)` へ lerp。メニュー中は俯瞰へゆっくり旋回。
- エフェクト: バウンド時ダストリング(スケール+フェード)、ヒット時フラッシュ。
  `SceneApi.spawnBounceFx(pos)` / `spawnHitFx(pos)` を main から呼ぶ。
- ライティング: DirectionalLight(影あり、shadowMap 1024)+ HemisphereLight。
  背景は夕方グラデーションの大型スフィア(CanvasTexture)。

## 13. UI(`src/ui/`)

```ts
class UI {
  constructor(root: HTMLElement, handlers: UIHandlers)  // onStart(config), onRematch, onQuit
  showMenu(): void; showHud(): void
  updateHud(view: HudView): void   // スコア・スタミナ・サーブメーター・バナー
  showMatchOver(result: MatchResult): void
}
```

DOM オーバーレイ(canvas の上に absolute 配置)。スタイルは `styles.css`。
HudView / MatchResult は types.ts に定義。バナーは CSS アニメ(scale+fade)。
フォントは読みやすさ優先で大きめ(GAME_DESIGN §9)。プレイ中は画面端に
操作キー一覧の半透明パネルを常時表示。`HudView.charge` が非 null のとき
チャージバーを表示(1.0 超のオーバーチャージ域は警告色)。

## 14. オーディオ(`src/audio/sfx.ts`)

```ts
class Sfx {
  resume(): void           // 初回ユーザー操作で呼ぶ
  play(name: SfxName, opts?: { intensity?: number }): void
}
type SfxName = 'hit_flat'|'hit_spin'|'hit_slice'|'bounce'|'net'|'serve'|'point'|'applause'|'ui'
```

OscillatorNode + ノイズバッファ + BiquadFilter による合成。マスター GainNode で音量管理。

## 15. メインループ(`src/main.ts`、統括が実装)

```
rAF(t):
  acc += min(t - prev, 0.1)
  while acc >= PHYS_DT:
    input.poll()
    playerCtrl.update(PHYS_DT, ctxP)
    aiCtrl.update(PHYS_DT, ctxA)
    events = ballSim.step(PHYS_DT)        // rally 中のみ
    for e of events: sfx, fx, verdict = judge.onEvent(e)
    verdict ??= judge.update(ball)
    if verdict: スコア反映 → pointOver へ遷移
    acc -= PHYS_DT
  renderer.render(dt, worldView)
  ui.updateHud(hudView)
```

## 17. デバッグ(AI判断ログ)

敵AIの不可解なプレー(例: サーブの暴投→ダブルフォルト)を診断するための仕組み。

- `ControlContext.logDebug?(e: AIDebugEvent)` — コントローラが判断ポイントで呼ぶ任意のシンク。
  AI は サーブ選択(`serve`)・ショット選択(`shot`)・見送り判定(`leave`)で発火する。
- `main.ts` がシンクを実装: 各イベントを**現在ポイントのバッファ**に積む(`pushLog`)。
  サーブ実行時には main 自身も結果(初速・予測着地・ボックス内か)を `sys` として記録する。
- ポイント開始(`startNextPoint`)でバッファをリセット、ポイント確定(`applyVerdict` の得点時)で
  `finalizePointLog` が直近1ポイント分を JSON 化して `ui.setDebugDump(json, flagged)` へ渡す。
  フォルト/ダブルフォルトが起きたポイントは `flagged=true`(UI で警告色)。
- **「0」キー**(Digit0 / Numpad0)で `ui.setDebugVisible` をトグル。`?debug` URL で初期 ON。
  (旧バッククォートはキー配列により反応しないことがあったため数字キーへ変更。)
- デバッグ ON 中はイベントを `ui.pushDebugLine` でライブ表示(画面左下に流れる)。
- UI(`ui.ts`)のデバッグオーバーレイ: ライブログ窓 + [Copy JSON](クリップボード)+
  [Show/Hide JSON](全文表示・手動選択用)。直近1ポイントの JSON を Claude Code に渡せる。
- デバッグ表示中は **相手(opponent)のスタミナゲージも表示**する(通常時はプレイヤーのみ)。
- **調整メニュー**(画面左の `.tuning-panel`): 体感に影響する定数をスライダーで実行時調整。
  `constants.ts` の `TUNABLES`(`key/label/desc/min/max/step/get/set`)を UI が列挙して生成し、
  各行はホバーで `desc` をツールチップ表示する。対象定数は `export let`(ES module ライブ
  バインディング)にしてあり、`set()` の再代入が各モジュールの参照(毎フレーム読む箇所)へ
  即反映される。主にスタミナ系(クールダウン時間・回復レート・強打消費・強打しきい値・
  スプリント消費・ポイント間回復)+ チャージ威力。
- **`?auto`(オートプレイ / AI 対 AI)**: 手前コートも `AIController`(`side='player'`)で操作する
  デモ・挙動検証モード。`AIController` は `side` 以外を `sideSign(this.side)` で吸収して両コートに
  対応する(サーブ弾道は `handleServe` が `server` 側基準で解くため side 非依存)。長いラリーを
  放置で生成でき、スタミナ消費やスプリント頻度の計測に使う(`scripts/aistamina.mjs`)。
- **`?debug` 限定の計測フック `window.__diag()`**: `phase` と両者の位置・スタミナ・スプリント状態を
  返す。ヘッドレス検証から高頻度ポーリングして時系列計測する用途(本番挙動には影響しない)。

## 16. テスト方針

- `tests/physics.test.ts`: バウンド高の減衰、トップスピンの落下(同初速でフラット
  より着地が手前)、predictLanding と実バウンドの一致、ソルバの着地誤差 ≤ 0.5m。
- 接触コンテキスト(§6.1)の検証:
  - 中打点(h≈0.95)・ベースライン・vIn≈18・無チャージのトップスピンは
    従来同様に目標へ高精度で収束する(修飾がほぼ無効=安定維持の回帰)。
  - スマッシュ条件(h≥1.7・前寄り・flat)で初速が通常フラットを大きく上回る。
  - 低打点(h≈0.3)+チャージのフラットは、中打点同条件より着地が深く
    (アウト方向へ)ばらつく(統計的・多数試行)。
  - 高打点(h≈1.8)トップスピンは横オフセットを広げても相手コート内に収まる
    (角度がついても入る)。
  - 速球(vIn 大)をフラットで返すと低速球より初速が増える(リダイレクト)。
- 速球の返球(§6.2):
  - 速球(vIn≈50)を無チャージのトップスピンで返すと、通常球(vIn≈18)同条件より
    返球初速が遅く・弾道頂点が高い(山なりの弱返球になる)。
  - 同じ速球(vIn≈50)でも、フルチャージのスライスはトップスピンより
    返球初速が速く弾道が低い(ブロックで deep に返せる)。
  - 通常ラリー球速(vIn≤25)では mishit=0 で従来どおりの打球になる(回帰)。
- サーブの種類(§6.4):
  - 3種ともサービスボックス内に着地する(スライス/キックの横曲がりを補正できている)。
  - kick はバウンド後の最高到達高が flat より高い(高く弾む)。
  - flat は kick より初速が速い。
- `tests/scoring.test.ts`: ポイント進行、デュース→アド→ゲーム、サーブ権交代、マッチ決着。
- `tests/rally.test.ts`: イン/アウト/ネット/2バウンド/サーブフォルトの判定。
- render / ui / audio は型チェックのみ(DOM/GL のためユニットテスト対象外)。
