import { chromium } from 'playwright'
const errors = []
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport:{width:1280,height:720}, permissions:['clipboard-read','clipboard-write'] })
const page = await ctx.newPage()
page.on('pageerror', (e)=>errors.push('pageerror: '+e.message))
page.on('console', (m)=>{ if(m.type()==='error') errors.push('console.error: '+m.text()) })
await page.goto('http://localhost:4173/?debug', { waitUntil:'networkidle' })
await page.waitForTimeout(1000)
await page.getByText(/start/i).first().click()
await page.waitForTimeout(500)
// プレイ: サーブ連打+少しラリーして AI のログを発生させる
for (let i=0;i<10;i++){ await page.keyboard.down(' '); await page.waitForTimeout(380); await page.keyboard.up(' ')
  await page.keyboard.press('k'); await page.waitForTimeout(900) }
await page.screenshot({ path:'/tmp/d1-debug-overlay.png' })
// オーバーレイの可視性とライブ行数、JSON dump の有無を確認
const info = await page.evaluate(() => {
  const ov = document.querySelector('.debug-overlay')
  const lines = document.querySelectorAll('.debug-log-line').length
  const json = document.querySelector('.debug-json')
  // Copy ボタンを探して押す
  const btns = [...document.querySelectorAll('.debug-btn')]
  const copyBtn = btns.find(b=>/copy/i.test(b.textContent||''))
  return { visible: ov?.classList.contains('visible'), liveLines: lines,
    hasCopyBtn: !!copyBtn, header: document.querySelector('.debug-header')?.textContent || '' }
})
console.log('overlay:', JSON.stringify(info))
// Copy を押してクリップボード内容(JSON)を取得
const copyBtn = await page.$('.debug-btn')
// 最初の .debug-btn が Copy 想定。テキストで絞る
const allBtns = await page.$$('.debug-btn')
for (const b of allBtns){ const t=await b.textContent(); if(/copy/i.test(t||'')){ await b.click(); break } }
await page.waitForTimeout(300)
let clip=''
try { clip = await page.evaluate(()=>navigator.clipboard.readText()) } catch(e){ clip='(read failed)' }
console.log('clipboard JSON length:', clip.length)
console.log('clipboard head:', clip.slice(0,180).replace(/\n/g,' '))
console.log('errors:', errors.length); for(const e of errors.slice(0,5)) console.log(e)
await browser.close()
process.exit(errors.length>0?1:0)
