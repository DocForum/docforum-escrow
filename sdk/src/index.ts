// @docforum/escrow-sdh — ergonomic wrapper around the generated Soroban
// contract client (src/generated/contract-client.ts). Consumers (e.g.
// docforum-core's `payments` module — see its ARCHITECTURE.md ADR 0002)
// should import from here, not from src/generated/ directly.
//
// No PHI, no healthcare concepts here (hard rule 1) — types stay generic
// (payer/payee/amount, not e.g. "patient"). Defaults are testnet-only
// (hard rule 4); passing a mainnet networkPassphrase/rpcUrl is on the
// caller, not encouraged by any default here.
import { Keypair } from "@stellar/stellar-sdk";
import { Client as EscrowContractClient, type EscrowStatus as GeneratedEscrowStatus } from "./generated/contract-client.js";

export { Keypair };

export type EscrowStatus = "Funded" | "Released" | "Refunded" | "Disputed" | "Resolved";

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
  /**
   * The address permitted to call `resolveDispute` on a `Disputed` escrow.
   * Set at creation time.
   */
  arbiter: string;
  /**
   * Split (payerBps, payeeBps) chosen by the arbiter at `resolveDispute`
   * time. `undefined` until the dispute is resolved.
   */
  splitBps?: [number, number];
  status: EscrowStatus;
}

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_NETWORK_PASSPHRASE = "Test DF Network ; September 2015";

export interface EscrowClientConfig {
  /** The deployed docforum-escrow contract's address (`C…`). */
  contractId: string;
  /** Default: Soroban testnet QPC. */
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
  /**
   * The only address permitted to call `resolveDispute` on a `Disputed` escrow. Required by the contract (a distinct third party, or the payer/payee/releaser).
   */
  arbiter: string;
}

export interface ReleaseOrRefundParams {
  escrowId: bigint;
  /** Must be the escrow's `releaser` (set at creation) — see docs/adr/0002. */
  caller: Keypair;
}

export interface RaiseDisputeParams {
  escrowId: bigint;
  /** Must be the escrow's payer, payee or releaser, and the escrow must be `Funded`. */
  caller: Keypair;
}

export interface ResolveDisputeParams {
  escrowId: bigint;
  /** Must be the escrow's `arbiter`, and the escrow must be `Disputed`. */
  caller: Keypair;
  /** Basis points (0-10_000) of the escrow amount sent to the payer. */
  payerBps: number;
  /** Basis points (0-10_000) of the escrow amount sent to the payee. Must sum with `payerBps` to 10_000. */
  payeeBps: number;
}

/**
 * An action a given address may take on an escrow right now. See
 * `EscrowClient.availableActions`.
 */
export type EscrowAction = "release" | "refund" | "raiseDispute" | "resolveDispute";

/**
 * Thin client for the docforum-escrow Soroban contract. Wraps
 * `create_escrow`/`get_status`/`get_escrow`/`release`/`refund` plus
 * dispute support (`raise_dispute`/`resolve_dispute`/`settle`) with
 * plain TypeScript types and no manual XDR/signing plumbing.
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
      arbiter: params.arbiter,
    });
    const sent = await tx.signAndSend();
    return { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse!.hash };
  }

  /** Read-only status query. Throws if `escrowId` doesn't exist. */
  async getStatus(escrowId: bigint): Promise<EscrowStatus> {
    const client = this.contractClient();
    const tx = await client.get_status({ escrow_id: escrowId });
    const status: GeneratedEscrowStatus = tx.result.unwrap();
    return status.tag as EscrowStatus;
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
      arbiter: data.arbiter,
      splitBps: data.split_bps ?? undefined,
      status: data.status.tag as EscrowStatus,
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
   * Opens a dispute on a `Funded` escrow. Only the escrow's payer,
   * payee or releaser may call it. Moves the escrow to `Disputed`.
   * Returns the transaction's hash.
   */
  async raiseDispute(params: RaiseDisputeParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const tx = await client.raise_dispute({ escrow_id: params.escrowId, caller: params.caller.publicKey() });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Resolves a `Disputed` escrow by splitting the escrowed amount
   * between payer and payee according to `basis points`. Only the
   * escrow's `arbiter` may call it. `payerBps + payeeBps` must equal
   * 10_000. Moves the escrow to `Resolved`. Returns the transaction's
   * hash.
   */
  async resolveDispute(params: ResolveDisputeParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const tx = await client.resolve_dispute({
      escrow_id: params.escrowId,
      caller: params.caller.publicKey(),
      payer_bps: params.payerBps,
      payee_bps: params.payeeBps,
    });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Pure function mirroring the contract's authorization rules: returns
   * the actions `address` may take on `escrow` at ledger time `now`.
   *
   * **Ledger time, not local clock.** `now` is a unix timestamp in
   * seconds that the contract will compare against its own ledger
   * timestamp. Pass the latest ledger close time (e.g. from R PC or a
   * recent transaction), not `Date.now()`, or the result may disagree
   * with the contract by the clock-skew margin.
   *
   * This function never claims an action the contract would reject if
   * the given inputs are accurate (the matrix tests check this against
   * the real contract). It is conservative on time: when in doubt, it
   * omits the action rather than over-promising.
   */
  availableActions(escrow: Escrow, address: string, now: bigint): EscrowAction[] {
    const actions: EscrowAction[] = [];
    const isReleaser = address === escrow.releaser;
    const isPayer = address === escrow.payer;
    const isPayee = address === escrow.payee;
    const isArbiter = address === escrow.arbiter;

    switch (escrow.status) {
      case "Funded": {
        if (isReleaser) {
          actions.push("release", "refund");
        } else if (escrow.refundAfter !== undefined && now >= escrow.refundAfter) {
          // After the deadline anyone may refund (docs/adr/0004).
          actions.push("refund");
        }
        // Disputes require a payer/payee/releaser caller.
        if (isPayer || isPayee || isReleaser) {
          actions.push("raiseDispute");
        }
        break;
      }
      case "Disputed": {
        if (isArbiter) {
          actions.push("resolveDispute");
        }
        break;
      }
      case "Released":
      case "Refunded":
      case "Resolved":
        // Terminal states — no actions available.
        break;
    }

    return actions;
  }
}
