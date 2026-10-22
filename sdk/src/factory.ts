import {
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Server as RpcServer } from "@stellar/stellar-sdk/rpc";
import type { EscrowClient } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An escrow instance deployed by a factory. */
export interface FactoryInstance {
  /** The instance's contract id (C... StrKey). */
  contractId: string;
  /** RPC endpoint of the network the instance lives on. */
  rpcUrl: string;
  /** Network passphrase the instance was deployed with. */
  networkPassphrase: string;
}

/** Configuration for a factory-deployed escrow instance. */
export interface FactoryInstanceConfig {
  /** The integrator that owns the deployed instance. */
  integrator: string;
  /** A 32-byte salt used to derive the instance address. Random if omitted. */
  salt?: Uint8Array;
  /** Signer for the deploy transaction. Required — a public key cannot sign. */
  signer?: Keypair;
}

/** Result of a factory deployment. */
export interface FactoryDeployResult {
  /** The deterministic address of the deployed instance. */
  instanceId: string;
  /** The transaction hash of the deploy call, or "" when nothing was sent. */
  txHash: string;
  /** True if the instance already existed and no deploy was sent. */
  alreadyDeployed: boolean;
  /** The salt used for derivation (useful for reproducing the address). */
  salt: Uint8Array;
}

/** Configuration for the FactoryClient. */
export interface FactoryClientConfig {
  /** The factory contract id (C... StrKey). */
  factoryId: string;
  /** Soroban RPC endpoint. Defaults to the public testnet RPC. */
  rpcUrl?: string;
  /** Network passphrase. Defaults to the public testnet passphrase. */
  networkPassphrase?: string;
}

/** Parameters for `FactoryClient.deployInstance`. Alias kept for the stable public surface. */
export type DeployInstanceParams = FactoryInstanceConfig;
/** Result alias kept for the stable public surface. */
export type DeployInstanceResult = FactoryDeployResult;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const SALT_LENGTH = 32;

// ---------------------------------------------------------------------------
// Address prediction
// ---------------------------------------------------------------------------

/**
 * Compute the deterministic contract address of an escrow instance deployed by
 * a factory, without touching the network.
 *
 * Soroban derives the address of a contract deployed with `deploy_v2` from the
 * deployer address, the salt and the network id (CAP-0046). This replicates
 * that derivation exactly, so the result matches the address the factory's
 * `deploy_instance` call creates.
 *
 * @param factoryId - The factory contract id (C... StrKey).
 * @param salt - 32 bytes of entropy used as the deploy salt.
 * @param networkPassphrase - Network the instance is deployed on.
 * @returns The predicted contract address (C... StrKey).
 */
export function predictInstanceAddress(
  factoryId: string,
  salt: Uint8Array,
  networkPassphrase: string = defaultNetworkPassphrase(),
): string {
  if (typeof factoryId !== "string" || factoryId.length === 0) {
    throw new TypeError("predictInstanceAddress: factoryId must be a non-empty string");
  }
  if (!StrKey.isValidContract(factoryId)) {
    throw new TypeError("predictInstanceAddress: factoryId must be a contract id (C...)");
  }
  const saltBytes = Uint8Array.from(salt ?? []);
  if (saltBytes.length !== SALT_LENGTH) {
    throw new TypeError(
      `predictInstanceAddress: salt must be ${SALT_LENGTH} bytes, got ${saltBytes.length}`,
    );
  }

  const preimage = new xdr.HashIdPreimageContractId({
    networkId: hash(new TextEncoder().encode(networkPassphrase)),
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: new Address(factoryId).toScAddress(),
        salt: saltBytes,
      }),
    ),
  });
  const envelope = xdr.HashIdPreimage.envelopeTypeContractId(preimage);
  return StrKey.encodeContract(hash(envelope.toXDR()));
}

/** Random 32-byte salt, using the platform CSPRNG. */
export function randomSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_LENGTH);
  globalThis.crypto.getRandomValues(salt);
  return salt;
}

// ---------------------------------------------------------------------------
// FactoryClient
// ---------------------------------------------------------------------------

/**
 * Client for a Soroban escrow factory contract.
 *
 * The factory is expected to expose `deploy_instance(integrator, salt)` and
 * `get_instance(integrator)`; instances are escrow contracts whose address is
 * derived by `predictInstanceAddress`. Nothing here is escrow-contract specific,
 * so an integrator can point it at any factory that follows that interface.
 */
