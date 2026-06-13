import { chromium } from 'playwright'
const errors=[]
const browser=await chromium.launch()
const page=await browser.newPage({viewport:{width:1280,height:720}})
page.on('pageerror',e=>errors.push('pageerror: '+e.message))
page.on('console',m=>{if(m.type()==='error')errors.push('console.error: '+m.text())})
await page.goto('http://localhost:4173/',{waitUntil:'networkidle'})
await page.waitForTimeout(1000)
// 1. メニューに Controls が無いこと
const menuHasControls = await page.evaluate(()=>!!document.querySelector('.menu-controls'))
await page.screenshot({path:'/tmp/u1-menu.png'})
console.log('menu has Controls section:', menuHasControls)
// 試合開始
await page.getByText(/start/i).first().click()
await page.waitForTimeout(800)
// 4. デバッグキー「0」でオーバーレイ表示
await page.keyboard.press('0')
await page.waitForTimeout(200)
const dbgVisible = await page.evaluate(()=>document.querySelector('.debug-overlay')?.classList.contains('visible'))
console.log('debug overlay visible after pressing 0:', dbgVisible)
await page.keyboard.press('0') // 戻す
await page.waitForTimeout(150)
// 2. HUD のマッチ情報(ペルソナ名・難易度)
const mi = await page.evaluate(()=>({
  player: document.querySelector('.mi-player')?.textContent,
  diff: document.querySelector('.mi-diff')?.textContent,
  opp: document.querySelector('.mi-opponent')?.textContent,
}))
console.log('match info:', JSON.stringify(mi))
await page.screenshot({path:'/tmp/u2-hud.png'})
// 3. ESC でポーズ(メニューに即戻らないこと)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const st = await page.evaluate(()=>({
  pauseVisible: !document.querySelector('.screen-pause')?.classList.contains('hidden'),
  menuVisible: !document.querySelector('.screen-menu')?.classList.contains('hidden'),
}))
console.log('after ESC:', JSON.stringify(st))
await page.screenshot({path:'/tmp/u3-pause.png'})
// ESC でポーズ解除
await page.keyboard.press('Escape')
await page.waitForTimeout(250)
const resumed = await page.evaluate(()=>document.querySelector('.screen-pause')?.classList.contains('hidden'))
console.log('pause hidden after 2nd ESC (resumed):', resumed)
// 再度ポーズ→「ゲーム終了」クリックでメニューへ
await page.keyboard.press('Escape')
await page.waitForTimeout(250)
await page.getByRole('button',{name:/ゲーム終了/}).click()
await page.waitForTimeout(300)
const backToMenu = await page.evaluate(()=>!document.querySelector('.screen-menu')?.classList.contains('hidden'))
console.log('quit button → menu:', backToMenu)
console.log('errors:', errors.length); for(const e of errors.slice(0,6))console.log(e)
await browser.close()
process.exit(errors.length>0?1:0)
