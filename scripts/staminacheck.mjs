import { chromium } from 'playwright'
const errors=[]
const browser=await chromium.launch()
const page=await browser.newPage({viewport:{width:1280,height:720}})
page.on('pageerror',e=>errors.push('pageerror: '+e.message))
page.on('console',m=>{if(m.type()==='error')errors.push('console.error: '+m.text())})
await page.goto('http://localhost:4173/',{waitUntil:'networkidle'})
await page.waitForTimeout(900)
await page.getByText(/start/i).first().click()
await page.waitForTimeout(600)
await page.keyboard.down(' '); await page.waitForTimeout(400); await page.keyboard.up(' ')
await page.waitForTimeout(400)
await page.keyboard.down('Shift')
for(let i=0;i<26;i++){ await page.keyboard.down('a'); await page.waitForTimeout(110); await page.keyboard.up('a')
  await page.keyboard.down('d'); await page.waitForTimeout(110); await page.keyboard.up('d') }
await page.keyboard.up('Shift')
await page.waitForTimeout(200)
const g = await page.evaluate(()=>{
  const rings=[...document.querySelectorAll('.stamina-ring')].map(e=>({
    cls:e.className, hidden:e.classList.contains('hidden'),
    label:e.querySelector('.stamina-ring-label')?.textContent,
    left:e.style.left, top:e.style.top }))
  return rings
})
console.log('rings:', JSON.stringify(g))
await page.screenshot({path:'/tmp/s1-stamina.png'})
console.log('errors:', errors.length); for(const e of errors.slice(0,6))console.log(e)
await browser.close()
