# IMPROVEMENTS — 改善アイディア集(未実装の候補)

> 確定仕様は `GAME_DESIGN.md` / `ARCHITECTURE.md`。本書は**未着手の提案**のみを残す。
>
> 実装済み(本書から消し込み済み): プレイヤーペルソナ6タイプ + 能力6軸レーダー +
> 選択UI(§3)/ テニスのセオリー調査(§1)/ 既存システムとの対応(§2)/
> 3Dモデルの体格・外見・1P/2Pカラー(§3.6-3.7)/ スタミナ戦略性強化 + 精神力 +
> 円形ゲージ・発汗(旧§5)/ §4★★★ 高(モメンタム・プレッシャー品質変動・オープンコート
> 可視化・マッチ後スタッツ拡充)/ スタミナUI/バランス微調整(旧§5: ゲージ控えめ化・通常消費増)/
> AI 戦術スタンス(ベースライン/ネットの局面判断 + 着地点に対する深い/前の構え + ペルソナ性格で
> ネット志向を調整。旧§4★★★「AI の打点位置取り」も内包)/
> ジャストミート(リリース打球方式 + 芯判定 + 演出A/B/C + 難易度ゲートのヒント。旧§6.1.1)/
> §4★★中 すべて(サーフェス選択 / ネットプレー・ボレー / AI ペルソナ別ショット選択)/
> 打球音のリアル化(実録サンプル + 合成フォールバック。旧§7。質向上候補=合成側の
> 「オフライン生成インパルスのラウンドロビン(方法2)」のみ将来候補として残す)/
> 難易度 veryHard / EXTREME の追加(AI_PROFILES 拡張 + 敵 ratings ボーナス + EXTREME 赤演出。旧§6.1)。
> → 仕様は GAME_DESIGN §4.4/§4.4.1/§4.7/§6/§6.1/§6.2/§6.3/§7.1/§9/§10/§12/§13/§14・
>   ARCHITECTURE §6.5/§11・GAME_DESIGN §7.2 に反映済み。

---

## 4. その他の改善アイディア(優先度つき)

ペルソナの戦略的価値を高める順に。`★優先度`(高=先にやる価値)。

> ★★★ 高(モメンタム/プレッシャー品質変動・オープンコート可視化・マッチ後スタッツ拡充・
> AI 戦術スタンス)、★★ 中(サーフェス・ボレー・AI ペルソナ別ショット選択)は実装済み
> (GAME_DESIGN §4.7/§6.2/§6.3/§7.1/§9/§13)。
> AI 打点位置取りの高精度版(バウンド後軌道を前方シミュレートして好打点高さの地点を厳密に
> 求める)は未実装——現状は固定オフセット距離で近似。必要なら将来の精緻化候補。以下は未着手。

### ★ 低(将来・任意)
- **ダブルス / 2人プレイ**(構成変更が大きい)。
- **トーナメント/キャリアモード**: ペルソナを選んで複数 AI を勝ち抜く。相性ゲームが活きる。
- **リプレイ/ハイライト**、**観客・音響の盛り上げ**演出。
- **モバイル/タッチ操作**対応。

---

## 5. サーブ強打のリスク & リターンのミート timing 増幅(2026-06-16)`★★★`

> **実装状況(2026-06-16)**: §5.2(サーブ硬直微増)・§5.3(リターン timing 増幅)は**実装済み**。
> 仕様は GAME_DESIGN §4.4.1/§4.6/§5・ARCHITECTURE §6.1/§6.2 に反映済み。
> **§5.4(AI の `just` 対称化)は未実装**(任意の後続候補として下に残す)。

> **狙い**: 「速くてタイミングを合わせにくいサーブほど、芯で合わせれば強烈なカウンター
> (リターンエース)になり、外せば強烈に差し込まれる」というリスク・リワードを作る。
> あわせてサーブ強打後の硬直を僅かに延ばし、強打サーブ→戻れない→好リターンで返される
> という読み合い(GAME_DESIGN §5「サーブ後の硬直」)を一段強める。

### 5.1 背景(現状の仕組みと課題)

- **サーブ後硬直**(`player.ts:359`): `swingLockTimer = SERVE_RECOVERY_MIN + SERVE_RECOVERY_GAIN·power`
  (= `0.15 + 0.6·power`、最大 0.75 秒)。強打ほど長い。
