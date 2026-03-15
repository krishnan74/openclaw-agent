/**
 * Grocery Shopping Agent — External HTTP Server
 *
 * Exposed publicly via ngrok so OpenClaw can call it.
 *
 * Flow:
 *   OpenClaw → POST /order → x402 payment → mock Zepto → JSON response
 *
 * Endpoints:
 *   GET  /health          — liveness check
 *   GET  /catalog         — list available items + prices
 *   POST /order           — place order (auto-pays via x402)
 *   GET  /status/:orderId — check payment + order status
 */

import express from 'express'
import cors from 'cors'
import { ethers } from 'ethers'
import { GoatX402Client } from 'goatx402-sdk-server'
import ngrok from '@ngrok/ngrok'
import 'dotenv/config'
import { getZeptoSession, provideOtp } from './zepto/session.js'
import { placeZeptoOrder } from './zepto/order.js'
import type { Browser, BrowserContext } from 'playwright'

// Zepto browser session (reused across orders)
let zeptoBrowser: Browser | null = null
let zeptoContext: BrowserContext | null = null

async function getSession() {
  if (!zeptoContext) {
    const result = await getZeptoSession()
    zeptoBrowser = result.browser
    zeptoContext  = result.context
  }
  return zeptoContext
}

const app = express()
const port = process.env.AGENT_PORT || 3002

app.use(cors())
app.use(express.json())

// ── Config ────────────────────────────────────────────────────

const CHAIN_ID      = 48816
const USDC_CONTRACT = '0x29d1ee93e9ecf6e50f309f498e40a6b42d352fa1'
const GOAT_RPC      = 'https://rpc.testnet3.goat.network'
const EXPLORER      = 'https://explorer.testnet3.goat.network'
const USDC_ABI      = ['function transfer(address to, uint256 amount) returns (bool)']

const goatx402Client = new GoatX402Client({
  baseUrl:   process.env.GOATX402_API_URL!,
  apiKey:    process.env.GOATX402_API_KEY!,
  apiSecret: process.env.GOATX402_API_SECRET!,
})

// ── Catalog ───────────────────────────────────────────────────

const CATALOG: Record<string, { name: string; priceUsdc: number; emoji: string }> = {
  'mango juice':  { name: 'Mango Juice 200ml',      priceUsdc: 0.001, emoji: '🥭' },
  'water':        { name: 'Bisleri Water 1L',        priceUsdc: 0.001, emoji: '💧' },
  'coke':         { name: 'Coca Cola 250ml',         priceUsdc: 0.001, emoji: '🥤' },
  'coffee':       { name: 'Nescafe Coffee Sachet',   priceUsdc: 0.001, emoji: '☕' },
  'chips':        { name: "Lay's Chips 26g",         priceUsdc: 0.001, emoji: '🍟' },
  'energy drink': { name: 'Red Bull 250ml',          priceUsdc: 0.001, emoji: '⚡' },
  'milk':         { name: 'Amul Full Cream Milk 1L', priceUsdc: 0.001, emoji: '🥛' },
}

function findItem(query: string) {
  const q = query.toLowerCase().trim()
  for (const [key, val] of Object.entries(CATALOG)) {
    if (q.includes(key) || key.includes(q)) return { key, ...val }
  }
  return null
}

// ── Payment ───────────────────────────────────────────────────

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

async function waitForConfirmation(orderId: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await goatx402Client.getOrderStatus(orderId)
    if (status.status === 'PAYMENT_CONFIRMED' || status.status === 'INVOICED') {
      return status.status
    }
    if (status.status === 'FAILED' || status.status === 'EXPIRED' || status.status === 'CANCELLED') {
      throw new Error(`Payment ${status.status}`)
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  throw new Error('Payment confirmation timeout')
}

async function runZeptoOrder(itemName: string) {
  const context = await getSession()
  return placeZeptoOrder(context, itemName)
}

// ── Routes ────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'grocery-shopping-agent', chain: 'GOAT Testnet3' })
})

// Catalog
app.get('/catalog', (_req, res) => {
  const items = Object.entries(CATALOG).map(([key, val]) => ({
    key,
    name:      val.name,
    emoji:     val.emoji,
    priceUsdc: val.priceUsdc,
  }))
  res.json({ items })
})

/**
 * POST /order
 * Body: { item: "mango juice" }
 *
 * Full flow:
 *   1. Find item in catalog
 *   2. Create x402 order
 *   3. Pay on-chain autonomously
 *   4. Wait for confirmation
 *   5. Mock Zepto order
 *   6. Return result
 */
