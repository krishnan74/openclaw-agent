/**
 * Wallet Connection Hook
 */

import { useState, useCallback, useEffect } from 'react'
import { ethers } from 'ethers'

declare global {
  interface Window {
    ethereum?: {
      isMetaMask?: boolean
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
      on: (event: string, callback: (...args: unknown[]) => void) => void
      removeListener: (event: string, callback: (...args: unknown[]) => void) => void
    }
  }
}

export interface WalletState {
  isConnected: boolean
  address: string | null
  chainId: number | null
  signer: ethers.Signer | null
  provider: ethers.BrowserProvider | null
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    isConnected: false,
    address: null,
    chainId: null,
    signer: null,
    provider: null,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Connect wallet
  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError('MetaMask is not installed')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const provider = new ethers.BrowserProvider(window.ethereum)

      // Request accounts
      await provider.send('eth_requestAccounts', [])

      const signer = await provider.getSigner()
      const address = await signer.getAddress()
      const network = await provider.getNetwork()
      const chainId = Number(network.chainId)

      setState({
        isConnected: true,
        address,
        chainId,
        signer,
        provider,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet')
    } finally {
      setLoading(false)
    }
  }, [])

  // Disconnect wallet
  const disconnect = useCallback(() => {
    setState({
      isConnected: false,
      address: null,
      chainId: null,
      signer: null,
      provider: null,
    })
  }, [])

  // Switch chain
  const switchChain = useCallback(async (chainId: number) => {
    if (!window.ethereum) {
      setError('MetaMask is not installed')
      return
    }

    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      })
    } catch (err: unknown) {
      // Chain not added to MetaMask
      if ((err as { code?: number })?.code === 4902) {
        setError('Please add this network to MetaMask first')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to switch chain')
      }
    }
  }, [])

  // Handle account changes
  useEffect(() => {
    if (!window.ethereum) return

    const handleAccountsChanged = async (accounts: unknown) => {
      const accountsArr = accounts as string[]
      if (accountsArr.length === 0) {
        disconnect()
      } else if (state.isConnected) {
        const provider = new ethers.BrowserProvider(window.ethereum!)
        const signer = await provider.getSigner()
        setState((prev) => ({
          ...prev,
          address: accountsArr[0],
          signer,
          provider,
        }))
      }
    }

    const handleChainChanged = async (chainIdHex: unknown) => {
      const chainId = parseInt(chainIdHex as string, 16)
      if (state.isConnected && window.ethereum) {
        const provider = new ethers.BrowserProvider(window.ethereum)
        const signer = await provider.getSigner()
        setState((prev) => ({
          ...prev,
          chainId,
          signer,
          provider,
        }))
      }
    }

    window.ethereum.on('accountsChanged', handleAccountsChanged)
    window.ethereum.on('chainChanged', handleChainChanged)

    return () => {
      window.ethereum?.removeListener('accountsChanged', handleAccountsChanged)
      window.ethereum?.removeListener('chainChanged', handleChainChanged)
    }
  }, [state.isConnected, disconnect])

  return {
    ...state,
    loading,
    error,
    connect,
    disconnect,
    switchChain,
  }
}
