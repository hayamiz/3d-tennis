// dev サーバー(5173)での表示確認
import { chromium } from 'playwright'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()) })
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
await page.screenshot({ path: '/tmp/dev-menu.png' })
const text = await page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | ').slice(0, 200))
console.log('text:', text)
console.log('errors:', errors.length)
for (const e of errors) console.log(e)
await browser.close()
process.exit(errors.length > 0 ? 1 : 0)
