// Adapters for wallets that are not Parsec.
//
// The Algorand side needs no adapter at all — `AvmSigner.sign` is
// `algosdk.TransactionSigner`, so a wallet that has one is a one-line wrap. These exist
// for the two shapes that are *not* already that: a raw ARC-0001 provider, and an
// EIP-1193 provider for the EVM rail.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import algosdk from 'algosdk';
import { base64ToBytes, bytesToBase64 } from '../protocol';
import type { AvmSigner, EvmSigner } from '../host';

/**
 * Any wallet with an `algosdk.TransactionSigner`.
 *
 * ```ts
 * import { useWallet } from '@txnlab/use-wallet';
 * const { activeAddress, transactionSigner } = useWallet();
 * const signer = algorandSigner(activeAddress, transactionSigner);
 * ```
 *
 * AlgoKit's `algorand.account.getSigner(addr)` and
 * `algosdk.makeBasicAccountTransactionSigner(account)` fit the same way.
 */
export function algorandSigner(address: string, sign: algosdk.TransactionSigner): AvmSigner {
  return { address, sign };
}

/** The ARC-0001 shape: base64 msgpack in, base64 signed blobs out, nulls for what was skipped. */
export interface Arc0001Provider {
  signTxns(txns: Array<{ txn: string; signers?: string[] }>): Promise<Array<string | null>>;
}

/**
 * A wallet exposing ARC-0001 `signTxns` (Lute, a WalletConnect session, an injected provider).
 *
 * Transactions the payer does not own are sent with `signers: []`, which is ARC-0001's way
 * of saying "this one is here for context, do not sign it" — exactly what a sponsored
 * x402 group needs for the facilitator's fee transaction.
 */
export function arc0001Signer(address: string, provider: Arc0001Provider): AvmSigner {
  const sign: algosdk.TransactionSigner = async (txnGroup, indexesToSign) => {
    const wanted = new Set(indexesToSign);
    const request = txnGroup.map((txn, i) => ({
      txn: bytesToBase64(algosdk.encodeUnsignedTransaction(txn)),
      ...(wanted.has(i) ? {} : { signers: [] }),
    }));
    const answered = await provider.signTxns(request);
    const out: Uint8Array[] = [];
    for (const i of indexesToSign) {
      const blob = answered[i];
      if (!blob) throw new Error(`wallet did not sign transaction ${i}`);
      out.push(base64ToBytes(blob));
    }
    return out;
  };
  return { address, sign };
}

/** The EIP-1193 shape — MetaMask, Rabby, a WalletConnect session, any injected provider. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * An EVM signer over `eth_signTypedData_v4`.
 *
 * The typed-data document is assembled here rather than by the caller, so what the wallet
 * displays is an EIP-3009 transfer authorization and cannot be anything else.
 */
export function eip1193Signer(address: string, provider: Eip1193Provider): EvmSigner {
  return {
    address,
    async signTransferAuthorization(domain, authorization) {
      const typedData = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        domain,
        message: authorization,
      };
      const signature = await provider.request({
        method: 'eth_signTypedData_v4',
        params: [address, JSON.stringify(typedData)],
      });
      if (typeof signature !== 'string') throw new Error('wallet returned no signature');
      return signature;
    },
  };
}