- **ジャストミート**(`shot.ts`): `req.just` 成立時に初速 `×JUST_POWER_MUL(1.08)`・
  回転 `×JUST_SPIN_MUL(1.12)`・狙い誤差 `×JUST_AIM_MUL(0.6)`。**いずれも相手球速に依らず一律**。
- **差し込まれ `mishit`**(`shot.ts:432-447`): `mishit ∝ paceExcess = max(0, vIn − RETURN_PACE_THRESH(26))`
  で球速に比例。だが **`req.just` を参照していない** → 芯で合わせても速球は同程度に差し込まれ、
  `posMit = max(0.35, min(1, 1.3 − q))` が品質経由で僅かに緩めるのみ。

**課題**: ① just ボーナスが球速で増えないため、速球を芯で返しても「強烈なカウンター」に
ならない。② mishit が just と独立なので、芯で合わせても差し込まれが大きく減らない。
③ 結果、**速球リターンは「合わせても外しても似たような甘い返球」**になりがちで、
リターンエースがほとんど発生しない。

### 5.2 改善案 1 — サーブ強打後の硬直を僅かに延長

`SERVE_RECOVERY_GAIN` をパワー比例分だけ僅かに上げる(`SERVE_RECOVERY_MIN` は据え置き、
弱いサーブの硬直は変えない)。

| 定数 | 現状 | 提案 | 最大硬直(power=1) |
|---|---|---|---|
| `SERVE_RECOVERY_GAIN` | 0.6 | **0.72** | 0.75 → **0.87 秒** |

- パワー比例分のみ増やすので「強打サーブほどリスク」という意図に合致。
- 「僅かに」の範囲。体感がきつければ 0.66〜0.72 で微調整(+0.06〜+0.12 秒)。
- ドキュメント: GAME_DESIGN §5「サーブ後の硬直(リスク)」の数値記述を更新。

### 5.3 改善案 2 — リターンの timing を相手球速で増幅(本命)

`req.just`(芯で合わせた)か否かを **`mishit` 計算と just 威力ボーナスの両方に効かせ**、
さらに **`paceExcess`(球速超過分)に比例**させる。狙いは「速球ほど合否の差が開く」。

**(a) 差し込まれ `mishit` に timing 係数を乗算**(`shot.ts:444-447` の `mishit` 算出に追加):

```
timingFactor = req.just ? (1 − RETURN_JUST_MISHIT_RELIEF)   // 芯: 差し込まれを大幅軽減
                        : RETURN_NOJUST_MISHIT_AMP           // 外し: 差し込まれを増幅
mishit = clamp01( (paceExcess / RETURN_OVERWHELM_RANGE)
                  · typeWeak · chargeMit · posMit · m.returnSolidMul · timingFactor )
```

- 芯で合わせれば `mishit ≈ 0`(`floatSpeed`/`floatApex`/手前引き/スプレーが発火しない)→
  山なり sitter にならず **deep で速いカウンター**を返せる。
- 外せば `mishit` 増幅 → より遅く・高く・浅い(差し込まれ強化)。
- `mishit ∝ paceExcess` は不変なので、**通常ラリー(vIn ≤ 26)は paceExcess=0 → mishit=0** のまま
  影響ゼロ(回帰防止)。timing 係数は速球リターンでだけ意味を持つ。

**(b) just の威力ボーナスを球速で上積み**(`shot.ts:364` の `if (req.just) speed *= JUST_POWER_MUL` を拡張):

```
if (req.just) {
  justPaceBonus = min(RETURN_JUST_PACE_POWER_MAX, RETURN_JUST_PACE_POWER_K · paceExcess)
  speed *= JUST_POWER_MUL + justPaceBonus    // 通常ラリーは paceExcess=0 → 従来の 1.08
}
```

- 既存の pace リダイレクト(`PACE_REDIRECT_FLAT=0.3·vIn` を初速加算、`shot.ts:319-326`)と
  あわせ、**速いサーブを芯フラットで返す = 球威を乗せた強烈なカウンター**になる。
- `JUST_AIM_MUL(0.6)` の狙い縮小も効くので、速球 just リターンは「速く・正確」= リターンエース経路。
- 実装メモ: `paceExcess` は現状 `shot.ts:432` で定義。(b) はそれより前(364 行)で使うため、
  `paceExcess` の算出を `vIn` 定義直後(`shot.ts:255` 付近)へ巻き上げる小リファクタが必要。

