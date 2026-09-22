// Parsec x402 — the settlement ledger.
//
// The old payment flow declared `txId` and never assigned it: nothing read
// `X-PAYMENT-RESPONSE`, so a payment that succeeded left no proof it had. Every
// proof-carrying flow downstream — a paid BANKON name claim needs exactly an Algorand
// transaction id paying a quoted address — was blocked on that one missing line.
//
// A receipt is written the moment a settlement readback is decoded, whether the resource
// then returned 200 or not: a payment that settled and a resource that failed to deliver
// are two different facts, and the first is the one worth keeping.
//
// Device storage. A receipt is not a secret — it is a public transaction id and a URL —
// but it is the participant's record, so it never leaves the machine.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import { hostStorage } from './host';
import { explorerTxUrl, type Caip2 } from './networks';

export interface X402Receipt {
  /** Settled transaction id. On Algorand, of `paymentGroup[paymentIndex]`. */
  txId: string;
  network: Caip2;
  /** Resource paid for. */
  url: string;
  description?: string;
  payer: string;
  payTo: string;
  /** Atomic units of `asset`, as a string — receipts survive JSON round trips. */
  amount: string;
  asset: string;
  assetSymbol: string;
  decimals: number;
  scheme: string;
  /** ISO 8601, when the settlement was read. */
  settledAt: string;
  /** Whether the resource itself then came back OK. */
  delivered: boolean;
  /** Set when the payment settled but something afterwards did not. */
  error?: string;
}

const KEY = 'parsec-x402-receipts';
const LIMIT = 500;

type Listener = (receipts: X402Receipt[]) => void;
const listeners = new Set<Listener>();

export function listReceipts(): X402Receipt[] {
  try {
    const raw = hostStorage().getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as X402Receipt[]) : [];
  } catch {
    return [];
  }
}

/** Append a receipt, newest first. Returns the stored list. */
export function recordReceipt(receipt: X402Receipt): X402Receipt[] {
  const next = [receipt, ...listReceipts().filter((r) => r.txId !== receipt.txId)].slice(0, LIMIT);
  try { hostStorage().setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  listeners.forEach((fn) => fn(next));
  return next;
}

export function clearReceipts(): void {
  try { hostStorage().removeItem(KEY); } catch { /* storage unavailable */ }
  listeners.forEach((fn) => fn([]));
}

export function onReceipts(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Receipts for one resource URL — what a paywalled page asks before paying twice. */
export function receiptsFor(url: string): X402Receipt[] {
  return listReceipts().filter((r) => r.url === url);
}

/**
 * The most recent settled payment to an address, on a network.
 *
 * This is the lookup a name claim makes: BNR's `Payment-Proof` wants the transaction id
 * of a payment to the registry treasury, and this is where one comes from.
 */
export function latestReceiptTo(payTo: string, network?: string): X402Receipt | null {
  return (
    listReceipts().find((r) => r.payTo === payTo && (!network || r.network === network)) ?? null
  );
}

/** Explorer link for a receipt, or '' when the network has no known explorer. */
export function receiptExplorerUrl(receipt: X402Receipt): string {
  return explorerTxUrl(receipt.network, receipt.txId);
}

/** Total settled per asset, for the desk's summary row. */
export function totals(): Array<{ assetSymbol: string; network: Caip2; amount: bigint; decimals: number; count: number }> {
  const byKey = new Map<string, { assetSymbol: string; network: Caip2; amount: bigint; decimals: number; count: number }>();
  for (const r of listReceipts()) {
    const key = `${r.network}:${r.asset}`;
    const entry = byKey.get(key) ?? { assetSymbol: r.assetSymbol, network: r.network, amount: 0n, decimals: r.decimals, count: 0 };
    entry.amount += BigInt(r.amount || '0');
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}
