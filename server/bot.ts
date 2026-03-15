/**
 * Grocery Shopping Bot — Telegram
 *
 * Flow:
 *   /search <query> → pick product → x402 payment on GOAT Network → Zepto order placed
 */

import TelegramBot from 'node-telegram-bot-api'
import { ethers } from 'ethers'
import { GoatX402Client } from 'goatx402-sdk-server'
import { getZeptoSession, provideOtp } from './zepto/session.js'
import { placeZeptoOrder } from './zepto/order.js'
import { searchZeptoProducts } from './zepto/search.js'
import type { ZeptoProduct } from './zepto/search.js'
import type { BrowserContext } from 'playwright'

// ── Chain config ──────────────────────────────────────────────
const CHAIN_ID      = 48816
const USDC_CONTRACT = '0x29d1ee93e9ecf6e50f309f498e40a6b42d352fa1'
const GOAT_RPC      = 'https://rpc.testnet3.goat.network'
const RPC_EXPLORER  = 'https://explorer.testnet3.goat.network'
const USDC_ABI      = ['function transfer(address to, uint256 amount) returns (bool)']
const PRICE_USDC    = 0.1

const goatx402Client = new GoatX402Client({
  baseUrl:   process.env.GOATX402_API_URL!,
  apiKey:    process.env.GOATX402_API_KEY!,
  apiSecret: process.env.GOATX402_API_SECRET!,
})

async function payOnChain(payToAddress: string, amountWei: string): Promise<string> {
  const pk = process.env.USER_WALLET_PRIVATE_KEY
  if (!pk) throw new Error('USER_WALLET_PRIVATE_KEY not set in .env')
  const provider = new ethers.JsonRpcProvider(GOAT_RPC)
  const wallet   = new ethers.Wallet(pk, provider)
  const usdc     = new ethers.Contract(USDC_CONTRACT, USDC_ABI, wallet)
  const tx = await usdc.transfer(payToAddress, BigInt(amountWei), {
    gasLimit: 100000n,
    gasPrice: 1000000n,
  })
  await tx.wait()
  return tx.hash as string
}

async function waitForConfirmation(orderId: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await goatx402Client.getOrderStatus(orderId)
    if (status.status === 'PAYMENT_CONFIRMED' || status.status === 'INVOICED') return
    if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(status.status)) {
      throw new Error(`Payment ${status.status}`)
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  throw new Error('Payment confirmation timeout')
}

// ── Zepto session ─────────────────────────────────────────────
let zeptoContext: BrowserContext | null = null

// ── Pending searches ──────────────────────────────────────────
const pendingSearches = new Map<number, ZeptoProduct[]>()

export function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.warn('[bot] TELEGRAM_BOT_TOKEN not set — bot disabled')
    return
  }

  const bot = new TelegramBot(token, { polling: true })
  console.log('[bot] Telegram bot started (polling)')

  async function getSession(chatId: number) {
    if (!zeptoContext) {
      const result = await getZeptoSession(() => {
        bot.sendMessage(chatId,
          `📱 *OTP sent to your phone.*\nReply with \`/otp <code>\` to continue Zepto login.`,
          { parse_mode: 'Markdown' }
        )
      })
      zeptoContext = result.context
    }
    return zeptoContext
  }

  // ── Commands ──────────────────────────────────────────────────

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `🛒 *Zepto Shopping Bot*\n\n` +
      `I order groceries from Zepto — paid via x402 on GOAT Network.\n\n` +
      `*Commands:*\n` +
      `/search <query> — search Zepto & pick a product\n` +
      `/cancel — cancel active search\n` +
      `/otp <code> — submit Zepto OTP when prompted`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/otp (.+)/, (msg, match) => {
    provideOtp(match![1].trim())
    bot.sendMessage(msg.chat.id, `✅ OTP submitted.`)
  })

  bot.onText(/\/cancel/, (msg) => {
    pendingSearches.delete(msg.chat.id)
    bot.sendMessage(msg.chat.id, `❌ Search cancelled.`)
  })

  bot.onText(/\/search (.+)/, async (msg, match) => {
    const chatId = msg.chat.id
    const query  = match![1].trim()

    await bot.sendMessage(chatId, `🔍 Searching Zepto for *"${query}"*...`, { parse_mode: 'Markdown' })

    try {
      const context  = await getSession(chatId)
      const products = await searchZeptoProducts(context, query)

      if (products.length === 0) {
        return bot.sendMessage(chatId, `❌ No products found for *"${query}"*.`, { parse_mode: 'Markdown' })
      }

      pendingSearches.set(chatId, products)

      const list = products.map((p, i) => `*${i + 1}.* ${p.name} — ${p.price}`).join('\n')

      await bot.sendMessage(chatId,
        `🛒 *Results for "${query}":*\n\n${list}\n\n` +
        `Reply with a number to order, or /cancel to abort.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      bot.sendMessage(chatId, `❌ Search failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  })

  // Number selection → payment → Zepto order
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id
    const text   = msg.text?.trim()
    if (!text || text.startsWith('/') || !pendingSearches.has(chatId)) return

    const num      = parseInt(text, 10)
    const products = pendingSearches.get(chatId)!

    if (isNaN(num) || num < 1 || num > products.length) {
      return bot.sendMessage(chatId,
        `Please reply with a number between 1 and ${products.length}, or /cancel.`
      )
    }

    const selected = products[num - 1]
    pendingSearches.delete(chatId)

    await bot.sendMessage(chatId,
      `✅ *${selected.name}* (${selected.price})\n\n⏳ Initiating x402 payment...`,
      { parse_mode: 'Markdown' }
    )

    try {
      const amountWei = Math.floor(PRICE_USDC * 1e6).toString()

      // Step 1: Create x402 order
      const order = await goatx402Client.createOrder({
        dappOrderId:   `tg-${chatId}-${Date.now()}`,
        chainId:       CHAIN_ID,
        tokenSymbol:   'USDC',
        tokenContract: USDC_CONTRACT,
        fromAddress:   new ethers.Wallet(process.env.USER_WALLET_PRIVATE_KEY!).address,
        amountWei,
      })

      await bot.sendMessage(chatId,
        `💳 *x402 Order Created*\n` +
        `Order ID: \`${order.orderId}\`\n` +
        `Amount: \`${PRICE_USDC} USDC\`\n\n` +
        `⏳ Paying on-chain...`,
        { parse_mode: 'Markdown' }
      )

      // Step 2: Pay on-chain
      const txHash = await payOnChain(order.payToAddress, amountWei)

      await bot.sendMessage(chatId,
        `✅ *Payment Sent!*\n` +
        `🔗 [View TX](${RPC_EXPLORER}/tx/${txHash})\n\n` +
        `⏳ Waiting for confirmation...`,
        { parse_mode: 'Markdown' }
      )

      // Step 3: Wait for confirmation
      await waitForConfirmation(order.orderId)

      await bot.sendMessage(chatId, `✅ *Payment confirmed!*\n\n🛒 Placing order on Zepto...`, { parse_mode: 'Markdown' })

      // Step 4: Place Zepto order
      const context = await getSession(chatId)
      const zepto   = await placeZeptoOrder(context, selected.name, selected.url)

      bot.sendMessage(chatId,
        `📦 *Order Placed!*\n\n` +
        `Item: ${zepto.item}\n` +
        `Price: ${zepto.price}\n` +
        `ETA: ${zepto.eta}\n` +
        `Zepto Order ID: \`${zepto.zeptoOrderId}\``,
        { parse_mode: 'Markdown' }
      )

    } catch (err) {
      bot.sendMessage(chatId, `❌ Order failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  })
}