**提案する新規定数**(`constants.ts`、§4.6 の RETURN_* 群の近くに追加):

| 定数 | 採用値 | 意味 |
|---|---|---|
| `RETURN_JUST_MISHIT_RELIEF` | 0.8 | just のとき `mishit ×(1−0.8)=×0.2`(芯で合わせれば速球も差し込まれをほぼ無効化) |
| `RETURN_NOJUST_MISHIT_AMP` | 1.25 | not-just のとき `mishit ×1.25`(差し込まれ増幅) |
| `RETURN_JUST_PACE_POWER_K` | 0.012 | just 初速ボーナス傾き(/(m/s) 超過分) |
| `RETURN_JUST_PACE_POWER_MAX` | 0.25 | 同ボーナスの上限(`speed` 倍率の加算上限) |

> 実装メモ: `RELIEF` は当初 0.7 を想定したが、わずかに残る `mishit` が flat の
> ソルバを速度優先ドライブから収束ソルバへ切替えてしまい「速いサーブを just したのに
> 返球初速が落ちる」逆転が出たため 0.8 に調整(芯 just が clean ドライブ経路を保つ)。

例: 40 m/s のフラットサーブ(vIn≈40 → paceExcess≈14)を芯フラットで返すと、
`justPaceBonus = min(0.25, 0.012·14)=0.168` → 初速 `×1.248` + `PACE_REDIRECT_FLAT` の上乗せ +
狙い `×0.6` + `mishit≈0`。芯を外すと `mishit` が ×1.25 で増え、遅く浮いた絶好球になる。

### 5.4 AI 側の `just` 非対称性と対称化(任意・推奨)

現状 **AI は `just` を設定しない**(`ai.ts:1107-1117`)ため、改善案 2 を入れると:

- **プレイヤー → AI 強打サーブ**: AI は常に not-just 扱い → 差し込まれ増幅で甘い返球が増える
  (プレイヤーの**サービス有利**が増す)。
- **AI → プレイヤー強打サーブ**: プレイヤーは芯で合わせれば**リターンエースを狙える**(本提案の主目的)。

これでも成立するが、**AI が一切リターンエースを打てない**のは不自然。対称化案として、
`ai.ts` の `chooseShot` で **確率的に `just` を立てる**(乱数はゲームプレイ品質ノイズ用途として
規約上 OK。物理は決定的のまま):

```
// 例: 難易度・リターン位置取り rating ほど just しやすく、速球ほど難しい
pJust = AI_RETURN_JUST_BASE · positioningRating · clamp01(1 − paceExcess / RETURN_OVERWHELM_RANGE)
req.just = rng() < pJust
```

- `AI_RETURN_JUST_BASE` は難易度別(easy≈0.1 〜 EXTREME≈0.6)。速球ほど `just` 率を下げ、
  プレイヤーと同じ「速いほど合わせにくい」感覚を AI にも持たせる。
- これにより AI も時折リターンエース/強カウンターを返し、サーブ偏重を防ぐ。

### 5.5 通常ラリーへの非影響(回帰防止)とバランス指針

- すべての新項は **`paceExcess`(vIn−26)に依存** → 通常ラリー(〜25 m/s)では発火せず従来挙動。
- 既存の救済が残るので速球も「合わせる以外の」対処が可能:
  スライス(`RETURN_WEAKNESS_SLICE=0.35`)+ 早めのチャージ(`RETURN_CHARGE_MITIGATION=0.7`)で
  ブロック → deep に返す(GAME_DESIGN §4.6 のセオリーを維持)。
- 過強調注意: `RETURN_NOJUST_MISHIT_AMP` を上げすぎるとサーブが強すぎて単調化。
  まず 1.25 で様子見、リターンが甘すぎなら 1.15、サーブが弱すぎなら 1.35 へ。

### 5.6 検証(`scripts/` ヘッドレス)

- `?debug` の just ログ(`shot=` / `vIn` / `just OK|--` / `q`)と既存の mishit ログで、
  **速球 just → 高初速・低 mishit / 速球 not-just → 高 mishit** を確認(`scripts/diag.mjs`)。
