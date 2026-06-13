// AI(敵=ケイ)のスタミナ消費・スプリント頻度の計測(オートプレイ ?auto を使用)。
// 両コートを AI が操作するため放置で長いラリーが続く。window.__diag を高頻度ポーリングして
// 敵(ケイ)側 AI の staminaPct とスプリント占有率をサンプリングする。
// 使い方: vite preview(?debug ビルド)起動済みで `node scripts/aistamina.mjs [計測ms]`。
import { chromium } from 'playwright'

const DURATION_MS = Number(process.argv[2] || 60000)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()) })

await page.goto('http://localhost:4173/?debug&auto', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)

// 敵ペルソナをケイ(ニシゴオリ)に。nav = [p1prev,p1next,p2prev,p2next]、相手▶ を巡回。
const navBtns = await page.$$('.persona-nav-btn')
let names = []
for (let tries = 0; tries < 6; tries++) {
  names = await page.evaluate(() => [...document.querySelectorAll('.persona-name')].map((e) => e.textContent))
  if (names[1] && names[1].includes('ケイ')) break
  await navBtns[3].click(); await page.waitForTimeout(150)
}
console.log('personas (player, opponent):', JSON.stringify(names))

const hard = await page.getByRole('button', { name: 'Hard' }).count()
if (hard) await page.getByRole('button', { name: 'Hard' }).click()
await page.getByText(/試合開始|start/i).first().click()
await page.waitForTimeout(800)

// オートプレイでも、サーブの「トス/発射」操作が人間入力前提なら詰まることがあるので
// serve フェーズが続いたら念のためスペースを軽く叩く保険を入れる。
const samples = []
let lastServeNudge = 0
let serveStuckMs = 0
let lastPhase = ''
const end = Date.now() + DURATION_MS
while (Date.now() < end) {
  const d = await page.evaluate(() => (window.__diag ? window.__diag() : null))
  const now = Date.now()
  if (d) {
    if (d.phase === 'rally' && d.ai) samples.push({ aiStam: d.ai.staminaPct, aiSprint: d.ai.sprinting })
    if (d.phase === 'serve') {
      serveStuckMs += 50
      if (serveStuckMs > 1500 && now - lastServeNudge > 1500) {
        await page.keyboard.down(' '); await page.waitForTimeout(360); await page.keyboard.up(' ')
        lastServeNudge = now
      }
    } else {
      serveStuckMs = 0
    }
    lastPhase = d.phase
  }
  await page.waitForTimeout(50)
}

const stams = samples.map((s) => s.aiStam)
const sprintFrac = samples.length ? samples.filter((s) => s.aiSprint).length / samples.length : 0
const min = stams.length ? Math.min(...stams) : 1
const last = stams.length ? stams[stams.length - 1] : 1
const avg = stams.length ? stams.reduce((a, b) => a + b, 0) / stams.length : 1
const traj = []
for (let i = 0; i < stams.length; i += 20) traj.push(stams[i].toFixed(2)) // ~1s毎(20*50ms)

console.log('--- AI(ケイ)スタミナ計測 / オートプレイ ---')
console.log('rally サンプル:', samples.length, ' (lastPhase:', lastPhase + ')')
console.log('スプリント占有率(rally中):', (sprintFrac * 100).toFixed(1) + '%')
console.log('staminaPct  min:', min.toFixed(2), ' avg:', avg.toFixed(2), ' last:', last.toFixed(2))
console.log('trajectory(~1s毎):', traj.join(' '))
console.log('errors:', errors.length)
for (const e of errors.slice(0, 6)) console.log(e)

await browser.close()
process.exit(0)
