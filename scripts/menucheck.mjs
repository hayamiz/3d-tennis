import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
await page.screenshot({ path: '/tmp/v2-7-menu-fixed.png' })
await browser.close()