- `scripts/smoke.mjs`・`scripts/matchflow.mjs` がエラーゼロで通ること。
- ユニットテスト(`npm test`)に「solveShot: just × 高 vIn で初速が not-just × 高 vIn を上回り、
  not-just × 高 vIn の mishit が just 時を上回る」ケースを追加。

### 5.7 ドキュメント反映先(実装時に同時更新)

- GAME_DESIGN **§4.4.1**(ジャストミート): 「速球を芯で合わせると pace を乗せたカウンターになり、
  差し込まれが大幅に減る/外すと差し込まれ増幅」を追記。
- GAME_DESIGN **§4.6**(差し込まれ): `mishit` 式に timing 係数を追記。
- GAME_DESIGN **§5**(サーブ後の硬直): `SERVE_RECOVERY_GAIN` の新数値。
- ARCHITECTURE **§6.1/§6.2**(接触コンテキスト/速球返球ソルバ): just × pace の初速ボーナスと
  timing 係数の合成順を追記。

---

## 6. 他テニスゲームからの導入候補(事例調査)

主要テニスゲーム(Top Spin / Virtua Tennis / Mario Tennis Aces / Full Ace / Tennis Elbow)
の仕組みを調べ、本作の方向性(本格寄り+アーケードの軽快さ、決定論的物理、外部アセット
なし、ペルソナ/スタミナ/モメンタム)に**取り込んで面白くなりそうな要素**を抜粋。
出典は末尾。各案に `優先度★` と本作への接続を付記。

### 6.1 スキル表現を深める(操作・タイミング)

> **ジャストミート(旧§6.1.1)は実装済み**: ショットキー長押しでチャージ → 離した瞬間に打球、
> 離した瞬間 `hDist ≤ JUST_SWEET_DIST` なら just。演出は (A) 金白の発光リング+スパーク+
> フラッシュ / (B)(C) 飛行球の金色着色・トレイル強調 / 打球音のベル倍音。ヒント(収束リング)は
> easy/normal は常時・それ以外はデバッグモード時のみ表示。仕様は GAME_DESIGN §4.4 / §4.4.1。
>
> 残る後続候補:
> - (E) **ジュース**: 威力比例の微小スクリーンシェイク / 1〜2フレームのヒットストップ。
>   物理は固定タイムステップなので全体停止なら決定性は保てるが、ラリーがもたつくため最小限 or 見送り。
> - (G) **`?debug` のリーチ範囲可視化**: プレイヤー周囲の `REACH`(水平円柱)・`REACH_HEIGHT`
>   (高さ上限)を描画し、ボールが範囲内に入ったらハイライト(窓幅・チューニング用途)。

- **カジュアル簡易操作モード**(Virtua Tennis 4 / Nintendo Switch Sports 系)`★★`
  Virtua Tennis 4 はシンプル操作で初心者・カジュアル層に寄せた。本作も**ワンボタン寄りの
  入門モード**(コースは自動アシスト、チャージ簡略)を用意すると間口が広がる。
  既存の深い操作は「標準/上級」として残す。

### 6.2 スペクタクル・派手さ(アーケード要素・モード切替前提)

> 本作の本格寄りの手触りを壊さないよう、これらは**「アーケードモード」トグルの中**で
> 有効化する想定(標準モードはシミュレーション寄りのまま)。

- **エナジーゲージ + ペルソナ固有「シグネチャーショット」**(Mario Tennis Aces)`★★`
  Aces は良いプレー(ラリー継続・トリックショット・好タイミング)でエナジーゲージが
  溜まり、満タンで強力なスペシャルショットを撃てる(相手のラケット破壊チャンスも)。
  本作では**ペルソナごとの必殺の一撃**(サンブラントの強烈サーブ、ニシゴオリの超アングル等)
  に落とし込めば、§3 のペルソナ個性が一段立ち、**逆転要素**も生まれる。
  ゲージは既存の**モメンタム**指標と統合できる。
- **ゾーンスピード / ダイブ・スライディングリターン**(Mario Tennis Aces / Virtua Tennis)`★★`
  届かない球へ**飛びつく一回限りのリーチ拡張**(`REACH` を瞬間的に拡大、代わりに
  スタミナを大きく消費し直後は隙)。守備の盛り上がりが出て、**カウンター/スピード型
  ペルソナ(ジョコヴィン/ニシゴオリ)が映える**。Aces のゾーンスピード(時間を遅くして
  追う、エナジー消費)も同系統。本作のスタミナ経済に自然に乗る。
