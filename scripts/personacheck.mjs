import { chromium } from 'playwright'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()) })
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.screenshot({ path: '/tmp/p1-menu-personas.png' })
// 相手をナダウ(左利き・stocky・ノースリーブ)に変えるため ▶ を何度か押す位置を探す
// まず persona-name のテキストを確認
const names = await page.evaluate(() => [...document.querySelectorAll('.persona-name')].map(e=>e.textContent))
console.log('picker names:', JSON.stringify(names))
// 相手ピッカー(2つ目)の ▶ を押してナダウまで巡回(最大6回)し見た目変化を狙う
const nextBtns = await page.$$('.persona-nav-btn')
// nextBtns: [p1prev,p1next,p2prev,p2next] の想定。p2next を数回
for (let i=0;i<4 && nextBtns[3];i++){ await nextBtns[3].click(); await page.waitForTimeout(120) }
await page.screenshot({ path: '/tmp/p2-menu-changed.png' })
// 試合開始
await page.getByText(/試合開始|start/i).first().click()
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/p3-match-models.png' })
const text = await page.evaluate(() => document.body.innerText.replace(/\n+/g,' | ').slice(0,120))
console.log('in-match hud:', text)
console.log('errors:', errors.length)
for (const e of errors.slice(0,6)) console.log(e)
await browser.close()
process.exit(errors.length>0?1:0)
