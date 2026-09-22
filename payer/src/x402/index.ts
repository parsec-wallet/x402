// Parsec x402 — module index.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

// The short way in
export * from './pay';

// Ports — how a host plugs in its signing, storage and nodes
export * from './host';
export * from './adapters/wallets';

// The wire
export * from './protocol';
export * from './networks';

// The rails
export * from './rails';
export { avmRail, buildPaymentGroup, signPaymentGroup, preflightAvm, optInToAsset, isOptedIn, signAndSend, sendAlgoPayment, walletNetworkFor } from './rails/avm';
export type { AvmPaymentPayload } from './rails/avm';
export { evmRail, buildAuthorization, preflightEvm, validityWindow, chainIdOf, randomNonce, setEvmRpc } from './rails/evm';
export type { EvmPaymentPayload } from './rails/evm';

// The flow
export * from './client';
export * from './quote';
export * from './receipts';
export * from './settings';
export * from './facilitator';
export * from './bazaar';