- **ブロック/ラケットへの負荷**(Mario Tennis Aces)`★`
  Aces は強烈なショットをブロックするとラケット破壊リスク。本作の**差し込まれ(mishit)
  =弱い返球**が既に近い役割。深追いせず、強打を受け続けると返球が崩れる現行挙動の
  **演出強化**(火花・きしみ音)程度に留めるのが無難。

### 6.3 モード・進行・エンゲージメント

- **スキル練習ミニゲーム + キャリア/ワールドツアー**(Virtua Tennis)`★★`
  Virtua Tennis のワールドツアーは、試合の合間に**サーブ/ボレー/ベースライン別の
  ミニゲーム**(的当て・風船割り・リターン壁など)でステータスを上げる。本作の
  §4★低「トーナメント/キャリア」を具体化でき、ミニゲームは**チュートリアル兼
  練習場**にもなる(操作習得 → ペルソナ能力の底上げ)。練習モード(ボールマシン、
  GAME_DESIGN §14)は実装済みなので、その発展形として的当て等を載せられる。

### 6.4 演出・没入感

- **観客・歓声のモメンタム連動、ライバル/実況フレーバー**(各作)`★`
  §4★低「観客・音響の盛り上げ」を具体化。本作の**モメンタム/プレッシャー**指標と
  歓声・どよめきを連動させ、ブレークポイントで場が静まる→決まって沸く、等。
  外部アセットなしの規約に沿い、歓声は WebAudio 合成で表現。

### 6.5 調査で確認できた「本作が既に正しい方向にある」点

- **着地ゾーン+誤差**(Tennis Elbow): 「狙うのはゾーンで、ばらつきが出るのが現実的」。
  → 本作の**品質ノイズ(`AIM_NOISE_R`)**が同じ思想。可視化(良い体勢で**狙いゾーンが
  締まる**様子を見せる)を足せば、初心者に戦略性が伝わりやすくなる(教育的UI)。
- **ポジショニングとタイミングが品質を決める**(Full Ace): 本作の**距離係数・体勢品質
  (§4.2)**と一致。方向性は本格シムと同じで、ジャストミート窓(実装済み)でさらに深い。

### 6.6 おすすめ着手順(費用対効果)

> ジャストミート窓・サーフェスは実装済み。残る候補の着手順:

1. `★★`(アーケードモード)**ダイブ/スライディングリターン**(§6.2): 守備の盛り上がりを
   低〜中コストで追加。スタミナ経済に自然に乗る。
2. `★★` **キャリア+練習ミニゲーム**(§6.3): エンゲージメントとオンボーディングを底上げ。
   既存の練習モードを発展させる。
3. `★★`(アーケードモード)**エナジーゲージ+シグネチャーショット**(§6.2): 派手さ・逆転。
   モード分離で本格モードの純度を保つ。

### 出典

- [12 Best Tennis Games of All Time — Cultured Vultures](https://culturedvultures.com/best-tennis-games/)
- [TopSpin 2K25 Gameplay, Physics, Mechanics — Operation Sports](https://www.operationsports.com/topspin-2k25-gameplay-venues-tournaments-physics-mechanics-and-more/)
- [Centre Court Report: Gameplay — TopSpin 2K25 公式](https://topspin.2k.com/2k25/centre-court-report/gameplay/)
- [Zone Shot — Super Mario Wiki](https://www.mariowiki.com/Zone_Shot)
- [How to Trick Shot in Mario Tennis Aces — Shacknews](https://www.shacknews.com/article/105747/how-to-trick-shot-in-mario-tennis-aces)
- [Mario Tennis Aces Character Types — Nintendo Insider](https://www.nintendo-insider.com/mario-tennis-aces-character-types-explaining-the-different-classes/)
- [Virtua Tennis: World Tour — Wikipedia](https://en.wikipedia.org/wiki/Virtua_Tennis:_World_Tour)
- [Virtua Tennis 4 Review — The SEGA Source](https://thesegasource.wordpress.com/2011/06/26/virtua-tennis-4-review/)
- [Full Ace Tennis Simulator Review — Operation Sports](https://www.operationsports.com/full-ace-tennis-simulator-review-serving-up-a-cross-court-winner/)
