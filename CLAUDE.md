# 3D Tennis — ブラウザでプレイできる3Dテニスゲーム

Three.js + TypeScript + Vite 製のシングルプレイヤー3Dテニスゲーム。
プレイヤー(手前コート)が AI(奥コート)と対戦する。

## コマンド

```bash
npm install        # 依存関係のインストール
npm run dev        # 開発サーバー起動 (http://localhost:5173)
npm run build      # 型チェック + プロダクションビルド (dist/)
npm run typecheck  # tsc --noEmit のみ
npm test           # vitest 実行(物理・スコアリングの単体テスト)
```

## ドキュメント

- `docs/GAME_DESIGN.md` — ゲーム仕様(ルール、操作、ショット、AI、戦略性の意図)
- `docs/ARCHITECTURE.md` — 詳細設計(座標系、物理式、モジュールAPI、状態機械)

仕様・設計の真実はこの2つのドキュメント。実装と食い違う場合はドキュメントを正とし、
意図的に変える場合はドキュメントも更新すること。

## アーキテクチャの要点

- **座標系**: メートル単位。ネットが `z=0`、プレイヤー側が `z>0`、AI側が `z<0`。
  `y` が上方向。コートは縦 23.77m × 横 8.23m(シングルス)。
- **依存ルール(重要)**: `src/` 配下の各モジュールは `three`、`src/types.ts`、
  `src/constants.ts` 以外を import しない。モジュール間の連携はすべて
  `types.ts` のインターフェースを介した依存性注入で行い、`src/main.ts` だけが
  全モジュールを import して結線する。
- **物理は固定タイムステップ**(1/120秒)。描画はrAF、物理はアキュムレータ方式。
- **ショットソルバ**は解析解+前方シミュレーション補正(`docs/ARCHITECTURE.md` §6)。

## ディレクトリ構成

```
src/
  types.ts          # 共有型・インターフェース(全モジュールの契約)
  constants.ts      # コート寸法・物理定数・ゲームパラメータ
  main.ts           # エントリポイント。全モジュールの結線とゲームループ
  physics/ball.ts   # ボール物理(積分、バウンス、着地予測)
  gameplay/shot.ts  # ショットソルバ(目標着地点 → 初速・スピン)
  gameplay/player.ts# プレイヤー操作(移動、スイング、品質計算)
  gameplay/input.ts # キーボード入力
  gameplay/ai.ts    # AI(移動、ショット選択、難易度)
  core/scoring.ts   # テニススコア(15/30/40、デュース、ゲーム)
  core/rally.ts     # ラリー判定(バウンドイベント → ポイント帰属)
  render/           # Three.js シーン、コート、エンティティ、カメラ
  ui/               # HUD、メニュー(DOM オーバーレイ)
  audio/sfx.ts      # WebAudio 効果音(外部アセットなし)
```

## 動作検証(ヘッドレスブラウザ)

`scripts/` に Playwright による自動検証スクリプトがある(要 `npm run build` +
`npx vite preview --port 4173` 起動済み):

- `scripts/smoke.mjs` — 起動〜サーブ〜ラリー〜スコア進行をエラーゼロで通すこと
- `scripts/matchflow.mjs` — マッチ決着 → リザルト画面 → 再戦のフルフロー
- `scripts/diag.mjs` — `?debug` 付きで打球・バウンド・判定のログを観察

URL に `?debug` を付けるとゲームプレイ診断ログ(打球品質・ターゲット・判定)が
コンソールに出る。この環境は sudo 不可のため、ブラウザの共有ライブラリは
`apt-get download` + `dpkg-deb -x` で /tmp に展開し `LD_LIBRARY_PATH` で渡す
(手順は git 履歴ではなくこのリポジトリの開発ログ参照。要再構築なら
`apt-get update -o Dir::State::lists=/tmp/aptlists` を併用)。

## 規約

- ドキュメント・コードコメントは日本語。識別子は英語。
- 外部アセット(モデル・テクスチャ・音声ファイル)は使わない。
  ジオメトリはプリミティブ、音は WebAudio で合成する。
- 乱数はゲームプレイ品質ノイズにのみ使用。物理積分は決定的に保つ。
- チューニング用パラメータは `constants.ts` に集約し、マジックナンバーを散らさない。
