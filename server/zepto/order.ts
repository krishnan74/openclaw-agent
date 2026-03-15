/**
 * Zepto Order Automation
 *
 * Uses saved session to:
 *   1. Search for item
 *   2. Add to cart
 *   3. Proceed to checkout
 *   4. Set delivery address
 *   5. Place order (payment handled by virtual card — Phase 2.5)
 *
 * Returns: { zeptoOrderId, item, price, eta }
 */

import { BrowserContext } from 'playwright'

const ZEPTO_URL = 'https://www.zepto.com'

export interface ZeptoOrderResult {
  zeptoOrderId: string
  item: string
  price: string
  eta: string
  screenshot?: string
}

export async function placeZeptoOrder(
  context: BrowserContext,
  query: string
): Promise<ZeptoOrderResult> {
  const page = await context.newPage()

  try {
    console.log(`[zepto] Starting order for: "${query}"`)

    // ── Step 1: Go to homepage ──────────────────────────────
    await page.goto(ZEPTO_URL, { waitUntil: 'networkidle', timeout: 40000 })
    await page.waitForTimeout(2000)

    // ── Step 2: Search ──────────────────────────────────────
    console.log('[zepto] Searching...')
    await page.click('[data-testid="search-bar-icon"]')
    await page.waitForTimeout(1500)

    const searchInput = await page.$('input[type="search"], input[placeholder*="earch" i]')
    if (!searchInput) throw new Error('Search input not found')

    await searchInput.fill(query)
    await page.waitForTimeout(2000)

    // Click first suggestion
    await page.locator(`text=${query}`).first().click()
    await page.waitForTimeout(3000)
    console.log('[zepto] Search results loaded:', page.url())

    // ── Step 3: Get first product details ──────────────────
    const firstProduct = await page.evaluate(() => {
      const link = document.querySelector('a[href*="/pn/"]')
      const price = document.querySelector('[class*="price"], [class*="Price"]')
      return {
        href: link?.getAttribute('href'),
        text: link?.textContent?.trim().slice(0, 60),
        price: price?.textContent?.trim().slice(0, 20),
      }
    })
    console.log('[zepto] First product:', firstProduct)

    // ── Step 4: Add to cart ─────────────────────────────────
    console.log('[zepto] Adding to cart...')
    await page.locator('button', { hasText: 'ADD' }).first().click()
    await page.waitForTimeout(2000)

    // Get price from cart button
    const cartText = await page.locator('text=Cart').first().textContent().catch(() => '')
    console.log('[zepto] Cart:', cartText)

    // ── Step 5: Open cart ───────────────────────────────────
    console.log('[zepto] Opening cart...')
    await page.locator('text=Cart').first().click()
    await page.waitForTimeout(3000)
    await page.screenshot({ path: '/tmp/zepto-cart-view.png' })

    // Check if login required
    const needsLogin = await page.locator('text=Please Login').isVisible().catch(() => false)
    if (needsLogin) throw new Error('SESSION_EXPIRED — call POST /otp to re-login')

    // ── Step 6: Proceed to checkout ─────────────────────────
    console.log('[zepto] Proceeding to checkout...')
    const checkoutBtn = page.locator('button', { hasText: /proceed|checkout|place order/i }).first()
    await checkoutBtn.click()
    await page.waitForTimeout(3000)
    await page.screenshot({ path: '/tmp/zepto-checkout.png' })
    console.log('[zepto] Checkout URL:', page.url())

    // ── Step 7: Set delivery address ────────────────────────
    console.log('[zepto] Setting delivery address...')
    const address = process.env.ZEPTO_ADDRESS!
    const pincode = process.env.ZEPTO_PINCODE!

    // Check if address selection is needed
    const addAddressBtn = page.locator('text=Add Address, text=Add new address').first()
    const addressVisible = await addAddressBtn.isVisible().catch(() => false)

    if (addressVisible) {
      await addAddressBtn.click()
      await page.waitForTimeout(2000)

      // Enter pincode
      const pincodeInput = await page.$('input[placeholder*="pincode" i], input[placeholder*="PIN" i], input[maxlength="6"]')
      if (pincodeInput) {
        await pincodeInput.fill(pincode)
        await page.waitForTimeout(2000)
      }

      // Fill address fields
      const addressInput = await page.$('input[placeholder*="address" i], textarea[placeholder*="address" i]')
      if (addressInput) {
        await addressInput.fill(address)
        await page.waitForTimeout(1000)
      }

      await page.screenshot({ path: '/tmp/zepto-address.png' })
    }

    await page.waitForTimeout(2000)
    await page.screenshot({ path: '/tmp/zepto-pre-payment.png' })

    // ── Step 8: Get order summary ───────────────────────────
    const orderSummary = await page.evaluate(() => {
      const total = document.querySelector('[class*="total" i], [class*="amount" i]')
      const eta = document.querySelector('[class*="eta" i], [class*="time" i], [class*="minute" i]')
      return {
        total: total?.textContent?.trim().slice(0, 30),
        eta: eta?.textContent?.trim().slice(0, 30),
      }
    })
    console.log('[zepto] Order summary:', orderSummary)

    // ── Phase 2.5: Payment (virtual card) ──────────────────
    // TODO: Add virtual card payment here
    // For now, capture the state before payment
    const finalScreenshot = '/tmp/zepto-ready-to-pay.png'
    await page.screenshot({ path: finalScreenshot })

    return {
      zeptoOrderId: `ZPT-PENDING-${Date.now()}`,
      item: firstProduct.text || query,
      price: orderSummary.total || firstProduct.price || 'unknown',
      eta: orderSummary.eta || '10–15 mins',
    }

  } finally {
    await page.close()
  }
}
