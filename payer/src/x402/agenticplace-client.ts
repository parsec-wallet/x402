// Parsec x402 Integration — AgenticPlace HTTP Client
// Connects to pythai.net services: discovery API, oracle, facilitator, BANKON.
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import { AGENTICPLACE_DEFAULTS } from './constants';
import type {
  AgentRegistration,
  PriceTableEntry,
  BankonPaymentRequirement,
} from './types';

export interface AgenticPlaceConfig {
  /** Discovery API base URL (default: agenticplace.pythai.net) */
  discoveryApi?: string;
  /** MindX base URL (default: mindx.pythai.net) */
  mindx?: string;
  /** Facilitator base URL (default: mindx.pythai.net:4022) */
  facilitator?: string;
  /** BANKON service base URL (default: bankon.pythai.net) */
  bankon?: string;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
}

// ── Response types from AgenticPlace services ────────────────────

export interface AgentSearchResult {
  agentId: number;
  name: string;
  description: string;
  chainId: number;
  chainName: string;
  owner: string;
  image?: string;
  services?: string[];
  registeredAt?: string;
}

export interface OracleAlgoUsd {
  algo_usd: number;
  source: string;
  cached: boolean;
  timestamp: string;
}

export interface OracleTopTokens {
  tokens: Array<{
    assetId: number;
    symbol: string;
    usd: number;
    algo: number;
    source: string;
  }>;
  algo_usd: number;
  timestamp: string;
}

export interface ServiceHealth {
  status: string;
  service: string;
  uptime?: number;
  facilitator?: { status: string };
  oracle?: { status: string; algo_usd: number };
}

export interface FacilitatorVerifyResult {
  valid: boolean;
  txId?: string;
  error?: string;
}

export interface FacilitatorSettleResult {
  settled: boolean;
  txId: string;
  receipt?: {
    id: string;
    endpoint: string;
    payer: string;
    priceUsd: number;
    priceNative: number;
    settledAt: string;
  };
}

// ── Client ───────────────────────────────────────────────────────

export class AgenticPlaceClient {
  private readonly urls: Required<Omit<AgenticPlaceConfig, 'timeout'>>;
  private readonly timeout: number;

  constructor(config: AgenticPlaceConfig = {}) {
    this.urls = {
      discoveryApi: config.discoveryApi || AGENTICPLACE_DEFAULTS.discoveryApi,
      mindx: config.mindx || AGENTICPLACE_DEFAULTS.mindx,
      facilitator: config.facilitator || AGENTICPLACE_DEFAULTS.facilitator,
      bankon: config.bankon || AGENTICPLACE_DEFAULTS.bankon,
    };
    this.timeout = config.timeout ?? 10000;
  }

  private async get<T>(baseUrl: string, path: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(this.timeout),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
    return (await res.json()) as T;
  }

  private async post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeout),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
    return (await res.json()) as T;
  }

  // ── Discovery API ──────────────────────────────────────────────

  /** Search agents across all indexed chains */
  async searchAgents(query: string, limit = 20): Promise<AgentSearchResult[]> {
    return this.get(this.urls.discoveryApi, `/agents/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  }

  /** Get agents by chain */
  async getAgentsByChain(chainId: number, page = 1, limit = 50): Promise<AgentSearchResult[]> {
    return this.get(this.urls.discoveryApi, `/agents/chain/${chainId}?page=${page}&limit=${limit}`);
  }

  /** Get total agent count */
  async getAgentCount(): Promise<{ total: number; chains: Record<string, number> }> {
    return this.get(this.urls.discoveryApi, '/agents/count');
  }

  /** Get agent details by ID and chain */
  async getAgent(agentId: number, chainId: number): Promise<AgentRegistration | null> {
    try {
      return await this.get(this.urls.discoveryApi, `/agents/${chainId}/${agentId}`);
    } catch {
      return null;
    }
  }

  // ── Oracle ─────────────────────────────────────────────────────

  /** Get current ALGO/USD price from SmartOracle */
  async getAlgoUsd(): Promise<OracleAlgoUsd> {
    return this.get(this.urls.mindx, '/oracle/algo-usd');
  }

  /** Get top token prices from Algorand DEX */
  async getTopTokens(): Promise<OracleTopTokens> {
    return this.get(this.urls.mindx, '/oracle/top');
  }

  // ── MindX Service ──────────────────────────────────────────────

  /** Get service health status */
  async getHealth(): Promise<ServiceHealth> {
    return this.get(this.urls.mindx, '/health');
  }

  /** Get agent info / capabilities */
  async getAgentInfo(): Promise<AgentRegistration> {
    return this.get(this.urls.mindx, '/agent-info');
  }

  /** Get x402 price table (free endpoint) */
  async getPriceTable(): Promise<PriceTableEntry[]> {
    return this.get(this.urls.mindx, '/x402/price');
  }

  /**
   * Make an x402 request — returns the 402 payment requirement if payment needed,
   * or the response body if a payment header is provided.
   */
  async makeX402Request(
    path: string,
    paymentHeader?: string,
  ): Promise<{ status: number; body: unknown; paymentRequired?: BankonPaymentRequirement }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (paymentHeader) {
      headers['X-PAYMENT'] = paymentHeader;
    }

    const res = await fetch(`${this.urls.mindx}${path}`, {
      signal: AbortSignal.timeout(this.timeout),
      headers,
    });

    const body = await res.json();

    if (res.status === 402) {
      return { status: 402, body, paymentRequired: body as BankonPaymentRequirement };
    }

    return { status: res.status, body };
  }

  // ── Facilitator ────────────────────────────────────────────────

  /** Verify a payment transaction */
  async verifyPayment(payload: {
    txBytes: string;
    network: string;
    payTo: string;
    price: string;
  }): Promise<FacilitatorVerifyResult> {
    return this.post(this.urls.facilitator, '/verify', payload);
  }

  /** Settle a verified payment */
  async settlePayment(payload: {
    txId: string;
    network: string;
    endpoint: string;
  }): Promise<FacilitatorSettleResult> {
    return this.post(this.urls.facilitator, '/settle', payload);
  }

  // ── BANKON Identity ────────────────────────────────────────────

  /** Check if an address has a BANKON IDNFT */
  async checkIdentity(address: string): Promise<{
    hasIdnft: boolean;
    agentId?: number;
    tier?: number;
    tierName?: string;
  }> {
    try {
      return await this.get(this.urls.bankon, `/identity/${address}`);
    } catch {
      return { hasIdnft: false };
    }
  }
}
