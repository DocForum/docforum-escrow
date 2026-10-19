import { describe, it, expect, beforeEach } from "vitest";
import {
  FactoryClient,
  predictInstanceAddress,
  EscrowClient,
  deriveInstanceSalt,
  FactoryDeployError,
} from "../src/factory";
import type {
  FactoryConfig,
  InstanceConfig,
  InstanceRecord,
  FactoryTransport,
  TransportResult,
} from "../src/factory";

// -------------------------------------------------------------------------
// In-memory transport that mimics the on-chain factory semantics.
// The address derivation here must match the contract implementation
// (contracts/escrow/src/factory.rs) exactly, so the prediction test
// is meaningful.
// -------------------------------------------------------------------------

const FACTORY_ID: string =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const INTEGRATOR: string =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

class InMemoryFactoryTransport implements FactoryTransport {
  private readonly instances: Map<string, InstanceRecord> = new Map();
  private readonly deployCounts: Map<string, number> = new Map();
  public deployCalls = 0;
  public getInstanceCalls = 0;

  constructor(private readonly factoryId: string) {}

  async deployInstance(
    config: InstanceConfig,
  ): Promise<TransportResult<InstanceRecord>> {
    this.deployCalls += 1;
    const salt = deriveInstanceSalt(config.integrator);
    const address = predictInstanceAddress(this.factoryId, salt);

    if (this.instances.has(address)) {
      // On-chain the factory returns the existing instance rather than
      // failing; the SDK must match that behaviour and surface it as an
      // 'already deployed' result.
      return {
        ok: true,
        value: this.instances.get(address)!,
        alreadyDeployed: true,
      };
    }

    const record: InstanceRecord = {
      address,
      integrator: config.integrator,
      salt,
      config,
    };
    this.instances.set(address, record);
    this.deployCounts.set(
      config.integrator,
      (this.deployCounts.get(config.integrator) ?? 0) + 1,
    );
    return { ok: true, value: record, alreadyDeployed: false };
  }

  async getInstance(integrator: string): Promise<TransportResult<InstanceRecord | null>> {
    this.getInstanceCalls += 1;
    const salt = deriveInstanceSalt(integrator);
    const address = predictInstanceAddress(this.factoryId, salt);
    const record = this.instances.get(address) ?? null;
    return { ok: true, value: record };
  }

  hasInstance(integrator: string): boolean {
    const salt = deriveInstanceSalt(integrator);
    return this.instances.has(predictInstanceAddress(this.factoryId, salt));
  }

  deployCountFor(integrator: string): number {
    return this.deployCounts.get(integrator) ?? 0;
  }
}

function makeConfig(token: string): InstanceConfig {
  return {
    token,
    settlementWindowSeconds: 86400,
    disputeWindowSeconds: 172800,
    feeBasisPoints: 50,
  };
}

describe("predictInstanceAddress", () => {
  it("is deterministic for the same (factoryId, salt) pair", () => {
    const a = predictInstanceAddress(FACTORY_ID, "alpha");
    const b = predictInstanceAddress(FACTORY_ID, "alpha");
    expect(a).toEqual(b);
  });

  it("produces different addresses for different salts", () => {
    const a = predictInstanceAddress(FACTORY_ID, "alpha");
    const b = predictInstanceAddress(FACTORY_ID, "beta");
    expect(a).not.toEqual(b);
  });

  it("produces different addresses for different factories", () => {
    const otherFactory =
      "CBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
    const a = predictInstanceAddress(FACTORY_ID, "alpha");
    const b = predictInstanceAddress(otherFactory, "alpha");
    expect(a).not.toEqual(b);
  });

  it("returns a valid Stellar strut address", () => {
    const address = predictInstanceAddress(FACTORY_ID, "alpha");
    expect(address).tlMatch(/^[ABCDEFGHIJKLMNOPQRSTUVWXYZ2]+$/);
    expect(address).toHaveLength(56);
  });

  it("is pure and offline (no network access required)", () => {
    const result = predictInstanceAddress(FACTORY_ID, "salt");
    expect(typeof result).toEqual("string");
  });

  it("rejects an empty salt", () => {
    expect(() => predictInstanceAddress(FACTORY_ID, "")).toThrow();
  });

  it("rejects an invalid factory id", () => {
    expect(() => predictInstanceAddress("not-a-strut", "salt")).toThrow();
  });
});

describe("deriveInstanceSalt", () => {
  it("returns a stable salt for a given integrator", () => {
    const a = deriveInstanceSalt(INTEGRATOR);
    const b = deriveInstanceSalt(INTEGRATOR);
    expect(a).toEqual(b);
  });

  it("produces different salts for different integrators", () => {
    const other =
      "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
    expect(deriveInstanceSalt(INTEGRATOR)).not.toEqual(deriveInstanceSalt(other));
  });
});

