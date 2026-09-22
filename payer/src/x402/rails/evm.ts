// Parsec x402 — the EVM rail, scheme `exact`, EIP-3009.
//
// Where Algorand builds an atomic group, EVM signs an authorization. The payer signs an
// EIP-712 `TransferWithAuthorization` naming the recipient, the amount and a validity
// window; the facilitator calls `transferWithAuthorization` on the token and pays the
// gas. The facilitator can decline to broadcast; it cannot change where the money goes
// or how much of it moves. That asymmetry is the whole scheme.
//
//   payload = { signature: "0x…65 bytes", authorization: { from, to, value,
//               validAfter, validBefore, nonce } }
//
// The nonce is 32 random bytes and single-use — the token contract marks it spent, which
// is what stops a facilitator replaying an authorization it has already settled.
//
// Signing goes through whatever `EvmSigner` the caller supplied. Parsec passes one backed
// by Rust (`chain_evm_sign_transfer_authorization`), which builds the EIP-712 digest itself
// from named fields — the key never enters the renderer and the renderer cannot ask for a
// signature over anything else. A browser wallet passes one wrapping
// `eth_signTypedData_v4`; see `adapters/eip1193.ts`.
//
// Spec: `specs/schemes/exact/scheme_exact_evm.md` in algorandfoundation/x402; EIP-3009.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import { hostEvmRpc } from '../host';
import { describeNetwork, toCaip2 } from '../networks';
import { registerRail, type X402Blocker, type X402PaymentContext, type X402Preflight, type X402Rail } from '../rails';

/** The scheme payload for EVM `exact` via EIP-3009. */
export interface EvmPaymentPayload extends Record<string, unknown> {
  signature: string;
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
}

/** Point the rail at a different JSON-RPC endpoint for a chain. */
export function setEvmRpc(network: string, url: string): void {
  overrides[toCaip2(network)] = url;
}

const overrides: Record<string, string> = {};

function rpcFor(network: string): string {
  return overrides[toCaip2(network)] || hostEvmRpc(network);
}

/** `eip155:8453` → `8453`. */
export function chainIdOf(network: string): number {
  const caip2 = toCaip2(network);
  const reference = caip2.slice(caip2.indexOf(':') + 1);
  const id = Number(reference);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`not an eip155 chain id: ${caip2}`);
  return id;
}

/** 32 random bytes as 0x-hex. Single-use by the token contract's own bookkeeping. */
export function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

// ── Minimal ABI, inline ──────────────────────────────────────────────────────
// `balanceOf(address)` and a uint256 read. Eight lines rather than a dependency on
// the permaweb bridge's encoder, which is built for a different token on a fixed
// chain and would drag its constants in with it.

const BALANCE_OF = '0x70a08231';

function encodeBalanceOf(address: string): string {
  return BALANCE_OF + address.trim().replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

function decodeUint256(hex: string): bigint {
  const body = (hex || '0x0').trim();
  return BigInt(body === '0x' ? '0x0' : body);
}

async function ethCall(network: string, to: string, data: string): Promise<string> {
  const url = rpcFor(network);
  if (!url) throw new Error(`no RPC configured for ${describeNetwork(network).label}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: string; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || 'RPC error');
  return json.result ?? '0x0';
}

// ── The rail ─────────────────────────────────────────────────────────────────

/**
 * The validity window the authorization carries.
 *
 * `validAfter` is backdated a minute so a payer whose clock runs fast does not sign
 * something no node will accept yet; `validBefore` is the server's own
 * `maxTimeoutSeconds` from now, which is the window it said it would wait.
 */
export function validityWindow(maxTimeoutSeconds: number, now = Date.now()): { validAfter: string; validBefore: string } {
  const seconds = Math.floor(now / 1000);
  const timeout = Number.isFinite(maxTimeoutSeconds) && maxTimeoutSeconds > 0 ? Math.floor(maxTimeoutSeconds) : 60;
  return { validAfter: String(seconds - 60), validBefore: String(seconds + timeout) };
}

export async function buildAuthorization(ctx: X402PaymentContext): Promise<EvmPaymentPayload> {
  const { requirement, payer } = ctx;
  const extra = requirement.extra ?? {};
  const method = typeof extra.assetTransferMethod === 'string' ? extra.assetTransferMethod : 'eip3009';
  if (method !== 'eip3009') {
    // Permit2 and ERC-7710 need an on-chain approval or a smart account; neither is
    // something to half-implement behind a payment button.
    throw new Error(`asset transfer method "${method}" is not implemented — this rail signs EIP-3009 only`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(requirement.asset)) {
    throw new Error(`asset must be a token contract address, got ${requirement.asset}`);
  }

  const { validAfter, validBefore } = validityWindow(requirement.maxTimeoutSeconds);
  const authorization = {
    from: payer,
    to: requirement.payTo,
    value: requirement.amount,
    validAfter,
    validBefore,
    nonce: randomNonce(),
  };

  const signer = ctx.signers.evm;
  if (!signer) throw new Error('no EVM signer supplied for an EVM requirement');

  const signature = await signer.signTransferAuthorization(
    {
      // A token's EIP-712 domain is part of what makes the signature valid on that token
      // and nowhere else. The server states it; USDC's is ("USDC", "2").
      name: typeof extra.name === 'string' && extra.name ? extra.name : 'USDC',
      version: typeof extra.version === 'string' && extra.version ? extra.version : '2',
      chainId: chainIdOf(requirement.network),
      verifyingContract: requirement.asset,
    },
    authorization,
  );

  return { signature, authorization };
}

export async function preflightEvm(ctx: X402PaymentContext): Promise<X402Preflight> {
  const { requirement, payer } = ctx;
  const blockers: X402Blocker[] = [];
  if (!payer) {
    return { ok: false, blockers: [{ code: 'no-account', message: 'No EVM account selected.' }] };
  }

  let balance: bigint | undefined;
  try {
    balance = decodeUint256(await ethCall(requirement.network, requirement.asset, encodeBalanceOf(payer)));
  } catch (err) {
    // Not a blocker: the payer may well have the funds, we just could not look. Say so
    // rather than refusing a payment on the strength of a rate-limited public RPC.
    blockers.push({
      code: 'other',
      message: `Could not read the token balance: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { ok: true, blockers };
  }

  if (balance < BigInt(requirement.amount)) {
    blockers.push({
      code: 'insufficient-funds',
      message: `Balance ${balance} is below the quoted ${requirement.amount} atomic units.`,
    });
  }

  // No gas check: the point of EIP-3009 is that the facilitator pays it. An account
  // with zero ETH can still make this payment.
  return { ok: blockers.length === 0, blockers, balance };
}

export const evmRail: X402Rail = {
  family: 'evm',
  label: 'EVM',
  schemes: ['exact'],

  buildPayload: buildAuthorization,

  preflight: preflightEvm,
};

registerRail(evmRail);
