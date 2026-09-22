// Parsec x402 Integration — Price Oracle
// Algorand DEX price oracle via Vestige API (Tinyman/Pact/Folks pools).
// Augments the CoinGecko-only prices.ts with Algorand-native pricing.
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import { ALGO_DECIMALS, USD_DECIMALS, parseDecimal, usdToAssetUnits } from '../money';
import { VESTIGE_API, FALLBACK_ALGO_USD, DEFAULT_CACHE_TTL } from './constants';

export class PriceOracle {
  private cachedAlgoUsd = FALLBACK_ALGO_USD;
  private cacheTimestamp = 0;
  private readonly cacheTtl: number;

  constructor(cacheTtl = DEFAULT_CACHE_TTL) {
    this.cacheTtl = cacheTtl;
  }

  /** Get current ALGO/USD price (cached) */
  async getAlgoUsd(): Promise<number> {
    if (Date.now() - this.cacheTimestamp < this.cacheTtl && this.cachedAlgoUsd > 0) {
      return this.cachedAlgoUsd;
    }
    try {
      const res = await fetch(`${VESTIGE_API}/asset/0/price`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { price?: number };
        if (data.price && data.price > 0) {
          this.cachedAlgoUsd = data.price;
          this.cacheTimestamp = Date.now();
        }
      }
    } catch {
      /* use cached */
    }
    return this.cachedAlgoUsd;
  }

  /**
   * Convert scaled micro-USD to microALGO, exactly.
   *
   * The old form — `Math.ceil((usd / algoUsd) * 1e6)` — did a float divide and
   * a float multiply before rounding into the amount actually signed. Rounding
   * is a display decision, never a storage one (cp4096 IV). Rounds UP so the
   * payer covers the remainder rather than underpaying.
   */
  async usdToMicroAlgoExact(usdMicro: bigint): Promise<bigint> {
    const algoUsd = await this.getAlgoUsd();
    const rate = parseDecimal(algoUsd.toFixed(USD_DECIMALS), USD_DECIMALS);
    return usdToAssetUnits(usdMicro, USD_DECIMALS, rate, USD_DECIMALS, ALGO_DECIMALS, 'ceil');
  }

  /**
   * Convert USD to ALGO for DISPLAY ONLY.
   *
   * Returns a float and is therefore not usable in a value path — use
   * `usdToMicroAlgoExact()` for anything that will be signed. Kept because a
   * label needs a number, not because the arithmetic is sound
   * (cypherpunk4096 commitment IV).
   */
  async usdToAlgoForDisplay(usd: number): Promise<number> {
    const algoUsd = await this.getAlgoUsd();
    return +(usd / algoUsd).toFixed(6);
  }

  /** Get price for any ASA by asset ID (0 = ALGO native) */
  async getAssetPrice(asaId: number): Promise<{ usd: number; algo: number; source: string }> {
    if (asaId === 0) {
      const usd = await this.getAlgoUsd();
      return { usd, algo: 1, source: 'vestige' };
    }
    try {
      const res = await fetch(`${VESTIGE_API}/asset/${asaId}/price`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { price?: number; price_algo?: number };
        return {
          usd: data.price || 0,
          algo: data.price_algo || 0,
          source: 'vestige',
        };
      }
    } catch {
      /* fall through */
    }
    return { usd: 0, algo: 0, source: 'unavailable' };
  }

  /** Get BANKON token price (ASA 203977300) */
  async getBankonPrice(): Promise<{ usd: number; algo: number; source: string }> {
    return this.getAssetPrice(203977300);
  }

  /** Cache age in milliseconds */
  get cacheAge(): number {
    return Date.now() - this.cacheTimestamp;
  }

  /** Whether oracle data is fresh (within TTL) */
  get isFresh(): boolean {
    return this.cacheAge < this.cacheTtl;
  }

  /** Current cached price (no fetch) */
  get currentPrice(): number {
    return this.cachedAlgoUsd;
  }

  /** Force cache refresh on next call */
  invalidate(): void {
    this.cacheTimestamp = 0;
  }
}
