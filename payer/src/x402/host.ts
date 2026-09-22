// Parsec x402 — the host ports.
//
// Everything in this module that is not the protocol lives behind one of three small
// interfaces: how to sign, where to reach a node, and where to keep a receipt. Parsec
// supplies implementations backed by Rust and `localStorage`; a different wallet supplies
// its own and the rest of the module does not notice.
//
// This is what "works in another wallet" actually requires. Before it, `rails/avm.ts`
// imported Parsec's `chain_algo` IPC directly, so the payment path could only ever run
// inside the Tauri shell — the protocol work was portable and the one line that mattered
// was not.
//
// The AVM signer is deliberately `algosdk.TransactionSigner`, the shape use-wallet,
// AlgoKit Utils, Pera, Defly and Lute already speak. Integrating a wallet that has one is
// a single line; there is no adapter to write.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import type algosdk from 'algosdk';
import type { RailFamily } from './networks';
import { ALGORAND_LOCALNET, ALGORAND_MAINNET, ALGORAND_TESTNET, toCaip2, type Caip2 } from './networks';

// ── Signing ──────────────────────────────────────────────────────

/** An Algorand signer. `sign` is `algosdk.TransactionSigner` — the ecosystem's own shape. */
export interface AvmSigner {
  /** The address paying, 58-character base32. */
  address: string;
  /**
   * Sign the transactions at `indexesToSign` and return them in that order.
   *
   * Exactly `algosdk.TransactionSigner`, so `useWallet().transactionSigner`, an AlgoKit
   * account, or `algosdk.makeBasicAccountTransactionSigner(account)` can be passed
   * straight in. Transactions not named in `indexesToSign` must not be signed — in an
   * x402 group that is the facilitator's own, and signing it is neither possible nor ours.
   */
  sign: algosdk.TransactionSigner;
}

/** The EIP-712 domain of an ERC-20 being spent. */
export interface EvmDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/** EIP-3009 `TransferWithAuthorization`, in the casing the wire uses. */
export interface EvmAuthorizationFields {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** An EVM signer. One message, deliberately — see `chain_evm/eip712.rs`. */
export interface EvmSigner {
  /** The address paying, 0x-hex. */
  address: string;
  /**
   * Sign an EIP-3009 transfer authorization; return the 65-byte `r||s||v` as 0x-hex.
   *
   * A wallet exposing `eth_signTypedData_v4` implements this in a few lines — see
   * `adapters/eip1193.ts`.
   */
  signTransferAuthorization(domain: EvmDomain, authorization: EvmAuthorizationFields): Promise<string>;
}

/** The signers available for a payment, one per rail family. */
export interface X402Signers {
  avm?: AvmSigner;
  evm?: EvmSigner;
  svm?: never;
  arweave?: never;
}

/** The address a signer pays from, for a family, or '' when there is none. */
export function signerAddress(signers: X402Signers | undefined, family: RailFamily): string {
  const signer = signers?.[family] as { address?: string } | undefined;
  return signer?.address ?? '';
}

// ── Storage ──────────────────────────────────────────────────────

/**
 * Where per-device state lives: the settings and the receipt ledger.
 *
 * `localStorage`-shaped because that is the common denominator, but a host with a real
 * store (Tauri, an agent's config file) supplies its own. Every call is wrapped, so an
 * implementation may throw and the module degrades to holding nothing rather than failing.
 */
export interface X402Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage. The default anywhere `localStorage` is absent — an agent, a test, SSR. */
export function memoryStorage(): X402Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function browserStorage(): X402Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null; // private mode, blocked site data
  }
}

// ── Nodes ────────────────────────────────────────────────────────

/** Public algod endpoints, per network. A host overriding these is the normal case. */
export const DEFAULT_ALGOD: Record<string, string> = {
  [ALGORAND_MAINNET]: 'https://mainnet-api.algonode.cloud',
  [ALGORAND_TESTNET]: 'https://testnet-api.algonode.cloud',
  [ALGORAND_LOCALNET]: 'http://localhost:4001',
};

// ── The host ─────────────────────────────────────────────────────

export interface X402Host {
  /** Per-device state. Defaults to `localStorage`, then to memory. */
  storage: X402Storage;
  /** An algod client for a network. Defaults to a public node with no token. */
  algod(network: string): algosdk.Algodv2;
  /** An EVM JSON-RPC endpoint, for the token balance read before signing. */
  evmRpc(network: string): string;
}

let configured: Partial<X402Host> = {};
let cachedStorage: X402Storage | null = null;

/**
 * Point the module at this host's facilities. Call once, at startup.
 *
 * Every field is optional; what is not given falls back to a public default, so a
 * consumer that only wants to pay can skip this entirely.
 */
export function configureX402Host(host: Partial<X402Host>): void {
  configured = { ...configured, ...host };
  if (host.storage) cachedStorage = host.storage;
}

/** Reset to defaults. For tests, and for a host tearing down a session. */
export function resetX402Host(): void {
  configured = {};
  cachedStorage = null;
}

export function hostStorage(): X402Storage {
  if (configured.storage) return configured.storage;
  if (!cachedStorage) cachedStorage = browserStorage() ?? memoryStorage();
  return cachedStorage;
}

/** An algod client for a network — the host's, or a public node. */
export async function hostAlgod(network: string): Promise<algosdk.Algodv2> {
  if (configured.algod) return configured.algod(network);
  const caip2 = toCaip2(network) as Caip2;
  const url = DEFAULT_ALGOD[caip2];
  if (!url) throw new Error(`no algod endpoint for ${caip2}; pass one via configureX402Host({ algod })`);
  const { default: algosdkModule } = await import('algosdk');
  return new algosdkModule.Algodv2('', url, '');
}

/** A JSON-RPC endpoint for an EVM network. */
export function hostEvmRpc(network: string): string {
  if (configured.evmRpc) return configured.evmRpc(network);
  return DEFAULT_EVM_RPC[toCaip2(network)] ?? '';
}

/** Public EVM endpoints, per chain. Asked for one `eth_call` per payment and nothing else. */
export const DEFAULT_EVM_RPC: Record<string, string> = {
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:84532': 'https://sepolia.base.org',
  'eip155:1': 'https://ethereum-rpc.publicnode.com',
};
