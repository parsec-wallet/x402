// x402 — the module manifest. One registration: routes, rail entries, dashboard tile.
//
// Importing this file registers the rails as a side effect, so a payment flow reached
// from anywhere in the app finds one without each caller remembering to import it.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import { registerModule } from '../modules';
import { x402DashboardModule } from '../dashboard/x402-module';
import { X402_CHOICES, X402_ID } from './choices';
import './rails/avm';
import './rails/evm';

registerModule({
  id: X402_ID,
  tier: 'agenticplace',
  priority: 25,
  enabled: true,
  choices: X402_CHOICES,
  routes: [
    {
      id: 'x402-desk',
      title: 'x402 Desk',
      load: async () => (await import('../../views/x402-desk')).x402DeskView,
      disclosure: 'more',
      inRail: true,
      keywords: ['x402', 'pay', 'micropayment', 'facilitator', 'usdc', 'receipts'],
    },
    {
      id: 'x402-bazaar',
      title: 'Bazaar',
      load: async () => (await import('../../views/x402-bazaar')).x402BazaarView,
      disclosure: 'more',
      inRail: true,
      keywords: ['bazaar', 'discovery', 'paid api', 'resources', 'marketplace'],
    },
    {
      id: 'x402-confirm',
      title: 'Confirm Payment',
      load: async () => (await import('../../views/x402-confirm')).x402ConfirmView,
      disclosure: 'simple',
      modal: true,
    },
  ],
  dashboard: x402DashboardModule,
});
