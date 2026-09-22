// Parsec x402 Integration — Vault-Secured Signing Bridge
// Retrieves keys from vault EPHEMERALLY, builds x402 signer, signs, discards.
// Secrets pass through JS only for a single signing operation.
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import algosdk from 'algosdk';
import { keystoreRetrieve } from '../keystore';
import { getAlgodClient } from '../algorand/client';
import type { NetworkId } from '../../types/wallet';

// ── x402 Signer Interface ────────────────────────────────────────
// Matches @x402-avm/fetch expected signer shape.

export interface X402Signer {
  address: string;
  getAddresses: () => string[];
  signTransaction: (txnBytes: Uint8Array) => Promise<Uint8Array>;
  signTransactions: (txns: Uint8Array[], indexesToSign?: number[]) => Promise<(Uint8Array | null)[]>;
  getAlgodClient: () => algosdk.Algodv2;
  sendTransactions: (signedTxns: Uint8Array[]) => Promise<string>;
  waitForConfirmation: (txId: string, network: string, waitRounds?: number) => Promise<Record<string, unknown>>;
}

// ── Algorand x402 Signer ─────────────────────────────────────────

/**
 * Build a vault-secured x402 signer for Algorand.
 *
 * Flow:
 *   1. keystoreRetrieve(address, passphrase) → mnemonic (brief hold)
 *   2. algosdk.mnemonicToSecretKey(mnemonic) → { addr, sk }
 *   3. Build signer object with sk in closure
 *   4. Caller uses signer for one x402 payment cycle
 *   5. Caller discards signer reference → sk eligible for GC
 *
 * The signer closure is the ONLY place the secret key lives in JS.
 */
export async function buildAlgorandX402Signer(
  address: string,
  passphrase: string,
  network: NetworkId = 'testnet',
): Promise<X402Signer> {
  // Step 1: Retrieve mnemonic from vault (Rust AES-256-GCM → JS briefly)
  const mnemonic = await keystoreRetrieve(address, passphrase);
  if (!mnemonic) {
    throw new Error(`No key found in vault for ${address}`);
  }

  // Step 2: Derive signing key
  const { addr, sk } = algosdk.mnemonicToSecretKey(mnemonic.trim());
  const addrStr = addr.toString();

  // Verify address matches
  if (addrStr !== address) {
    throw new Error(`Vault key mismatch: expected ${address}, got ${addrStr}`);
  }

  // Step 3: Build algod client for this network
  const client = getAlgodClient(network);

  // Step 4: Return x402-compatible signer (sk lives in closure only)
  return {
    address: addrStr,
    getAddresses: () => [addrStr],

    signTransaction: async (txnBytes: Uint8Array) => {
      const decoded = algosdk.decodeUnsignedTransaction(txnBytes);
      const signed = algosdk.signTransaction(decoded, sk);
      return signed.blob;
    },

    signTransactions: async (txns: Uint8Array[], indexesToSign?: number[]) => {
      return txns.map((txn, i) => {
        if (indexesToSign && !indexesToSign.includes(i)) return null;
        const decoded = algosdk.decodeUnsignedTransaction(txn);
        const signed = algosdk.signTransaction(decoded, sk);
        return signed.blob;
      });
    },

    getAlgodClient: () => client,

    sendTransactions: async (signedTxns: Uint8Array[]) => {
      const response = await client.sendRawTransaction(signedTxns).do();
      return response.txid as string;
    },

    waitForConfirmation: async (_txId: string, _network: string, waitRounds = 4) => {
      const result = await algosdk.waitForConfirmation(client, _txId, waitRounds);
      return result as unknown as Record<string, unknown>;
    },
  };
}

// ── xchain (EVM-controlled Algorand) x402 Signer ─────────────────

/**
 * Build an x402 signer for a MetaMask-controlled Algorand LogicSig account.
 * No vault retrieval: the EVM key never enters parsec — MetaMask remains the
 * sole custodian. Each `signTransaction` call routes through EIP-712.
 */
export async function buildXchainX402Signer(
  algoAddress: string,
  evmAddress: string,
  network: NetworkId = 'testnet',
): Promise<X402Signer> {
  // Lazy imports to avoid pulling the EVM stack into non-xchain code paths.
  const { detectInjectedProvider } = await import('../builder/isolation');
  const { signTxnWithMetamask } = await import('../xchain/sign');

  const provider = detectInjectedProvider();
  if (!provider) throw new Error('No injected EVM wallet detected for xchain signer');

  const client = getAlgodClient(network);

  return {
    address: algoAddress,
    getAddresses: () => [algoAddress],

    signTransaction: async (txnBytes: Uint8Array) => {
      const decoded = algosdk.decodeUnsignedTransaction(txnBytes);
      const signed = await signTxnWithMetamask(provider, evmAddress, [decoded], network);
      return signed[0];
    },

    signTransactions: async (txns: Uint8Array[], indexesToSign?: number[]) => {
      // Decode all, then sign as a group so MetaMask sees one EIP-712 prompt.
      const decoded = txns.map((t) => algosdk.decodeUnsignedTransaction(t));
      const signed = await signTxnWithMetamask(provider, evmAddress, decoded, network);
      return signed.map((blob, i) => (indexesToSign && !indexesToSign.includes(i) ? null : blob));
    },

    getAlgodClient: () => client,

    sendTransactions: async (signedTxns: Uint8Array[]) => {
      const response = await client.sendRawTransaction(signedTxns).do();
      return response.txid as string;
    },

    waitForConfirmation: async (txId: string, _network: string, waitRounds = 4) => {
      const result = await algosdk.waitForConfirmation(client, txId, waitRounds);
      return result as unknown as Record<string, unknown>;
    },
  };
}

