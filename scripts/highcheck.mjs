import { chromium } from 'playwright'
const errors=[]
const browser=await chromium.launch()
const page=await browser.newPage({viewport:{width:1280,height:720}})
page.on('pageerror',e=>errors.push('pageerror: '+e.message))
page.on('console',m=>{if(m.type()==='error')errors.push('console.error: '+m.text())})
await page.goto('http://localhost:4173/',{waitUntil:'networkidle'})
await page.waitForTimeout(900)
// 1ゲーム先取・Easy で開始(短くマッチ終了まで到達)
await page.getByRole('button',{name:'Easy'}).click()
await page.getByRole('button',{name:/^1 Game$/}).click()
await page.getByText(/start/i).first().click()
await page.waitForTimeout(500)
// マッチ終了まで: 自分の番ならサーブ + 適当に打つ
const deadline=Date.now()+240000
let finished=false
while(Date.now()<deadline){
  const t=await page.evaluate(()=>document.body.innerText)
  if(/rematch/i.test(t)){finished=true;break}
  await page.keyboard.down(' ');await page.waitForTimeout(360);await page.keyboard.up(' ')
  await page.keyboard.press('k');await page.waitForTimeout(700)
}
// オープンコート確認用に1枚(ラリー中)— 既に終了していれば後で
await page.screenshot({path:'/tmp/h1-matchover.png'})
const over=await page.evaluate(()=>document.body.innerText.replace(/\n+/g,' | '))
console.log('match finished:', finished)
console.log('over screen:', over.slice(0,400))
console.log('errors:', errors.length); for(const e of errors.slice(0,6))console.log(e)
await browser.close()
process.exit(errors.length>0?1:0)
