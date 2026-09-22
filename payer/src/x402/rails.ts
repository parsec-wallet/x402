// Parsec x402 — the rail registry.
//
// "Self-register, iterate, never branch on chain name" (docs/modules.md) applied to
// payment. A rail owns one CAIP-2 namespace and knows how to turn a `PaymentRequirements`
// into the scheme payload for that chain. The client picks a requirement by asking which
// rails are registered, never by testing the network string itself — which is how the old
// `executeX402Payment()` came to be hardcoded to Algorand with EVM and Solana payees
// unreachable behind it.
//
// Adding a chain to x402 is one `registerRail()` call.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import type { X402Signers } from './host';
import { familyFor, sameNetwork, type Caip2, type RailFamily, type WalletNetwork } from './networks';
import type { PaymentRequired, PaymentRequirements } from './protocol';

/** Everything a rail needs to build a payment, and nothing it does not. */
export interface X402PaymentContext {
  /** The requirement the participant approved. */
  requirement: PaymentRequirements;
  /** The whole challenge, for rails that need the resource url or an extension. */
  challenge: PaymentRequired;
  /** The address paying, in that chain's native format. */
  payer: string;
  /** The host's network selector for the rail, where it has one. */
  walletNetwork: WalletNetwork;
  /**
   * How to sign. A rail reaches for its own family's signer and nothing else.
   *
   * This is the seam that makes the module portable: before it, the Algorand rail
   * imported Parsec's Rust IPC directly and the payment path could only run inside
   * one application.
   */
  signers: X402Signers;
}

/** A blocking condition found before signing — reported, never worked around silently. */
export interface X402Blocker {
  code: 'not-opted-in' | 'insufficient-funds' | 'no-account' | 'unsupported' | 'other';
  message: string;
  /** Present when the wallet can clear it itself (e.g. an ASA opt-in). */
  remedy?: { label: string; run: () => Promise<void> };
}

export interface X402Preflight {
  ok: boolean;
  blockers: X402Blocker[];
  /** Spendable balance in atomic units of the quoted asset, when the rail can read it. */
  balance?: bigint;
}

export interface X402Rail {
  /** CAIP-2 namespace family this rail serves. */
  family: RailFamily;
  label: string;
  /** Schemes it implements — 'exact' today. */
  schemes: string[];
  /** Networks it will actually pay on. Empty means "any network in the family". */
  networks?: Caip2[];
  /**
   * Build the scheme payload — for Algorand `exact`, `{ paymentGroup, paymentIndex }`.
   * Signing happens here, through whatever custody the rail owns.
   */
  buildPayload(ctx: X402PaymentContext): Promise<Record<string, unknown>>;
  /** Check what would stop this payment before anything is signed. */
  preflight?(ctx: X402PaymentContext): Promise<X402Preflight>;
  /** The address this rail would pay from, given the wallet's current state. */
  resolvePayer?(walletNetwork: WalletNetwork): Promise<string>;
}

const rails = new Map<RailFamily, X402Rail>();

/**
 * Register a rail. The last registration for a family wins.
 *
 * Registration is a side effect of importing a rail module, which is what makes
 * `import './rails/avm'` enough to make Algorand payable. The cost is that **import
 * order decides which rail signs**: a file that imports `rails/avm` for an unrelated
 * helper will register the real rail and silently replace a stub a test had put there.
 * If a payment suddenly reaches a network it should not, look for a new import before
 * looking at this function.
 */
export function registerRail(rail: X402Rail): void {
  rails.set(rail.family, rail);
}

export function listRails(): X402Rail[] {
  return [...rails.values()];
}

/** The rail for a network, or null when nothing is registered for its namespace. */
export function railFor(network: string): X402Rail | null {
  let family: RailFamily;
  try {
    family = familyFor(network);
  } catch {
    return null;
  }
  const rail = rails.get(family);
  if (!rail) return null;
  if (rail.networks?.length && !rail.networks.some((n) => sameNetwork(n, network))) return null;
  return rail;
}

/** Whether a registered rail can satisfy this requirement. */
export function canPay(requirement: PaymentRequirements): boolean {
  const rail = railFor(requirement.network);
  return !!rail && rail.schemes.includes(requirement.scheme);
}

/**
 * Choose which of the server's offers to pay.
 *
 * Preference order: a requirement on `preferNetwork`, then any payable one, in the
 * order the server listed them — a server orders `accepts[]` by what it would rather
 * receive, and there is no reason to override that beyond the participant's own
 * network preference.
 */
export function selectRequirement(
  challenge: PaymentRequired,
  preferNetwork?: string,
): PaymentRequirements | null {
  const payable = challenge.accepts.filter(canPay);
  if (!payable.length) return null;
  if (preferNetwork) {
    const preferred = payable.find((r) => sameNetwork(r.network, preferNetwork));
    if (preferred) return preferred;
  }
  return payable[0];
}

/** Every network the server offered that no registered rail can pay, for an honest error. */
export function unpayableNetworks(challenge: PaymentRequired): string[] {
  return [...new Set(challenge.accepts.filter((r) => !canPay(r)).map((r) => r.network))];
}


