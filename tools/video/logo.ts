import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
const OUT = join(import.meta.dir, 'out')
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: join(OUT, '.chrome-profile') })
const page = await browser.newPage()
await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 })
await page.goto(pathToFileURL(join(import.meta.dir, 'logo.html')).href, { waitUntil: 'networkidle0' })
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: join(OUT, 'tripwire-logo.png') })
await browser.close()
