// 視認性改修の目視確認用スクリーンショット撮影
import { chromium } from 'playwright'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()) })

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.screenshot({ path: '/tmp/v2-1-menu.png' })

await page.getByText(/start/i).first().click()
await page.waitForTimeout(400)

// サーブフェーズで立ち位置を移動してみる(ワイドへ)
await page.keyboard.down('d')
await page.waitForTimeout(600)
await page.keyboard.up('d')
await page.screenshot({ path: '/tmp/v2-2-serve-moved.png' })

// サーブ
await page.keyboard.down(' ')
await page.waitForTimeout(420)
await page.keyboard.up(' ')
await page.waitForTimeout(500)

// チャージ(K 長押し)してチャージバーとテイクバックを確認
await page.keyboard.down('k')
await page.waitForTimeout(1100)
await page.screenshot({ path: '/tmp/v2-3-charging.png' })
await page.waitForTimeout(600)
await page.screenshot({ path: '/tmp/v2-4-overcharge.png' })
await page.keyboard.up('k')

// ラリーを少し継続(ボール視認性の確認用スクリーンショット)
for (let i = 0; i < 6; i++) {
  await page.keyboard.down('k')
  await page.waitForTimeout(700)
  await page.keyboard.up('k')
  await page.waitForTimeout(300)
}
await page.screenshot({ path: '/tmp/v2-5-rally.png' })
await page.waitForTimeout(2500)
await page.screenshot({ path: '/tmp/v2-6-rally2.png' })

const text = await page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | ').slice(0, 250))
console.log('hud:', text)
console.log('errors:', errors.length)
for (const e of errors.slice(0, 8)) console.log(e)
await browser.close()
process.exit(errors.length > 0 ? 1 : 0)
