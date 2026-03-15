/**
 * Zepto Session Manager
 *
 * Handles login (phone + OTP) and session persistence.
 * Login is triggered once — session saved to zepto-session.json.
 * Future runs reuse the saved session without re-login.
 *
 * OTP flow:
 *   1. Automation enters phone, Zepto sends OTP to user's phone
 *   2. provideOtp(code) is called (via POST /otp on agent server)
 *   3. Automation enters OTP and saves session
 */

import { chromium, BrowserContext, Browser } from 'playwright'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = path.join(__dirname, '../../zepto-session.json')

const ZEPTO_URL  = 'https://www.zepto.com'
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

let otpResolver: ((otp: string) => void) | null = null
let otpRejecter: ((err: Error) => void) | null = null

/** Called by POST /otp on agent server with the OTP the user received */
export function provideOtp(otp: string) {
  if (otpResolver) {
    otpResolver(otp)
    otpResolver = null
    otpRejecter = null
  }
}

function waitForOtp(timeoutMs = 5 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    otpResolver = resolve
    otpRejecter = reject
    setTimeout(() => {
      if (otpRejecter) {
        otpRejecter(new Error('OTP timeout — no OTP received within 5 minutes'))
        otpResolver = null
        otpRejecter = null
      }
    }, timeoutMs)
  })
}

function browserContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 390, height: 844 },
    locale: 'en-IN',
    geolocation: { latitude: 12.9903, longitude: 80.2456 }, // Chennai Tharamani
    permissions: ['geolocation'],
  })
}

async function injectStealth(context: BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
}

/** Returns a ready BrowserContext — either from saved session or fresh login */
export async function getZeptoSession(): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  // Try saved session first
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf-8')
    const storageState = JSON.parse(raw)
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 390, height: 844 },
      locale: 'en-IN',
      geolocation: { latitude: 12.9903, longitude: 80.2456 },
      permissions: ['geolocation'],
      storageState,
    })
    await injectStealth(context)

    // Quick check — can we access cart?
    const page = await context.newPage()
    await page.goto(`${ZEPTO_URL}`, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(2000)

    // Check if logged in by looking for "Please Login" absence
    const cartUrl = `${ZEPTO_URL}/?cart=open`
    await page.goto(cartUrl, { waitUntil: 'networkidle', timeout: 20000 })
    await page.waitForTimeout(2000)
    const needsLogin = await page.locator('text=Please Login').isVisible().catch(() => false)
    await page.close()

    if (!needsLogin) {
      console.log('[zepto] Using saved session ✅')
      return { browser, context }
    }

    console.log('[zepto] Saved session expired, re-logging in...')
    await context.close()
  } catch {
    console.log('[zepto] No saved session, logging in fresh...')
  }

  // Fresh login
  const context = await browserContext(browser)
  await injectStealth(context)
  await login(context)

  return { browser, context }
}

/** Full login flow: phone → OTP → session saved */
async function login(context: BrowserContext) {
  const phone = process.env.ZEPTO_PHONE
  if (!phone) throw new Error('ZEPTO_PHONE not set in .env')

  const page = await context.newPage()

  // Go to homepage and open cart to trigger login
  await page.goto(ZEPTO_URL, { waitUntil: 'networkidle', timeout: 40000 })
  await page.waitForTimeout(3000)

  // Search + add item to trigger cart → login
  await page.click('[data-testid="search-bar-icon"]')
  await page.waitForTimeout(1500)
  const searchInput = await page.$('input[type="search"], input[placeholder*="earch" i]')
  await searchInput!.fill('water')
  await page.waitForTimeout(2000)
  await page.locator('text=Water').first().click()
  await page.waitForTimeout(3000)
  await page.locator('button', { hasText: 'ADD' }).first().click()
  await page.waitForTimeout(2000)
  await page.locator('text=Cart').first().click()
  await page.waitForTimeout(3000)

  // Click Login
  await page.locator('button', { hasText: 'Login' }).click()
  await page.waitForTimeout(2000)

  // Enter phone number
  await page.fill('input[placeholder="Enter Phone Number"]', phone)
  await page.waitForTimeout(500)
  await page.locator('button', { hasText: 'Continue' }).click()
  await page.waitForTimeout(3000)
  await page.screenshot({ path: '/tmp/zepto-otp-screen.png' })

  console.log(`[zepto] OTP sent to +91${phone} — waiting for provideOtp() call...`)

  // Wait for OTP from agent server
  const otp = await waitForOtp()
  console.log(`[zepto] OTP received: ${otp}`)

  // Enter OTP digits
  const otpInputs = await page.$$('input[maxlength="1"], input[type="number"]')
  if (otpInputs.length >= 4) {
    for (let i = 0; i < otpInputs.length && i < otp.length; i++) {
      await otpInputs[i].fill(otp[i])
      await page.waitForTimeout(100)
    }
  } else {
    // Single OTP input
    const singleInput = await page.$('input[type="tel"], input[inputmode="numeric"]')
    if (singleInput) await singleInput.fill(otp)
  }

  await page.waitForTimeout(3000)
  await page.screenshot({ path: '/tmp/zepto-after-otp.png' })

  // Verify login succeeded
  const stillNeedsLogin = await page.locator('text=Please Login').isVisible().catch(() => false)
  if (stillNeedsLogin) throw new Error('Login failed after OTP — check OTP and retry')

  // Save session
  const storageState = await context.storageState()
  await fs.writeFile(SESSION_FILE, JSON.stringify(storageState, null, 2))
  console.log('[zepto] Session saved ✅')

  await page.close()
}
