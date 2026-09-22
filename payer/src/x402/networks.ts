// Parsec x402 — CAIP-2 network identity and the assets quoted on each one.
//
// One table, read by every rail. x402 v2 names a network by its CAIP-2 id; v1 named
// it with a short alias ("algorand-testnet", "base"). Servers in the wild still emit
// either, and the truncated CASA form turns up in SDK constants, so `toCaip2()`
// normalizes all three into the canonical id before anything compares them.
//
// Mirrors mindX `mindx_backend_service/x402_protocol.py` deliberately — the two ends
// of the same rail must not drift on what a network is called.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

/**
 * A host's own network selector.
 *
 * Structurally identical to Parsec's `NetworkId`, declared here so the module's core
 * imports nothing from the application embedding it.
 */
export type WalletNetwork = 'mainnet' | 'testnet' | 'betanet';

/** A CAIP-2 chain id, `namespace:reference`. */
export type Caip2 = `${string}:${string}`;

/** The rail family a CAIP-2 namespace dispatches to. */
export type RailFamily = 'avm' | 'evm' | 'svm' | 'arweave';

// ── Canonical network ids ────────────────────────────────────────

export const ALGORAND_MAINNET: Caip2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
export const ALGORAND_TESTNET: Caip2 = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';
export const ALGORAND_LOCALNET: Caip2 = 'algorand:localnet';

export const BASE_MAINNET: Caip2 = 'eip155:8453';
export const BASE_SEPOLIA: Caip2 = 'eip155:84532';
export const ETHEREUM_MAINNET: Caip2 = 'eip155:1';

export const SOLANA_MAINNET: Caip2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_DEVNET: Caip2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/** Synthetic id for the Arweave fulfillment leg — there is no settlement chain. */
export const ARWEAVE_PERMAWEB: Caip2 = 'arweave:permaweb';

// ── Alias → canonical ────────────────────────────────────────────

const ALIASES: Record<string, Caip2> = {
  // Algorand — v1 short names, wallet NetworkId, and the truncated CASA reference.
  'algorand-mainnet': ALGORAND_MAINNET,
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k': ALGORAND_MAINNET,
  'algorand-testnet': ALGORAND_TESTNET,
  'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe': ALGORAND_TESTNET,
  'algorand-localnet': ALGORAND_LOCALNET,
  localnet: ALGORAND_LOCALNET,
  // EVM
  base: BASE_MAINNET,
  'base-sepolia': BASE_SEPOLIA,
  ethereum: ETHEREUM_MAINNET,
  // Solana
  solana: SOLANA_MAINNET,
  'solana-devnet': SOLANA_DEVNET,
  // Arweave
  arweave: ARWEAVE_PERMAWEB,
  permaweb: ARWEAVE_PERMAWEB,
};

/**
 * Normalize any accepted network name to its CAIP-2 id.
 *
 * Bare `mainnet` / `testnet` are ambiguous across chains, so they resolve only when
 * a `family` is given; otherwise the input comes back unchanged. Unknown ids are
 * returned as-is — a network Parsec has never heard of is opaque, not an error.
 */
export function toCaip2(network: string, family: RailFamily = 'avm'): Caip2 {
  if (!network) return network as Caip2;
  if (network === 'mainnet' || network === 'testnet') {
    if (family === 'avm') return network === 'mainnet' ? ALGORAND_MAINNET : ALGORAND_TESTNET;
    if (family === 'evm') return network === 'mainnet' ? BASE_MAINNET : BASE_SEPOLIA;
    if (family === 'svm') return network === 'mainnet' ? SOLANA_MAINNET : SOLANA_DEVNET;
  }
  return ALIASES[network] ?? ALIASES[network.toLowerCase()] ?? (network as Caip2);
}

/** The rail family a network belongs to, keyed off the CAIP-2 namespace. */
export function familyFor(network: string): RailFamily {
  const caip2 = toCaip2(network);
  const namespace = caip2.slice(0, caip2.indexOf(':'));
  switch (namespace) {
    case 'algorand': return 'avm';
    case 'eip155': return 'evm';
    case 'solana': return 'svm';
    case 'arweave': return 'arweave';
    default: throw new Error(`unsupported x402 network ${network}`);
  }
}

/** Whether two network ids name the same chain, comparing by prefix so the truncated CASA form matches. */
export function sameNetwork(a: string, b: string): boolean {
  const [x, y] = [toCaip2(a), toCaip2(b)];
  if (x === y) return true;
  const shorter = x.length < y.length ? x : y;
  const longer = x.length < y.length ? y : x;
  return shorter.length > 12 && longer.startsWith(shorter);
}

// ── Display + wallet mapping ─────────────────────────────────────

