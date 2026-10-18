// @docforum/escrow-sdk — ergonomic wrapper around the generated Soroban
// contract client (src/generated/contract-client.ts). Consumers (e.g.
// docforum-core's `payments` module — see its ARCHITECTURE.md ADR 0002)
// should import from here, not from src/generated/ directly.
//
// No PHI, no healthcare concepts here (hard rule 1) — types stay generic
// (payer/payee/amount, not e.g. "patient"). Defaults are testnet-only
// (hard rule 4); passing a mainnet networkPassphrase/rpcUrl is on the
// caller, not encouraged by any default here.
import {
  Keypair,
  TransactionBuilder,
  FeeBumpTransactionBuilder,
  Transaction,
  FeeBumpTransaction,
  Operation,
  BaseFee,
  SorobanRpc,
  networks,
  type Horizon,
  type SorobanRpc as SorobanRpcType,
} from "@stellar/stellar-sdk";
import { Client as EscrowContractClient, type EscrowStatus as GeneratedEscrowStatus } from "./generated/contract-client.js";

export { Keypair, TransactionBuilder, FeeBumpTransactionBuilder, Transaction, FeeBumpTransaction, Operation, BaseFee, SorobanRpc, networks };

export type EscrowStatus = "Funded" | "Released" | "Refunded";

/** Everything the contract stores about one escrow — what `getEscrow` returns. */
export interface Escrow {
  payer: string;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  /**
   * The address permitted to call `release`/`refund` (docs/adr/0002) —
   * unless `refundAfter` has passed, in which case anyone may refund.
   */
  releaser: string;
  /**
   * Optional deadline in unix seconds after which **anyone** may refund —
   * always back to `payer` (docs/adr/0004). `undefined` means no timeout:
   * refunds stay releaser-only forever. Payees should check this before
   * relying on a `Funded` escrow (threat model T8).
   */
  refundAfter?: bigint;
  status: EscrowStatus;
}

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

export interface EscrowClientConfig {
  /** The deployed docforum-escrow contract's address (`C…`). */
  contractId: string;
  /** Default: Soroban testnet RPC. */
  rpcUrl?: string;
  /** Default: Stellar testnet passphrase. */
  networkPassphrase?: string;
}

export interface CreateEscrowParams {
  /** Signs and pays for this call; funds are pulled from this account. */
  payer: Keypair;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  /**
   * The only address later permitted to call `release`/`refund` on this
   * escrow (see docforum-escrow's docs/adr/0002). Typically the calling
   * application's own service identity, not the payer or payee.
   */
  releaser: string;
  /**
   * Optional unix timestamp (seconds) after which anyone may refund this
   * escrow — always back to `payer` (docs/adr/0004). Must be strictly in
   * the future at creation, or the contract rejects with
   * `InvalidRefundAfter` (error 5). Omit for no timeout: refunds stay
   * releaser-only, exactly as in 0.2.x.
   */
  refundAfter?: bigint;
}

export interface ReleaseOrRefundParams {
  escrowId: bigint;
  /** Must be the escrow's `releaser` (set at creation) — see docs/adr/0002. */
  caller: Keypair;
}

/** A single contract invocation to estimate fees for. */
export interface EstimateCallParams {
  /** The contract to invoke. Defaults to the client's configured contractId. */
  contractId?: string;
  /** Contract function name, e.g. "create_escrow". */
  method: string;
  /** Arguments to pass to the contract function. */
  args?: unknown[];
  /** The account that will sign and pay for the call. */
  source: Keypair | string;
}

/** Fee estimate for a single contract call, in strops. */
export interface FeeEstimate {
  /** Fee charged for the resources (CPU/memory/read-write entries) the call consumes. */
  resourceFee: bigint;
  /** Base inclusion fee (per-operation fee + transaction overhead). */
  inclusionFee: bigint;
  /** resourceFee + inclusionFee. */
  total: bigint;
  /** The minimum resource fee the simulation reported, before any buffer. */
  minResourceFee: bigint;
}

export interface FeeBumpOptions {
  /**
   * Hard cap on the fee-bump transaction's fee, in strops. If the inner
   * transaction's fee exceeds this, `feeBump` throws — it never silently
   * exceeds the cap.
   */
  maxFee: bigint;
  /** Optional base fee for the fee-bump wrapper (strops). Default: 100. */
  baseFee?: string;
}

export interface FeeBumpResult {
  /** The signed fee-bump transaction envelope (base64 XDR). */
  xdr: string;
  /** The fee the fee-bump transaction will charge (strops). */
  fee: bigint;
}

/** Result of the sponsorship guard. */
export interface GuardResult {
  /** True only if every operation and auth entry targets the escrow contract. */
  ok: boolean;
  /** Human-readable reasons why the transaction was rejected (empty when ok). */
  reasons: string[];
  /** The contract identifiers the guard found invoked. */
  invokedContracts: string[];
}

