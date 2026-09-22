// Parsec x402 — per-device settings.
//
// Which network to prefer when a server offers several, which facilitator to ask about
// capabilities and discovery, and the ceiling under which a payment may be made without
// a confirmation dialog. The cap is stored in atomic USD units (micro-USD) and defaults
// to zero: nothing is ever paid silently until the participant says otherwise.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import { hostStorage } from './host';
import { ALGORAND_MAINNET, ALGORAND_TESTNET, toCaip2, type Caip2 } from './networks';

/** GoPlausible runs the facilitator the Algorand x402 ecosystem settles through. */
export const DEFAULT_FACILITATOR = 'https://facilitator.goplausible.xyz';

export interface X402Settings {
  /** Preferred network when a challenge offers more than one payable option. */
  preferNetwork: Caip2;
  /** Facilitator for `/supported` and Bazaar discovery. Payment settles through whichever facilitator the resource's `extra.feePayer` names. */
  facilitatorUrl: string;
  /** Auto-approve payments at or below this, in micro-USD. 0 disables auto-approval. */
  autoApproveMicroUsd: number;
  /** Ask the rail to read balance and opt-in state before showing the confirmation. */
  preflight: boolean;
}

const KEY = 'parsec-x402-settings';

export const DEFAULT_X402_SETTINGS: X402Settings = {
  preferNetwork: ALGORAND_TESTNET,
  facilitatorUrl: DEFAULT_FACILITATOR,
  autoApproveMicroUsd: 0,
  preflight: true,
};

export function getX402Settings(): X402Settings {
  try {
    const raw = hostStorage().getItem(KEY);
    if (!raw) return { ...DEFAULT_X402_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<X402Settings>;
    return {
      preferNetwork: parsed.preferNetwork ? toCaip2(parsed.preferNetwork) : DEFAULT_X402_SETTINGS.preferNetwork,
      facilitatorUrl:
        typeof parsed.facilitatorUrl === 'string' && parsed.facilitatorUrl
          ? parsed.facilitatorUrl.replace(/\/$/, '')
          : DEFAULT_FACILITATOR,
      autoApproveMicroUsd:
        Number.isFinite(parsed.autoApproveMicroUsd) && (parsed.autoApproveMicroUsd as number) >= 0
          ? Math.floor(parsed.autoApproveMicroUsd as number)
          : 0,
      preflight: parsed.preflight !== false,
    };
  } catch {
    return { ...DEFAULT_X402_SETTINGS };
  }
}

export function setX402Settings(next: Partial<X402Settings>): X402Settings {
  const merged = { ...getX402Settings(), ...next };
  try { hostStorage().setItem(KEY, JSON.stringify(merged)); } catch { /* storage unavailable */ }
  return merged;
}

/** Whether the preferred network is a mainnet — the one thing worth being loud about. */
export function isMainnetPreferred(s: X402Settings = getX402Settings()): boolean {
  return s.preferNetwork === ALGORAND_MAINNET;
}
