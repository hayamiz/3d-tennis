import { chromium } from 'playwright'
const browser=await chromium.launch()
const ctx=await browser.newContext({viewport:{width:1280,height:720},permissions:['clipboard-read','clipboard-write']})
const page=await ctx.newPage()
const errors=[]
page.on('pageerror',e=>errors.push('pageerror: '+e.message))
page.on('console',m=>{if(m.type()==='error')errors.push('console.error: '+m.text())})
await page.goto('http://localhost:4173/?debug',{waitUntil:'networkidle'})
await page.waitForTimeout(900)
await page.getByText(/start/i).first().click()
await page.waitForTimeout(500)
// 2つのスライダーを変更(1番目=移動消費 を max、3番目=スプリント消費 を min)
const sliders = await page.$$('.tuning-panel input[type=range]')
await sliders[0].evaluate(el=>{el.value=el.max; el.dispatchEvent(new Event('input',{bubbles:true}))})
await sliders[2].evaluate(el=>{el.value=el.min; el.dispatchEvent(new Event('input',{bubbles:true}))})
await page.waitForTimeout(100)
// コピーボタンを押す
await page.getByRole('button',{name:/変更点をコピー/}).click()
await page.waitForTimeout(300)
let clip=''
try { clip = await page.evaluate(()=>navigator.clipboard.readText()) } catch(e){ clip='(read failed)' }
const feedback = await page.evaluate(()=>document.querySelector('.tuning-copy-feedback')?.textContent)
console.log('feedback:', feedback)
console.log('clipboard:', clip.replace(/\n/g,' '))
console.log('errors:', errors.length); for(const e of errors.slice(0,5))console.log(e)
await browser.close()
