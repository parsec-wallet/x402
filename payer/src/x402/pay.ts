// Parsec x402 — the short way in.
//
// Everything below this file is available piecemeal, and using it that way means knowing
// about rails, requirements, quotes, preflight and receipts before paying for anything.
// That is the right surface for a wallet building its own confirmation screen, and far
// too much for an agent that wants one paid endpoint.
//
//   const x402 = createX402Client({ signers: { avm: algorandSigner(addr, signer) } });
//   const res  = await x402.fetch('https://api.example.com/weather');
//
// One object, configured once, holding the signers. Free requests pass straight through;
// a 402 is paid and the settlement recorded.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import {
  discoverRequirements,
  preparePayment,
  signPayment,
  submitPayment,
  x402Request,
  X402Unpayable,
  type ApproveFn,
  type PendingX402Payment,
  type X402PaymentResult,
} from './client';
import { configureX402Host, type X402Host, type X402Signers } from './host';
import { listReceipts, receiptsFor, type X402Receipt } from './receipts';
import { getX402Settings, setX402Settings, type X402Settings } from './settings';
import { quote, type X402Quote } from './quote';
import { selectRequirement, unpayableNetworks } from './rails';
import { listResources, searchResources, type BazaarQuery, type BazaarResource } from './bazaar';
import { probeFacilitator, type FacilitatorHealth } from './facilitator';
import type { PaymentRequired } from './protocol';

export interface X402ClientOptions {
  /** How to sign, per rail. Without these the client can read and quote but not pay. */
  signers?: X402Signers;
  /**
   * Called before anything is signed. Return false to decline.
   *
   * Omitting it means every payment is refused unless it falls under the auto-approve
   * cap — silence is not consent, and a client that pays by default is a client that
   * pays for a redirect.
   */
  approve?: ApproveFn;
  /** Preferred network when a server offers more than one payable option. */
  preferNetwork?: string;
  /** Storage, node endpoints — anything this host does differently. Applied on construction. */
  host?: Partial<X402Host>;
  /** Settings to apply on construction: facilitator, auto-approve cap, preflight. */
  settings?: Partial<X402Settings>;
}

export interface X402Client {
  /** `fetch`, except a 402 is paid. Throws on decline or when nothing can pay. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The same flow, returning the transaction id and receipt rather than only the body. */
  request(url: string, init?: RequestInit): Promise<X402PaymentResult>;
  /** What a resource would charge, without paying. Null when it is free. */
  probe(url: string, init?: RequestInit): Promise<PaymentRequired | null>;
  /** What a resource costs right now, priced. Null when it is free. Needs no signer. */
  quote(url: string, init?: RequestInit): Promise<X402Quote | null>;
  /** Prepare a payment for a challenge without signing — for a custom confirmation screen. */
  prepare(url: string, challenge: PaymentRequired, init?: RequestInit): Promise<PendingX402Payment>;
  /** Sign and send a prepared payment. Pairs with `prepare`. */
  pay(pending: PendingX402Payment): Promise<X402PaymentResult>;
  /** Browse the facilitator's catalogue of paid resources. Free. */
  discover(query?: BazaarQuery): Promise<BazaarResource[]>;
  /** Search that catalogue. Free. */
  search(term: string, query?: BazaarQuery): Promise<BazaarResource[]>;
  /** What the facilitator says it can settle, and who sponsors fees. */
  facilitator(): Promise<FacilitatorHealth>;
  /** Settlements recorded on this device, newest first. */
  receipts(url?: string): X402Receipt[];
  /** Swap the signers — a wallet changing account, without rebuilding the client. */
  useSigners(signers: X402Signers): void;
}

/**
 * Build a client.
 *
 * The signers are the only thing most callers need. Everything else has a default that
 * works: a public node, the GoPlausible facilitator for discovery, `localStorage` where
 * it exists and memory where it does not.
 */
export function createX402Client(options: X402ClientOptions = {}): X402Client {
  if (options.host) configureX402Host(options.host);
  if (options.settings) setX402Settings(options.settings);

  let signers: X402Signers = options.signers ?? {};
  const fetchOptions = () => ({
    signers,
    approve: options.approve,
    preferNetwork: options.preferNetwork ?? getX402Settings().preferNetwork,
  });

  return {
    async fetch(url, init) {
      const result = await x402Request(url, init, fetchOptions());
      if (!result.success || !result.response) throw new Error(result.error || 'Payment failed');
      return result.response;
    },

    request: (url, init) => x402Request(url, init, fetchOptions()),

    probe: (url, init) => discoverRequirements(url, init),

    async quote(url, init) {
      // Deliberately not `prepare`: quoting signs nothing and reads no balance, so it
      // must not require a signer. An agent deciding whether a resource is worth paying
      // for should not have to hold a key to find out what it costs.
      const challenge = await discoverRequirements(url, init);
      if (!challenge) return null;
      const requirement = selectRequirement(challenge, options.preferNetwork ?? getX402Settings().preferNetwork);
      if (!requirement) throw new X402Unpayable(unpayableNetworks(challenge));
      return quote(requirement);
    },

    prepare: (url, challenge, init) => preparePayment(url, challenge, fetchOptions(), init),

    async pay(pending) {
      return submitPayment(pending, await signPayment(pending));
    },

    async discover(query) {
      return (await listResources(query)).items;
    },

    async search(term, query) {
      return (await searchResources(term, query)).items;
    },

    facilitator: () => probeFacilitator(),

    receipts: (url) => (url ? receiptsFor(url) : listReceipts()),

    useSigners(next) {
      signers = next;
    },
  };
}

export { quote as quoteRequirement };