// ── algorand-hd (ARC-52) x402 Signer ─────────────────────────────

/**
 * Build a vault-secured x402 signer for an ARC-52 HD-derived child key.
 * The 24-word BIP-39 seed is retrieved briefly from bankon_vault, the
 * extended root key is derived, the requested account/index signs, then
 * the rootKey buffer is zeroed.
 */
export async function buildAlgorandHdX402Signer(
  primaryAddress: string,
  account: number,
  keyIndex: number,
  network: NetworkId = 'testnet',
): Promise<X402Signer> {
  const { rootKeyFromMnemonic } = await import('../algorand-hd/seed');
  const { signTxn: hdSignTxn, deriveAlgo } = await import('../algorand-hd/derive');

  const mnemonic = await keystoreRetrieve(primaryAddress, '');
  if (!mnemonic) throw new Error(`No HD seed in vault for ${primaryAddress}`);

  // Derive the child address up front to populate `address` / `getAddresses`.
  const rootKeyForAddr = rootKeyFromMnemonic(mnemonic);
  let childAddress: string;
  try {
    const k = await deriveAlgo(rootKeyForAddr, account, keyIndex);
    childAddress = k.address;
  } finally {
    rootKeyForAddr.fill(0);
  }

  const client = getAlgodClient(network);

  // sign helper that re-derives rootKey on each call and zeroes after.
  async function signOne(prefixEncodedTx: Uint8Array): Promise<Uint8Array> {
    const rootKey = rootKeyFromMnemonic(mnemonic!);
    try {
      return await hdSignTxn(rootKey, account, keyIndex, prefixEncodedTx);
    } finally {
      rootKey.fill(0);
    }
  }

  return {
    address: childAddress,
    getAddresses: () => [childAddress],

    signTransaction: signOne,

    signTransactions: async (txns: Uint8Array[], indexesToSign?: number[]) => {
      const out: (Uint8Array | null)[] = [];
      for (let i = 0; i < txns.length; i++) {
        if (indexesToSign && !indexesToSign.includes(i)) {
          out.push(null);
          continue;
        }
        out.push(await signOne(txns[i]));
      }
      return out;
    },

    getAlgodClient: () => client,

    sendTransactions: async (signedTxns: Uint8Array[]) => {
      const response = await client.sendRawTransaction(signedTxns).do();
      return response.txid as string;
    },

    waitForConfirmation: async (txId: string, _network: string, waitRounds = 4) => {
      const result = await algosdk.waitForConfirmation(client, txId, waitRounds);
      return result as unknown as Record<string, unknown>;
    },
  };
}

// ── Algorand Message Signing ─────────────────────────────────────

/**
 * Sign arbitrary bytes using vault-secured key.
 * Used for: identity challenges, command channel, EIP-712 equivalent on Algorand.
 */
export async function signBytesWithVault(
  address: string,
  passphrase: string,
  message: Uint8Array,
): Promise<Uint8Array> {
  const mnemonic = await keystoreRetrieve(address, passphrase);
  if (!mnemonic) {
    throw new Error(`No key found in vault for ${address}`);
  }

  const { sk } = algosdk.mnemonicToSecretKey(mnemonic.trim());
  const signature = algosdk.signBytes(message, sk);
  // sk goes out of scope here → eligible for GC
  return signature;
}

// ── Algorand Payment (direct, non-x402) ──────────────────────────

/**
 * Send a direct ALGO payment using vault-secured key.
 * For x402 payments, use buildAlgorandX402Signer() instead.
 */
export async function sendPaymentWithVault(
  address: string,
  passphrase: string,
  receiver: string,
  amountMicroAlgos: number,
  note: string,
  network: NetworkId = 'testnet',
): Promise<{ txId: string; confirmedRound: number }> {
  const mnemonic = await keystoreRetrieve(address, passphrase);
  if (!mnemonic) {
    throw new Error(`No key found in vault for ${address}`);
  }

  const client = getAlgodClient(network);
  const account = algosdk.mnemonicToSecretKey(mnemonic.trim());
  const suggestedParams = await client.getTransactionParams().do();

  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver,
    amount: amountMicroAlgos,
    note: note ? new TextEncoder().encode(note) : undefined,
    suggestedParams,
  });

  const signedTxn = txn.signTxn(account.sk);
  const { txid } = await client.sendRawTransaction(signedTxn).do();
  const result = await algosdk.waitForConfirmation(client, txid, 4);
  // account goes out of scope → sk eligible for GC
  return { txId: txid, confirmedRound: Number(result.confirmedRound || 0) };
}
