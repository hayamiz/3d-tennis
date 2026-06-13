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
- **アウトの見送り**(GAME_DESIGN §7.1): 相手の新しい打球ごとに一度だけ判定。
  `predictLanding()` の着地が自陣コート外なら、はみ出し距離 `outDist` に応じて
  `leaveOutEdgeProb`(ライン際)〜`leaveOutClearProb`(`AI_LEAVE_CLEAR_MARGIN` 超)を
  補間した確率で「見送り」を決定。見送る球は `tryHit` で打たず、移動目標もホームに戻す。
  バウンド済み(`bounceCount>0`)やコート内予測の球は見送らない。判定は着地予測が
  得られ次第(反応遅延を待たず)行い、速いアウト球を反応前に打ってしまうのを防ぐ。
- 相手が打ってから `reactionDelay` 秒は旧目標のまま(反応遅延)。
- 予測点 ± 到達余裕で移動。スプリントは「間に合わない時だけ」使用(スタミナ管理)。
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
