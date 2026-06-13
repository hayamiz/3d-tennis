import { defineConfig } from 'vite'

export default defineConfig({
  // 相対パス出力にして、どの静的ホスト(ルート/サブパス問わず)でも
  // そのまま動くようにする。GitHub Pages のプロジェクトページ
  // (/<repo>/ 配下)でも追加設定なしで配信できる。
  base: './',
  server: { host: true },
  build: { target: 'es2022' },
})
