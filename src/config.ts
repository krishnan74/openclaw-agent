/**
 * Demo Configuration
 *
 * API credentials are stored on the backend server.
 * Token configuration is fetched from the merchant API.
 */

export const config = {
  // Backend API URL (proxied via Vite in development)
  apiUrl: '/api',

  // Chain explorer URLs
  chains: {
    1: { name: 'Ethereum', explorerUrl: 'https://etherscan.io' },
    56: { name: 'BSC Mainnet', explorerUrl: 'https://bscscan.com' },
    97: { name: 'BSC Testnet', explorerUrl: 'https://testnet.bscscan.com' },
    137: { name: 'Polygon', explorerUrl: 'https://polygonscan.com' },
    48816: { name: 'Goat Testnet', explorerUrl: 'https://explorer.testnet3.goat.network' },
  } as Record<number, { name: string; explorerUrl: string }>,
}
