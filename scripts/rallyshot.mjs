import { chromium } from 'playwright'
const errors=[]
const browser=await chromium.launch()
const page=await browser.newPage({viewport:{width:1280,height:720}})
page.on('pageerror',e=>errors.push('pageerror: '+e.message))
page.on('console',m=>{if(m.type()==='error')errors.push('console.error: '+m.text())})
await page.goto('http://localhost:4173/',{waitUntil:'networkidle'})
await page.waitForTimeout(900)
await page.getByText(/start/i).first().click()
await page.waitForTimeout(500)
// サーブして、左右に振りながらラリー(相手を走らせてオープンコートを出す)
await page.keyboard.down(' ');await page.waitForTimeout(380);await page.keyboard.up(' ')
await page.waitForTimeout(600)
for(let i=0;i<10;i++){
  await page.keyboard.down('a');await page.keyboard.press('k');await page.waitForTimeout(160);await page.keyboard.up('a')
  await page.keyboard.down('d');await page.keyboard.press('j');await page.waitForTimeout(160);await page.keyboard.up('d')
}
await page.screenshot({path:'/tmp/h2-rally.png'})
const el = await page.evaluate(()=>{
  const m=document.querySelector('[class*="momentum"]')
  return { momentumEl: !!m, momentumCls: m?m.className:null, momentumHidden: m?m.classList.contains('hidden'):null }
})
console.log('momentum element:', JSON.stringify(el))
console.log('errors:', errors.length); for(const e of errors.slice(0,6))console.log(e)
await browser.close()
