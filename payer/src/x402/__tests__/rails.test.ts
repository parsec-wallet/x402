// The registry exists so nothing branches on a chain name. These pin the behaviour that
// replaced the hardcoded Algorand signer: an offer on an unregistered chain is reported,
// never silently paid on the wrong rail or silently dropped.

import { describe, it, expect, beforeEach } from 'vitest';
import { canPay, listRails, railFor, registerRail, selectRequirement, unpayableNetworks } from '../rails';
import { normalizeChallenge, normalizeRequirement } from '../protocol';
import { ALGORAND_MAINNET, ALGORAND_TESTNET, BASE_MAINNET } from '../networks';
import '../rails/avm';

const challenge = normalizeChallenge(
  {
    x402Version: 2,
    resource: { url: 'https://x/y' },
    accepts: [
      { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0xUSDC', payTo: '0xabc' },
      { scheme: 'exact', network: 'algorand-mainnet', amount: '250000', asset: '31566704', payTo: 'PAYTO' },
      { scheme: 'exact', network: 'algorand-testnet', amount: '1000', asset: '10458941', payTo: 'PAYTO' },
    ],
  },
  'https://x/y',
);

describe('rail registry', () => {
  it('registers the Algorand rail on import', () => {
    expect(listRails().some((r) => r.family === 'avm')).toBe(true);
    expect(railFor(ALGORAND_MAINNET)?.label).toBe('Algorand');
  });

  it('has no rail for a chain nothing registered', () => {
    expect(railFor(BASE_MAINNET)).toBeNull();
    expect(railFor('cosmos:cosmoshub-4')).toBeNull();
  });

  it('refuses a scheme the rail does not implement', () => {
    expect(canPay(normalizeRequirement({ scheme: 'upto', network: ALGORAND_MAINNET, amount: '1' }))).toBe(false);
  });
});

describe('choosing what to pay', () => {
  it('honours the preferred network', () => {
    expect(selectRequirement(challenge, ALGORAND_TESTNET)?.network).toBe(ALGORAND_TESTNET);
    expect(selectRequirement(challenge, ALGORAND_MAINNET)?.network).toBe(ALGORAND_MAINNET);
  });

  it('falls back to the server’s own ordering, skipping what it cannot pay', () => {
    // The EVM offer is listed first and has no registered rail.
    expect(selectRequirement(challenge)?.network).toBe(ALGORAND_MAINNET);
  });

  it('returns null when nothing is payable, and names what was offered', () => {
    const evmOnly = normalizeChallenge(
      { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '1', asset: '0x', payTo: '0x' }] },
      'https://x/y',
    );
    expect(selectRequirement(evmOnly)).toBeNull();
    expect(unpayableNetworks(evmOnly)).toEqual([BASE_MAINNET]);
  });

  it('reports nothing unpayable when everything is payable', () => {
    const algoOnly = normalizeChallenge(
      { x402Version: 2, accepts: [{ scheme: 'exact', network: 'algorand-mainnet', amount: '1', asset: '0', payTo: 'P' }] },
      'https://x/y',
    );
    expect(unpayableNetworks(algoOnly)).toEqual([]);
  });
});

describe('a registered rail', () => {
  beforeEach(() => {
    registerRail({
      family: 'evm',
      label: 'Test EVM',
      schemes: ['exact'],
      async buildPayload() {
        return { signature: '0x00' };
      },
    });
  });

  it('makes its family payable without any other file changing', () => {
    expect(railFor(BASE_MAINNET)?.label).toBe('Test EVM');
    expect(selectRequirement(challenge, BASE_MAINNET)?.network).toBe(BASE_MAINNET);
  });
});
