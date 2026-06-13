import { chromium } from 'playwright'
const browser=await chromium.launch()
const page=await browser.newPage({viewport:{width:1280,height:720}})
await page.goto('http://localhost:4173/',{waitUntil:'networkidle'})
await page.waitForTimeout(900)
await page.getByRole('button',{name:/グラス|grass/i}).first().click().catch(()=>{})
await page.getByText(/start/i).first().click()
await page.waitForTimeout(1100)
// コート中央付近の画素色をサンプル(緑か)
const px = await page.evaluate(()=>{
  const c=document.querySelector('#game-canvas')
  return c ? 'canvas-present' : 'no-canvas'
})
await page.screenshot({path:'/tmp/surf-grass.png'})
console.log(px)
await browser.close()
