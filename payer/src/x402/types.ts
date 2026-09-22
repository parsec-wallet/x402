// Parsec x402 Integration — Core Types
// Adapted from x402-demo: erc8004/src/types.ts, modules/identity/types.ts, modules/bankon-payments/types.ts
// No viem dependency — all address/hash types are plain strings.
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

// ── ERC-8004 Agent Identity ──────────────────────────────────────

export interface AgentRegistration {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
  name: string;
  description: string;
  image?: string;
  services: AgentService[];
  registrations: AgentRegistrationEntry[];
  supportedTrust: Array<'reputation' | 'crypto-economic' | 'tee-attestation' | 'zkML'>;
  x402Support?: boolean;
  active?: boolean;
  /** Algorand command channel — 1000-byte note directives */
  commandChannel?: CommandChannel;
}

export interface CommandChannel {
  chain: 'algorand';
  network: 'mainnet' | 'testnet';
  address: string;
  protocol: 'smarttime-directive-v1';
  minTier?: 'base' | 'phi' | 'phi2' | 'phi3';
  minDignitas?: number;
  acceptedCommands?: string[];
  maxChainLength?: number;
  responseChannel?: string;
}

export interface AgentService {
  name: 'web' | 'A2A' | 'MCP' | 'OASF' | 'ENS' | 'DID' | 'email';
  endpoint: string;
  version?: string;
  skills?: string[];
  domains?: string[];
}

export interface AgentRegistrationEntry {
  agentId: number;
  agentRegistry: string;
  chainId?: number;
}

export interface FeedbackParams {
  agentId: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
}

export interface ReputationSummary {
  count: bigint;
  summaryValue: bigint;
  summaryValueDecimals: number;
}

export interface ProofOfPayment {
  fromAddress: string;
  toAddress: string;
  chainId: string;
  txHash: string;
  network: string;
}

// ── Identity Verification (Access Tiers) ─────────────────────────

export type AccessTier = 0 | 1 | 2 | 3 | 4 | 5;

export const TIER_NAMES: Record<AccessTier, string> = {
  0: 'Visitor',
  1: 'Citizen',
  2: 'Artisan',
  3: 'Senator',
  4: 'Consul',
  5: 'Imperator',
};

/** BONA FIDE thresholds per tier */
export const TIER_THRESHOLDS: Record<AccessTier, bigint> = {
  0: 0n,
  1: 0n,       // Citizen: IDNFT only
  2: 100n,     // Artisan: notus
  3: 1000n,    // Senator: clarus
  4: 5000n,    // Consul: illustris
  5: 10000n,   // Imperator: eminens
};

/** EIP-712 challenge for identity proof */
export interface IdentityChallenge {
  agent: string;
  timestamp: number;
  nonce: string;
  purpose: 'access' | 'governance' | 'mint' | 'trade';
}

export const EIP712_DOMAIN = {
  name: 'AgenticPlace SignatureVerification',
  version: '1',
} as const;

export const CHALLENGE_TYPES = {
  IdentityChallenge: [
    { name: 'agent', type: 'address' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'purpose', type: 'string' },
  ],
} as const;

export interface HoldingsStatus {
  bonaFideBalance: bigint;
  hasIdnft: boolean;
  hasSoulBadger: boolean;
  hasNfPrompt: boolean;
  hasNfrlt: boolean;
}

export interface VerificationResult {
  valid: boolean;
  agent: string;
  tier: AccessTier;
  tierName: string;
  holdings: HoldingsStatus;
  timestamp: number;
  error?: string;
}

// ── Payment Types ────────────────────────────────────────────────

export type NetworkFamily = 'algorand' | 'evm' | 'solana';
export type Network = `${string}:${string}`;

export interface EndpointPricing {
  path: string;
  method: 'GET' | 'POST';
  priceUsd: number;
  description: string;
  discovery?: {
    input?: Record<string, unknown>;
    inputSchema?: Record<string, unknown>;
    output?: Record<string, unknown>;
  };
}

export interface FeeSchedule {
  endpoints: EndpointPricing[];
}

export interface PaymentConfig {
  payTo: string;
  facilitatorUrl: string;
  network: Network;
  additionalNetworks?: Network[];
  cacheTtl?: number;
  erc8004?: {
    agentId: number;
    agentRegistry: string;
    reputationRegistry: string;
  };
  discount?: {
    asaId: number;
    minBalance: number;
    pct: number;
  };
}

export interface PaymentRecord {
  id: string;
  endpoint: string;
  payer: string;
  priceUsd: number;
  priceNative: number;
  nativeAsset: string;
  exchangeRate: number;
  txHash: string;
  network: Network;
  settledAt: string;
  discountApplied: boolean;
}

export interface HolderStatus {
  isHolder: boolean;
  balance: number;
}

export interface PriceTableEntry {
  path: string;
  description: string;
  usd: number;
  algo: number;
  microAlgo: number;
}

export interface BankonPaymentRequirement {
  method: 'x402';
  network: Network;
  payTo: string;
  price: string;
  asset?: string;
  facilitatorUrl: string;
  extensions?: Record<string, unknown>;
}

export interface PaymentManifestEntry {
  method: 'x402';
  payee: string;
  network: string;
  endpoint?: string;
  extensions?: {
    x402?: { facilitatorUrl: string; payeeMode?: 'static' | 'dynamic' };
    erc8004?: Record<string, unknown>;
    bankon?: { holderDiscount: number; asaId: number };
  };
}
