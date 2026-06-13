import { chromium } from 'playwright'
const browser=await chromium.launch()
const page=await browser.newPage({viewport:{width:1280,height:720}})
await page.goto('http://localhost:4173/',{waitUntil:'networkidle'})
await page.waitForTimeout(900)
await page.getByText(/start/i).first().click()
await page.waitForTimeout(800)
const r = await page.evaluate(()=>{
  const sb=document.querySelector('.hud-scoreboard')?.getBoundingClientRect()
  const sl=document.querySelector('.hud-serve-label')?.getBoundingClientRect()
  return { scoreboardBottom: sb?Math.round(sb.bottom):null,
           serveLabelTop: sl?Math.round(sl.top):null,
           serveLabelHidden: document.querySelector('.hud-serve-label')?.classList.contains('hidden') }
})
console.log(JSON.stringify(r), 'overlap=', (r.serveLabelTop!=null && r.scoreboardBottom!=null) ? (r.serveLabelTop < r.scoreboardBottom) : 'n/a')
await page.screenshot({path:'/tmp/u4-noverlap.png'})
await browser.close()
