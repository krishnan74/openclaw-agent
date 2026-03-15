/**
 * Zepto Product Search
 *
 * Searches Zepto for a query and returns a list of matching products.
 * Used by the bot to show options before ordering.
 */

import { BrowserContext } from 'playwright'

const ZEPTO_URL = 'https://www.zepto.com'

export interface ZeptoProduct {
  name: string
  price: string
  url: string
}

export async function searchZeptoProducts(
  context: BrowserContext,
  query: string,
  limit = 5
): Promise<ZeptoProduct[]> {
  const page = await context.newPage()

  try {
    console.log(`[zepto:search] Searching for: "${query}"`)

    await page.goto(ZEPTO_URL, { waitUntil: 'networkidle', timeout: 40000 })
    await page.waitForTimeout(2000)

    // Open search
    await page.click('[data-testid="search-bar-icon"]')
    await page.waitForTimeout(1500)

    const searchInput = await page.$('input[type="search"], input[placeholder*="earch" i]')
    if (!searchInput) throw new Error('Search input not found')

    await searchInput.fill(query)
    await page.waitForTimeout(2000)

    // Click first suggestion to go to results page
    await page.locator(`text=${query}`).first().click()
    await page.waitForTimeout(3000)

    await page.screenshot({ path: '/tmp/zepto-search-results.png' })
    console.log('[zepto:search] Results URL:', page.url())

    // Extract product list
    const products = await page.evaluate((max: number) => {
      const results: { name: string; price: string; url: string }[] = []
      const links = Array.from(document.querySelectorAll('a[href*="/pn/"]'))

      for (const link of links) {
        const href = link.getAttribute('href') || ''
        const rawName = link.textContent?.trim() ?? ''
        const name = rawName
          .replace(/ADD/g, '')                              // ADD button text
          .replace(/₹\s?\d+(\.\d+)?\s*(OFF|off)?/g, '')   // ₹30, ₹5OFF
          .replace(/\d+\.?\d*\s*(pc|pcs|ml|g|kg|L|ltr|litre|liters?)\b.*/i, '') // "1 pc (600ml)..." onwards
          .replace(/\d+\.\d+\s*\(\d+.*/, '')               // "4.6(175.9k)" rating onwards
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80)

        // Walk up to find a card container, then search broadly for ₹ price text
        let price = '—'
        let container: Element | null = link.parentElement
        for (let i = 0; i < 6 && container; i++) {
          // Look for any element whose text is just a ₹ price (e.g. "₹45" or "₹45.00")
          const priceEl = Array.from(container.querySelectorAll('*')).find(el => {
            const t = el.textContent?.trim() ?? ''
            return /^₹\s?\d/.test(t) && t.length < 15 && el.children.length === 0
          })
          if (priceEl) { price = priceEl.textContent?.trim() ?? '—'; break }
          container = container.parentElement
        }

        if (name && href && !results.find(r => r.url === href)) {
          results.push({ name, price, url: href })
        }
        if (results.length >= max) break
      }
      return results
    }, limit)

    console.log(`[zepto:search] Found ${products.length} products`)
    return products

  } finally {
    await page.close()
  }
}
