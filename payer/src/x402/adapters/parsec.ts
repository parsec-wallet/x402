// Parsec's implementations of the x402 host ports.
//
// The only file in the module that knows Parsec exists. Everything else talks to
// `host.ts`, which is why the same protocol code runs in another wallet unchanged.
//
// Both signers route through Rust: `chain_algo_sign_transaction` takes the exact
// `TX`-prefixed preimage from `bytesToSign()`, `chain_evm_sign_transfer_authorization`
// builds the EIP-712 digest itself from named fields. A key is never returned to the
// renderer in either case.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import type algosdk from 'algosdk';
import { algoSignTransaction } from '../../chain-algo';
import { evmSignTransferAuthorization } from '../../chain-evm';
import { getAccountAddress } from '../../store';
import type { WalletAccount } from '../../../types/wallet';
import { base64ToBytes, bytesToBase64 } from '../protocol';
import type { AvmSigner, EvmSigner, X402Signers } from '../host';

/**
 * An Algorand signer backed by the vault and Rust.
 *
 * Signs one transaction at a time because that is what the IPC surface offers; the
 * group is still atomic on chain, since grouping happens before any of this.
 */
export function parsecAvmSigner(address: string): AvmSigner {
  const sign: algosdk.TransactionSigner = async (txnGroup, indexesToSign) => {
    const out: Uint8Array[] = [];
    for (const i of indexesToSign) {
      const txn = txnGroup[i];
      if (txn.sender.toString() !== address) {
        throw new Error(`asked to sign transaction ${i}, which is not from ${address}`);
      }
      const { signature_b64 } = await algoSignTransaction(address, bytesToBase64(txn.bytesToSign()));
      out.push(txn.attachSignature(address, base64ToBytes(signature_b64)));
    }
    return out;
  };
  return { address, sign };
}

/** An EVM signer backed by the vault and Rust. */
export function parsecEvmSigner(address: string): EvmSigner {
  return {
    address,
    async signTransferAuthorization(domain, authorization) {
      const { signature_hex } = await evmSignTransferAuthorization(
        address,
        {
          name: domain.name,
          version: domain.version,
          chain_id: domain.chainId,
          verifying_contract: domain.verifyingContract,
        },
        {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value,
          valid_after: authorization.validAfter,
          valid_before: authorization.validBefore,
          nonce: authorization.nonce,
        },
      );
      return signature_hex;
    },
  };
}

/** The wallet's chain id per rail family. */
const CHAIN_ID_FOR: Record<string, string> = { avm: 'algorand', evm: 'ethereum', svm: 'solana', arweave: 'arweave' };

/**
 * The addresses this account can pay from, one per rail family.
 *
 * For the read-only paths — quoting, preflight, a probe — where nothing is signed and a
 * full signer is more than the caller needs.
 */
export function payersFromAccount(account: WalletAccount): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [family, chainId] of Object.entries(CHAIN_ID_FOR)) {
    const address = getAccountAddress(account, chainId);
    if (address) out[family] = address;
  }
  return out;
}

/**
 * Every signer this account can offer.
 *
 * Which one pays is decided by the offer the server makes, so the flow is handed all of
 * them rather than being told one address up front and discovering it belonged to the
 * wrong chain.
 */
export function signersForAccount(account: WalletAccount): X402Signers {
  const signers: X402Signers = {};
  const algorand = getAccountAddress(account, 'algorand');
  if (algorand) signers.avm = parsecAvmSigner(algorand);
  const ethereum = getAccountAddress(account, 'ethereum');
  if (ethereum) signers.evm = parsecEvmSigner(ethereum);
  return signers;
}
