import { chromium } from 'playwright'
const errors=[]
const browser=await chromium.launch()
const page=await browser.newPage({viewport:{width:1280,height:720}})
page.on('pageerror',e=>errors.push('pageerror: '+e.message))
page.on('console',m=>{if(m.type()==='error')errors.push('console.error: '+m.text())})
await page.goto('http://localhost:4173/',{waitUntil:'networkidle'})
await page.waitForTimeout(1000)
// メニューにサーフェスボタンがあるか
const labels = await page.evaluate(()=>[...document.querySelectorAll('.opt-btn')].map(b=>b.textContent))
console.log('option buttons:', JSON.stringify(labels))
await page.screenshot({path:'/tmp/surf-menu.png'})
// クレーを選んで開始 → コート色
const clayBtn = await page.getByRole('button',{name:/クレー|clay/i}).first()
if(clayBtn) await clayBtn.click().catch(()=>{})
await page.getByText(/start/i).first().click()
await page.waitForTimeout(1200)
await page.screenshot({path:'/tmp/surf-clay.png'})
console.log('errors:',errors.length); for(const e of errors.slice(0,6))console.log(e)
await browser.close()
