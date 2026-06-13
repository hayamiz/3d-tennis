import { chromium } from 'playwright'
const browser=await chromium.launch()
const page=await browser.newPage({viewport:{width:1280,height:720}})
await page.goto('http://localhost:4173/',{waitUntil:'networkidle'})
await page.waitForTimeout(900)
await page.getByText(/start/i).first().click()
await page.waitForTimeout(500)
await page.keyboard.down(' ');await page.waitForTimeout(380);await page.keyboard.up(' ')
await page.waitForTimeout(300)
// まず大きく削る
await page.keyboard.down('Shift')
for(let i=0;i<30;i++){
  await page.keyboard.down('d');await page.waitForTimeout(95);await page.keyboard.up('d')
  await page.keyboard.down('a');await page.waitForTimeout(95);await page.keyboard.up('a')
}
// 低スタミナのまま動き続けつつ連写(発汗が飛ぶ瞬間を捉える)
for(let s=0;s<5;s++){
  await page.keyboard.down('d');await page.waitForTimeout(90)
  await page.screenshot({path:`/tmp/sweat_${s}.png`}); await page.keyboard.up('d')
  await page.keyboard.down('a');await page.waitForTimeout(90);await page.keyboard.up('a')
}
await page.keyboard.up('Shift')
await browser.close()
console.log('done')
