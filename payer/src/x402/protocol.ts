// Parsec x402 — the wire protocol, version-agnostic.
//
// x402 has shipped twice. v1 put the challenge in the response *body* and the payment
// in an `X-PAYMENT` header; v2 (the one the Algorand facilitators speak) moves all three
// messages into base64 headers — `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`
// — renames `maxAmountRequired` to `amount`, swaps short network names for CAIP-2 ids, and
// makes `accepted` mandatory on the payment.
//
// Everything above the codec works in the v2 shape. Reading accepts either version and
// normalizes; writing emits v2 and, when the server declared v1, the v1 aliases as well.
// A server that speaks one version never sees the other's vocabulary.
//
// Spec: algorandfoundation/x402 `specs/x402-specification-v2.md`, `specs/transports-v2/http.md`.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import { toCaip2, type Caip2 } from './networks';

export const X402_VERSION = 2;

/** v2 headers — the canonical three. */
export const HEADER_PAYMENT_REQUIRED = 'PAYMENT-REQUIRED';
export const HEADER_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE';
export const HEADER_PAYMENT_RESPONSE = 'PAYMENT-RESPONSE';
/** v1 aliases, still emitted by servers that have not migrated. */
export const HEADER_X_PAYMENT = 'X-PAYMENT';
export const HEADER_X_PAYMENT_RESPONSE = 'X-PAYMENT-RESPONSE';

// ── Types ────────────────────────────────────────────────────────

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/** One way to pay, as the server offers it. Normalized to the v2 field names. */
export interface PaymentRequirements {
  scheme: string;
  network: Caip2;
  /** Atomic units of `asset`, as a decimal string. Never a number — these are exact. */
  amount: string;
  /** ASA id ('0' = native ALGO), ERC-20 address, or SPL mint. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
  /** Carried through from v1 so a v1 server sees its own vocabulary on the way back. */
  description?: string;
  mimeType?: string;
  outputSchema?: unknown;
}