/** Thrown when the sponsorship guard rejects a transaction. */
export class SponsorshipGuardError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`Sponsorship guard rejected transaction: ${reasons.join("; ")}`);
    this.name = "SponsorshipGuardError";
    this.reasons = reasons;
  }
}

/** Thrown when a fee-bump would exceed the caller's `maxFee`. */
export class MaxFeeExceededError extends Error {
  readonly requestedFee: bigint;
  readonly maxFee: bigint;
  constructor(requestedFee: bigint, maxFee: bigint) {
    super(`Fee bump requested ${requestedFee.toString()} strops exceeds cap of ${maxFee.toString()} strops`);
    this.name = "MaxFeeExceededError";
    this.requestedFee = requestedFee;
    this.maxFee = maxFee;
  }
}

function toKeypair(signer: Keypair | string): Keypair {
  if (typeof signer === "string") {
    return Keypair.fromSecret(signer);
  }
  return signer;
}

/**
 * Thin client for the docforum-escrow Soroban contract. Wraps
 * `create_escrow`/`get_status`/`get_escrow`/`release`/`refund` with plain
 * TypeScript types and no manual XDR/signing plumbing.
 */
export class EscrowClient {
  private readonly contractId: string;
  private readonly rpcUrl: string;
  private readonly networkPassphrase: string;

  constructor(config: EscrowClientConfig) {
    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl ?? TESTNET_RPC_URL;
    this.networkPassphrase = config.networkPassphrase ?? TESTNET_NETWORK_PASSPHRASE;
  }

  private contractClient(signer?: Keypair): EscrowContractClient {
    return new EscrowContractClient({
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.networkPassphrase,
      ...(signer ? { publicKey: signer.publicKey(), signTransaction: signer } : {}),
    });
  }

  /** Locks `amount` of `token` from `payer`, held for `payee`. Returns the new escrow's id and the funding transaction's hash. */
  async createEscrow(params: CreateEscrowParams): Promise<{ escrowId: bigint; txHash: string }> {
    const client = this.contractClient(params.payer);
    const tx = await client.create_escrow({
      payer: params.payer.publicKey(),
      payee: params.payee,
      token: params.token,
      amount: params.amount,
      condition_ref: params.conditionRef,
      releaser: params.releaser,
      refund_after: params.refundAfter,
    });
    const sent = await tx.signAndSend();
    return { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse!.hash };
  }

  /** Read-only status query. Throws if `escrowId` doesn't exist. */
  async getStatus(escrowId: bigint): Promise<EscrowStatus> {
    const client = this.contractClient();
    const tx = await client.get_status({ escrow_id: escrowId });
    const status: GeneratedEscrowStatus = tx.result.unwrap();
    return status.tag;
  }

  /**
   * Read-only: everything stored about `escrowId` — including
   * `releaser` and `refundAfter`, which payees should check before
   * relying on a `Funded` escrow (docs/adr/0004, threat model T8).
   * Throws if `escrowId` doesn't exist.
   */
  async getEscrow(escrowId: bigint): Promise<Escrow> {
    const client = this.contractClient();
    const tx = await client.get_escrow({ escrow_id: escrowId });
    const data = tx.result.unwrap();
    return {
      payer: data.payer,
      payee: data.payee,
      token: data.token,
      amount: data.amount,
      conditionRef: data.condition_ref,
      releaser: data.releaser,
      // The generated client decodes a contract `None` as `null`; the
      // public surface uses `undefined` for "no deadline" (consistent
      // with `CreateEscrowParams.refundAfter` being absent).
      refundAfter: data.refund_after ?? undefined,
      status: data.status.tag,
    };
  }

