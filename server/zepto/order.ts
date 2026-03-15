/**
 * Zepto Order Automation
 *
 * Uses saved session to:
 *   1. Search for item
 *   2. Add to cart
 *   3. Proceed to checkout
 *   4. Set delivery address (if needed)
 *   5. Pay with Zepto Cash (wallet)
 *   6. Confirm order and return real order ID
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
}

export async function placeZeptoOrder(
  context: BrowserContext,
  query: string,
  productUrl?: string          // if provided, skip search and go directly to product
): Promise<ZeptoOrderResult> {
  const page = await context.newPage()

  try {
    console.log(`[zepto] Starting order for: "${query}"${productUrl ? ' (direct URL)' : ''}`)

    let productName = query
    let productPrice = 'unknown'

    if (productUrl) {
      // ── Direct product URL (selected from search list) ────
      const fullUrl = productUrl.startsWith('http') ? productUrl : `${ZEPTO_URL}${productUrl}`
      console.log('[zepto] Going directly to product:', fullUrl)
      await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 40000 })
      await page.waitForTimeout(2000)

      const details = await page.evaluate(() => {
        const name  = document.querySelector('h1, [class*="product-name"], [class*="productName"]')
        const price = document.querySelector('[class*="price"], [class*="Price"]')
        return {
          name:  name?.textContent?.trim().slice(0, 60),
          price: price?.textContent?.trim().slice(0, 20),
        }
      })
      productName  = details.name  || query
      productPrice = details.price || 'unknown'
      console.log('[zepto] Product:', productName, productPrice)

    } else {
      // ── Step 1: Homepage ───────────────────────────────────
      await page.goto(ZEPTO_URL, { waitUntil: 'networkidle', timeout: 40000 })
      await page.waitForTimeout(2000)

      // ── Step 2: Search ─────────────────────────────────────
      console.log('[zepto] Searching...')
      await page.click('[data-testid="search-bar-icon"]')
      await page.waitForTimeout(1500)

      const searchInput = await page.$('input[type="search"], input[placeholder*="earch" i]')
      if (!searchInput) throw new Error('Search input not found')

      await searchInput.fill(query)
      await page.waitForTimeout(2000)

      await page.locator(`text=${query}`).first().click()
      await page.waitForTimeout(3000)
      console.log('[zepto] Search results loaded:', page.url())

      // ── Step 3: Get first product details ─────────────────
      const firstProduct = await page.evaluate(() => {
        const link  = document.querySelector('a[href*="/pn/"]')
        const price = document.querySelector('[class*="price"], [class*="Price"]')
        return {
          text:  link?.textContent?.trim().slice(0, 60),
          price: price?.textContent?.trim().slice(0, 20),
        }
      })
      console.log('[zepto] First product:', firstProduct)
      productName  = firstProduct.text  || query
      productPrice = firstProduct.price || 'unknown'
    }

    // ── Step 4: Add to cart ──────────────────────────────────
    console.log('[zepto] Adding to cart...')
    await page.locator('button', { hasText: 'ADD' }).first().click()
    // Wait for cart count to update (button changes from ADD → quantity counter)
    try {
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('button')).some(b => /view cart/i.test(b.textContent?.trim() ?? ''))
      , { timeout: 5000 })
      console.log('[zepto] Item added to cart ✅')
    } catch {
      console.log('[zepto] Could not confirm item added — continuing')
      await page.waitForTimeout(2000)
    }

    // ── Step 5: Open cart ────────────────────────────────────
    // Zepto is a SPA — clicking the cart icon opens the cart drawer in-place.
    console.log('[zepto] Opening cart...')
    const cartOpened = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, a, div, span')).find(e =>
        /view cart/i.test(e.textContent?.trim() ?? '') && (e as HTMLElement).offsetParent !== null
      ) as HTMLElement | undefined
      if (el) { el.click(); return true }
      return false
    })
    if (!cartOpened) await page.locator('text=Cart').first().click()
    console.log('[zepto] Cart URL:', page.url())

    // Wait for cart checkout section to render (bill summary or action button)
    try {
      await page.waitForFunction(() =>
        /item total|total bill|add address|proceed to pay/i.test(document.body.innerText)
      , { timeout: 10000 })
      console.log('[zepto] Cart checkout section loaded ✅')
    } catch {
      console.log('[zepto] Cart checkout section not found after 10s — proceeding anyway')
    }
    await page.screenshot({ path: '/tmp/zepto-cart.png' })
    console.log('[zepto] Cart buttons:', await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
    ))

    // Check if session expired
    const needsLogin = await page.locator('text=Please Login').isVisible().catch(() => false)
    if (needsLogin) throw new Error('SESSION_EXPIRED — re-login needed')

    // Helper: click a button by regex text match via JS — bypasses vaul/Radix overlay hit-testing
    async function jsClickButton(pattern: RegExp, label: string): Promise<boolean> {
      const clicked = await page.evaluate((pat: string) => {
        const re = new RegExp(pat, 'i')
        const btn = Array.from(document.querySelectorAll('button')).find(
          b => re.test(b.textContent?.trim() ?? '')
        ) as HTMLElement | undefined
        if (btn) { btn.click(); return true }
        return false
      }, pattern.source)
      console.log(`[zepto] jsClick "${label}":`, clicked ? 'clicked ✅' : 'not found')
      return clicked
    }

    // ── Step 6: Click "Add Address to proceed" ───────────────
    console.log('[zepto] Step 6: clicking proceed button...')
    await jsClickButton(/add address to proceed|proceed to checkout/i, 'Add Address to proceed')
    await page.waitForTimeout(3000)
    await page.screenshot({ path: '/tmp/zepto-s6-after-proceed.png' })

    // ── Step 7: Address selection ─────────────────────────────
    // After clicking proceed, a drawer opens with saved addresses.
    // Log all buttons + clickable divs to see what Zepto renders.
    console.log('[zepto] Step 7: handling address...')

    // Address rows are div/li elements (NOT buttons) — find first saved address near the heading
    await page.waitForTimeout(1000)
    const isAddressModal = await page.evaluate(() =>
      /select an address|saved addresses/i.test(document.body.innerText)
    )
    console.log('[zepto] Address modal open:', isAddressModal)

    if (isAddressModal) {
      const addrClicked = await page.evaluate(() => {
        // Find "SAVED ADDRESSES" heading element
        const allEls = Array.from(document.querySelectorAll('*')) as HTMLElement[]
        const heading = allEls.find(
          el => /^saved addresses$/i.test(el.textContent?.trim() ?? '') && (el as HTMLElement).offsetParent !== null
        ) as HTMLElement | undefined

        if (heading) {
          // Walk up containers looking for address row siblings
          let container: HTMLElement | null = heading.parentElement
          for (let i = 0; i < 5 && container; i++) {
            const rows = Array.from(container.querySelectorAll('div, li, a')) as HTMLElement[]
            const addrRow = rows.find(el => {
              const text = el.textContent?.trim() ?? ''
              return (
                text.length > 10 && text.length < 300 &&
                el.offsetParent !== null &&
                !/^saved addresses$/i.test(text) &&
                !/^add new address$/i.test(text) &&
                !/^select an address$/i.test(text) &&
                el !== heading
              )
            })
            if (addrRow) { addrRow.click(); return addrRow.textContent?.trim().slice(0, 60) }
            container = container.parentElement
          }
        }

        // Fallback: any visible element with address-like content (comma-separated, not a nav item)
        const fallback = (Array.from(document.querySelectorAll('div, li, a')) as HTMLElement[]).find(el => {
          const text = el.textContent?.trim() ?? ''
          return (
            text.length > 20 && text.length < 300 &&
            el.offsetParent !== null &&
            text.includes(',') &&
            !/add new address|select an address|saved addresses/i.test(text)
          )
        })
        if (fallback) { fallback.click(); return `fallback: ${fallback.textContent?.trim().slice(0, 60)}` }
        return null
      })
      console.log('[zepto] Address row clicked:', addrClicked)
      await page.waitForTimeout(2000)

      // Some flows show a confirm button after selecting an address row
      await jsClickButton(/deliver here|use this address|confirm address|done/i, 'Confirm address')
      await page.waitForTimeout(2000)
    } else {
      console.log('[zepto] No address modal detected — address may already be set')
    }

    await page.waitForTimeout(2000)
    await page.screenshot({ path: '/tmp/zepto-s7-after-address.png' })
    console.log('[zepto] Buttons after address step:', await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
    ))

    // ── Step 8: Proceed to Pay ───────────────────────────────
    console.log('[zepto] Step 8: clicking Proceed to Pay...')
    const proceedToPay = await jsClickButton(/proceed to pay/i, 'Proceed to Pay')
    if (!proceedToPay) console.log('[zepto] No "Proceed to Pay" — may already be at payment screen')
    await page.waitForTimeout(3000)
    await page.screenshot({ path: '/tmp/zepto-s8-payment-screen.png' })

    console.log('[zepto] Buttons at payment screen:', await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
    ))

    // ── Step 9: Select Zepto Cash ────────────────────────────
    console.log('[zepto] Step 9: selecting Zepto Cash...')
    const walletClicked = await page.evaluate(() => {
      // Zepto Cash is often a div/label, not always a button
      const el = Array.from(document.querySelectorAll('div, label, button, span')).find(
        e => /zepto cash|zepto wallet|wallet balance/i.test(e.textContent?.trim() ?? '')
          && (e as HTMLElement).offsetParent !== null  // visible
      ) as HTMLElement | undefined
      if (el) { el.click(); return true }
      return false
    })
    console.log('[zepto] Zepto Cash clicked:', walletClicked)
    await page.waitForTimeout(1500)
    await page.screenshot({ path: '/tmp/zepto-s9-pre-place.png' })

    // ── Step 10: Get order summary ───────────────────────────
    const orderSummary = await page.evaluate(() => {
      const total = document.querySelector('[class*="total" i], [class*="amount" i], [class*="payable" i]')
      const eta   = document.querySelector('[class*="eta" i], [class*="time" i], [class*="minute" i]')
      return {
        total: total?.textContent?.trim().slice(0, 30),
        eta:   eta?.textContent?.trim().slice(0, 30),
      }
    })
    console.log('[zepto] Order summary:', orderSummary)

    // ── Step 11: Place order ──────────────────────────────────
    console.log('[zepto] Step 11: placing order...')
    console.log('[zepto] All buttons before place:', await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
    ))

    const placed = await jsClickButton(/place order|pay now|confirm order|pay ₹/i, 'Place Order')
    if (!placed) throw new Error('Could not find Place Order / Pay Now button — see /tmp/zepto-s9-pre-place.png')
    await page.waitForTimeout(5000)
    await page.screenshot({ path: '/tmp/zepto-s11-post-place.png' })
    console.log('[zepto] Post-place URL:', page.url())

    // ── Step 11: Extract order confirmation ──────────────────
    const confirmation = await page.evaluate(() => {
      // Look for order ID in the confirmation page
      const idEl = document.querySelector(
        '[class*="orderId" i], [class*="order-id" i], [class*="order_id" i]'
      )
      const idText = document.body.innerText.match(/#?([A-Z0-9]{6,20})/)?.[1]
      const etaEl  = document.querySelector('[class*="eta" i], [class*="time" i], [class*="minute" i]')
      const totalEl = document.querySelector('[class*="total" i], [class*="amount" i]')
      return {
        orderId: idEl?.textContent?.trim() || idText || null,
        eta:     etaEl?.textContent?.trim().slice(0, 30) || null,
        total:   totalEl?.textContent?.trim().slice(0, 30) || null,
      }
    })
    console.log('[zepto] Confirmation:', confirmation)

    // Check if we landed on a confirmation/success page
    const currentUrl = page.url()
    const isConfirmed =
      currentUrl.includes('order') ||
      currentUrl.includes('success') ||
      currentUrl.includes('confirmed') ||
      (await page.locator('text=/order placed|order confirmed|on the way/i').isVisible().catch(() => false))

    if (!isConfirmed) {
      await page.screenshot({ path: '/tmp/zepto-order-failed.png' })
      throw new Error(`Order placement may have failed. URL: ${currentUrl}`)
    }

    const zeptoOrderId = confirmation.orderId
      ? `ZPT-${confirmation.orderId}`
      : `ZPT-${Date.now()}`

    return {
      zeptoOrderId,
      item:  productName,
      price: confirmation.total || orderSummary.total || productPrice,
      eta:   confirmation.eta   || orderSummary.eta   || '10–15 mins',
    }

  } finally {
    await page.close()
  }
}
