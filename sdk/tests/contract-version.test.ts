import { describe, expect, it, vi } from "vitest";
import {
  EscrowClient,
  SUPPORTED_CONTRACT_VERSIONS,
  UnsupportedContractVersionError,
  isSupportedContractVersion,
  networks,
} from "../src/index.js";

const CONTRACT_ID = "CAANBNO7UXU24RVORQSGV33VJ7ZPL4UQKQNGPOSCSDDLISQ35SH62Y6E";
const MISSING_FUNCTION = "HostError: Error(WasmVm, MissingValue)\ntrying to invoke non-existent contract function";

type VersionCall = () => Promise<{ result: string }>;

function makeClient(version: VersionCall, config: Record<string, unknown> = {}) {
  const client = new EscrowClient({ contractId: CONTRACT_ID, rpcUrl: "https://rpc.example.test", ...config });
  const versionCall = vi.fn(version);
  const getEvents = vi.fn(async () => ({ events: [], cursor: "next" }));
  const internals = client as unknown as { contractClient: unknown; rpc: unknown };
  internals.contractClient = () => ({ version: versionCall });
  internals.rpc = { getEvents };
  return { client, versionCall, getEvents };
}

const reports = (version: string): VersionCall => async () => ({ result: version });
const missing: VersionCall = async () => {
  throw new Error(MISSING_FUNCTION);
};
const rpcDown: VersionCall = async () => {
  throw new Error("connect ECONNREFUSED");
};
const firstCall = (client: EscrowClient) => client.getEvents({ fromLedger: 1 });

describe("isSupportedContractVersion", () => {
  it.each(["2.0.0", "2.5.1", "2.99.99", "2.5.1-rc.1"])("accepts %s", (version) => {
    expect(isSupportedContractVersion(version)).toBe(true);
  });

  it.each(["1.0.0", "1.99.99", "3.0.0", "10.0.0", "2.5", "v2.5.1", "", "latest"])("rejects %s", (version) => {
    expect(isSupportedContractVersion(version)).toBe(false);
  });

  it("exposes the supported range", () => {
    expect(SUPPORTED_CONTRACT_VERSIONS).toEqual({ minInclusive: "2.0.0", maxExclusive: "3.0.0" });
  });
});

describe("getContractVersion", () => {
  it("reads the version once and caches it", async () => {
    const { client, versionCall } = makeClient(reports("2.5.1"));
    expect(await client.getContractVersion()).toBe("2.5.1");
    expect(await client.getContractVersion()).toBe("2.5.1");
    expect(versionCall).toHaveBeenCalledTimes(1);
  });

  it("returns null for an older deployment with no version()", async () => {
    const { client } = makeClient(missing);
    expect(await client.getContractVersion()).toBeNull();
  });

  it("doesn't mistake a missing contract for a missing function", async () => {
    const { client } = makeClient(async () => {
      throw new Error("HostError: Error(Storage, MissingValue)");
    });
    await expect(client.getContractVersion()).rejects.toThrow("Storage");
  });

  it("doesn't cache a failed lookup", async () => {
    const version = vi.fn<VersionCall>().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ result: "2.5.1" });
    const { client } = makeClient(version);
    await expect(client.getContractVersion()).rejects.toThrow("timeout");
    await Promise.resolve();
    expect(await client.getContractVersion()).toBe("2.5.1");
  });
});

describe("verifyContractVersion()", () => {
  it("accepts a supported version", async () => {
    await expect(makeClient(reports("2.5.1")).client.verifyContractVersion()).resolves.toBeUndefined();
  });

  it("rejects an unsupported version and names it", async () => {
    await expect(makeClient(reports("1.0.0")).client.verifyContractVersion()).rejects.toMatchObject({
      name: "UnsupportedContractVersionError",
      contractId: CONTRACT_ID,
      version: "1.0.0",
    });
  });

  it("rejects an older deployment with a null version", async () => {
    const error = await makeClient(missing).client.verifyContractVersion().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedContractVersionError);
    expect((error as UnsupportedContractVersionError).version).toBeNull();
    expect((error as Error).message).toContain("no version() function");
  });
});

describe("automatic check before the first network call", () => {
  const required = { verifyContractVersion: true };
  const preset = { network: networks.testnet, rpcUrl: "https://rpc.example.test" };

  it("is off by default without a preset", async () => {
    const { client, versionCall, getEvents } = makeClient(reports("1.0.0"));
    await firstCall(client);
    expect(versionCall).not.toHaveBeenCalled();
    expect(getEvents).toHaveBeenCalledTimes(1);
  });

  it("stays off with verifyContractVersion: false, even with a preset", async () => {
    const { client, versionCall } = makeClient(reports("1.0.0"), { ...preset, verifyContractVersion: false });
    await firstCall(client);
    expect(versionCall).not.toHaveBeenCalled();
  });

  it("checks once when required, then allows later calls", async () => {
    const { client, versionCall, getEvents } = makeClient(reports("2.5.1"), required);
    await firstCall(client);
    await firstCall(client);
    expect(versionCall).toHaveBeenCalledTimes(1);
    expect(getEvents).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an unsupported version", reports("3.0.0")],
    ["an older deployment", missing],
    ["a failed lookup", rpcDown],
  ])("rejects %s when required, before the RPC call", async (_name, version) => {
    const { client, getEvents } = makeClient(version, required);
    await expect(firstCall(client)).rejects.toThrow();
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("rejects a known unsupported version with a preset", async () => {
    const { client, getEvents } = makeClient(reports("1.0.0"), preset);
    await expect(firstCall(client)).rejects.toBeInstanceOf(UnsupportedContractVersionError);
    expect(getEvents).not.toHaveBeenCalled();
  });

  it.each([
    ["an older deployment", missing],
    ["a failed lookup", rpcDown],
  ])("allows %s with a preset", async (_name, version) => {
    const { client, getEvents } = makeClient(version, preset);
    await firstCall(client);
    expect(getEvents).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed lookup with a preset", async () => {
    const version = vi.fn<VersionCall>().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ result: "1.0.0" });
    const { client } = makeClient(version, preset);
    await firstCall(client);
    await expect(firstCall(client)).rejects.toBeInstanceOf(UnsupportedContractVersionError);
  });
});