/** The 402 challenge. */
export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** The payment the client sends back. */
export interface PaymentPayload {
  x402Version: number;
  /** Top-level scheme/network are redundant with `accepted` but several servers read them. */
  scheme?: string;
  network?: Caip2;
  resource?: ResourceInfo;
  /** Verbatim copy of the chosen `accepts[]` entry. Required in v2. */
  accepted: PaymentRequirements;
  /** Scheme-specific. For Algorand `exact`: `{ paymentGroup, paymentIndex }`. */
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** What the server reports after settlement. */
export interface SettlementResponse {
  success: boolean;
  /** The settled transaction id — on Algorand, of `paymentGroup[paymentIndex]`. */
  transaction: string;
  network: Caip2;
  payer?: string;
  errorReason?: string;
  errorMessage?: string;
  amount?: string;
  extensions?: Record<string, unknown>;
}

// ── base64 ───────────────────────────────────────────────────────
// `btoa(String.fromCharCode(...bytes))` blows the argument limit on anything
// sizeable and mangles anything outside latin-1. A payment group is neither small
// nor guaranteed ASCII, so both directions go through TextEncoder and chunking.

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeEnvelope(value: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeEnvelope<T>(b64: string): T {
  return JSON.parse(new TextDecoder().decode(base64ToBytes(b64.trim()))) as T;
}

// ── Reading a challenge ──────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * A non-negative decimal integer, or `'0'`.
 *
 * The amount is the one field on the wire that decides how much money moves, and it
 * arrives from a server this client has no reason to trust. Left unchecked it reaches
 * `BigInt()`, where `'0x10'` is silently 16 rather than 10, `'-1'` is a negative
 * transfer, and `'1e400'` throws in the middle of a payment instead of before one.
 *
 * Anything that is not plainly a decimal integer becomes `'0'`, which every rail then
 * refuses — a quote of nothing is unpayable, which is the correct outcome for a
 * requirement nobody can read.
 */
function amountOrZero(raw: unknown): string {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : '0';
  if (typeof raw !== 'string') return '0';
  const trimmed = raw.trim();
  // No sign, no exponent, no radix prefix, no separators. Just digits.
  return /^\d+$/.test(trimmed) ? String(BigInt(trimmed)) : '0';
}

/**
 * Normalize one `accepts[]` entry from either version.
 *
 * `amount` is taken from `amount` (v2) then `maxAmountRequired` (v1). It stays a
 * string the whole way: an atomic-unit quantity that passes through `Number` has
 * already lost the exactness the payment depends on (cypherpunk4096 IV).
 */
export function normalizeRequirement(raw: unknown): PaymentRequirements {
  const r = asRecord(raw);
  const declared = r.amount ?? r.maxAmountRequired;
  const amount = amountOrZero(declared);
  const network = toCaip2(str(r.network));
  return {
    scheme: str(r.scheme, 'exact'),
    network,
    amount,
    asset: str(r.asset, '0'),
    payTo: str(r.payTo),
    maxTimeoutSeconds: typeof r.maxTimeoutSeconds === 'number' ? r.maxTimeoutSeconds : 60,
    extra: asRecord(r.extra),
    description: typeof r.description === 'string' ? r.description : undefined,
    mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
    outputSchema: r.outputSchema ?? undefined,
  };
}

/**
 * Normalize a whole challenge.
 *
 * v1 put `resource` (a URL string), `description` and `mimeType` on each `accepts[]`
 * entry; v2 hoists them into one `resource` object. `requestUrl` is the fallback when
 * neither is present — a client always knows what it asked for.
 */
export function normalizeChallenge(raw: unknown, requestUrl: string): PaymentRequired {
  const r = asRecord(raw);
  const rawAccepts = Array.isArray(r.accepts)
    ? r.accepts
    : Array.isArray(r.paymentRequirements)
      ? r.paymentRequirements
      : [];
  const accepts = rawAccepts.map(normalizeRequirement);

  const resourceRaw = r.resource;
  let resource: ResourceInfo;
  if (resourceRaw && typeof resourceRaw === 'object') {
    const ro = asRecord(resourceRaw);
    resource = { url: str(ro.url, requestUrl), description: str(ro.description) || undefined, mimeType: str(ro.mimeType) || undefined };
  } else {
    const first = asRecord(rawAccepts[0]);
    resource = {
      url: str(resourceRaw) || str(first.resource) || requestUrl,
      description: str(first.description) || undefined,
      mimeType: str(first.mimeType) || undefined,
    };
  }

  return {
    // Undeclared means unknown, not v1: a server that names no version is assumed
    // current, and only one that says `1` gets the v1 headers back.
    x402Version: typeof r.x402Version === 'number' ? r.x402Version : X402_VERSION,
    error: str(r.error) || undefined,
    resource,
    accepts,
    extensions: r.extensions ? asRecord(r.extensions) : undefined,
  };
}

/**
 * Read the challenge from a 402 response.
 *
 * v2 puts it in the `PAYMENT-REQUIRED` header and leaves the body `{}`; v1 puts it
 * in the body. Header first, body second — a v2 server that also fills the body must
 * not be read as v1.
 *
 * Consumes the response body, so pass a response nothing else will read.
 */
export async function readChallenge(response: Response, requestUrl: string): Promise<PaymentRequired> {
  const header = response.headers.get(HEADER_PAYMENT_REQUIRED);
  if (header) {
    try {
      return normalizeChallenge(decodeEnvelope(header), requestUrl);
    } catch {
      /* malformed header — fall through to the body */
    }
  }
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    /* empty or non-JSON body */
  }
  return normalizeChallenge(body, requestUrl);
}

// ── Writing a payment ────────────────────────────────────────────

/** The headers that carry a payment, for the version the server declared. */
export function paymentHeaders(payment: PaymentPayload): Record<string, string> {
  const encoded = encodeEnvelope(payment);
  const headers: Record<string, string> = { [HEADER_PAYMENT_SIGNATURE]: encoded };
  if (payment.x402Version < 2) headers[HEADER_X_PAYMENT] = encoded;
  return headers;
}

/** Build the payment envelope around a scheme's payload. */
export function buildPayment(
  challenge: PaymentRequired,
  accepted: PaymentRequirements,
  payload: Record<string, unknown>,
): PaymentPayload {
  return {
    x402Version: challenge.x402Version || X402_VERSION,
    scheme: accepted.scheme,
    network: accepted.network,
    resource: challenge.resource,
    accepted,
    payload,
    extensions: {},
  };
}

// ── Reading a settlement ─────────────────────────────────────────

/**
 * The settlement readback, or null when the server sent none.
 *
 * This is where a settled transaction id comes from — the one thing the previous
 * payment flow never captured, and the reason a paid BANKON name claim had no proof
 * to carry.
 */
export function readSettlement(response: Response): SettlementResponse | null {
  const header =
    response.headers.get(HEADER_PAYMENT_RESPONSE) ?? response.headers.get(HEADER_X_PAYMENT_RESPONSE);
  if (!header) return null;
  try {
    const r = asRecord(decodeEnvelope(header));
    return {
      success: r.success !== false,
      transaction: str(r.transaction) || str(r.txHash) || str(r.txId),
      network: toCaip2(str(r.network)),
      payer: str(r.payer) || undefined,
      errorReason: str(r.errorReason) || undefined,
      errorMessage: str(r.errorMessage) || undefined,
      amount: str(r.amount) || undefined,
      extensions: r.extensions ? asRecord(r.extensions) : undefined,
    };
  } catch {
    return null;
  }
}
