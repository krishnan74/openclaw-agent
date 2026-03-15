/**
 * Wallet Connection Component
 */

interface ConnectWalletProps {
  isConnected: boolean
  address: string | null
  chainId: number | null
  loading: boolean
  error: string | null
  onConnect: () => void
  onDisconnect: () => void
}

export function ConnectWallet({
  isConnected,
  address,
  chainId,
  loading,
  error,
  onConnect,
  onDisconnect,
}: ConnectWalletProps) {
  const formatAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`
  }

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Wallet</h2>
          {isConnected && address && (
            <div className="mt-1">
              <p className="text-sm text-gray-600 font-mono">{formatAddress(address)}</p>
              <p className="text-xs text-gray-500">Chain ID: {chainId}</p>
            </div>
          )}
        </div>

        {isConnected ? (
          <button
            onClick={onDisconnect}
            className="px-4 py-2 bg-red-100 text-red-700 rounded hover:bg-red-200 transition"
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition disabled:opacity-50"
          >
            {loading ? 'Connecting...' : 'Connect MetaMask'}
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}
    </div>
  )
}
