/**
 * Grocery Shopping Agent — Telegram Bot
 *
 * Acts as a mock orchestrator for Phase 1.
 * User pays USDC via x402 → bot confirms → mocks Zepto order.
 * Phase 2: replace mockZeptoOrder() with real Chromium automation.
 */

import TelegramBot from 'node-telegram-bot-api'
import { GoatX402Client } from 'goatx402-sdk-server'

const CHAIN_ID = 48816
const USDC_CONTRACT = '0x29d1ee93e9ecf6e50f309f498e40a6b42d352fa1'
const RPC_EXPLORER = 'https://explorer.testnet3.goat.network'

// Grocery catalog — price in USDC
const CATALOG: Record<string, { name: string; priceUsdc: number; emoji: string }> = {
  'mango juice':  { name: 'Mango Juice 200ml',     priceUsdc: 0.5,  emoji: '🥭' },
  'water':        { name: 'Bisleri Water 1L',       priceUsdc: 0.2,  emoji: '💧' },
  'coke':         { name: 'Coca Cola 250ml',        priceUsdc: 0.4,  emoji: '🥤' },
  'coffee':       { name: 'Nescafe Coffee Sachet',  priceUsdc: 0.8,  emoji: '☕' },
  'chips':        { name: "Lay's Chips 26g",        priceUsdc: 0.3,  emoji: '🍟' },
  'energy drink': { name: 'Red Bull 250ml',         priceUsdc: 1.2,  emoji: '⚡' },
  'milk':         { name: 'Amul Full Cream Milk 1L',priceUsdc: 0.6,  emoji: '🥛' },
}

// Active payment polls: orderId → chatId + item info
const pendingOrders = new Map<string, {
  chatId: number
  itemName: string
  priceUsdc: number
}>()

