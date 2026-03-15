/**
 * GoatX402 Demo Backend Server
 *
 * This server handles GoatX402 API calls securely, keeping API credentials on the backend.
 */

import express from 'express'
import cors from 'cors'
import { GoatX402Client } from 'goatx402-sdk-server'
import 'dotenv/config'
import { startBot } from './bot'

const app = express()
const port = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// Create GoatX402 client
const goatx402Client = new GoatX402Client({
  baseUrl: process.env.GOATX402_API_URL || 'http://localhost:8286',
  apiKey: process.env.GOATX402_API_KEY || '',
  apiSecret: process.env.GOATX402_API_SECRET || '',
})

// Merchant ID from environment
const merchantId = process.env.GOATX402_MERCHANT_ID || 'demo_merchant'

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Get app config (supported chains and tokens from merchant)
app.get('/api/config', async (_req, res) => {
  try {
    const merchant = await goatx402Client.getMerchant(merchantId)

    // Group tokens by chain
    const chains: Record<
      number,
      {
        chainId: number
        name: string
        tokens: Array<{ symbol: string; contract: string }>
      }
    > = {}

    // Chain name mapping
    const chainNames: Record<number, string> = {
      97: 'BSC Testnet',
      56: 'BSC Mainnet',
      48816: 'Goat Testnet',
      1: 'Ethereum',
      137: 'Polygon',
    }

    for (const token of merchant.supportedTokens) {
      if (!chains[token.chainId]) {
        chains[token.chainId] = {
          chainId: token.chainId,
          name: chainNames[token.chainId] || `Chain ${token.chainId}`,
          tokens: [],
        }
      }
      chains[token.chainId].tokens.push({
        symbol: token.symbol,
        contract: token.tokenContract,
      })
    }

    res.json({
      merchantId: merchant.merchantId,
      merchantName: merchant.name,
      chains: Object.values(chains),
    })
  } catch (error) {
    console.error('Get config error:', error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get config',
    })
  }
})

// Create order
app.post('/api/orders', async (req, res) => {
  try {
    const { chainId, tokenSymbol, tokenContract, fromAddress, amountWei, callbackCalldata } =
      req.body

    if (!chainId || !tokenSymbol || !tokenContract || !fromAddress || !amountWei) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const order = await goatx402Client.createOrder({
      dappOrderId: `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chainId,
      tokenSymbol,
      tokenContract,
      fromAddress,
      amountWei,
      callbackCalldata,
    })

    // Return order to frontend (includes payment instructions)
    res.json({
      orderId: order.orderId,
      flow: order.flow,
      payToAddress: order.payToAddress,
      expiresAt: order.expiresAt,
      calldataSignRequest: order.calldataSignRequest,
      // Include original params for frontend display
      chainId,
      tokenSymbol,
      tokenContract,
      fromAddress,
      amountWei,
    })
  } catch (error: unknown) {
    console.error('Create order error:', error)
    const errObj = error as { status?: number; responseBody?: unknown }
    const status = errObj.status || 500
    // Include responseBody for debugging
    if (errObj.responseBody) {
      console.error('Response body:', errObj.responseBody)
    }
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to create order',
      details: errObj.responseBody,
    })
  }
})

// Get order status
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params
    const order = await goatx402Client.getOrderStatus(orderId)
    res.json(order)
  } catch (error: unknown) {
    console.error('Get order error:', error)
    const status = (error as { status?: number }).status || 500
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to get order',
    })
  }
})

// Submit calldata signature
app.post('/api/orders/:orderId/signature', async (req, res) => {
  try {
    const { orderId } = req.params
    const { signature } = req.body

    if (!signature) {
      return res.status(400).json({ error: 'Missing signature' })
    }

    await goatx402Client.submitCalldataSignature(orderId, signature)
    res.json({ success: true })
  } catch (error: unknown) {
    console.error('Submit signature error:', error)
    const status = (error as { status?: number }).status || 500
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to submit signature',
    })
  }
})

// Get merchant info
app.get('/api/merchants/:merchantId', async (req, res) => {
  try {
    const { merchantId } = req.params
    const merchant = await goatx402Client.getMerchant(merchantId)
    res.json(merchant)
  } catch (error: unknown) {
    console.error('Get merchant error:', error)
    const status = (error as { status?: number }).status || 500
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to get merchant',
    })
  }
})

// Start server
app.listen(port, () => {
  console.log(`Demo server running at http://localhost:${port}`)

  // Warn if credentials are missing
  if (!process.env.GOATX402_API_KEY || !process.env.GOATX402_API_SECRET) {
    console.warn('Warning: GOATX402_API_KEY and/or GOATX402_API_SECRET not set')
    console.warn('Please create a .env file with your credentials')
  }

  // Start Telegram bot
  startBot()
})
