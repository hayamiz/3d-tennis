// ヘッドレスブラウザによるスモークテスト:
// メニュー表示 → マッチ開始 → サーブ → ラリー操作までを自動操作し、
// コンソールエラーが出ないこと・フェーズが進むことを確認する。
import { chromium } from 'playwright'

const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
})

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/shot-1-menu.png' })

// タイトル画面から開始(Easy で開始して AI 挙動も見る)
const startBtn = page.getByText(/start/i).first()
await startBtn.click()
await page.waitForTimeout(800)
await page.screenshot({ path: '/tmp/shot-2-serve.png' })

// サーブ: Space を押してメーターを進め、離す
await page.keyboard.down(' ')
await page.waitForTimeout(450)
await page.keyboard.up(' ')
await page.waitForTimeout(1200)
await page.screenshot({ path: '/tmp/shot-3-rally.png' })

const hudText = () => page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | '))

// 約40秒間プレイし続ける: サーブ(自分番なら)+ ラリー中はショット連打
const snapshots = []
for (let round = 0; round < 20; round++) {
  // サーブ試行(自分の番でなければ無害)
  await page.keyboard.down(' ')
  await page.waitForTimeout(420)
  await page.keyboard.up(' ')
  // ラリー操作
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('k')
    await page.waitForTimeout(150)
    await page.keyboard.press('j')
    await page.waitForTimeout(150)
  }
  snapshots.push(await hudText())
}
await page.screenshot({ path: '/tmp/shot-4-after-rally.png' })
await page.waitForTimeout(3000)
await page.screenshot({ path: '/tmp/shot-5-later.png' })
snapshots.push(await hudText())

console.log('--- HUD snapshots(抜粋)---')
for (const s of snapshots.filter((_, i) => i % 4 === 0)) console.log(s.slice(0, 140))

// スコア進行の検証: ポイント/ゲームのいずれかが 0-0 以外になったスナップショットがあるか
const progressed = snapshots.some((s) => /15|30|40|Ad/i.test(s) || /[1-9]\s*[—-]/.test(s))
console.log('--- score progressed:', progressed, '---')
console.log('--- errors:', errors.length, '---')
for (const e of errors.slice(0, 10)) console.log(e)
await browser.close()
process.exit(errors.length > 0 || !progressed ? 1 : 0)
