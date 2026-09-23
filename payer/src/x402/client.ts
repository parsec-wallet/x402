// Parsec x402 — the payment flow.
//
//   request → 402 → read the challenge → pick an offer a registered rail can pay →
//   quote it exactly → check what would block it → ask the participant → sign →
//   resend with PAYMENT-SIGNATURE → read the settlement → write a receipt.
//
// Two things it deliberately does not do. It does not choose the price: under the
// `exact` scheme the facilitator verifies the transferred amount against the quote, so
// a client that applied its own discount would produce a payment the network accepts and
// the facilitator rejects. A holder discount belongs to the server, and the payer hint
// below is how a server learns whom it is quoting for. And it does not settle its own
// payment: the resource server settles, because a settlement asserted by the party
// trying to be convinced is not evidence.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import { signerAddress, type X402Signers } from './host';
import { describeNetwork, familyFor, type RailFamily, type WalletNetwork } from './networks';
import {
  buildPayment,
  paymentHeaders,
  readChallenge,
  readSettlement,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
} from './protocol';
import { railFor, selectRequirement, unpayableNetworks, type X402Preflight } from './rails';
import { quote, type X402Quote } from './quote';
import { recordReceipt, type X402Receipt } from './receipts';
import { getX402Settings } from './settings';
import { bazaarInfoFrom, type BazaarInfo } from './bazaar';

/**
 * A hint, not a credential.
 *
 * A server cannot know who is asking until it has been paid, which makes per-payer
 * pricing — a BANKON holder discount, a subscriber rate — impossible to quote. This
 * header tells a server which address intends to pay so it can quote accordingly. It
 * asserts nothing: a server that acts on it without verifying holdings on chain has
 * only itself to blame, and a server that ignores it loses nothing.
 */
export const HEADER_PAYER_HINT = 'X-Payer-Hint';

/** Everything the confirmation surface needs, and nothing it must not have. */
export interface PendingX402Payment {
  url: string;
  requestInit?: RequestInit;
  challenge: PaymentRequired;
  /** The offer that will be paid. */
  requirement: PaymentRequirements;
  quote: X402Quote;
  /** Every offer the server made, quoted — so the participant can see what was passed over. */
  alternatives: X402Quote[];
  payer: string;
  walletNetwork: WalletNetwork;
  /** The signers this payment will use. Carried so the confirmation surface can sign. */
  signers: X402Signers;
  /** Null when preflight is disabled in settings. */
  preflight: X402Preflight | null;
  /** The endpoint's own declaration of what it takes and returns, when it published one. */
  bazaar: BazaarInfo | null;
  /** True when this is about to move real value. */
  mainnet: boolean;
}

export interface X402PaymentResult {
  success: boolean;
  /** The settled transaction id. Assigned — which is the whole point of this rewrite. */
  txId?: string;
  settlement?: SettlementResponse;
  receipt?: X402Receipt;
  response?: Response;
  error?: string;
}

/** Decide whether to pay. Returning false declines; the flow then throws `X402Declined`. */
export type ApproveFn = (pending: PendingX402Payment) => Promise<boolean>;

export class X402Declined extends Error {
  constructor() {
    super('Payment declined');
    this.name = 'X402Declined';
  }
}

/**
 * The request was sent with a signed payment and no answer came back.
 *
 * Deliberately not a failure. The server may have received the payment, settled it, and
 * failed only on the way back — in which case the money moved and there is a transaction
 * id on chain that this client never saw. Anything that catches this must say *unknown*,
 * not *failed*, and the remedy is to look at the chain or ask the server, never to pay
 * again.
 */
export class X402Indeterminate extends Error {
  readonly url: string;
  readonly payTo: string;
  constructor(url: string, payTo: string) {
    super(
      `No response after the payment was sent to ${url}. It may have settled. ` +
        `Check the chain for a transfer to ${payTo} before paying again.`,
    );
    this.name = 'X402Indeterminate';
    this.url = url;
    this.payTo = payTo;
  }
}

export class X402Unpayable extends Error {
  readonly networks: string[];
  constructor(networks: string[]) {
    super(
      networks.length
        ? `No registered rail can pay this resource. It accepts: ${networks.join(', ')}.`
        : 'The server returned 402 but offered no payment requirements.',
    );
    this.name = 'X402Unpayable';
    this.networks = networks;
  }
}

