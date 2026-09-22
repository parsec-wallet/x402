// What the x402 module elects. It asks for signatures — payment groups through
// `chain_algo_sign_transaction` — and never for a key. Every reading leaves the device
// (the resource server, its facilitator, the Bazaar catalogue, an ASA balance from
// algod), the preferred network, the facilitator and the settlement receipts live in
// device storage, and the facilitator is the participant's to change.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import type { ModuleChoices } from '../module-choices';

export const X402_ID = 'x402';

export const X402_CHOICES: ModuleChoices = {
  privilege: 'sign',
  reach: 'external',
  persistence: 'device',
  provider: 'optional-external',
};
