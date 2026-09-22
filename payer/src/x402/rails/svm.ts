// Parsec x402 — the Solana rail, scheme `exact`.
//
// Where Algorand builds an atomic group and EVM signs an authorization, Solana signs a
// transaction that is deliberately incomplete. The payer compiles a transaction whose
// **fee payer is the facilitator**, signs only their own slot, and sends it; the
// facilitator adds its signature at settlement and submits. A transaction missing a
// required signature cannot execute, so the half-signed artefact is inert until the
// facilitator completes it — and the facilitator cannot alter it, because changing any
// byte invalidates the signature already on it.
//
//   payload = { transaction: "<base64 of the partially-signed wire transaction>" }
//
// `extra.memo`, when the server sets one, MUST be used verbatim as the Memo instruction
// rather than a random nonce: it is how a seller reconciles a payment against an invoice.
//
// Spec: `specs/schemes/exact/scheme_exact_svm.md` in algorandfoundation/x402.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit';
import { hostSolanaRpc } from '../host';
import { SOLANA_DEVNET, SOLANA_MAINNET, describeNetwork } from '../networks';
import { bytesToBase64 } from '../protocol';
import { registerRail, type X402Blocker, type X402PaymentContext, type X402Preflight, type X402Rail } from '../rails';

/** The scheme payload for Solana `exact`. */
export interface SvmPaymentPayload extends Record<string, unknown> {
  transaction: string;
}

// ── Program ids ──────────────────────────────────────────────────────────────

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address;
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address;

/** `transferChecked` — instruction 12 of the SPL token program. */
const TRANSFER_CHECKED = 12;

// ── Associated token accounts ────────────────────────────────────────────────

/**
 * Derive an owner's associated token account for a mint.
 *
 * `PDA([owner, tokenProgram, mint], associatedTokenProgram)` — the derivation every
 * Solana wallet uses, and the one place in this rail where being wrong is silent and
 * expensive: a mis-derived address is a valid-looking account nobody controls. Pinned in
 * the tests against addresses read back from a live RPC, not against our own arithmetic.
 */
export async function associatedTokenAddress(
  owner: string,
  mint: string,
  tokenProgram: Address = TOKEN_PROGRAM,
): Promise<Address> {
  const encoder = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encoder.encode(address(owner)), encoder.encode(tokenProgram), encoder.encode(address(mint))],
  });
  return ata;
}

// ── Instruction encoding ─────────────────────────────────────────────────────

/** `transferChecked(amount: u64, decimals: u8)` — 10 bytes, little-endian. */
export function encodeTransferChecked(amount: bigint, decimals: number): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = TRANSFER_CHECKED;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return data;
}

function transferCheckedInstruction(args: {
  source: Address;
  mint: Address;
  destination: Address;
  authority: Address;
  amount: bigint;
  decimals: number;
  tokenProgram: Address;
}) {
  return {
    programAddress: args.tokenProgram,
    accounts: [
      { address: args.source, role: 1 as const },        // writable
      { address: args.mint, role: 0 as const },          // readonly
      { address: args.destination, role: 1 as const },   // writable
      { address: args.authority, role: 2 as const },     // readonly signer
    ],
    data: encodeTransferChecked(args.amount, args.decimals),
  };
}

function memoInstruction(memo: string) {
  return { programAddress: MEMO_PROGRAM, accounts: [], data: new TextEncoder().encode(memo) };
}

// ── RPC ──────────────────────────────────────────────────────────────────────

