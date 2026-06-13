import { chromium } from 'playwright'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()) })
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
await page.getByText(/start/i).first().click()
await page.waitForTimeout(500)
// サーブ位置を右に動かして、ラベルが頭上(プレイヤー)に追従するか確認
await page.keyboard.down('d'); await page.waitForTimeout(450); await page.keyboard.up('d')
await page.keyboard.press('l') // スライス選択
await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/v4-serve-head.png' })
// 種類ラベルのDOM位置を取得
const box = await page.evaluate(() => {
  const el = document.querySelector('.hud-serve-type-label')
  if (!el || el.classList.contains('hidden')) return null
  const r = el.getBoundingClientRect()
  return { text: el.textContent, cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }
})
console.log('serve-type label:', JSON.stringify(box))
console.log('errors:', errors.length)
for (const e of errors.slice(0,5)) console.log(e)
await browser.close()
process.exit(errors.length>0?1:0)