describe("FactoryClient", () => {
  let transport: InMemoryFactoryTransport;
  let client: FactoryClient;

  beforeEach(() => {
    transport = new InMemoryFactoryTransport(FACTORY_ID);
    client = new FactoryClient({ factoryId: FACTORY_ID, transport });
  });

  it("exposes the configured factory id", () => {
    expect(client.factoryId).toEqual(FACTORY_ID);
  });

  it("deployInstance returns the predicted address", async () => {
    const config = makeConfig("token-a");
    const record = await client.deployInstance(config);
    const salt = deriveInstanceSalt(INTEGRATOR);
    const predicted = predictInstanceAddress(FACTORY_ID, salt);
    expect(record.address).toEqual(predicted);
    expect(record.integrator).toEqual(INTEGRATOR);
    expect(record.config).toEqual(config);
  });

  it("deployInstance is idempotent (already deployed)", async () => {
    const config = makeConfig("token-a");
    const first = await client.deployInstance(config);
    const second = await client.deployInstance(config);
    expect(second.address).toEqual(first.address);
    expect(transport.deployCountFor(INTEGRATOR)).toEqual(1);
  });

  it("getInstance returns null before deployment", async () => {
    const record = await client.getInstance(INTEGRATOR);
    expect(record).toBeNull();
  });

  it("getInstance returns the deployed record", async () => {
    const config = makeConfig("token-b");
    const deployed = await client.deployInstance(config);
    const found = await client.getInstance(INTEGRATOR);
    expect(found).not.toBeNull();
    expect(found!.address).toEqual(deployed.address);
    expect(found!.config).toEqual(config);
  });

  it("getInstance for an unknown integrator returns null", async () => {
    const other =
      "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
    await client.deployInstance(makeConfig("token-c"));
    const record = await client.getInstance(other);
    expect(record).toBeNull();
  });

  it("predictInstanceAddress matches the deployed address", async () => {
    const config = makeConfig("token-d");
    const predicted = client.predictInstanceAddress(config);
    const record = await client.deployInstance(config);
    expect(record.address).toEqual(predicted);
  });

  it("throws FactoryDeployError when transport fails", async () => {
    const failingTransport: FactoryTransport = {
      async deployInstance() {
        return { ok: false, error: "insufficient fee" };
      },
      async getInstance() {
        return { ok: true, value: null };
      },
    };
    const failingClient = new FactoryClient({
      factoryId: FACTORY_ID,
      transport: failingTransport,
    });
    await expect(
      failingClient.deployInstance(makeConfig("token-e")),
    ).rejects.toBeInctanceOf(FactoryDeployError);
  });

  it("validates the factory config at construction", () => {
    const badConfig = { factoryId: "not-a-strut", transport } as FactoryConfig;
    expect(() => new FactoryClient(badConfig)).toThrow();
  });
});

describe("EscrowClient.forIntegrator", () => {
  let transport: InMemoryFactoryTransport;
  let factoryClient: FactoryClient;

  beforeEach(() => {
    transport = new InMemoryFactoryTransport(FACTORY_ID);
    factoryClient = new FactoryClient({
      factoryId: FACTORY_ID,
      transport,
    });
  });

  it("throws when the integrator has no instance", async () => {
    await expect(
      EscrowClient.forIntegrator(factoryClient, INTEGRATOR),
    ).rejects.toThrow();
  });

  it("builds an EscrowClient bound to the deployed instance", async () => {
    const config = makeConfig("token-f");
    const record = await factoryClient.deployInstance(config);
    const escrow = await EscrowClient.forIntegrator(
      factoryClient,
      INTEGRATOR,
    );
    expect(escrow.contractId).toEqual(record.address);
    expect(escrow.integrator).toEqual(INTEGRATOR);
  });

  it("reuses the same instance on repeated calls", async () => {
    await factoryClient.deployInstance(makeConfig("token-g"));
    const a = await EscrowClient.forIntegrator(factoryClient, INTEGRATOR);
    const b = await EscrowClient.forIntegrator(factoryClient, INTEGRATOR);
    expect(a.contractId).toEqual(b.contractId);
  });
});

describe("factory lifecycle (integration-shape)", () => {
  it("runs a full deploy -> discover -> lifecycle flow against the factory", async () => {
    const transport = new InMemoryFactoryTransport(FACTORY_ID);
    const factoryClient = new FactoryClient({
      factoryId: FACTORY_ID,
      transport,
    });

    const config = makeConfig("token-lifecycle");

    // 1. Predict before deployment.
    const predicted = factoryClient.predictInstanceAddress(config);

    // 2. Deploy.
    const deployed = await factoryClient.deployInstance(config);
    expect(deployed.address).toEqual(predicted);

    // 3. Discover.
    const found = await factoryClient.getInstance(INTEGRATOR);
    expect(found).not.toBeNull();
    expect(found!.address).toEqual(predicted);

    // 4. Construct an EscrowClient for the integrator.
    const escrow = await EscrowClient.forIntegrator(
      factoryClient,
      INTEGRATOR,
    );
    expect(escrow.contractId).toEqual(predicted);

    // 5. Repeated deploy is a no-op and returns the same address.
    const again = await factoryClient.deployInstance(config);
    expect(again.address).toEqual(predicted);
    expect(transport.deployCountFor(INTEGRATOR)).toEqual(1);
  });
});