export class FactoryClient {
  readonly factoryId: string;
  readonly server: RpcServer;
  readonly rpcUrl: string;
  readonly networkPassphrase: string;

  constructor(config: FactoryClientConfig) {
    if (!config.factoryId) {
      throw new TypeError("FactoryClient: factoryId is required");
    }
    this.factoryId = config.factoryId;
    this.rpcUrl = config.rpcUrl ?? defaultRpcUrl();
    this.networkPassphrase = config.networkPassphrase ?? defaultNetworkPassphrase();
    this.server = new RpcServer(this.rpcUrl);
  }

  /**
   * Deploy a new escrow instance for the given integrator.
   *
   * The instance address is derived from the factory id and the salt before the
   * call is sent. If the integrator already has an instance, the deploy is
   * skipped and `alreadyDeployed: true` is returned.
   */
  async deployInstance(config: FactoryInstanceConfig): Promise<FactoryDeployResult> {
    const salt = config.salt ? Uint8Array.from(config.salt) : randomSalt();
    if (salt.length !== SALT_LENGTH) {
      throw new TypeError(`deployInstance: salt must be ${SALT_LENGTH} bytes, got ${salt.length}`);
    }
    const instanceId = predictInstanceAddress(this.factoryId, salt, this.networkPassphrase);

    const existing = await this.getInstance(config.integrator);
    if (existing) {
      return { instanceId: existing.contractId, txHash: "", alreadyDeployed: true, salt };
    }

    if (!config.signer) {
      throw new TypeError("deployInstance: signer is required to submit the deploy transaction");
    }
    const signer = config.signer;
    const sourceAccount = await this.server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.factoryId,
          function: "deploy_instance",
          args: [new Address(config.integrator).toScVal(), nativeToScVal(salt, { type: "bytes" })],
        }),
      )
      .setTimeout(30)
      .build();
    tx.sign(signer);

    const sent = await this.server.sendTransaction(tx);
    if (sent.status !== "PENDING") {
      throw new Error(
        `FactoryClient.deployInstance: transaction was not accepted (status ${sent.status})`,
      );
    }
    return { instanceId, txHash: tx.hash().toString("hex"), alreadyDeployed: false, salt };
  }

  /**
   * Look up the instance owned by `integrator`.
   *
   * Returns `null` when the factory has no instance for that integrator. This
   * only simulates, so it costs nothing and never signs.
   */
  async getInstance(integrator: string): Promise<FactoryInstance | null> {
    const source = await this.sourceAccount();
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.factoryId,
          function: "get_instance",
          args: [new Address(integrator).toScVal()],
        }),
      )
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if ("error" in sim || !sim.result) {
      return null;
    }
    const native = scValToNative(sim.result.retval);
    const contractId =
      typeof native === "string"
        ? native
        : native instanceof Address
          ? native.toString()
          : null;
    if (!contractId || !StrKey.isValidContract(contractId)) {
      return null;
    }
    return { contractId, rpcUrl: this.rpcUrl, networkPassphrase: this.networkPassphrase };
  }

  /**
   * Build an `EscrowClient` bound to `integrator`'s instance.
   *
   * Throws if the integrator has no deployed instance yet.
   */
  async forIntegrator(integrator: string): Promise<EscrowClient> {
    const instance = await this.getInstance(integrator);
    if (!instance) {
      throw new Error(`FactoryClient.forIntegrator: no instance deployed for integrator ${integrator}`);
    }
    const { EscrowClient: Client } = await import("./index.js");
    return new Client({
      contractId: instance.contractId,
      rpcUrl: instance.rpcUrl,
      networkPassphrase: instance.networkPassphrase,
    });
  }

  /** A funded account for simulation; simulations do not need a real one. */
  private async sourceAccount() {
    const anyKey = Keypair.random().publicKey();
    try {
      return await this.server.getAccount(anyKey);
    } catch {
      return new (await import("@stellar/stellar-sdk")).Account(anyKey, "0");
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultRpcUrl(): string {
  return env("STELLAR_RPC_URL") ?? DEFAULT_RPC_URL;
}

function defaultNetworkPassphrase(): string {
  return env("STELLAR_NETWORK_PASSPHRASE") ?? TESTNET_NETWORK_PASSPHRASE;
}

/** Read an env var without requiring Node's `process` type in a browser build. */
function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}