export interface X402FetchOptions {
  /**
   * How to sign, per rail family. The normal way to pay.
   *
   * A signer carries its own address, so supplying these supplies the payer too —
   * `payer`/`payers` below exist for the read-only paths, where nothing is signed.
   */
  signers?: X402Signers;
  /** The address paying, when the caller knows there is only one rail in play. */
  payer?: string;
  /** Addresses per rail family. Used when no signer for that family was given. */
  payers?: Partial<Record<RailFamily, string>>;
  /** Called before signing. Omit only for an unattended flow under an auto-approve cap. */
  approve?: ApproveFn;
  /** Override the preferred network for this call. */
  preferNetwork?: string;
  /** Send the payer hint on the initial probe so a server can quote per-payer. Default true. */
  sendPayerHint?: boolean;
  /**
   * How long to wait for a resource that has not been paid yet. Default 30 s.
   *
   * Only bounds the free half — the probe and the discovery. The paid request is bounded
   * by the server's own `maxTimeoutSeconds`, because that is the window it said it would
   * hold the quote open for.
   */
  timeoutMs?: number;
}

/** A probe or discovery that has not cost anything yet. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How long to wait after sending a payment.
 *
 * The server states `maxTimeoutSeconds` — how long it will hold the quote — so waiting
 * meaningfully longer is waiting for something that has already expired, and waiting less
 * gives up on a payment that may still be settling. Floored at 30 s so a server naming
 * something tiny cannot make every payment indeterminate, and capped at 3 min so nothing
 * hangs forever.
 */
export function settleTimeoutMs(maxTimeoutSeconds: number): number {
  const stated = Number.isFinite(maxTimeoutSeconds) && maxTimeoutSeconds > 0 ? maxTimeoutSeconds * 1000 : 60_000;
  return Math.min(Math.max(stated, 30_000), 180_000);
}

/**
 * Which address pays for this requirement.
 *
 * Throws rather than falling back to whatever address was nearest: signing an EVM
 * authorization whose `from` is an Algorand address produces a signature that recovers
 * to nobody, and the failure would surface at the facilitator as something unrelated.
 */
export function resolvePayer(network: string, options: X402FetchOptions): string {
  const family = familyFor(network);
  // A signer knows its own address, so it is the most authoritative source.
  const chosen = signerAddress(options.signers, family) || options.payers?.[family] || options.payer || '';
  if (!chosen) {
    throw new Error(
      `No ${family.toUpperCase()} address in this wallet to pay a ${describeNetwork(network).label} requirement.`,
    );
  }
  return chosen;
}

/** Build the pending payment for a challenge, without signing anything. */
export async function preparePayment(
  url: string,
  challenge: PaymentRequired,
  options: X402FetchOptions,
  init?: RequestInit,
): Promise<PendingX402Payment> {
  const settings = getX402Settings();
  const requirement = selectRequirement(challenge, options.preferNetwork ?? settings.preferNetwork);
  if (!requirement) throw new X402Unpayable(unpayableNetworks(challenge));

  const network = describeNetwork(requirement.network);
  const walletNetwork: WalletNetwork = network.walletNetwork ?? 'testnet';
  const rail = railFor(requirement.network);
  if (!rail) throw new X402Unpayable([requirement.network]);

  const payer = resolvePayer(requirement.network, options);
  const signers = options.signers ?? {};
  const ctx = { requirement, challenge, payer, walletNetwork, signers };
  const [q, alternatives, pre] = await Promise.all([
    quote(requirement),
    Promise.all(challenge.accepts.map(quote)),
    settings.preflight && rail.preflight ? rail.preflight(ctx) : Promise.resolve(null),
  ]);

  return {
    url,
    requestInit: init,
    challenge,
    requirement,
    quote: q,
    alternatives,
    payer,
    walletNetwork,
    signers,
    preflight: pre,
    bazaar: bazaarInfoFrom(challenge.extensions),
    mainnet: !network.testnet,
  };
}

/** Sign the payment for a prepared quote. Nothing is sent. */
export async function signPayment(pending: PendingX402Payment): Promise<PaymentPayload> {
  const rail = railFor(pending.requirement.network);
  if (!rail) throw new X402Unpayable([pending.requirement.network]);
  const payload = await rail.buildPayload({
    requirement: pending.requirement,
    challenge: pending.challenge,
    payer: pending.payer,
    walletNetwork: pending.walletNetwork,
    signers: pending.signers,
  });
  return buildPayment(pending.challenge, pending.requirement, payload);
}

/**
 * Send the signed payment and read what came back.
 *
 * The receipt is written on a decoded settlement, not on a 200: a payment can settle and
 * the resource still fail, and losing the transaction id in that case is exactly the
 * failure this module was rewritten to stop.
 */
