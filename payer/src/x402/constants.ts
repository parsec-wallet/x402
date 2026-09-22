// Parsec x402 Integration — Constants
// Adapted from x402-demo/modules/bankon-payments/constants.ts
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import type { Network } from './types';

// ── Network Identifiers (CAIP-2) ───────────────────────────────

export const ALGO_TESTNET: Network = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';
export const ALGO_MAINNET: Network = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';

export const EVM_NETWORKS = {
  base: 'eip155:8453' as Network,
  baseSepolia: 'eip155:84532' as Network,
  ethereum: 'eip155:1' as Network,
  sepolia: 'eip155:11155111' as Network,
  polygon: 'eip155:137' as Network,
  arbitrum: 'eip155:42161' as Network,
} as const;

export const DEFAULT_NETWORK = ALGO_TESTNET;

// ── BANKON Token ─────────────────────────────────────────────────

/** BANKON ASA on Algorand Mainnet — 10,000,000 supply, 0 decimals */
export const BANKON_ASA_ID = 203977300;
export const BANKON_SUPPLY = 10_000_000;

/** Treasury address — receives x402 payments */
export const TREASURY_ADDRESS = '44FM64A7UOXRVCM66TOHOATSQK3WXAXISQC6KC3OIVSKARTBSLN2DIJ3YI';

/** Default holder discount percentage (50%) */
export const DEFAULT_DISCOUNT_PCT = 50;

// ── Oracle & API ─────────────────────────────────────────────────

export const DEFAULT_CACHE_TTL = 60_000;
export const VESTIGE_API = 'https://free-api.vestige.fi';
export const ALGO_INDEXER_URL = 'https://mainnet-idx.4160.nodely.dev';
export const FALLBACK_ALGO_USD = 0.20;

// ── ERC-8004 Contracts (CREATE2 — same address all EVM chains) ───

export const ERC8004_MAINNET = {
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  validationRegistry: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
} as const;

export const ERC8004_TESTNET = {
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
} as const;

/** Well-known testnet chain IDs */
const TESTNET_CHAIN_IDS = new Set([
  84532, 11155111, 421614, 11155420, 314159, 80002, 44787, 10200,
  534351, 59141, 168587773, 84531, 999999999, 1442, 280, 5001, 43113, 4002,
]);

/** Get ERC-8004 addresses for any EVM chain (CREATE2 deterministic) */
export function getErc8004Addresses(chainId: number, isTestnet?: boolean) {
  const testnet = isTestnet ?? TESTNET_CHAIN_IDS.has(chainId);
  return testnet ? ERC8004_TESTNET : ERC8004_MAINNET;
}

// ── Network Detection ────────────────────────────────────────────

/** Detect network family from address format */
export function detectNetworkFamily(address: string): 'evm' | 'solana' | 'algorand' {
  if (address.startsWith('0x')) return 'evm';
  if (address.length === 58 && /^[A-Z2-7]+$/.test(address)) return 'algorand';
  return 'solana';
}

// ── AgenticPlace Service Endpoints ───────────────────────────────

export const AGENTICPLACE_DEFAULTS = {
  discoveryApi: 'https://agenticplace.pythai.net',
  mindx: 'https://mindx.pythai.net',
  facilitator: 'https://mindx.pythai.net:4022',
  bankon: 'https://bankon.pythai.net',
} as const;