export interface NetworkDescriptor {
  caip2: Caip2;
  label: string;
  family: RailFamily;
  testnet: boolean;
  /** Parsec's own network selector, where the chain has one. */
  walletNetwork?: WalletNetwork;
  /** Explorer base for a settled transaction id. */
  explorerTx?: string;
}

export const NETWORKS: NetworkDescriptor[] = [
  { caip2: ALGORAND_MAINNET, label: 'Algorand Mainnet', family: 'avm', testnet: false, walletNetwork: 'mainnet', explorerTx: 'https://allo.info/tx/' },
  { caip2: ALGORAND_TESTNET, label: 'Algorand Testnet', family: 'avm', testnet: true, walletNetwork: 'testnet', explorerTx: 'https://testnet.explorer.perawallet.app/tx/' },
  { caip2: ALGORAND_LOCALNET, label: 'Algorand Localnet', family: 'avm', testnet: true },
  { caip2: BASE_MAINNET, label: 'Base', family: 'evm', testnet: false, explorerTx: 'https://basescan.org/tx/' },
  { caip2: BASE_SEPOLIA, label: 'Base Sepolia', family: 'evm', testnet: true, explorerTx: 'https://sepolia.basescan.org/tx/' },
  { caip2: ETHEREUM_MAINNET, label: 'Ethereum', family: 'evm', testnet: false, explorerTx: 'https://etherscan.io/tx/' },
  { caip2: SOLANA_MAINNET, label: 'Solana', family: 'svm', testnet: false, explorerTx: 'https://solscan.io/tx/' },
  { caip2: SOLANA_DEVNET, label: 'Solana Devnet', family: 'svm', testnet: true },
  { caip2: ARWEAVE_PERMAWEB, label: 'Arweave', family: 'arweave', testnet: false, explorerTx: 'https://viewblock.io/arweave/tx/' },
];

export function describeNetwork(network: string): NetworkDescriptor {
  const caip2 = toCaip2(network);
  const found = NETWORKS.find((n) => sameNetwork(n.caip2, caip2));
  if (found) return found;
  return { caip2, label: caip2, family: familyFor(caip2), testnet: false };
}

/** Explorer URL for a settled transaction, or '' when the network has no known explorer. */
export function explorerTxUrl(network: string, txId: string): string {
  const base = describeNetwork(network).explorerTx;
  return base && txId ? `${base}${txId}` : '';
}

// ── Assets ───────────────────────────────────────────────────────

export interface AssetDescriptor {
  /** As it appears in `PaymentRequirements.asset`: an ASA id, a contract address, or '0' for native. */
  id: string;
  network: Caip2;
  symbol: string;
  decimals: number;
}

/**
 * The assets Parsec can name without asking the server. A requirement may quote
 * anything; `extra.decimals` on the wire always wins over this table.
 */
export const ASSETS: AssetDescriptor[] = [
  { id: '31566704', network: ALGORAND_MAINNET, symbol: 'USDC', decimals: 6 },
  { id: '10458941', network: ALGORAND_TESTNET, symbol: 'USDC', decimals: 6 },
  { id: '0', network: ALGORAND_MAINNET, symbol: 'ALGO', decimals: 6 },
  { id: '0', network: ALGORAND_TESTNET, symbol: 'ALGO', decimals: 6 },
  { id: '0', network: ALGORAND_LOCALNET, symbol: 'ALGO', decimals: 6 },
  { id: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', network: BASE_MAINNET, symbol: 'USDC', decimals: 6 },
  { id: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', network: BASE_SEPOLIA, symbol: 'USDC', decimals: 6 },
];

/** USDC ASA ids, named because the x402 Global Challenge settles in them. */
export const USDC_ASA_MAINNET = 31566704;
export const USDC_ASA_TESTNET = 10458941;

export function describeAsset(network: string, asset: string): AssetDescriptor {
  const caip2 = toCaip2(network);
  const found = ASSETS.find((a) => sameNetwork(a.network, caip2) && a.id === asset);
  return found ?? { id: asset, network: caip2, symbol: asset === '0' ? 'ALGO' : `ASA ${asset}`, decimals: 6 };
}

/** The USDC asset id for an Algorand network, or '' where none is known. */
export function usdcFor(network: string): string {
  const caip2 = toCaip2(network);
  if (sameNetwork(caip2, ALGORAND_MAINNET)) return String(USDC_ASA_MAINNET);
  if (sameNetwork(caip2, ALGORAND_TESTNET)) return String(USDC_ASA_TESTNET);
  const found = ASSETS.find((a) => sameNetwork(a.network, caip2) && a.symbol === 'USDC');
  return found?.id ?? '';
}
