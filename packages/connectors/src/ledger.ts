import {
  SupportedProviders,
  loadConnectKit,
} from '@ledgerhq/connect-kit-loader'
import type { EthereumProvider } from '@ledgerhq/connect-kit-loader'
import type { Chain } from '@wagmi/chains'
import {
  ProviderRpcError,
  SwitchChainError,
  UserRejectedRequestError,
  createWalletClient,
  custom,
  getAddress,
  numberToHex,
} from 'viem'

import type { ConnectorData } from './base'
import { Connector } from './base'
import { normalizeChainId } from './utils/normalizeChainId'

type LedgerConnectorOptions = {
  bridge?: string
  chainId?: number
  enableDebugLogs?: boolean
  rpc?: { [chainId: number]: string }
}

export class LedgerConnector extends Connector<
  EthereumProvider,
  LedgerConnectorOptions
> {
  readonly id = 'ledger'
  readonly name = 'Ledger'
  readonly ready = true

  #provider?: EthereumProvider

  constructor({
    chains,
    options = { enableDebugLogs: false },
  }: {
    chains?: Chain[]
    options?: LedgerConnectorOptions
  } = {}) {
    super({ chains, options })
  }

  async connect(): Promise<Required<ConnectorData>> {
    try {
      const provider = await this.getProvider({ create: true })

      if (provider.on) {
        provider.on('accountsChanged', this.onAccountsChanged)
        provider.on('chainChanged', this.onChainChanged)
        provider.on('disconnect', this.onDisconnect)
      }

      this.emit('message', { type: 'connecting' })

      const accounts = (await provider.request({
        method: 'eth_requestAccounts',
      })) as string[]
      const account = getAddress(accounts[0] as string)
      const id = await this.getChainId()
      const unsupported = this.isChainUnsupported(id)

      // Enable support for programmatic chain switching
      this.switchChain = this.#switchChain

      return {
        account,
        chain: { id, unsupported },
      }
    } catch (error) {
      if ((error as ProviderRpcError).code === 4001) {
        throw new UserRejectedRequestError(error as Error)
      }
      if ((error as ProviderRpcError).code === -32002) {
        throw error instanceof Error ? error : new Error(String(error))
      }

      throw error
    }
  }

  async disconnect() {
    const provider = await this.getProvider()

    if (provider?.disconnect) {
      await provider.disconnect()
    }

    if (provider?.removeListener) {
      provider.removeListener('accountsChanged', this.onAccountsChanged)
      provider.removeListener('chainChanged', this.onChainChanged)
      provider.removeListener('disconnect', this.onDisconnect)
    }

    typeof localStorage !== 'undefined' &&
      localStorage.removeItem('walletconnect')
  }

  async getAccount() {
    const provider = await this.getProvider()
    const accounts = (await provider.request({
      method: 'eth_accounts',
    })) as string[]
    const account = getAddress(accounts[0] as string)

    return account
  }

  async getChainId() {
    const provider = await this.getProvider()
    const chainId = (await provider.request({
      method: 'eth_chainId',
    })) as number

    return normalizeChainId(chainId)
  }

  async getProvider(
    { chainId, create }: { chainId?: number; create?: boolean } = {
      create: false,
    },
  ) {
    if (!this.#provider || chainId || create) {
      const connectKit = await loadConnectKit()

      if (this.options.enableDebugLogs) {
        connectKit.enableDebugLogs()
      }

      const rpc = this.chains.reduce(
        (rpc, chain) => ({
          ...rpc,
          [chain.id]: chain.rpcUrls.default.http[0],
        }),
        {},
      )

      connectKit.checkSupport({
        bridge: this.options.bridge,
        providerType: SupportedProviders.Ethereum,
        chainId: chainId || this.options.chainId,
        rpc: { ...rpc, ...this.options?.rpc },
      })

      this.#provider = (await connectKit.getProvider()) as EthereumProvider
    }
    return this.#provider
  }

  async getWalletClient({ chainId }: { chainId?: number } = {}) {
    const [provider, account] = await Promise.all([
      this.getProvider({ chainId }),
      this.getAccount(),
    ])
    const chain = this.chains.find((x) => x.id === chainId) || this.chains[0]
    if (!provider) throw new Error('provider is required.')
    return createWalletClient({
      account,
      chain,
      transport: custom(provider),
    })
  }

  async isAuthorized() {
    try {
      const account = await this.getAccount()
      return !!account
    } catch {
      return false
    }
  }

  async #switchChain(chainId: number) {
    const provider = await this.getProvider()
    const id = numberToHex(chainId)

    try {
      // Set up a race between `wallet_switchEthereumChain` & the `chainChanged` event
      // to ensure the chain has been switched. This is because there could be a case
      // where a wallet may not resolve the `wallet_switchEthereumChain` method, or
      // resolves slower than `chainChanged`.
      await Promise.race([
        provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: id }],
        }),
        new Promise((res) =>
          this.on('change', ({ chain }) => {
            if (chain?.id === chainId) res(chainId)
          }),
        ),
      ])
      return (
        this.chains.find((x) => x.id === chainId) ??
        ({
          id: chainId,
          name: `Chain ${id}`,
          network: `${id}`,
          nativeCurrency: { name: 'Ether', decimals: 18, symbol: 'ETH' },
          rpcUrls: { default: { http: [''] }, public: { http: [''] } },
        } as Chain)
      )
    } catch (error) {
      const message =
        typeof error === 'string' ? error : (error as ProviderRpcError)?.message
      if (/user rejected request/i.test(message))
        throw new UserRejectedRequestError(error as Error)
      throw new SwitchChainError(error as Error)
    }
  }

  protected onAccountsChanged = (accounts: string[]) => {
    if (accounts.length === 0) this.emit('disconnect')
    else this.emit('change', { account: getAddress(accounts[0] as string) })
  }

  protected onChainChanged = (chainId: number | string) => {
    const id = normalizeChainId(chainId)
    const unsupported = this.isChainUnsupported(id)
    this.emit('change', { chain: { id, unsupported } })
  }

  protected onDisconnect = () => {
    this.emit('disconnect')
  }
}
