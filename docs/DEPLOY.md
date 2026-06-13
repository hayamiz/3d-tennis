# デプロイ手順

このゲームは**外部アセットを持たない純粋な静的サイト**(`npm run build` →
`dist/`)。`vite.config.ts` で `base: './'` を指定しているため、出力は相対パスで、
**どの静的ホストでも・サブパス配下でも追加設定なしで動く**。

以下のいずれの方法も**無料**で公開できる。おすすめは、すでに git を使っているので
**GitHub Pages(自動デプロイ)**。CLI で手早く出したいなら **Cloudflare Pages** か
**Netlify**。

---

## 方法A: GitHub Pages(推奨・自動デプロイ)

`.github/workflows/deploy.yml` を用意済み。`master`/`main` に push するだけで
ビルド → 公開まで自動で走る。

**必要なアカウント**: GitHub(無料)。リポジトリの作成権限。

**初回のみの手順:**

1. GitHub でリポジトリを作成し、リモートに登録して push する。
   ```bash
   git remote add origin git@github.com:<ユーザー名>/3d-tennis.git
   git push -u origin master
   ```
2. リポジトリの **Settings → Pages → Build and deployment** で
   **Source** を **「GitHub Actions」** に変更する(これが唯一の手動設定)。
3. 以降は push のたびに自動デプロイ。公開URLは
   `https://<ユーザー名>.github.io/3d-tennis/`。
   Actions タブの実行ログ末尾にも表示される。

> 手動実行したいときは Actions タブ → "Deploy to GitHub Pages" → "Run workflow"。

---

## 方法B: Cloudflare Pages(CLI 一発)

無料枠が広く、独自ドメインも無料。

**必要なアカウント**: Cloudflare(無料)。

```bash
npm run deploy:cloudflare
```

初回は `npx wrangler login` のブラウザ認証を求められる。プロジェクト名は
`package.json` の `deploy:cloudflare`(`--project-name=tennis-3d`)で変更可。
公開URLは `https://tennis-3d.pages.dev`。

---

## 方法C: Netlify(CLI 一発)

**必要なアカウント**: Netlify(無料、GitHub ログイン可)。

```bash
npm run deploy:netlify
```

初回はブラウザ認証 → サイトの新規作成を対話で聞かれる。以降は同コマンドで上書き公開。

---

## 方法D: Vercel(CLI 一発)

**必要なアカウント**: Vercel(無料、GitHub ログイン可)。

```bash
npm run deploy:vercel
```

初回はブラウザ認証とプロジェクト紐付けの確認あり。

---

## 方法E: Surge(アカウント作成が最も手軽)

メールアドレスだけで使え、CLI 内でその場でアカウントも作れる。

**必要なアカウント**: Surge(CLI 初回実行時にメール+パスワードでその場作成)。

```bash
npm run deploy:surge
```

公開URLは `https://<適当な名前>.surge.sh`(初回に対話で指定)。

---

## アカウント要否まとめ

| 方法            | 必要アカウント            | 自動デプロイ | 独自ドメイン |
|-----------------|---------------------------|--------------|--------------|
| GitHub Pages    | GitHub                    | ◯(push連動) | ◯(無料)    |
| Cloudflare Pages| Cloudflare                | △(連携設定) | ◯(無料)    |
| Netlify         | Netlify(GitHubログイン可)| △            | ◯            |
| Vercel          | Vercel(GitHubログイン可) | △            | ◯            |
| Surge           | Surge(メールのみ)        | ✕            | ◯(有料)    |

いずれも `dist/` を配るだけなので、どれか1つで十分。**まず GitHub Pages を推奨。**