app.post('/order', async (req, res) => {
  const { item: query } = req.body

  if (!query) {
    return res.status(400).json({ error: 'Missing "item" in request body' })
  }

  const item = findItem(query)
  if (!item) {
    return res.status(404).json({
      error: `Item "${query}" not found in catalog`,
      suggestion: 'Call GET /catalog to see available items',
    })
  }

  console.log(`\n[agent] Order received: "${query}" → ${item.name} (${item.priceUsdc} USDC)`)

  try {
    const amountWei = Math.floor(item.priceUsdc * 1e6).toString()

    // Step 1: Create x402 order
    console.log('[agent] Creating x402 order...')
    const order = await goatx402Client.createOrder({
      dappOrderId:   `agent-${Date.now()}`,
      chainId:       CHAIN_ID,
      tokenSymbol:   'USDC',
      tokenContract: USDC_CONTRACT,
      fromAddress:   new ethers.Wallet(process.env.USER_WALLET_PRIVATE_KEY!).address,
      amountWei,
    })
    console.log(`[agent] Order created: ${order.orderId}`)

    // Step 2: Pay on-chain
    console.log('[agent] Paying on-chain...')
    const txHash = await payOnChain(order.payToAddress, amountWei)
    console.log(`[agent] TX sent: ${txHash}`)

    // Step 3: Wait for confirmation
    console.log('[agent] Waiting for confirmation...')
    await waitForConfirmation(order.orderId)
    console.log('[agent] Payment confirmed!')

    // Step 4: Real Zepto order via Playwright
    console.log('[agent] Launching Zepto automation...')
    const zepto = await runZeptoOrder(item.name)
    console.log(`[agent] Zepto order: ${zepto.zeptoOrderId}`)

    res.json({
      success:      true,
      item:         item.name,
      emoji:        item.emoji,
      priceUsdc:    item.priceUsdc,
      payment: {
        orderId:    order.orderId,
        txHash,
        explorerUrl: `${EXPLORER}/tx/${txHash}`,
      },
      zepto: {
        orderId: zepto.zeptoOrderId,
        eta:     zepto.eta,
        status:  'confirmed',
      },
      message: `${item.emoji} ${item.name} ordered on Zepto! Arriving in ${zepto.eta}.`,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[agent] Error:', message)
    res.status(500).json({ error: message })
  }
})

/**
 * POST /otp
 * Body: { otp: "123456" }
 * Called by OpenClaw/user after receiving OTP on phone.
 * Unblocks the Zepto login flow.
 */
app.post('/otp', (req, res) => {
  const { otp } = req.body
  if (!otp) return res.status(400).json({ error: 'Missing otp in body' })
  provideOtp(String(otp))
  console.log(`[agent] OTP received: ${otp}`)
  res.json({ success: true, message: 'OTP submitted, login continuing...' })
})

// Order status
app.get('/status/:orderId', async (req, res) => {
  try {
    const status = await goatx402Client.getOrderStatus(req.params.orderId)
    res.json(status)
  } catch (err) {
    res.status(404).json({ error: 'Order not found' })
  }
})

// ── Start ─────────────────────────────────────────────────────

app.listen(port, async () => {
  console.log(`\n🤖 Grocery Agent Server running at http://localhost:${port}`)
  console.log(`   GET  /health          — health check`)
  console.log(`   GET  /catalog         — browse items`)
  console.log(`   POST /order           — place order (body: { "item": "mango juice" })`)
  console.log(`   POST /otp             — submit Zepto OTP (body: { "otp": "123456" })`)
  console.log(`   GET  /status/:orderId — payment status\n`)

  // Expose via ngrok
  if (process.env.NGROK_AUTHTOKEN) {
    try {
      const listener = await ngrok.connect({
        addr:      Number(port),
        authtoken: process.env.NGROK_AUTHTOKEN,
      })
      const url = listener.url()
      console.log(`🌐 Public URL (give this to OpenClaw):`)
      console.log(`   ${url}\n`)
      console.log(`   Endpoints:`)
      console.log(`   GET  ${url}/catalog`)
      console.log(`   POST ${url}/order`)
      console.log(`   GET  ${url}/status/:orderId\n`)
    } catch (err) {
      console.error('ngrok error:', err instanceof Error ? err.message : err)
    }
  }
})
