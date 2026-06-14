// マッチ決着までのフルフロー検証:
// 1ゲーム先取マッチを開始し、プレイヤーはサーブだけ打って放置(AI が勝つ想定)。
// マッチ終了画面(REMATCH ボタン)が出ること、再戦できることを確認する。
import { chromium } from 'playwright'

const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
})

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)

// 1ゲーム先取・Hard を選択して開始(exact: 'Very Hard' と区別する)
await page.getByRole('button', { name: 'Hard', exact: true }).click()
await page.getByRole('button', { name: /^1 Game$/ }).click()
await page.getByText(/start/i).first().click()
await page.waitForTimeout(500)

// マッチ終了画面が出るまで、自分の番ならサーブを打ち続ける(最大4分)
const deadline = Date.now() + 240_000
let finished = false
while (Date.now() < deadline) {
  const text = await page.evaluate(() => document.body.innerText)
  if (/rematch/i.test(text)) {
    finished = true
    break
  }
  // サーブ試行(レシーブ番なら無害)
  await page.keyboard.down(' ')
  await page.waitForTimeout(380)
  await page.keyboard.up(' ')
  await page.waitForTimeout(1500)
}
await page.screenshot({ path: '/tmp/shot-6-matchover.png' })
console.log('match finished:', finished)

if (finished) {
  const overText = await page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | '))
  console.log('over screen:', overText.slice(0, 250))
  // 再戦 → HUD に戻ること
  await page.getByRole('button', { name: /rematch/i }).click()
  await page.waitForTimeout(1000)
  const afterText = await page.evaluate(() => document.body.innerText)
  console.log('rematch ok:', /SERVE/i.test(afterText))
  await page.screenshot({ path: '/tmp/shot-7-rematch.png' })
}

console.log('--- errors:', errors.length, '---')
for (const e of errors.slice(0, 10)) console.log(e)
await browser.close()
process.exit(errors.length > 0 || !finished ? 1 : 0)
