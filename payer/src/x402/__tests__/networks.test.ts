// Network identity is where two implementations most easily drift apart: three spellings
// of the same chain, and a comparison done with `===` that silently pays nobody.

import { describe, it, expect } from 'vitest';
import {
  ALGORAND_MAINNET,
  ALGORAND_TESTNET,
  BASE_MAINNET,
  describeAsset,
  describeNetwork,
  explorerTxUrl,
  familyFor,
  sameNetwork,
  toCaip2,
  usdcFor,
} from '../networks';

describe('toCaip2', () => {
  it('maps the v1 short names', () => {
    expect(toCaip2('algorand-mainnet')).toBe(ALGORAND_MAINNET);
    expect(toCaip2('algorand-testnet')).toBe(ALGORAND_TESTNET);
    expect(toCaip2('base')).toBe(BASE_MAINNET);
  });

  it('leaves a canonical id alone', () => {
    expect(toCaip2(ALGORAND_MAINNET)).toBe(ALGORAND_MAINNET);
  });

  it('resolves bare mainnet/testnet only against a stated family', () => {
    expect(toCaip2('testnet', 'avm')).toBe(ALGORAND_TESTNET);
    expect(toCaip2('mainnet', 'evm')).toBe(BASE_MAINNET);
  });

  it('returns an unknown network unchanged rather than throwing', () => {
    expect(toCaip2('cosmos:cosmoshub-4')).toBe('cosmos:cosmoshub-4');
  });
});

describe('sameNetwork', () => {
  it('matches the truncated CASA reference against the full genesis hash', () => {
    expect(sameNetwork('algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k', ALGORAND_MAINNET)).toBe(true);
  });

  it('does not match two different chains', () => {
    expect(sameNetwork(ALGORAND_MAINNET, ALGORAND_TESTNET)).toBe(false);
  });

  it('does not match on a trivially short prefix', () => {
    expect(sameNetwork('algorand:', ALGORAND_MAINNET)).toBe(false);
  });
});

describe('families', () => {
  it('dispatches by CAIP-2 namespace', () => {
    expect(familyFor(ALGORAND_MAINNET)).toBe('avm');
    expect(familyFor('eip155:8453')).toBe('evm');
    expect(familyFor('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe('svm');
    expect(familyFor('arweave:permaweb')).toBe('arweave');
  });

  it('refuses a namespace it has no rail family for', () => {
    expect(() => familyFor('cosmos:cosmoshub-4')).toThrow();
  });
});

describe('assets', () => {
  it('knows the USDC ASA on each Algorand network', () => {
    expect(usdcFor(ALGORAND_MAINNET)).toBe('31566704');
    expect(usdcFor(ALGORAND_TESTNET)).toBe('10458941');
  });

  it('names ALGO for asset 0', () => {
    expect(describeAsset(ALGORAND_MAINNET, '0').symbol).toBe('ALGO');
  });

  it('describes an unknown ASA without pretending to know it', () => {
    const a = describeAsset(ALGORAND_MAINNET, '999999');
    expect(a.symbol).toBe('ASA 999999');
    expect(a.decimals).toBe(6);
  });
});

describe('display', () => {
  it('marks testnets as testnets', () => {
    expect(describeNetwork(ALGORAND_TESTNET).testnet).toBe(true);
    expect(describeNetwork(ALGORAND_MAINNET).testnet).toBe(false);
  });

  it('builds an explorer link, or none at all', () => {
    expect(explorerTxUrl(ALGORAND_MAINNET, 'TXID')).toContain('TXID');
    expect(explorerTxUrl('algorand:localnet', 'TXID')).toBe('');
    expect(explorerTxUrl(ALGORAND_MAINNET, '')).toBe('');
  });
});
