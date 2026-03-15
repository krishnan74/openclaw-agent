---
name: grocery-shopping-agent
description: Orders groceries from Zepto by accepting a natural language item request, paying via x402 (USDC on GOAT Network), and returning order confirmation. Use this when the user wants to buy food, drinks, or grocery items for delivery.
---

# Grocery Shopping Agent

## Goal
- Order grocery items from Zepto on behalf of the user by autonomously handling x402 crypto payment and returning a delivery confirmation.

## When to use
- "Buy me a mango juice"
- "Order some water from Zepto"
- "Get me a coke"
- "I want chips delivered"
- Any request to buy/order food, drinks, or grocery items

## Workflow
1. Extract the item name from the user's message
2. Call `GET /catalog` to check if the item is available (optional — skip if confident)
3. Call `POST /order` with `{ "item": "<extracted item>" }`
4. Wait for the JSON response (the server handles payment + mock Zepto order internally)
5. Return the `message` field from the response to the user, along with ETA and Zepto order ID

## Tools & Resources
- **Agent Server** (ngrok public URL): base URL for all API calls
  - `GET  /health`          — check if server is live
  - `GET  /catalog`         — list available items and prices in USDC
  - `POST /order`           — full order flow: x402 payment + Zepto order
  - `GET  /status/:orderId` — check payment status by order ID
- **Payment**: handled server-side via USDC on GOAT Testnet3 (chain 48816) — no wallet interaction needed from OpenClaw
- **Delivery**: mocked in Phase 1; real Chromium/Zepto automation in Phase 2

## Notes / Guardrails
- The `/order` endpoint is synchronous and may take 15–30 seconds (waits for on-chain confirmation)
- If item is not in catalog, the server returns 404 — tell the user the item is unavailable and suggest alternatives from `/catalog`
- Do not retry `/order` if it fails — each call creates a payment transaction
- Payment is in USDC testnet tokens — this is a testnet demo, not real money
- Phase 2 will replace the mock Zepto response with real browser automation
