import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, Networks, StrKey } from '@stellar/stellar-sdk';
import { Server as RpcServer } from '@stellar/stellar-sdk/rpc';

import {
  EscrowClient,
  MAINNET_NETWORK_PASSPHRASE,
  MainnetNotAllowedError,
  NetworkMismatchError,
  networks,
  type NetworkPreset,
} from '../src/index.js';

/**
 * Tests for the network presets and the explicit mainnet opt-in guard.
 *
 * Hard rule 4: testnet only until the security review, and never wire mainnet
 * into defaults. These tests are the code enforcement of that rule.
 */

const CONTRACT_ID = Keypair.random().publicKey();

/** Reads the private connection settings the client resolved from its config. */
function resolved(client: EscrowClient): { rpcUrl: string; networkPassphrase: string } {
  return client as unknown as { rpcUrl: string; networkPassphrase: string };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('network presets', () => {
  it('exposes testnet, futurenet and local presets', () => {
    expect(Object.keys(networks).sort()).toEqual(['futurenet', 'local', 'testnet']);
  });

  it('does not expose a mainnet preset', () => {
    expect((networks as Record<string, unknown>).mainnet).toBeUndefined();
  });

  it('each preset has an RPC URL, a passphrase and known contract ids', () => {
    for (const preset of Object.values(networks) as NetworkPreset[]) {
      expect(typeof preset.name).toBe('string');
      expect(preset.name.length).toBeGreaterThan(0);
      expect(typeof preset.rpcUrl).toBe('string');
      expect(preset.rpcUrl.length).toBeGreaterThan(0);
      expect(typeof preset.networkPassphrase).toBe('string');
      expect(preset.networkPassphrase.length).toBeGreaterThan(0);
      expect(typeof preset.contractIds).toBe('object');
      expect(preset.contractIds).not.toBeNull();
    }
  });

  it('testnet preset lists the known deployed contract ids', () => {
    expect(Object.keys(networks.testnet.contractIds).length).toBeGreaterThan(0);
    for (const id of Object.values(networks.testnet.contractIds)) {
      expect(StrKey.isValidContract(id)).toBe(true);
    }
  });

  it('no preset uses the mainnet passphrase', () => {
    for (const preset of Object.values(networks) as NetworkPreset[]) {
      expect(preset.networkPassphrase).not.toBe(MAINNET_NETWORK_PASSPHRASE);
    }
  });

  it('defaults to testnet when no network is configured', () => {
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    expect(resolved(client).rpcUrl).toBe(networks.testnet.rpcUrl);
    expect(resolved(client).networkPassphrase).toBe(networks.testnet.networkPassphrase);
  });

  it('takes the RPC URL and passphrase from a named preset', () => {
    const client = new EscrowClient({ contractId: CONTRACT_ID, network: networks.futurenet });
    expect(resolved(client).rpcUrl).toBe(networks.futurenet.rpcUrl);
    expect(resolved(client).networkPassphrase).toBe(networks.futurenet.networkPassphrase);
  });

  it('the local preset can be constructed (plain-HTTP quickstart RPC)', () => {
    const client = new EscrowClient({ contractId: CONTRACT_ID, network: networks.local });
    expect(resolved(client).rpcUrl).toBe(networks.local.rpcUrl);
    expect(resolved(client).networkPassphrase).toBe(networks.local.networkPassphrase);
  });

  it('rejects a plain-HTTP custom rpcUrl without allowHttp', () => {
    expect(
      () => new EscrowClient({ contractId: CONTRACT_ID, rpcUrl: 'http://127.0.0.1:8000/soroban/rpc' }),
    ).toThrow();
  });

  it('lets explicit rpcUrl/networkPassphrase win over the preset', () => {
    const client = new EscrowClient({
      contractId: CONTRACT_ID,
      network: networks.futurenet,
      rpcUrl: 'https://rpc.example.test',
      networkPassphrase: networks.testnet.networkPassphrase,
    });
    expect(resolved(client).rpcUrl).toBe('https://rpc.example.test');
    expect(resolved(client).networkPassphrase).toBe(networks.testnet.networkPassphrase);
  });
});

describe('mainnet opt-in guard', () => {
  it('recognises the mainnet passphrase', () => {
    expect(MAINNET_NETWORK_PASSPHRASE).toBe(Networks.PUBLIC);
  });

  it('throws when constructed against mainnet without opt-in', () => {
    expect(
      () =>
        new EscrowClient({
          contractId: CONTRACT_ID,
          networkPassphrase: MAINNET_NETWORK_PASSPHRASE,
        }),
    ).toThrow(MainnetNotAllowedError);
  });

  it('allows mainnet with an explicit opt-in', () => {
    const client = new EscrowClient({
      contractId: CONTRACT_ID,
      networkPassphrase: MAINNET_NETWORK_PASSPHRASE,
      allowMainnet: true,
    });
    expect(resolved(client).networkPassphrase).toBe(MAINNET_NETWORK_PASSPHRASE);
  });

  it('does not require opt-in for a testnet passphrase', () => {
    expect(
      () =>
        new EscrowClient({
          contractId: CONTRACT_ID,
          rpcUrl: networks.testnet.rpcUrl,
          networkPassphrase: networks.testnet.networkPassphrase,
        }),
    ).not.toThrow();
  });
});

describe('network passphrase verification', () => {
  function withRpc(client: EscrowClient, getNetwork: () => Promise<{ passphrase: string }>): void {
    (client as unknown as { rpc: unknown }).rpc = { getNetwork };
  }

  it('never runs during construction, even with a preset or verifyNetwork: true', () => {
    const getNetwork = vi.spyOn(RpcServer.prototype, 'getNetwork');
    new EscrowClient({ contractId: CONTRACT_ID, network: networks.testnet });
    new EscrowClient({ contractId: CONTRACT_ID, network: networks.local, verifyNetwork: true });
    new EscrowClient({ contractId: CONTRACT_ID, rpcUrl: 'https://rpc.example.test', verifyNetwork: true });
    expect(getNetwork).not.toHaveBeenCalled();
  });

  it('is off by default without a preset: no getNetwork round trip', async () => {
    const getNetwork = vi.fn(async () => ({ passphrase: MAINNET_NETWORK_PASSPHRASE }));
    const getEvents = vi.fn(async () => ({ events: [], cursor: 'next' }));
    const client = new EscrowClient({ contractId: CONTRACT_ID, rpcUrl: 'https://rpc.example.test' });
    (client as unknown as { rpc: unknown }).rpc = { getNetwork, getEvents };

    await expect(client.getEvents({ fromLedger: 1 })).resolves.toEqual({ events: [], nextCursor: 'next' });
    expect(getNetwork).not.toHaveBeenCalled();
  });

  it('is on when a preset is selected: the first call rejects an RPC on another network', async () => {
    const getNetwork = vi.fn(async () => ({ passphrase: MAINNET_NETWORK_PASSPHRASE }));
    const getEvents = vi.fn(async () => ({ events: [], cursor: 'next' }));
    // A testnet preset whose custom rpcUrl actually serves mainnet: the guard
    // must not be bypassable this way.
    const client = new EscrowClient({
      contractId: CONTRACT_ID,
      network: networks.testnet,
      rpcUrl: 'https://rpc.example.test',
    });
    (client as unknown as { rpc: unknown }).rpc = { getNetwork, getEvents };

    await expect(client.getEvents({ fromLedger: 1 })).rejects.toThrow(NetworkMismatchError);
    expect(getNetwork).toHaveBeenCalledTimes(1);
    expect(getEvents).not.toHaveBeenCalled();
  });

  it('verifyNetwork: true checks a custom rpcUrl without a preset', async () => {
    const getNetwork = vi.fn(async () => ({ passphrase: MAINNET_NETWORK_PASSPHRASE }));
    const getEvents = vi.fn(async () => ({ events: [], cursor: 'next' }));
    const client = new EscrowClient({
      contractId: CONTRACT_ID,
      rpcUrl: 'https://rpc.example.test',
      verifyNetwork: true,
    });
    (client as unknown as { rpc: unknown }).rpc = { getNetwork, getEvents };

    await expect(client.getEvents({ fromLedger: 1 })).rejects.toThrow(NetworkMismatchError);
    expect(getEvents).not.toHaveBeenCalled();
  });

  it('verifyNetwork: false disables the check even with a preset', async () => {
    const getNetwork = vi.fn(async () => ({ passphrase: 'Some Other Network ; January 2024' }));
    const getEvents = vi.fn(async () => ({ events: [], cursor: 'next' }));
    const client = new EscrowClient({
      contractId: CONTRACT_ID,
      network: networks.testnet,
      verifyNetwork: false,
    });
    (client as unknown as { rpc: unknown }).rpc = { getNetwork, getEvents };

    const page = await client.getEvents({ fromLedger: 1 });

    expect(page).toEqual({ events: [], nextCursor: 'next' });
    expect(getNetwork).not.toHaveBeenCalled();
  });

  it('skips the preset check when the RPC has no getNetwork (offline double)', async () => {
    const getEvents = vi.fn(async () => ({ events: [], cursor: 'next' }));
    const client = new EscrowClient({ contractId: CONTRACT_ID, network: networks.testnet });
    (client as unknown as { rpc: unknown }).rpc = { getEvents };

    await expect(client.getEvents({ fromLedger: 1 })).resolves.toEqual({ events: [], nextCursor: 'next' });
    expect(getEvents).toHaveBeenCalledTimes(1);
  });

  it('fails when verification was explicitly requested but the RPC has no getNetwork', async () => {
    const getEvents = vi.fn(async () => ({ events: [], cursor: 'next' }));
    const client = new EscrowClient({
      contractId: CONTRACT_ID,
      network: networks.testnet,
      verifyNetwork: true,
    });
    (client as unknown as { rpc: unknown }).rpc = { getEvents };

    await expect(client.getEvents({ fromLedger: 1 })).rejects.toThrow(/getNetwork/);
    await expect(client.verifyNetwork()).rejects.toThrow(/getNetwork/);
    expect(getEvents).not.toHaveBeenCalled();
  });

  it('allows a custom (private quickstart) network whose RPC matches', async () => {
    const passphrase = 'Private Quickstart ; 2026';
    const getNetwork = vi.fn(async () => ({ passphrase }));
    const getEvents = vi.fn(async () => ({ events: [], cursor: 'next' }));
    const client = new EscrowClient({
      contractId: CONTRACT_ID,
      rpcUrl: 'http://127.0.0.1:8000/soroban/rpc',
      networkPassphrase: passphrase,
      allowHttp: true,
      verifyNetwork: true,
    });
    (client as unknown as { rpc: unknown }).rpc = { getNetwork, getEvents };

    await expect(client.getEvents({ fromLedger: 1 })).resolves.toEqual({ events: [], nextCursor: 'next' });
    expect(getNetwork).toHaveBeenCalledTimes(1);
  });

  it('verifies on demand and caches a success', async () => {
    const getNetwork = vi.fn(async () => ({ passphrase: networks.testnet.networkPassphrase }));
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    withRpc(client, getNetwork);

    await client.verifyNetwork();
    await client.verifyNetwork();
    await client.verifyNetwork();

    expect(getNetwork).toHaveBeenCalledTimes(1);
  });

  it('throws NetworkMismatchError when the RPC reports another network', async () => {
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    withRpc(client, async () => ({ passphrase: 'Some Other Network ; January 2024' }));

    await expect(client.verifyNetwork()).rejects.toThrow(NetworkMismatchError);
    await expect(client.verifyNetwork()).rejects.toMatchObject({
      expected: networks.testnet.networkPassphrase,
      actual: 'Some Other Network ; January 2024',
    });
  });

  it('does not cache a failed verification', async () => {
    const getNetwork = vi
      .fn<() => Promise<{ passphrase: string }>>()
      .mockResolvedValueOnce({ passphrase: 'Some Other Network ; January 2024' })
      .mockResolvedValueOnce({ passphrase: networks.testnet.networkPassphrase });
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    withRpc(client, getNetwork);

    await expect(client.verifyNetwork()).rejects.toThrow(NetworkMismatchError);
    await expect(client.verifyNetwork()).resolves.toBeUndefined();
    expect(getNetwork).toHaveBeenCalledTimes(2);
  });

  it('runs once on the first call and is cached for later calls', async () => {
    const getNetwork = vi.fn(async () => ({ passphrase: networks.testnet.networkPassphrase }));
    const getEvents = vi.fn(async () => ({ events: [], cursor: 'next' }));
    const client = new EscrowClient({
      contractId: CONTRACT_ID,
      network: networks.testnet,
      rpcUrl: 'https://rpc.example.test',
    });
    (client as unknown as { rpc: unknown }).rpc = { getNetwork, getEvents };

    await client.getEvents({ fromLedger: 1 });
    await client.getEvents({ fromLedger: 1 });

    expect(getNetwork).toHaveBeenCalledTimes(1);
    expect(getEvents).toHaveBeenCalledTimes(2);
  });
});
