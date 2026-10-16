import { Keypair } from "@stellar/stellar-sdk";
import { Client } from "./generated/contract-client.js";

export type DisputeOutcome = "Release" | "Refund";

export interface DisputeClientConfig {
  contractId: string;
  rpcUrl?: string;
  networkPassphrase?: string;
}

export interface DisputeCreationParams {
  payer: Keypair;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  releaser: string;
  refundAfter?: bigint;
  arbiter: string;
}

export interface DisputeSettlementParams {
  escrowId: bigint;
  caller: Keypair;
}

/** Opt-in SDK calls for escrows created with a named arbiter. */
export class DisputeClient {
  private readonly contractId: string;
  private readonly rpcUrl: string;
  private readonly networkPassphrase: string;

  constructor(config: DisputeClientConfig) {
    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl ?? "https://soroban-testnet.stellar.org";
    this.networkPassphrase = config.networkPassphrase ?? "Test SDF Network ; September 2015";
  }

  private client(signer?: Keypair): Client {
    return new Client({
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.networkPassphrase,
      ...(signer ? { publicKey: signer.publicKey(), signTransaction: signer } : {}),
    });
  }

  /** Create an escrow that allows either party to raise a dispute. */
  async createEscrowWithArbiter(params: DisputeCreationParams): Promise<{ escrowId: bigint; txHash: string }> {
    const tx = await this.client(params.payer).create_escrow_with_arbiter({
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

  /** Freeze a funded escrow. Caller must be its payer or payee. */
  async raiseDispute(params: DisputeSettlementParams): Promise<{ txHash: string }> {
    const tx = await this.client(params.caller).raise_dispute({
      escrow_id: params.escrowId,
      caller: params.caller.publicKey(),
    });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /** Resolve a dispute to the escrow's stored payee or payer. */
  async resolveDispute(params: DisputeSettlementParams & { outcome: DisputeOutcome }): Promise<{ txHash: string }> {
    const tx = await this.client(params.caller).resolve_dispute({
      escrow_id: params.escrowId,
      caller: params.caller.publicKey(),
      outcome: { tag: params.outcome, values: undefined },
    });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }
}