async function rpc<T>(network: string, method: string, params: unknown[]): Promise<T> {
  const url = hostSolanaRpc(network);
  if (!url) throw new Error(`no Solana RPC configured for ${describeNetwork(network).label}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || 'Solana RPC error');
  return json.result as T;
}

interface AccountValue {
  value: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string }; owner?: string } } } } | null;
}

/** The token balance in an account, or null when the account does not exist. */
export async function tokenBalance(network: string, account: string): Promise<bigint | null> {
  const info = await rpc<AccountValue>(network, 'getAccountInfo', [account, { encoding: 'jsonParsed' }]);
  const amount = info?.value?.data?.parsed?.info?.tokenAmount?.amount;
  return amount === undefined ? null : BigInt(amount);
}

// ── Building the payment ─────────────────────────────────────────────────────

export async function buildSvmPayment(ctx: X402PaymentContext): Promise<SvmPaymentPayload> {
  const { requirement } = ctx;
  const signer = ctx.signers.svm;
  if (!signer) throw new Error('no Solana signer supplied for a Solana requirement');

  const extra = requirement.extra ?? {};
  const feePayer = typeof extra.feePayer === 'string' ? extra.feePayer : '';
  if (!feePayer) {
    // Without a sponsor the payer would have to pay the fee, which means holding SOL —
    // and the scheme has no shape for a self-paid transaction. Refuse rather than build
    // something the facilitator will not complete.
    throw new Error('Solana requirement names no extra.feePayer; this scheme requires a sponsor');
  }

  const tokenProgram = extra.tokenProgram === TOKEN_2022_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  const decimals = typeof extra.decimals === 'number' ? extra.decimals : 6;
  const amount = BigInt(requirement.amount);

  const [source, destination] = await Promise.all([
    associatedTokenAddress(signer.address, requirement.asset, tokenProgram),
    associatedTokenAddress(requirement.payTo, requirement.asset, tokenProgram),
  ]);

  const { value: blockhash } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
    requirement.network,
    'getLatestBlockhash',
    [{ commitment: 'confirmed' }],
  );

  // The fee payer is the facilitator, and it signs last. `createNoopSigner` reserves its
  // slot without pretending we can fill it.
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(address(feePayer)), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash.blockhash as never, lastValidBlockHeight: BigInt(blockhash.lastValidBlockHeight) },
      m,
    ),
    (m) => appendTransactionMessageInstruction(
      transferCheckedInstruction({
        source,
        mint: address(requirement.asset),
        destination,
        authority: address(signer.address),
        amount,
        decimals,
        tokenProgram,
      }),
      m,
    ),
    (m) => (typeof extra.memo === 'string' && extra.memo
      // Verbatim, per the scheme: a seller's invoice reference, not a nonce of ours.
      ? appendTransactionMessageInstruction(memoInstruction(extra.memo), m)
      : m),
  );

  const compiled = compileTransaction(message);
  // kit brands these as readonly; the wire format needs plain bytes, so unwrap once here
  // rather than threading the brands through the serializer.
  const plain = {
    messageBytes: new Uint8Array(compiled.messageBytes as unknown as ArrayLike<number>),
    signatures: compiled.signatures as unknown as Record<string, Uint8Array | null>,
  };

  const signature = await signer.signTransaction(plain.messageBytes);
  if (signature.length !== 64) {
    throw new Error(`signer returned ${signature.length} bytes; an ed25519 signature is 64`);
  }

  return { transaction: bytesToBase64(serializeWithSignature(plain, signer.address, signature)) };
}

/**
 * Wire format: `compactU16(count) || signatures || messageBytes`, with an empty slot for
 * every signer that has not signed yet — here, the facilitator's.
 */
export function serializeWithSignature(
  compiled: { messageBytes: Uint8Array; signatures: Readonly<Record<string, Uint8Array | null>> },
  signerAddress: string,
  signature: Uint8Array,
): Uint8Array {
  const order = Object.keys(compiled.signatures);
  const sigs = order.map((a) => (a === signerAddress ? signature : compiled.signatures[a] ?? new Uint8Array(64)));

  const count = compactU16(sigs.length);
  const out = new Uint8Array(count.length + sigs.length * 64 + compiled.messageBytes.length);
  out.set(count, 0);
  sigs.forEach((s, i) => out.set(s, count.length + i * 64));
  out.set(compiled.messageBytes, count.length + sigs.length * 64);
  return out;
}

/** Solana's compact-u16 length prefix. */
export function compactU16(n: number): Uint8Array {
  const bytes: number[] = [];
  let value = n;
  for (;;) {
    if (value < 0x80) { bytes.push(value); break; }
    bytes.push((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return Uint8Array.from(bytes);
}

// ── Preflight ────────────────────────────────────────────────────────────────

export async function preflightSvm(ctx: X402PaymentContext): Promise<X402Preflight> {
  const { requirement } = ctx;
  const signer = ctx.signers.svm;
  const blockers: X402Blocker[] = [];
  if (!signer) {
    return { ok: false, blockers: [{ code: 'no-account', message: 'No Solana account selected.' }] };
  }

  const tokenProgram = requirement.extra?.tokenProgram === TOKEN_2022_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  let balance: bigint | undefined;

  try {
    const [mine, theirs] = await Promise.all([
      associatedTokenAddress(signer.address, requirement.asset, tokenProgram),
      associatedTokenAddress(requirement.payTo, requirement.asset, tokenProgram),
    ]);
    const [mineBalance, theirsBalance] = await Promise.all([
      tokenBalance(requirement.network, mine),
      tokenBalance(requirement.network, theirs),
    ]);

    if (theirsBalance === null) {
      // Solana's analogue of the Algorand opt-in, and it fails the same silent way: a
      // transfer to an account that does not exist is rejected, and it does not read as
      // a funds problem. The payer cannot fix this one — the recipient must.
      blockers.push({
        code: 'other',
        message: `The recipient has no token account for this mint. ${requirement.payTo} must create one before it can be paid.`,
      });
    }
    if (mineBalance === null) {
      blockers.push({
        code: 'not-opted-in',
        message: `You have no token account for mint ${requirement.asset}. One is created the first time you receive the token.`,
      });
    } else {
      balance = mineBalance;
    }
  } catch (err) {
    // A public RPC that will not answer is not a reason to refuse a payment.
    blockers.push({ code: 'other', message: `Could not read token accounts: ${err instanceof Error ? err.message : String(err)}` });
    return { ok: true, blockers };
  }

  if (balance !== undefined && balance < BigInt(requirement.amount)) {
    blockers.push({
      code: 'insufficient-funds',
      message: `Balance ${balance} is below the quoted ${requirement.amount} atomic units.`,
    });
  }

  // No SOL check: the facilitator is the fee payer.
  return { ok: blockers.length === 0, blockers, balance };
}

export const svmRail: X402Rail = {
  family: 'svm',
  label: 'Solana',
  schemes: ['exact'],
  networks: [SOLANA_MAINNET, SOLANA_DEVNET],
  buildPayload: buildSvmPayment,
  preflight: preflightSvm,
};

registerRail(svmRail);
