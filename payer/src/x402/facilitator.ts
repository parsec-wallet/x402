// Parsec x402 — the facilitator, read-only.
//
// A facilitator does three things: it declares what it can settle (`/supported`), it
// verifies and submits payment groups for resource servers (`/verify`, `/settle`), and
// it catalogues the resources that settle through it (`/discovery/*` — the Bazaar).
//
// Parsec is a client, so it calls the first and the third. `/verify` and `/settle` are
// the *resource server's* calls to make; a client that settled its own payment would be
// asserting the payment succeeded to the party it is trying to convince. They are here
// only as a read-only dry run the desk can offer before a payment is sent.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import { toCaip2, type Caip2 } from './networks';
import type { PaymentPayload, PaymentRequirements, SettlementResponse } from './protocol';
import { X402_VERSION } from './protocol';
import { getX402Settings } from './settings';

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: Caip2;
  /** `extra.feePayer` here is the address that will sponsor fees on that network. */
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: string[];
  /** CAIP family pattern (`algorand:*`) → the facilitator's signer addresses. */
  signers: Record<string, string[]>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

const TIMEOUT = 15_000;

function base(url?: string): string {
  return (url || getX402Settings().facilitatorUrl).replace(/\/$/, '');
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`facilitator ${res.status} ${res.statusText}: ${url}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`facilitator ${res.status} ${res.statusText}: ${url}`);
  return (await res.json()) as T;
}

/** What the facilitator can settle, and who sponsors fees on each network. */
export async function getSupported(facilitatorUrl?: string): Promise<SupportedResponse> {
  const raw = await getJson<SupportedResponse>(`${base(facilitatorUrl)}/supported`);
  return {
    kinds: (raw.kinds ?? []).map((k) => ({ ...k, network: toCaip2(k.network) })),
    extensions: raw.extensions ?? [],
    signers: raw.signers ?? {},
  };
}

/** The fee payer this facilitator sponsors on a network, or '' when it sponsors none. */
export function feePayerFor(supported: SupportedResponse, network: string): string {
  const caip2 = toCaip2(network);
  const kind = supported.kinds.find((k) => k.network === caip2);
  const extra = kind?.extra as { feePayer?: string } | undefined;
  if (extra?.feePayer) return extra.feePayer;
  const namespace = caip2.slice(0, caip2.indexOf(':'));
  return supported.signers[`${namespace}:*`]?.[0] ?? '';
}

export interface FacilitatorHealth {
  reachable: boolean;
  name?: string;
  version?: string;
  kinds: SupportedKind[];
  extensions: string[];
  error?: string;
}

/** One round trip for the desk's status row. Never throws. */
export async function probeFacilitator(facilitatorUrl?: string): Promise<FacilitatorHealth> {
  const url = base(facilitatorUrl);
  try {
    const [root, supported] = await Promise.all([
      getJson<{ name?: string; version?: string }>(`${url}/`).catch(() => ({}) as { name?: string; version?: string }),
      getSupported(url),
    ]);
    return {
      reachable: true,
      name: root.name,
      version: root.version,
      kinds: supported.kinds,
      extensions: supported.extensions,
    };
  } catch (err) {
    return { reachable: false, kinds: [], extensions: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ask the facilitator whether a payment group would verify, without settling it.
 *
 * A dry run: it simulates the group against a node and reports what the resource
 * server would be told. Useful to prove a group is well-formed before handing it to a
 * server that will only ever answer 402.
 */
export async function verifyPayment(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
  facilitatorUrl?: string,
): Promise<VerifyResponse> {
  return postJson<VerifyResponse>(`${base(facilitatorUrl)}/verify`, {
    x402Version: payment.x402Version || X402_VERSION,
    paymentPayload: payment,
    paymentRequirements: requirements,
  });
}

/**
 * Settle a payment group directly.
 *
 * Present for completeness and for operating a resource server from the desk; a normal
 * client never calls it, because a settlement the client performed is not a settlement
 * the resource server has any reason to accept.
 */
export async function settlePayment(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
  facilitatorUrl?: string,
): Promise<SettlementResponse> {
  return postJson<SettlementResponse>(`${base(facilitatorUrl)}/settle`, {
    x402Version: payment.x402Version || X402_VERSION,
    paymentPayload: payment,
    paymentRequirements: requirements,
  });
}