export function startBot(goatx402Client: GoatX402Client) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.warn('[bot] TELEGRAM_BOT_TOKEN not set — bot disabled')
    return
  }

  const bot = new TelegramBot(token, { polling: true })
  console.log('[bot] Telegram bot started (polling)')

  // ── Helpers ──────────────────────────────────────────────────

  function findItem(query: string) {
    const q = query.toLowerCase().trim()
    for (const [key, val] of Object.entries(CATALOG)) {
      if (q.includes(key) || key.includes(q)) return { key, ...val }
    }
    return null
  }

  // Phase 2: replace this with real Chromium automation
  function mockZeptoOrder(itemName: string) {
    console.log(`[mock] 🤖 Chromium would launch Zepto here and order: ${itemName}`)
    return {
      zeptoOrderId: `ZPT-${Date.now()}`,
      item: itemName,
      eta: '10–15 mins',
    }
  }

  async function pollForPayment(orderId: string) {
    const pending = pendingOrders.get(orderId)
    if (!pending) return

    const { chatId, itemName, priceUsdc } = pending
    const maxAttempts = 40 // ~2 minutes at 3s intervals
    let attempts = 0

    const interval = setInterval(async () => {
      attempts++

      if (attempts > maxAttempts) {
        clearInterval(interval)
        pendingOrders.delete(orderId)
        bot.sendMessage(chatId,
          `⏱ Payment timeout for order \`${orderId}\`.\nOrder cancelled — try again with /order.`,
          { parse_mode: 'Markdown' }
        )
        return
      }

      try {
        const status = await goatx402Client.getOrderStatus(orderId)

        if (status.status === 'PAYMENT_CONFIRMED' || status.status === 'INVOICED') {
          clearInterval(interval)
          pendingOrders.delete(orderId)

          // Confirm payment
          await bot.sendMessage(chatId,
            `✅ *Payment confirmed!*\n` +
            `💰 ${priceUsdc} USDC received\n` +
            (status.txHash
              ? `🔗 [View TX](${RPC_EXPLORER}/tx/${status.txHash})\n`
              : '') +
            `\n🛒 Placing your order on Zepto...`,
            { parse_mode: 'Markdown' }
          )

          // Mock Zepto automation
          await new Promise(r => setTimeout(r, 1500))
          const zepto = mockZeptoOrder(itemName)

          bot.sendMessage(chatId,
            `📦 *Order Placed!*\n\n` +
            `Item: ${itemName}\n` +
            `Zepto Order ID: \`${zepto.zeptoOrderId}\`\n` +
            `ETA: ${zepto.eta}\n\n` +
            `_[Mock] Real Chromium automation coming in Phase 2_`,
            { parse_mode: 'Markdown' }
          )

        } else if (status.status === 'FAILED' || status.status === 'EXPIRED' || status.status === 'CANCELLED') {
          clearInterval(interval)
          pendingOrders.delete(orderId)
          bot.sendMessage(chatId,
            `❌ Payment ${status.status.toLowerCase()}.\nTry again with /order.`
          )
        }
      } catch {
        // silently retry
      }
    }, 3000)
  }

  // ── Commands ─────────────────────────────────────────────────

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `🐐 *Grocery Shopping Agent*\n\n` +
      `I order groceries from Zepto using crypto payments.\n\n` +
      `*Commands:*\n` +
      `/order <item> — order an item (pay with USDC)\n` +
      `/catalog — see available items & prices\n` +
      `/status <orderId> — check payment status\n\n` +
      `_Powered by x402 + ERC-8004 on GOAT Network_`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/catalog/, (msg) => {
    const list = Object.values(CATALOG)
      .map(v => `${v.emoji} ${v.name} — \`${v.priceUsdc} USDC\``)
      .join('\n')
    bot.sendMessage(msg.chat.id,
      `🛒 *Available Items:*\n\n${list}\n\n` +
      `Use /order <item name> to order`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/order (.+)/, async (msg, match) => {
    const chatId = msg.chat.id
    const query = match![1]
    const item = findItem(query)

    if (!item) {
      return bot.sendMessage(chatId,
        `❓ Couldn't find *"${query}"* in the catalog.\nTry /catalog to see what's available.`,
        { parse_mode: 'Markdown' }
      )
    }

    try {
      const amountWei = Math.floor(item.priceUsdc * 1e6).toString()

      const order = await goatx402Client.createOrder({
        dappOrderId: `tg-${chatId}-${Date.now()}`,
        chainId: CHAIN_ID,
        tokenSymbol: 'USDC',
        tokenContract: USDC_CONTRACT,
        fromAddress: '0x0000000000000000000000000000000000000000',
        amountWei,
      })

      pendingOrders.set(order.orderId, {
        chatId,
        itemName: item.name,
        priceUsdc: item.priceUsdc,
      })

      await bot.sendMessage(chatId,
        `${item.emoji} *${item.name}*\n\n` +
        `💳 *Payment Required (x402)*\n\n` +
        `Amount: \`${item.priceUsdc} USDC\`\n` +
        `Pay to: \`${order.payToAddress}\`\n` +
        `Order ID: \`${order.orderId}\`\n\n` +
        `*Pay via cast (GOAT Testnet3):*\n` +
        `\`\`\`\ncast send ${USDC_CONTRACT} \\\n` +
        `  "transfer(address,uint256)" \\\n` +
        `  ${order.payToAddress} ${amountWei} \\\n` +
        `  --rpc-url https://rpc.testnet3.goat.network \\\n` +
        `  --priority-gas-price 130000 --gas-price 1000000 \\\n` +
        `  --private-key $YOUR_PK\n\`\`\`\n\n` +
        `⏳ Waiting for payment... (2 min timeout)`,
        { parse_mode: 'Markdown' }
      )

      pollForPayment(order.orderId)

    } catch (err) {
      const msg2 = err instanceof Error ? err.message : 'Unknown error'
      bot.sendMessage(chatId, `❌ Failed to create order: ${msg2}`)
    }
  })

  bot.onText(/\/status (.+)/, async (msg, match) => {
    const chatId = msg.chat.id
    const orderId = match![1].trim()

    try {
      const status = await goatx402Client.getOrderStatus(orderId)
      bot.sendMessage(chatId,
        `📊 *Payment Status*\n\n` +
        `Order ID: \`${orderId}\`\n` +
        `Status: \`${status.status}\`\n` +
        (status.txHash ? `TX: \`${status.txHash}\`\n` : '') +
        (status.confirmedAt ? `Confirmed: ${new Date(status.confirmedAt).toLocaleString()}` : ''),
        { parse_mode: 'Markdown' }
      )
    } catch {
      bot.sendMessage(chatId, `❌ Order not found: \`${orderId}\``, { parse_mode: 'Markdown' })
    }
  })

  bot.on('polling_error', (err) => {
    console.error('[bot] Polling error:', err.message)
  })

  return bot
}
