import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const logs = []
page.on('console', (m) => { if (m.text().startsWith('[dbg]')) logs.push(m.text()) })
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message))
await page.goto('http://localhost:4173/?debug', { waitUntil: 'networkidle' })
await page.waitForTimeout(800)
await page.getByRole('button', { name: 'Hard' }).click()
await page.getByText(/start/i).first().click()
await page.waitForTimeout(500)
// 3ポイントぶんサーブして放置
for (let i = 0; i < 3; i++) {
  await page.keyboard.down(' ')
  await page.waitForTimeout(380)
  await page.keyboard.up(' ')
  await page.waitForTimeout(6000)
}
console.log(logs.join('\n'))
await browser.close()
