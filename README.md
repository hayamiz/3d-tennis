# 3D Tennis — ブラウザでプレイできる3Dテニスゲーム

Three.js + TypeScript + Vite 製のシングルプレイヤー3Dテニスゲーム。
プレイヤー(手前コート)が AI(奥コート)と対戦する。

仕様・設計の詳細は [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) /
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) を参照。

## コマンド

```bash
npm install        # 依存関係のインストール
npm run dev        # 開発サーバー起動 (http://localhost:5173)
npm run build      # 型チェック + プロダクションビルド (dist/)
npm run typecheck  # tsc --noEmit のみ
npm test           # vitest 実行(物理・スコアリングの単体テスト)
```

## クレジット / 出典

本作で使用している外部アセットと出典・ライセンス。

### 効果音(打球音)

- **効果音ラボ**(<https://soundeffect-lab.info/>)— 「テニスラケットで打つ 1 / 2」
  - 利用規約: <https://soundeffect-lab.info/agreement/>(商用利用可・クレジット任意・**再配布禁止**)
  - ゲームへの組み込み利用。ランタイムでの直リンクはせず、ビルドに同梱(自前ホスト)。
  - 詳細は [`src/audio/samples/CREDITS.md`](src/audio/samples/CREDITS.md) を参照。

> **このリポジトリを公開する場合の注意**: 効果音ラボの規約は効果音ファイルそのものの
> 再配布を禁止しています。生の音声ファイルを公開リポジトリに含めると再配布禁止に
> 触れるおそれがあるため、公開時は音源を同梱しない運用に切り替えてください。

打球音以外(バウンド・ネット・歓声・UI 等)は WebAudio による合成音で、外部アセットは
使用していません。