export async function submitPayment(
  pending: PendingX402Payment,
  payment: PaymentPayload,
): Promise<X402PaymentResult> {
  let response: Response;
  try {
    response = await fetch(pending.url, {
      ...pending.requestInit,
      headers: {
        ...(pending.requestInit?.headers as Record<string, string> | undefined),
        ...paymentHeaders(payment),
        Accept: (pending.requestInit?.headers as Record<string, string> | undefined)?.Accept ?? 'application/json',
      },
      signal: AbortSignal.timeout(settleTimeoutMs(pending.requirement.maxTimeoutSeconds)),
    });
  } catch (err) {
    // The payment is signed and was sent. Silence is not proof it failed.
    throw new X402Indeterminate(pending.url, pending.requirement.payTo);
  }

  const settlement = readSettlement(response);
  let receipt: X402Receipt | undefined;

  if (settlement?.transaction) {
    receipt = {
      txId: settlement.transaction,
      network: settlement.network || pending.requirement.network,
      url: pending.url,
      description: pending.challenge.resource.description,
      payer: settlement.payer || pending.payer,
      payTo: pending.requirement.payTo,
      amount: pending.requirement.amount,
      asset: pending.requirement.asset,
      assetSymbol: pending.quote.assetSymbol,
      decimals: pending.quote.decimals,
      scheme: pending.requirement.scheme,
      settledAt: new Date().toISOString(),
      delivered: response.ok,
      error: response.ok ? undefined : `resource returned ${response.status}`,
    };
    recordReceipt(receipt);
  }

  if (response.ok) {
    return { success: true, txId: settlement?.transaction, settlement: settlement ?? undefined, receipt, response };
  }

  const reason =
    settlement?.errorMessage ||
    settlement?.errorReason ||
    `resource returned ${response.status} ${response.statusText}`;
  return { success: false, txId: settlement?.transaction, settlement: settlement ?? undefined, receipt, response, error: reason };
}

/**
 * Fetch a resource, paying for it if it asks.
 *
 * Behaves exactly like `fetch` when the resource is free — a 402 is the only thing that
 * changes the shape of what happens.
 */
export async function x402Fetch(
  url: string,
  init: RequestInit | undefined,
  options: X402FetchOptions,
): Promise<Response> {
  const result = await x402Request(url, init, options);
  if (!result.success || !result.response) throw new Error(result.error || 'Payment failed');
  return result.response;
}

/** The same flow as `x402Fetch`, returning the receipt and transaction id rather than only the body. */
export async function x402Request(
  url: string,
  init: RequestInit | undefined,
  options: X402FetchOptions,
): Promise<X402PaymentResult> {
  const settings = getX402Settings();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  const hint = hintAddress(options, settings.preferNetwork);
  if (options.sendPayerHint !== false && hint) headers[HEADER_PAYER_HINT] = hint;

  const first = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (first.status !== 402) {
    return { success: first.ok, response: first, error: first.ok ? undefined : `${first.status} ${first.statusText}` };
  }

  const challenge = await readChallenge(first, url);
  const pending = await preparePayment(url, challenge, options, { ...init, headers });

  const blocked = pending.preflight && !pending.preflight.ok;
  const underCap =
    !blocked &&
    settings.autoApproveMicroUsd > 0 &&
    pending.quote.usdMicro !== null &&
    pending.quote.usdMicro <= BigInt(settings.autoApproveMicroUsd);

  if (!underCap) {
    if (!options.approve) {
      throw new Error(
        blocked
          ? `Payment blocked: ${pending.preflight?.blockers.map((b) => b.message).join(' ')}`
          : 'Payment requires approval and no approval handler was provided.',
      );
    }
    const approved = await options.approve(pending);
    if (!approved) throw new X402Declined();
  }

  const payment = await signPayment(pending);
  return submitPayment(pending, payment);
}

/**
 * The address to hint on the probe — the one for the preferred network's rail, since
 * that is the offer we would most likely take, falling back to any we have.
 */
function hintAddress(options: X402FetchOptions, preferNetwork: string): string {
  try {
    return resolvePayer(preferNetwork, options);
  } catch {
    return options.payer ?? Object.values(options.payers ?? {})[0] ?? '';
  }
}

/**
 * Probe a resource for its payment requirements without paying.
 *
 * The free half of the protocol: what a desk shows before a participant commits, and
 * what an agent reads to decide whether a resource is worth the money.
 */
export async function discoverRequirements(
  url: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PaymentRequired | null> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 402) return null;
  return readChallenge(response, url);
}
