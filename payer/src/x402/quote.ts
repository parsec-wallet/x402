// Parsec x402 — what a requirement actually costs, exactly.
//
// A requirement quotes `amount` in atomic units of `asset`. Turning that into something
// a participant can read must not go near a float: `Number('250000') / 1e6` is fine for
// a label and catastrophic anywhere near what gets signed, so the atomic value is carried
// as a bigint the whole way and only ever formatted for display (cypherpunk4096 IV).
//
// USD is derived, not authoritative. For a USD-pegged asset it is the same number at a
// different scale; for ALGO it is an oracle reading, and the quote says so — a settled
// payment is denominated in the asset, not in the estimate shown beside it.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import { ALGO_DECIMALS, USD_DECIMALS, formatDecimal, mulDiv, parseDecimal, rescale } from '../money';
import { describeAsset, describeNetwork } from './networks';
import type { PaymentRequirements } from './protocol';
import { PriceOracle } from './oracle';

const oracle = new PriceOracle();

/** Assets that are one-for-one with USD, so their USD value needs no oracle. */
const USD_PEGGED = new Set(['USDC', 'USDT', 'PYUSD', 'EURC']);

export interface X402Quote {
  requirement: PaymentRequirements;
  /** Atomic units of `asset`. This is the number that gets signed. */
  amountAtomic: bigint;
  decimals: number;
  assetSymbol: string;
  networkLabel: string;
  /** `0.25` — the amount in whole units of the asset. */
  amountDisplay: string;
  /** Scaled micro-USD, or null when no rate is available. */
  usdMicro: bigint | null;
  /** `$0.25` — or '' when no rate is available. */
  usdDisplay: string;
  /** How the USD figure was reached, so a label can say whether it is exact or a reading. */
  usdSource: 'pegged' | 'oracle' | 'none';
  /** True when the network is a testnet — nothing here is worth real money. */
  testnet: boolean;
}

/** The asset's decimals: the server's `extra.decimals` first, our table second. */
export function decimalsFor(requirement: PaymentRequirements): number {
  const declared = requirement.extra?.decimals;
  if (typeof declared === 'number' && declared >= 0 && declared <= 19) return declared;
  return describeAsset(requirement.network, requirement.asset).decimals;
}

/** The asset's symbol: the server's `extra.name` first, our table second. */
export function symbolFor(requirement: PaymentRequirements): string {
  const declared = requirement.extra?.name;
  if (typeof declared === 'string' && declared) return declared;
  return describeAsset(requirement.network, requirement.asset).symbol;
}

export async function quote(requirement: PaymentRequirements): Promise<X402Quote> {
  const decimals = decimalsFor(requirement);
  const symbol = symbolFor(requirement);
  const network = describeNetwork(requirement.network);
  const amountAtomic = BigInt(requirement.amount || '0');

  let usdMicro: bigint | null = null;
  let usdSource: X402Quote['usdSource'] = 'none';

  if (USD_PEGGED.has(symbol.toUpperCase())) {
    usdMicro = rescale(amountAtomic, decimals, USD_DECIMALS, 'ceil');
    usdSource = 'pegged';
  } else if (symbol.toUpperCase() === 'ALGO') {
    try {
      const algoUsd = await oracle.getAlgoUsd();
      const rate = parseDecimal(algoUsd.toFixed(USD_DECIMALS), USD_DECIMALS);
      // usd = amount × rate, carried from ALGO's scale to USD's.
      usdMicro = mulDiv(rescale(amountAtomic, decimals, ALGO_DECIMALS, 'ceil'), rate, 10n ** BigInt(ALGO_DECIMALS), 'ceil');
      usdSource = 'oracle';
    } catch {
      /* no rate — the quote stays denominated in the asset */
    }
  }

  return {
    requirement,
    amountAtomic,
    decimals,
    assetSymbol: symbol,
    networkLabel: network.label,
    amountDisplay: formatDecimal(amountAtomic, decimals, { maxFractionDigits: decimals }),
    usdMicro,
    usdDisplay: usdMicro === null ? '' : `$${formatDecimal(usdMicro, USD_DECIMALS, { maxFractionDigits: 4 })}`,
    usdSource,
    testnet: network.testnet,
  };
}

/** Quote every offer a challenge made, cheapest first by USD where known. */
export async function quoteAll(requirements: PaymentRequirements[]): Promise<X402Quote[]> {
  const quotes = await Promise.all(requirements.map(quote));
  return quotes.sort((a, b) => {
    if (a.usdMicro !== null && b.usdMicro !== null) return a.usdMicro < b.usdMicro ? -1 : a.usdMicro > b.usdMicro ? 1 : 0;
    return 0;
  });
}
