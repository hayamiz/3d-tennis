import { chromium } from 'playwright'
const errors=[]
const browser=await chromium.launch()
const page=await browser.newPage({viewport:{width:1280,height:720}})
page.on('pageerror',e=>errors.push('pageerror: '+e.message))
page.on('console',m=>{if(m.type()==='error')errors.push('console.error: '+m.text())})
await page.goto('http://localhost:4173/?debug',{waitUntil:'networkidle'}) // ?debug 初期ON
await page.waitForTimeout(900)
await page.getByText(/start/i).first().click()
await page.waitForTimeout(500)
// サーブして少しラリー(相手ゲージが見える状態に)
await page.keyboard.down(' ');await page.waitForTimeout(380);await page.keyboard.up(' ')
await page.waitForTimeout(800)
const info=await page.evaluate(()=>{
  const panel=document.querySelector('.tuning-panel')
  const sliders=document.querySelectorAll('.tuning-panel input[type=range]')
  const oppRing=document.querySelector('.stamina-ring-opponent')
  const tip=document.querySelector('.tuning-tip')
  return {
    panelVisible: panel ? !panel.classList.contains('hidden') : false,
    sliderCount: sliders.length,
    opponentRingHidden: oppRing ? oppRing.classList.contains('hidden') : 'no-el',
    hasTooltip: !!tip,
    firstRowLabel: document.querySelector('.tuning-label')?.textContent,
  }
})
console.log('tuning:', JSON.stringify(info))
// スライダーを動かして値ラベルが変わるか
const first = await page.$('.tuning-panel input[type=range]')
if(first){
  const before=await page.evaluate(()=>document.querySelector('.tuning-val')?.textContent)
  await first.evaluate(el=>{ el.value = el.max; el.dispatchEvent(new Event('input',{bubbles:true})) })
  await page.waitForTimeout(100)
  const after=await page.evaluate(()=>document.querySelector('.tuning-val')?.textContent)
  console.log('slider val before/after:', before, '/', after)
}
await page.screenshot({path:'/tmp/tuning1.png'})
console.log('errors:',errors.length); for(const e of errors.slice(0,6))console.log(e)
await browser.close()