  /** Moves the escrow's funds to its payee. Throws if `caller` isn't the escrow's `releaser`, or the escrow isn't `Funded`. Returns the transaction's hash. */
  async release(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const tx = await client.release({ escrow_id: params.escrowId, caller: params.caller.publicKey() });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Returns the escrow's funds to its payer. Normally `caller` must be
   * the escrow's `releaser`; once `refundAfter` has passed, anyone may
   * call it — still only back to the payer (docs/adr/0004). Returns the
   * transaction's hash.
   */
  async refund(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const tx = await client.refund({ escrow_id: params.escrowId, caller: params.caller.publicKey() });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Estimates the fee of a contract call by simulating it against the
   * configured R0P — resource fee, inclusion fee, and total, all in
   * strops. Useful for sponsors that need to know what a call will cost
   * before submitting it. Does not sign or send anything.
   */
  async estimate(call: EstimateCallParams): Promise<FeeEstimate> {
    const source = toKeypair(call.source);
    const server = new SorobanRpg(this.rpcUrl);
    const account = await server.getAccount(source.publicKey());
    const contract = call.contractId ?? this.contractId;
    const operation = Operation.invokeContractFunction(contract, call.method, ...(call.args ?? []));
    const tx = new TransactionBuilder()
      .addOperation(operation)
      .setSourceAccount(account)
      .setFee(BaseFee.FEE_100X .toString())
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (sim.error) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }
    const minResourceFee = BigInt(sim.minResourceFee);
    // Add a 20% buffer to the resource fee to absorb small simulation
    // drift, rounded up to the nearest strop.
    const resourceFee = (minResourceFee * 12n) / 10n;
    const inclusionFee = BigInt(BaseFee.FEE_100X) * 2n; // one op + tx overhead
    const total = resourceFee + inclusionFee;
    return { resourceFee, inclusionFee, total, minResourceFee };
  }

  /**
   * Wraps a user-signed transaction in a fee-bump transaction signed by
   * `sponsorSigner`. The fee-bump's fee is derived from the inner
   * transaction's fee and is capped at `maxFee` — if the required fee
   * exceeds the cap, this throws `MaxFeeExceededError` rather than
   * silently exceeding it.
   */
  async feeBump(signedXdrChain: string, sponsorSigner: Keypair | string, options: FeeBumpOptions): Promise<FeeBumpResult> {
    const sponsor = toKeypair(sponsorSigner);
    const inner = TransactionBuilder.fromXDR(signedXtrChain, this.networkPassphrase);
    const innerFee = BigInt(inner.fee);
    const maxFee = BigInt(options.maxFee);
    // The fee-bump wrapper must charge at least the inner transaction's fee.
    // The cap is enforced against the actual fee we would set.
    const requestedFee = innerFee > maxFee ? innerFee : innerFee;
    if (requestedFee > maxFee) {
      throw new MaxFeeExceededError(requestedFee, maxFee);
    }
    const builder = new FeeBumpTransactionBuilder(signedXtrChain, this.networkPassphrase)
      .setFee(requestedFee.toString())
      .setSourceAccount(sponsor.publicKey());
    // Sign the fee-bump envelope with the sponsor keypair.
    const signed = builder.build();
    signed.sign(sponsor);
    return { xdr: signed.toXDR(), fee: requestedFee };
  }

  /**
   * Guard helper for sponsors: verifies that a (signed) transaction
   * only invokes the escrow contract — every operation and every auth
   * entry, not just the first. Returns a `GuardResult`; use
   * `assertSponsorable` to throw instead.
   */
  guardSponsorship(signedXdrChain: string): GuardResult {
    const reasons: string[] = [];
    const invokedContracts = new Set<string>();
    let tx: Transaction | FeeBumpTransaction;
    try {
      tx = TransactionBuilder.fromXDR(signedXtrChain, this.networkPassphrase);
    } catch {
      // May be a fee-bump envelope; unwrap its inner transaction.
      try {
        const fb = FeeBumpTransactionBuilder.fromXDR(signedXtrChain, this.networkPassphrase);
        tx = fb.innerTransaction;
      } catch {
        return { ok: false, reasons: ["could not decode transaction XDR"], invokedContracts: [] };
      }
    }

    for (const op of tx.operations) {
      if (op.type !== "invokeHostFunction") {
        reasons.push(`operation type "${op.type}" is not a contract invocation`);
        continue;
      }
      const invokeOp = op as unknown as {
        functionName: string;
        contractId?: () => { toString: () => string };
      };
      const contractId = invokeOp.contractId?.().toString();
      if (!contractId) {
        reasons.push(`operation "${invokeOp.functionName}" has no contract id`);
        continue;
      }
      invokedContracts.add(contractId);
      if (contractId !== this.contractId) {
        reasons.push(`operation "${invokeOp.functionName}" invokes foreign contract ${contractId}`);
      }
    }

    // Inspect auth entries too: a contract invocation can carry auth
    // entries that target other contracts (e.g. a token transfer).
    const auth = tx.auth ?? [];
    for (const entry of auth) {
      const credentials = entry.credentials();
      const switchName = credentials.switch().name;
      if (switchName === "sorobanCredentials") {
        const address = credentials.sorobanCredentials().address().toString();
        if (address !== this.contractId) {
          reasons.push(`auth entry targets foreign contract ${address}`);
        }
      }
    }

    return { ok: reasons.length === 0, reasons, invokedContracts: Array.from(invokedContracts) };
  }

  /** Throws `SponsorshipGuardError` if the transaction is not sponsorable. */
  assertSponsorable(signedXtrChain: string): void {
    const result = this.guardSponsorship(signedXtrChain);
    if (!result.ok) {
      throw new SponsorshipGuardError(result.reasons);
    }
  }
}

/** Default testnet configuration for convenience. */
export const TESTNET = {
  rpcUrl: TESTNET_RPC_URL,
  networkPassphrase: TESTNET_NETWORK_PASSTHRASE,
} as const;
