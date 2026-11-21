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
  Address,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Operation,
  Networks,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Api, Server as RpcServer } from "@stellar/stellar-sdk/rpc";
import type { AssembledTransaction, Result, SentTransaction } from "@stellar/stellar-sdk/contract";
import {
  Client as EscrowContractClient,
  type EscrowData as GeneratedEscrowData,
  type EscrowStatus as GeneratedEscrowStatus,
  type PooledData as GeneratedPooledData,
  type Contribution as GeneratedContribution,
} from "./generated/contract-client.js";
import { decodeEscrowDataFromScVal } from "./escrow-data.js";
import {
  beginPhase,
  isInstrumentationEnabled,
  tracePhase,
  type EscrowSpanAttributes,
  type InstrumentationOptions,
} from "./instrumentation.js";
import type { FactoryClient as FactoryClientType } from "./factory.js";
import { signerAddress, type EscrowSigner } from "./signers/types.js";
import { NetworkMismatchError, toEscrowError } from "./errors.js";
import { getTokenInfo as readTokenInfo, rpcTokenInfoSource, type TokenInfo } from "./amounts.js";
import {
  PreparedTransactionExpiredError,
  SignedTransactionMismatchError,
  StaleSequenceError,
  UnsignedTransactionError,
  authSignersOf,
  ledgerBoundsMax,
  mergeSignatures as mergeSignedTransactions,
  setLedgerBounds,
  signAuthEntriesInEnvelope,
  transactionHash,
  type PreparedTransaction,
} from "./prepare.js";

export {
  PreparedTransactionExpiredError,
  SignedTransactionMismatchError,
  StaleSequenceError,
  UnsignedTransactionError,
  type PreparedTransaction,
} from "./prepare.js";

export { Keypair };
export {
  getTokenInfo,
  parseAmount,
  formatAmount,
  normaliseAmount,
  clearTokenInfoCache,
  rpcTokenInfoSource,
  AmountError,
  InvalidAmountError,
  MAX_TOKEN_DECIMALS,
  type TokenInfo,
  type TokenInfoSource,
  type TokenInfoSourceOptions,
} from "./amounts.js";
export { signerAddress, type EscrowSigner } from "./signers/types.js";
export {
  BalanceMismatchError,
  ContractError,
  EscrowError,
  InvalidAmountContractError,
  InvalidRefundAfterError,
  NetworkMismatchError,
  NotFoundError,
  NotFundedError,
  RequestTimeoutError,
  SimulationFailure,
  SubmissionFailure,
  UnauthorizedError,
  contractErrorName,
  toEscrowError,
} from "./errors.js";
export {
  otelTracer,
  spanName,
  type EscrowInstrumentationEvent,
  type EscrowSpan,
  type EscrowSpanAttributes,
  type EscrowSpanName,
  type EscrowTracer,
  type InstrumentationOptions,
} from "./instrumentation.js";
export { EscrowIndexerClient } from "./indexer-client.js";
export type { EscrowIndexerClientConfig, EscrowPage, IndexedEscrow } from "./indexer-client.js";
export { FactoryClient, predictInstanceAddress } from "./factory.js";
export {
  KNOWN_DEPLOYMENTS,
  UnknownDeploymentError,
  knownContractId,
  knownNetworkConfig,
  latestDeployment,
  parseDeployments,
  type DeploymentRecord,
  type DeploymentVerificationCase,
  type DeploymentsDocument,
} from "./deployments.js";
export type { FactoryClientConfig, DeployInstanceParams, DeployInstanceResult, FactoryInstance } from "./factory.js";

// Multisig releaser account helpers (T1 mitigation). Client-side only: they
// build classic `setOptions` transactions for the releaser account itself and
// never touch the escrow contract.
export {
  buildMultisigSetup,
  dryRunMultisigSetup,
  printMultisigDryRun,
  readOnChainMultisig,
  resolveMultisigPolicy,
  validateMultisigPolicy,
  verifyMultisig,
  MultisigLockOutError,
  MultisigValidationError,
  MAX_WEIGHT,
  MIN_WEIGHT,
  TESTNET_PASSPHRASE,
} from "./multisig.js";
export type {
  BuildMultisigSetupOptions,
  HorizonServerLike,
  MultisigDryRun,
  MultisigOnState,
  MultisigPolicy,
  MultisigSetupResult,
  MultisigSigner,
  MultisigVerificationResult,
  ResolvedMultisigPolicy,
  VerifyMultisigOptions,
} from "./multisig.js";

// Public types, constants and errors live in topical modules (one per
// feature); index.ts re-exports them all and keeps the EscrowClient class.
export * from "./archived-entries.js";
export * from "./batch.js";
export * from "./client-config.js";
export * from "./contract-version.js";
export * from "./escrow-types.js";
export * from "./events.js";
export * from "./fees.js";
export * from "./lifecycle.js";
export * from "./milestones.js";
export * from "./networks.js";
export * from "./pooled.js";
export * from "./prepare-submit.js";
export * from "./relayed-auth.js";
export * from "./solvency.js";

import { type ArchivedEntryBehavior } from "./archived-entries.js";
import { type BatchCreateItem, type BatchItemResult, type BatchOptions, BatchPartialFailureError, type BatchSettleOperation, MAX_BATCH_SIZE } from "./batch.js";
import { type EscrowClientConfig } from "./client-config.js";
import { UnsupportedContractVersionError, isSupportedContractVersion } from "./contract-version.js";
import { type CancelParams, type CreateEscrowParams, type CreateQuorumEscrowParams, type Escrow, type EscrowStatus, type ExtendRefundAfterParams, MAX_CONDITION_REF_LENGTH, MAX_FEE_BPS, MAX_RELEASERS, type ReleaseOrRefundParams, type SettlementApprovalsParams } from "./escrow-types.js";
import { type EscrowEvent, type EscrowEventType, EventCursorExpiredError, type GetEventsParams, type GetEventsResult, type SubscribeOptions } from "./events.js";
import { type EstimateCallParams, type FeeBumpOptions, type FeeBumpResult, type FeeEstimate, type GuardResult, MaxFeeExceededError, SponsorshipGuardError, computeFeeEstimate } from "./fees.js";
import { EMPTY_SPAN_ATTRIBUTES, MISSING_FUNCTION_ERROR, TESTNET_NETWORK_PASSPHRASE, TESTNET_RPC_URL, assertLedgerWindow, assertPositiveAmount, batchErrorMessage, contractAddressOf, isRetentionError, lifecycleCallSigner, safeScValToNative, sendErrorName, trancheOf } from "./internal.js";
import { type AcceptParams, type EscrowPreconditionCode, EscrowPreconditionError, type LifecycleCall, type LifecycleMethod, PREPARED_AUTH_TTL_LEDGERS, type PrepareLifecycleParams, type PreparedLifecycleCall, type TopUpParams, type TransferPayeeParams } from "./lifecycle.js";
import { type CreateMilestoneEscrowParams, type Milestone, type MilestoneEscrow, MilestoneEscrowPartialError, type RefundMilestoneParams, type ReleaseMilestoneParams, milestoneConditionRef, validateMilestoneSchedule } from "./milestones.js";
import { MAINNET_NETWORK_PASSPHRASE, MainnetNotAllowedError } from "./networks.js";
import { type ClaimRefundParams, type ContributeParams, type ContributionRecord, type CreatePooledEscrowParams, type PooledEscrow, type SolvencyReport } from "./pooled.js";
import { DEFAULT_SUBMIT_MAX_FEE, OFFLINE_PREPARED_TX_TTL_LEDGERS, PREPARED_TX_TTL_LEDGERS, type PrepareCreateEscrowParams, type PrepareSettlementParams, type SubmitSignedOptions, type SubmitSignedResult } from "./prepare-submit.js";
import { RELAYED_AUTH_TTL_LEDGERS, type RelayedAuthorization, type RelayedAuthorizationParams } from "./relayed-auth.js";

/**
 * Thin client for the docforum-escrow Soroban contract. Wraps
 * `create_escrow`/`get_status`/`get_escrow`/`release`/`refund` with plain
 * TypeScript types and no manual XDR/signing plumbing.
 */
export class EscrowClient {
  /** Contract id of the escrow instance this client talks to. */
  readonly contractId: string;
  private readonly rpcUrl: string;
  private readonly networkPassphrase: string;
  private readonly rpc: RpcServer;
  private readonly instrumentation?: InstrumentationOptions;
  private readonly archivalBehavior: ArchivedEntryBehavior;
  private readonly restoreSigner?: Keypair;
  private readonly allowMainnet: boolean;
  private readonly allowHttp: boolean;
  /** "required": explicit opt-in; "auto": preset selected; "off": no automatic check. */
  private readonly networkVerification: "required" | "auto" | "off";
  /** Cached result of the network passphrase verification. */
  private networkVerified?: Promise<void>;
  /** "required": explicit opt-in; "auto": preset selected; "off": no automatic check. */
  private readonly contractVersionCheck: "required" | "auto" | "off";
  /** Cached `version()` result; `null` means the deployment has no `version()`. */
  private contractVersion?: Promise<string | null>;
  private contractVersionChecked = false;

  constructor(config: EscrowClientConfig) {
    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl ?? config.network?.rpcUrl ?? TESTNET_RPC_URL;
    this.networkPassphrase =
      config.networkPassphrase ?? config.network?.networkPassphrase ?? TESTNET_NETWORK_PASSPHRASE;
    this.allowMainnet = config.allowMainnet === true;
    if (this.networkPassphrase === MAINNET_NETWORK_PASSPHRASE && !this.allowMainnet) {
      throw new MainnetNotAllowedError();
    }
    // No network I/O here: verification is lazy (see ensureNetworkVerified).
    this.networkVerification =
      config.verifyNetwork === true
        ? "required"
        : config.verifyNetwork === false
          ? "off"
          : config.network
            ? "auto"
            : "off";
    this.contractVersionCheck =
      config.verifyContractVersion === true
        ? "required"
        : config.verifyContractVersion === false
          ? "off"
          : config.network
            ? "auto"
            : "off";
    this.allowHttp = config.allowHttp ?? config.network?.allowHttp ?? false;
    this.rpc = new RpcServer(this.rpcUrl, { allowHttp: this.allowHttp });
    this.instrumentation = config.onEvent
      ? { ...config.instrumentation, onEvent: config.onEvent }
      : config.instrumentation;
    this.archivalBehavior = config.archivalBehavior ?? "error";
    this.restoreSigner = config.restoreSigner;
  }

  /**
   * Builds an `EscrowClient` for the instance owned by `integrator`, looked up
   * through `factoryClient`. Throws if the integrator has no deployed instance
   * yet — deploy one with `FactoryClient.deployInstance` first.
   */
  static async forIntegrator(
    factoryClient: FactoryClientType,
    integrator: string,
  ): Promise<EscrowClient> {
    const instance = await factoryClient.getInstance(integrator);
    if (!instance) {
      throw new Error(`No escrow instance is deployed for integrator ${integrator}.`);
    }
    return new EscrowClient({
      contractId: instance.contractId,
      rpcUrl: factoryClient.rpcUrl,
      networkPassphrase: factoryClient.networkPassphrase,
    });
  }

  /**
   * Verifies once (and caches) that the RPC's reported network passphrase
   * matches the configured one. A mismatch throws `NetworkMismatchError` so a
   * custom `rpcUrl` cannot silently point a client at another network. Calling
   * this is an explicit request, so an RPC without `getNetwork` is an error. A
   * rejection is not cached, so a transient RPC failure is retryable.
   */
  verifyNetwork(): Promise<void> {
    return this.runNetworkVerification(true);
  }

  private runNetworkVerification(required: boolean): Promise<void> {
    if (!this.networkVerified) {
      const rpc = this.rpc as Partial<Pick<RpcServer, "getNetwork">>;
      if (typeof rpc.getNetwork !== "function") {
        // Not cached: a later explicit request must still fail loudly.
        return required
          ? Promise.reject(
              new Error("Cannot verify the network: the RPC client does not implement getNetwork()."),
            )
          : Promise.resolve();
      }
      const getNetwork = rpc.getNetwork.bind(rpc);
      this.networkVerified = (async () => {
        const rpcNetwork = await getNetwork();
        if (rpcNetwork.passphrase !== this.networkPassphrase) {
          throw new NetworkMismatchError(this.networkPassphrase, rpcNetwork.passphrase);
        }
      })();
      this.networkVerified.catch(() => {
        this.networkVerified = undefined;
      });
    }
    return this.networkVerified;
  }

  /**
   * Gate on every network call path: lazily verifies the RPC's passphrase once
   * (see `verifyNetwork()`), then reuses the cached result. A no-op unless a
   * `network` preset was selected or `verifyNetwork: true` was passed; with a
   * preset only, an RPC without `getNetwork` is skipped rather than failing.
   */
  private async ensureNetworkVerified(): Promise<void> {
    await this.ensureNetworkPassphrase();
    await this.ensureContractVersionChecked();
  }

  private async ensureNetworkPassphrase(): Promise<void> {
    if (this.networkVerification === "off") return;
    await this.runNetworkVerification(this.networkVerification === "required");
  }

  /**
   * Reads the contract's semantic version once and caches it. Resolves to `null`
   * for an older deployment with no `version()` function. A failed lookup
   * rejects and isn't cached, so a transient RPC failure is retryable.
   */
  getContractVersion(): Promise<string | null> {
    if (!this.contractVersion) {
      this.contractVersion = (async () => {
        await this.ensureNetworkPassphrase();
        try {
          const tx = await this.contractClient().version();
          return tx.result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (MISSING_FUNCTION_ERROR.test(message)) return null;
          throw error;
        }
      })();
      this.contractVersion.catch(() => {
        this.contractVersion = undefined;
      });
    }
    return this.contractVersion;
  }

  /**
   * Checks the contract against `SUPPORTED_CONTRACT_VERSIONS`. Calling this is
   * an explicit request, so an older deployment with no `version()` is rejected
   * with `UnsupportedContractVersionError`, like any unsupported version.
   */
  async verifyContractVersion(): Promise<void> {
    const version = await this.getContractVersion();
    if (version === null || !isSupportedContractVersion(version)) {
      throw new UnsupportedContractVersionError(this.contractId, version);
    }
  }

  private async ensureContractVersionChecked(): Promise<void> {
    if (this.contractVersionCheck === "off" || this.contractVersionChecked) return;
    if (this.contractVersionCheck === "required") {
      await this.verifyContractVersion();
    } else {
      let version: string | null;
      try {
        version = await this.getContractVersion();
      } catch {
        return; // A failed lookup says nothing about the version; retry next call.
      }
      if (version !== null && !isSupportedContractVersion(version)) {
        throw new UnsupportedContractVersionError(this.contractId, version);
      }
    }
    this.contractVersionChecked = true;
  }

  private contractClient(signer?: EscrowSigner): EscrowContractClient {
    const effectiveSigner = signer ?? (this.archivalBehavior === "auto" ? this.restoreSigner : undefined);
    return new EscrowContractClient({
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.networkPassphrase,
      allowHttp: this.allowHttp,
      ...(effectiveSigner
        ? { publicKey: signerAddress(effectiveSigner), signTransaction: effectiveSigner }
        : {}),
    });
  }

  /** Non-secret attributes shared by every span of one contract call. */
  private spanAttributes(method: string, escrowId?: bigint, address?: string): EscrowSpanAttributes {
    const attributes: EscrowSpanAttributes = {
      "contract.id": this.contractId,
      "contract.function": method,
    };
    if (escrowId !== undefined) attributes["escrow.id"] = escrowId.toString();
    if (address && this.instrumentation?.includeAddresses) attributes["account.address"] = address;
    return attributes;
  }

  /** `spanAttributes` only when instrumentation is on; otherwise no allocation. */
  private spanAttributesIfEnabled(method: string, escrowId?: bigint, address?: string): EscrowSpanAttributes {
    return isInstrumentationEnabled(this.instrumentation)
      ? this.spanAttributes(method, escrowId, address)
      : EMPTY_SPAN_ATTRIBUTES;
  }

  /**
   * Simulate, sign, submit and confirm one write call, recording one span per
   * phase. With instrumentation disabled it skips every span allocation and
   * takes the shortest path (`send()`, which polls to completion).
   */
  private async invoke<T>(
    method: string,
    escrowId: bigint | undefined,
    build: () => Promise<AssembledTransaction<T>>,
    hooks: { beforeSign?: (tx: AssembledTransaction<T>) => Promise<void>; address?: string } = {},
  ): Promise<SentTransaction<T>> {
    await this.ensureNetworkVerified();
    const attributes = this.spanAttributesIfEnabled(method, escrowId, hooks.address);
    let tx: AssembledTransaction<T>;
    try {
      tx = await tracePhase(this.instrumentation, "simulate", attributes, build);
    } catch (error) {
      throw toEscrowError(error, "simulation");
    }
    if (tx.isReadCall) {
      throw new Error(`${method} was simulated as a read call; no transaction was sent.`);
    }
    await tracePhase(this.instrumentation, "sign", attributes, async () => {
      if (hooks.beforeSign) await hooks.beforeSign(tx);
      await tx.sign();
    });

    if (!this.instrumentation?.tracer && !this.instrumentation?.onEvent) {
      try {
        return await tx.send();
      } catch (error) {
        throw toEscrowError(error, "submission");
      }
    }

    const submitSpan = beginPhase(this.instrumentation, "submit", attributes);
    const confirmSpan = beginPhase(this.instrumentation, "confirm", attributes);
    let submitted = false;
    try {
      // `send()` submits and polls to a terminal state. `onSubmitted` marks
      // the submit/confirm boundary so the two phases are timed separately.
      const sent = await tx.send({
        onSubmitted: (response?: Api.SendTransactionResponse) => {
          submitted = true;
          if (response?.hash) {
            submitSpan.attributes["tx.hash"] = response.hash;
            confirmSpan.attributes["tx.hash"] = response.hash;
          }
          submitSpan.end();
          confirmSpan.start();
        },
      });
      if (!submitted) {
        submitSpan.end();
        confirmSpan.start();
      }
      const hash = sent.sendTransactionResponse?.hash;
      if (hash) {
        submitSpan.attributes["tx.hash"] = hash;
        confirmSpan.attributes["tx.hash"] = hash;
      }
      const attempts = sent.getTransactionResponseAll?.length ?? 0;
      if (attempts > 0) confirmSpan.attributes["retry.count"] = Math.max(0, attempts - 1);
      confirmSpan.end();
      return sent;
    } catch (error) {
      if (!submitted) submitSpan.end(error);
      confirmSpan.end(error);
      throw toEscrowError(error, "submission");
    }
  }

  /** Locks `amount` of `token` from `payer`, held for `payee`. Returns the new escrow's id and the funding transaction's hash. */
  async createEscrow(params: CreateEscrowParams): Promise<{ escrowId: bigint; txHash: string }> {
    if (params.conditionRef.length > MAX_CONDITION_REF_LENGTH) {
      throw new Error(
        `conditionRef must be at most ${MAX_CONDITION_REF_LENGTH} bytes, got ${params.conditionRef.length}`
      );
    }
    if ((params.feeRecipient === undefined) !== (params.feeBps === undefined)) {
      throw new TypeError("feeRecipient and feeBps must be given together, or both omitted");
    }
    if (params.feeBps !== undefined && (!Number.isInteger(params.feeBps) || params.feeBps < 0 || params.feeBps > MAX_FEE_BPS)) {
      throw new RangeError(`feeBps must be an integer between 0 and ${MAX_FEE_BPS} (10 %)`);
    }
    if (params.requiresAcceptance && (params.feeRecipient !== undefined || params.feeBps !== undefined)) {
      throw new TypeError("requiresAcceptance cannot be combined with feeRecipient or feeBps.");
    }
    const client = this.contractClient(params.payer);
    const createParams = {
      payer: signerAddress(params.payer),
      payee: params.payee,
      token: params.token,
      amount: params.amount,
      condition_ref: params.conditionRef,
      releaser: params.releaser,
      refund_after: params.refundAfter,
      notify_payee: params.notifyPayee ?? false,
      refund_to: params.refundTo,
      fee_recipient: params.feeRecipient,
      fee_bps: params.feeBps,
    };
    if (params.requiresAcceptance && (params.notifyPayee || params.releaseNotBefore !== undefined)) {
      throw new Error("requiresAcceptance cannot be combined with notifyPayee or releaseNotBefore.");
    }
    const sent = await this.invoke(
      "create_escrow",
      undefined,
      () => params.requiresAcceptance
        ? client.create_escrow_with_acceptance({
            payer: createParams.payer,
            payee: createParams.payee,
            token: createParams.token,
            amount: createParams.amount,
            condition_ref: createParams.condition_ref,
            releaser: createParams.releaser,
            refund_after: createParams.refund_after,
            requires_acceptance: true,
            refund_to: createParams.refund_to,
          })
        : params.releaseNotBefore === undefined
        ? client.create_escrow(createParams)
        : client.create_escrow_release_time({
            ...createParams,
            release_not_before: params.releaseNotBefore,
          }),
      { address: signerAddress(params.payer) },
    );
    return { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Read-only: `decimals`, `symbol` and `name` for `token`, read from the
   * SEP-41 contract over this client's RPC and cached per contract address.
   * Pass the returned `decimals` to `parseAmount`/`formatAmount` instead of
   * assuming 7.
   */
  async getTokenInfo(token: string): Promise<TokenInfo> {
    await this.ensureNetworkVerified();
    return readTokenInfo(
      token,
      rpcTokenInfoSource({ rpcUrl: this.rpcUrl, networkPassphrase: this.networkPassphrase }),
    );
  }

  /** Read-only status query. Throws if `escrowId` doesn't exist. */
  async getStatus(escrowId: bigint): Promise<EscrowStatus> {
    try {
      const client = this.contractClient();
      const tx = await tracePhase(
        this.instrumentation,
        "simulate",
        this.spanAttributesIfEnabled("get_status", escrowId),
        () => client.get_status({ escrow_id: escrowId }),
      );
      const status: GeneratedEscrowStatus = tx.result.unwrap();
      return status.tag;
    } catch (error) {
      throw toEscrowError(error);
    }
    await this.ensureNetworkVerified();
    const client = this.contractClient();
    const tx = await tracePhase(
      this.instrumentation,
      "simulate",
      this.spanAttributesIfEnabled("get_status", escrowId),
      () => client.get_status({ escrow_id: escrowId }),    );
    const status: GeneratedEscrowStatus = tx.result.unwrap();
    return status.tag;
  }

  /**
   * Locks `amount` on behalf of an M-of-N releaser set (docs/adr/0007): the
   * escrow settles only with `threshold` distinct approvals from
   * `releasers`. Same validation and returned shape as `createEscrow`.
   */
  async createQuorumEscrow(
    params: CreateQuorumEscrowParams
  ): Promise<{ escrowId: bigint; txHash: string }> {
    if (params.conditionRef.length > MAX_CONDITION_REF_LENGTH) {
      throw new Error(
        `conditionRef must be at most ${MAX_CONDITION_REF_LENGTH} bytes, got ${params.conditionRef.length}`
      );
    }
    if (params.releasers.length === 0) {
      throw new Error("releasers must contain at least one address");
    }
    if (params.releasers.length > MAX_RELEASERS) {
      throw new Error(
        `releasers must contain at most ${MAX_RELEASERS} addresses, got ${params.releasers.length}`
      );
    }
    if (new Set(params.releasers).size !== params.releasers.length) {
      throw new Error("releasers must not contain duplicate addresses");
    }
    if (
      !Number.isInteger(params.threshold) ||
      params.threshold < 1 ||
      params.threshold > params.releasers.length
    ) {
      throw new Error(
        `threshold must be an integer between 1 and ${params.releasers.length}, got ${params.threshold}`
      );
    }
    const client = this.contractClient(params.payer);
    const sent = await this.invoke(
      "create_escrow_with_releasers",
      undefined,
      () =>
        client.create_escrow_with_releasers({
          payer: signerAddress(params.payer),
          payee: params.payee,
          token: params.token,
          amount: params.amount,
          condition_ref: params.conditionRef,
          releasers: params.releasers,
          threshold: params.threshold,
          refund_after: params.refundAfter,
          notify_payee: params.notifyPayee ?? false,
          refund_to: params.refundTo,
        }),
      { address: signerAddress(params.payer) },
    );
    return { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Read-only: everything stored about `escrowId` — including the
   * `releasers` set, its `threshold` and `refundAfter`, which payees should
   * check before relying on a `Funded` escrow (docs/adr/0004, threat model
   * T8). Throws if `escrowId` doesn't exist, **and also once the escrow has
   * settled**: its record is reclaimed (docs/adr/0013). Use `getStatus` for a
   * settled id and the `ESCROW` state event for its history.
   */
  async getEscrow(escrowId: bigint): Promise<Escrow> {
    await this.ensureNetworkVerified();
    const client = this.contractClient();
    let tx: Awaited<ReturnType<EscrowContractClient["get_escrow"]>>;
    try {
      tx = await tracePhase(
        this.instrumentation,
        "simulate",
        this.spanAttributesIfEnabled("get_escrow", escrowId),
        () => client.get_escrow({ escrow_id: escrowId }),
      );
    } catch (error) {
      throw toEscrowError(error);
    }
    let data: GeneratedEscrowData;
    try {
      data = tx.result.unwrap();
    } catch (error) {
      // The generated bindings embed the current contract spec. A testnet
      // deployment that predates a newly added `EscrowData` field still
      // returns a valid map, but the SDK's positional struct decoder can
      // mis-read it (for example before `release_not_before` existed).
      // Decode the same map by field name so reads keep working across
      // deployed contract versions (issue #224).
      const retval = error instanceof TypeError
        ? tx.simulationData.result?.retval
        : undefined;
      if (retval?.switch().name === "scvMap") {
        return decodeEscrowDataFromScVal(retval);
      }
      throw error;
    }
    return {
      payer: data.payer,
      payee: data.payee,
      token: data.token,
      amount: data.amount,
      conditionRef: data.condition_ref,
      releasers: data.releasers,
      threshold: data.threshold,
      // The generated client decodes a contract `None` as `null`; the
      // public surface uses `undefined` for "no deadline" (consistent
      // with `CreateEscrowParams.refundAfter` being absent).
      refundAfter: data.refund_after ?? undefined,
      notifyPayee: data.notify_payee,
      refundTo: data.refund_to,
      releaseNotBefore: data.release_not_before ?? undefined,
      feeRecipient: data.fee_recipient ?? undefined,
      feeBps: data.fee_bps ?? undefined,
      requiresAcceptance: data.requires_acceptance,
      acceptedAt: data.accepted_at ?? undefined,
      status: data.status.tag,
    };
  }

  /**
   * Creates a milestone escrow: one single-tranche escrow per entry in
   * `milestones`, created in schedule order.
   *
   * The deployed contract is single-tranche, so a milestone schedule is
   * modelled client-side as a *group* of escrows rather than a new contract
   * entry point. That keeps every guarantee the contract already gives —
   * per-tranche releaser auth, refund deadlines, `Funded`/`Released` state —
   * and needs no contract change. Trade-offs, all visible in the return
   * value:
   *  - each tranche is its own escrow, so `releaseMilestone` /
   *    `refundMilestone` act on one `escrowId` at a time;
   *  - `payer` signs one transaction per tranche, so a group costs N
   *    transactions ("N tranches = N escrows" is logged in `conditionRef`
   *    as `<conditionRef>#m<i+1>/<n>`);
   *  - creation is sequential and not atomic: if tranche *k* fails, the
   *    earlier escrows already exist and are funded. The thrown
   *    `MilestoneEscrowPartialError` carries their ids so the caller can
   *    release or refund them.
   *
   * `milestones` must be positive and sum exactly to `amount`, validated
   * before the first transaction (`MilestoneScheduleError`).
   */
  async createMilestoneEscrow(params: CreateMilestoneEscrowParams): Promise<MilestoneEscrow> {
    validateMilestoneSchedule(params.milestones, params.amount);

    // Validate every tagged ref up front: failing on tranche 3 after 2
    // funded escrows exist is exactly the partial state this API must avoid.
    const refs = params.milestones.map((_, index) =>
      milestoneConditionRef(params.conditionRef, index, params.milestones.length),
    );

    const created: Milestone[] = [];
    const { milestones: schedule, ...escrowParams } = params;
    for (const [index, amount] of schedule.entries()) {
      try {
        const { escrowId } = await this.createEscrow({
          ...escrowParams,
          amount,
          conditionRef: refs[index],
        });
        created.push({ index, amount, escrowId, status: "unreleased" });
      } catch (error) {
        throw new MilestoneEscrowPartialError(
          created.map((milestone) => milestone.escrowId),
          created.length,
          schedule.length,
          error,
        );
      }
    }

    return {
      milestones: created,
      escrowIds: created.map((milestone) => milestone.escrowId),
    };
  }

  /**
   * Releases one tranche to the payee. `caller` must be that tranche's
   * `releaser`; out-of-order release is fine. Each tranche can be released
   * at most once, because each is its own single-tranche escrow. Returns the
   * transaction's hash.
   */
  async releaseMilestone(params: ReleaseMilestoneParams): Promise<{ txHash: string }> {
    const { escrowId } = trancheOf(params.escrow, params.milestoneIndex);
    return this.release({ escrowId, caller: params.caller });
  }

  /** Refunds one unreleased tranche to its `refundTo` — same rules as `refund`. */
  async refundMilestone(params: RefundMilestoneParams): Promise<{ txHash: string }> {
    const { escrowId } = trancheOf(params.escrow, params.milestoneIndex);
    return this.refund({ escrowId, caller: params.caller });
  }

  /**
   * Read-only: re-reads every tranche's escrow and reports it as
   * `"unreleased"` (`Funded`), `"released"` (`Released`) or `"refunded"`
   * (anything terminal otherwise). One `get_escrow` per tranche.
   */
  async getMilestones(escrow: MilestoneEscrow): Promise<Milestone[]> {
    return Promise.all(
      escrow.milestones.map(async ({ index, amount, escrowId }) => {
        const status = (await this.getEscrow(escrowId)).status;
        return {
          index,
          amount,
          escrowId,
          status: status === "Released" ? "released" : status === "Funded" ? "unreleased" : "refunded",
        } satisfies Milestone;
      }),
    );
  }

  /** Moves the escrow's funds to its payee. Throws if `caller` isn't the escrow's `releaser`, or the escrow isn't `Funded`. Returns the transaction's hash. */
  async release(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const sent = await this.invoke(
      "release",
      params.escrowId,
      () => client.release({ escrow_id: params.escrowId, caller: signerAddress(params.caller) }),
      { address: signerAddress(params.caller) },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Payer-side withdrawal before the payee accepts (docs/adr/0010): returns
   * the escrow's funds to its `refundTo` and marks it `Cancelled`. Only the
   * escrow's payer may call it, only while it is `Funded`, was created with
   * the acceptance gate, and the payee has not accepted. Returns the
   * transaction's hash.
   */
  async cancel(params: CancelParams): Promise<{ txHash: string }> {
    await this.ensureNetworkVerified();
    const payer = signerAddress(params.payer);
    const call: LifecycleCall = { method: "cancel", escrowId: params.escrowId, payer };
    if (params.checkPreconditions !== false) await this.checkLifecycleCall(call);
    const client = this.contractClient(params.payer);
    const sent = await this.invoke(
      "cancel",
      params.escrowId,
      () => client.cancel({ escrow_id: params.escrowId, payer }),
      { address: payer },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Adds `amount` to a `Funded` escrow without changing its parties or id
   * (issue #26). Only the escrow's original payer may top up; pooled
   * escrows grow through `contribute` instead and are rejected by the
   * contract (`NotSupportedForPooled`). Returns the transaction's hash.
   */
  async topUp(params: TopUpParams): Promise<{ txHash: string }> {
    const payer = signerAddress(params.payer);
    const call: LifecycleCall = { method: "top_up", escrowId: params.escrowId, payer, amount: params.amount };
    assertPositiveAmount(call);
    if (params.checkPreconditions !== false) await this.checkLifecycleCall(call);
    const client = this.contractClient(params.payer);
    const sent = await this.invoke(
      "top_up",
      params.escrowId,
      () => client.top_up({ escrow_id: params.escrowId, payer, amount: params.amount }),
      { address: payer },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Records the payee's acceptance on an escrow created with the
   * acceptance gate (issue #25). Once accepted, the payer can no longer
   * `cancel`. One-time and only while `Funded`. Returns the transaction's
   * hash.
   */
  async accept(params: AcceptParams): Promise<{ txHash: string }> {
    const payee = signerAddress(params.payee);
    const call: LifecycleCall = { method: "accept", escrowId: params.escrowId, payee };
    if (params.checkPreconditions !== false) await this.checkLifecycleCall(call);
    const client = this.contractClient(params.payee);
    const sent = await this.invoke(
      "accept",
      params.escrowId,
      () => client.accept({ escrow_id: params.escrowId, payee }),
      { address: payee },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Reassigns future payout rights to `newPayee` (contract `transfer_payee`,
   * issue #45). Only the escrow's current payee may call it, only while
   * `Funded`; `newPayee` must not be the payer or the contract id
   * (`InvalidNewPayee`). Warning: on a `notifyPayee` escrow the new payee
   * must implement the `notify_payee` callback, or payouts to it will fail.
   * Returns the transaction's hash.
   */
  async transferPayee(params: TransferPayeeParams): Promise<{ txHash: string }> {
    const currentPayee = signerAddress(params.currentPayee);
    const call: LifecycleCall = {
      method: "transfer_payee",
      escrowId: params.escrowId,
      currentPayee,
      newPayee: params.newPayee,
    };
    if (params.checkPreconditions !== false) await this.checkLifecycleCall(call);
    const client = this.contractClient(params.currentPayee);
    const sent = await this.invoke(
      "transfer_payee",
      params.escrowId,
      () =>
        client.transfer_payee({
          escrow_id: params.escrowId,
          current_payee: currentPayee,
          new_payee: params.newPayee,
        }),
      { address: currentPayee },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Step 1 of the multi-party flow: simulates `call` with `source` as the
   * transaction source and returns it as portable JSON, listing every other
   * party whose contract authorization is still needed. Pass the result to
   * each of them for `signLifecycleCall`, then to the source for
   * `submitLifecycleCall`. Nothing is signed here.
   */
  async prepareLifecycleCall(params: PrepareLifecycleParams): Promise<PreparedLifecycleCall> {
    const { call } = params;
    if (call.method === "top_up") assertPositiveAmount(call);
    await this.ensureNetworkVerified();
    if (params.checkPreconditions !== false) await this.checkLifecycleCall(call);
    const source = params.source ?? lifecycleCallSigner(call);
    const client = this.contractClientForAddress(source);
    const tx = await this.buildLifecycleCall(client, call);
    if (tx.isReadCall) {
      throw new Error(`${call.method} was simulated as a read call; no transaction was assembled.`);
    }
    const latestLedger = await this.rpc.getLatestLedger();
    return {
      method: call.method,
      transaction: tx.toJSON(),
      source,
      pendingSigners: tx.needsNonInvokerSigningBy(),
      expiresAtLedger: latestLedger.sequence + (params.ttlLedgers ?? PREPARED_AUTH_TTL_LEDGERS),
    };
  }

  /**
   * Step 2: signs `signer`'s contract auth entry in a prepared call and
   * returns the updated call with `signer` removed from `pendingSigners`.
   * Safe to run in a separate process from `prepareLifecycleCall`; the
   * signer never sees or signs the envelope.
   */
  async signLifecycleCall(
    prepared: PreparedLifecycleCall,
    signer: EscrowSigner,
  ): Promise<PreparedLifecycleCall> {
    const address = signerAddress(signer);
    if (!prepared.pendingSigners.includes(address)) {
      throw new Error(`${address} has no pending authorization in this ${prepared.method} call.`);
    }
    const client = this.contractClientForAddress(prepared.source);
    const tx = client.txFromJSON<Result<void>>(prepared.transaction);
    await tx.signAuthEntries({ signAuthEntry: signer, expiration: prepared.expiresAtLedger });
    return {
      ...prepared,
      transaction: tx.toJSON(),
      pendingSigners: tx.needsNonInvokerSigningBy(),
    };
  }

  /**
   * Step 3: the source signs the envelope and submits. Refuses to submit
   * while any party's authorization is still missing, or when `expectedMethod`
   * does not match, so a call meant for one function cannot be passed off as
   * another. Returns the transaction's hash.
   */
  async submitLifecycleCall(
    prepared: PreparedLifecycleCall,
    source: EscrowSigner,
    expectedMethod?: LifecycleMethod,
  ): Promise<{ txHash: string }> {
    let method: unknown;
    try {
      method = (JSON.parse(prepared.transaction) as { method?: unknown }).method;
    } catch (error) {
      throw new TypeError(`Prepared call is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (method !== prepared.method || (expectedMethod && method !== expectedMethod)) {
      throw new TypeError(
        `Prepared call is for ${String(method) || "an unknown method"}, not ${expectedMethod ?? prepared.method}.`
      );
    }
    if (signerAddress(source) !== prepared.source) {
      throw new Error(`Prepared call must be submitted by its source ${prepared.source}.`);
    }
    await this.ensureNetworkVerified();
    const client = this.contractClient(source);
    const tx = client.txFromJSON<Result<void>>(prepared.transaction);
    const missing = tx.needsNonInvokerSigningBy();
    if (missing.length > 0) {
      throw new Error(`Still waiting for authorization from: ${missing.join(", ")}.`);
    }
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /** A contract client that simulates as `address` without being able to sign. */
  private contractClientForAddress(address: string): EscrowContractClient {
    return new EscrowContractClient({
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.networkPassphrase,
      allowHttp: this.allowHttp,
      publicKey: address,
    });
  }

  private buildLifecycleCall(
    client: EscrowContractClient,
    call: LifecycleCall,
  ): Promise<AssembledTransaction<Result<void>>> {
    switch (call.method) {
      case "top_up":
        return client.top_up({ escrow_id: call.escrowId, payer: call.payer, amount: call.amount });
      case "accept":
        return client.accept({ escrow_id: call.escrowId, payee: call.payee });
      case "cancel":
        return client.cancel({ escrow_id: call.escrowId, payer: call.payer });
      case "transfer_payee":
        return client.transfer_payee({
          escrow_id: call.escrowId,
          current_payee: call.currentPayee,
          new_payee: call.newPayee,
        });
    }
  }

  /**
   * Client-side precondition check: reads the escrow once and throws
   * `EscrowPreconditionError` for anything the contract would certainly
   * reject. Rules mirror `contracts/escrow/src/lib.rs`.
   */
  private async checkLifecycleCall(call: LifecycleCall): Promise<void> {
    const escrow = await this.getEscrow(call.escrowId);
    const fail = (code: EscrowPreconditionCode, message: string): never => {
      throw new EscrowPreconditionError(call.method, code, message);
    };
    // Same order as the contract, so the error matches what it would return.
    const [party, expected] =
      call.method === "accept" || call.method === "transfer_payee"
        ? ["payee", escrow.payee] as const
        : ["payer", escrow.payer] as const;
    if (lifecycleCallSigner(call) !== expected) {
      fail("Unauthorized", `only the escrow's ${party} can call ${call.method}.`);
    }
    if (escrow.status !== "Funded") {
      fail("NotFunded", `escrow ${call.escrowId} is ${escrow.status}, not Funded.`);
    }
    if (call.method === "top_up") return;
    if (call.method === "transfer_payee") {
      if (call.newPayee === escrow.payer || call.newPayee === this.contractId) {
        fail(
          "InvalidNewPayee",
          "newPayee must not be the payer or the contract id.",
        );
      }
      return;
    }
    if (!escrow.requiresAcceptance) {
      fail("AcceptanceNotConfigured", "the escrow was created without the acceptance gate.");
    }
    if (escrow.acceptedAt !== undefined) fail("AlreadyAccepted", "the payee has already accepted.");
  }

  /**
   * Creates a pooled escrow (issue #113, docs/adr/0011): one agreement
   * that many payers fund with `contribute`. Creation moves no tokens —
   * the pool starts at 0 and grows to `fundingTarget`. Release becomes
   * possible only at exactly the target; if `fundingDeadline` passes
   * first, the round failed and each contributor pulls their own record
   * back with `claimRefund`. Returns the new escrow id and tx hash.
   */
  async createPooledEscrow(
    params: CreatePooledEscrowParams
  ): Promise<{ escrowId: bigint; txHash: string }> {
    if (params.conditionRef.length > MAX_CONDITION_REF_LENGTH) {
      throw new Error(
        `conditionRef must be at most ${MAX_CONDITION_REF_LENGTH} bytes, got ${params.conditionRef.length}`
      );
    }
    if (params.fundingTarget <= 0n) {
      throw new Error(`fundingTarget must be a positive raw amount, got ${params.fundingTarget}`);
    }
    if (params.fundingDeadline <= 0n) {
      throw new Error(
        `fundingDeadline must be a positive unix timestamp in seconds, got ${params.fundingDeadline}`
      );
    }
    const client = this.contractClient(params.creator);
    const sent = await this.invoke(
      "create_pooled_escrow",
      undefined,
      () =>
        client.create_pooled_escrow({
          creator: signerAddress(params.creator),
          payee: params.payee,
          token: params.token,
          funding_target: params.fundingTarget,
          condition_ref: params.conditionRef,
          releaser: params.releaser,
          funding_deadline: params.fundingDeadline,
        }),
      { address: signerAddress(params.creator) },
    );
    return { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Contributes `amount` to a pooled escrow from `payer` (docs/adr/0011).
   * Accepted only before the funding deadline and only while the pool
   * stays at or under its target; the contract verifies the received
   * amount with a balance-delta check and records it against `payer`,
   * accumulating across repeat contributions. Returns the tx hash.
   */
  async contribute(params: ContributeParams): Promise<{ txHash: string }> {
    if (params.amount <= 0n) {
      throw new Error(`amount must be a positive raw amount, got ${params.amount}`);
    }
    const client = this.contractClient(params.payer);
    const sent = await this.invoke(
      "contribute",
      params.escrowId,
      () =>
        client.contribute({
          escrow_id: params.escrowId,
          payer: signerAddress(params.payer),
          amount: params.amount,
        }),
      { address: signerAddress(params.payer) },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Pull-based refund of a failed funding round (docs/adr/0011): pays
   * `contributor` exactly their recorded amount, once. Only available
   * after the funding deadline passed below the target, and never after
   * a release. The contributor signs their own claim; anyone else's
   * claim of this record is impossible. Returns the tx hash.
   */
  async claimRefund(params: ClaimRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.contributor);
    const sent = await this.invoke(
      "claim_refund",
      params.escrowId,
      () =>
        client.claim_refund({
          escrow_id: params.escrowId,
          contributor: signerAddress(params.contributor),
        }),
      { address: signerAddress(params.contributor) },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Read-only: a pooled escrow's immutable funding config. Combine with
   * `getEscrow().amount` and the current ledger time to classify the
   * round: `amount === fundingTarget` succeeded (releasable at any time);
   * `now >= fundingDeadline && amount < fundingTarget` failed
   * (`claimRefund` is open). A failed round still reads `"Funded"` from
   * `getStatus` — status describes settlement, not funding. Throws
   * `NotPooled` (error 26) on a non-pooled or unknown id.
   */
  async getPooled(escrowId: bigint): Promise<PooledEscrow> {
    await this.ensureNetworkVerified();
    const client = this.contractClient();
    const tx = await tracePhase(
      this.instrumentation,
      "simulate",
      this.spanAttributesIfEnabled("get_pooled", escrowId),
      () => client.get_pooled({ escrow_id: escrowId }),
    );
    const data: GeneratedPooledData = tx.result.unwrap();
    return {
      fundingTarget: data.funding_target,
      fundingDeadline: data.funding_deadline,
    };
  }

  /**
   * Read-only: one contributor's record on a pooled escrow — the exact
   * amount they can claim from a failed round and whether it is already
   * claimed. `undefined` means the address never contributed. Throws
   * `NotFound` (1) on an unknown id, `NotPooled` (26) on a non-pooled one.
   */
  async getContribution(
    escrowId: bigint,
    contributor: string
  ): Promise<ContributionRecord | undefined> {
    await this.ensureNetworkVerified();
    const client = this.contractClient();
    const tx = await tracePhase(
      this.instrumentation,
      "simulate",
      this.spanAttributesIfEnabled("get_contribution", escrowId, contributor),
      () => client.get_contribution({ escrow_id: escrowId, contributor }),
    );
    const record: GeneratedContribution | undefined = tx.result.unwrap();
    if (record == null) return undefined;
    return { amount: record.amount, refunded: record.refunded };
  }

  /**
   * Read-only solvency check for one token (issue #39): the contract's
   * balance of `token` and its total outstanding liability in it (the sum
   * of `amount` over every `Funded` escrow, maintained on-chain in the
   * same invocation as each state change). `solvent` is false only when
   * the contract holds less than it owes, e.g. after an issuer clawback
   * (threat model T5). A token never used reports zero liabilities.
   */
  async getSolvency(token: string): Promise<SolvencyReport> {
    const client = this.contractClient();
    const tx = await tracePhase(
      this.instrumentation,
      "simulate",
      this.spanAttributesIfEnabled("solvency"),
      () => client.solvency({ token }),
    );
    const [balance, liabilities] = tx.result;
    return { balance, liabilities, solvent: balance >= liabilities };
  }

  /**
   * Returns the escrow's funds to its `refundTo` (the payer unless a
   * sponsored escrow set another destination, docs/adr/0009). Normally `caller` must be
   * the escrow's `releaser`; once `refundAfter` has passed, anyone may
   * call it — still only back to the payer (docs/adr/0004). Returns the
   * transaction's hash.
   */
  async refund(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const sent = await this.invoke(
      "refund",
      params.escrowId,
      () => client.refund({ escrow_id: params.escrowId, caller: signerAddress(params.caller) }),
      { address: signerAddress(params.caller) },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Blocks **new deposits** — `createEscrow`, its variants and any future
   * deposit path — until `unpause` is called (docs/adr/0011). Only the
   * custodian fixed at deployment may call it, and it must sign.
   *
   * Deliberately cannot touch money already escrowed: `release`,
   * `refund` and the timeout refund never read the flag, so a pause can
   * stop new exposure but never lock existing funds. Returns the
   * transaction's hash.
   */
  async pause(caller: EscrowSigner): Promise<{ txHash: string }> {
    const client = this.contractClient(caller);
    const sent = await this.invoke(
      "pause",
      undefined,
      () => client.pause({ caller: signerAddress(caller) }),
      { address: signerAddress(caller) },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Re-opens new deposits after a pause (docs/adr/0011). Same authority as
   * `pause` — only the deploy-time custodian, which must sign. Returns the
   * transaction's hash.
   */
  async unpause(caller: EscrowSigner): Promise<{ txHash: string }> {
    const client = this.contractClient(caller);
    const sent = await this.invoke(
      "unpause",
      undefined,
      () => client.unpause({ caller: signerAddress(caller) }),
      { address: signerAddress(caller) },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /** Read-only: is the emergency pause currently blocking new deposits? */
  async isPaused(): Promise<boolean> {
    const client = this.contractClient();
    const tx = await tracePhase(
      this.instrumentation,
      "simulate",
      this.spanAttributesIfEnabled("is_paused"),
      () => client.is_paused(),
    );
    return tx.result;
  }

  /**
   * Read-only: the custodian address that may `pause`/`unpause`, so an
   * integrator can verify who holds the role without trusting docs
   * (docs/adr/0011). `undefined` only for an instance deployed without a
   * constructor, which this contract's WASM does not allow.
   */
  async getPauseAdmin(): Promise<string | undefined> {
    const client = this.contractClient();
    const tx = await tracePhase(
      this.instrumentation,
      "simulate",
      this.spanAttributesIfEnabled("get_pause_admin"),
      () => client.get_pause_admin(),
    );
    return tx.result ?? undefined;
  }

  /** The contract's limit on items per batched call (docs/adr/0005). */
  get maxBatchSize(): number {
    return MAX_BATCH_SIZE;
  }

  /**
   * Creates several escrows, chunked to the contract's max batch size and
   * mapped back to the caller's input order. Each item goes through the
   * normal single-escrow `create_escrow` path, so validation, auth and
   * events are identical to `createEscrow`.
   *
   * A failure never stops later chunks: every item is attempted, then a
   * `BatchPartialFailureError` carrying all per-item results is thrown if
   * any failed. Retry with `{ resumeFrom: error.results }` to send only the
   * failures.
   */
  async createEscrows(
    items: BatchCreateItem[],
    options: BatchOptions<BatchCreateItem> = {},
  ): Promise<BatchItemResult<BatchCreateItem>[]> {
    const results = this.batchResults(items, options.resumeFrom);
    const chunkSize = this.resolveChunkSize(options.chunkSize);

    for (let start = 0; start < items.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, items.length);
      for (let index = start; index < end; index++) {
        if (results[index].ok) continue;
        try {
          const created = await this.createEscrow(items[index]);
          results[index] = { index, item: items[index], ok: true, skipped: false, ...created };
        } catch (error) {
          results[index] = {
            index,
            item: items[index],
            ok: false,
            skipped: false,
            error: batchErrorMessage(error),
          };
        }
      }
    }

    this.throwOnBatchFailure(results);
    return results;
  }

  /**
   * Settles several escrows (`release` or `refund`), chunked to the
   * contract's max batch size and mapped back to the caller's input order.
   * Each operation goes through the existing single-op `release`/`refund`
   * path, so auth and state rules are unchanged.
   *
   * A failure never stops later chunks: every operation is attempted, then
   * a `BatchPartialFailureError` carrying all per-op results is thrown if
   * any failed. Retry with `{ resumeFrom: error.results }` to send only the
   * failures — already settled escrows are then skipped, never re-sent.
   */
  async settleMany(
    ops: BatchSettleOperation[],
    options: BatchOptions<BatchSettleOperation> = {},
  ): Promise<BatchItemResult<BatchSettleOperation>[]> {
    const results = this.batchResults(ops, options.resumeFrom);
    const chunkSize = this.resolveChunkSize(options.chunkSize);

    for (let start = 0; start < ops.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, ops.length);
      for (let index = start; index < end; index++) {
        if (results[index].ok) continue;
        const op = ops[index];
        try {
          const settled = op.kind === "release"
            ? await this.release({ escrowId: op.escrowId, caller: op.caller })
            : await this.refund({ escrowId: op.escrowId, caller: op.caller });
          results[index] = { index, item: op, ok: true, skipped: false, ...settled };
        } catch (error) {
          results[index] = { index, item: op, ok: false, skipped: false, error: batchErrorMessage(error) };
        }
      }
    }

    this.throwOnBatchFailure(results);
    return results;
  }

  /** One not-yet-successful result per input, pre-filled from `resumeFrom`. */
  private batchResults<T>(items: T[], resumeFrom?: BatchItemResult<T>[]): BatchItemResult<T>[] {
    const results: BatchItemResult<T>[] = items.map((item, index) => ({
      index,
      item,
      ok: false,
      skipped: false,
    }));
    for (const prior of resumeFrom ?? []) {
      if (!prior.ok || prior.index < 0 || prior.index >= results.length) continue;
      results[prior.index] = { ...prior, item: items[prior.index], skipped: true };
    }
    return results;
  }

  private throwOnBatchFailure<T>(results: BatchItemResult<T>[]): void {
    if (results.some((result) => !result.ok)) throw new BatchPartialFailureError(results);
  }

  /** Clamp a caller-supplied chunk size to the contract's max batch size. */
  private resolveChunkSize(requested?: number): number {
    if (requested === undefined || !Number.isFinite(requested) || requested < 1) return MAX_BATCH_SIZE;
    return Math.min(Math.floor(requested), MAX_BATCH_SIZE);
  }

  /**
   * Simulates a `release`, has the releaser sign only its short-lived contract
   * authorization entry, and returns the resulting transaction for a separate
   * relayer to sign and submit. The relayer is the transaction source, so it
   * pays the fee; no envelope signature is collected here. Keep the returned
   * authorization private and submit it before `expiresAtLedger`.
   */
  async authorizeRelease(params: RelayedAuthorizationParams): Promise<RelayedAuthorization> {
    return this.authorizeSettlement("release", params);
  }

  /**
   * Simulates a `refund` and collects only the releaser's contract auth entry,
   * leaving the envelope for the relayer to sign and pay for. Same lifetime and
   * privacy rules as `authorizeRelease`.
   */
  async authorizeRefund(params: RelayedAuthorizationParams): Promise<RelayedAuthorization> {
    return this.authorizeSettlement("refund", params);
  }

  /** A contract client that can build and simulate for `publicKey` but cannot sign. */
  private publicContractClient(publicKey: string): EscrowContractClient {
    return new EscrowContractClient({
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.networkPassphrase,
      publicKey,
    });
  }

  /**
   * Builds and simulates a `create_escrow` for a payer who signs elsewhere (a
   * browser wallet, say) and returns the unsigned envelope. Nothing is signed
   * or submitted, and no secret key is needed.
   *
   * By default the payer is also the transaction source, so the wallet only
   * has to sign the envelope. Pass `source` to have another account pay the
   * fee; the payer then has to sign its auth entry too (see `authSigners`).
   *
   * Hand the returned `xdr` to the signer, then pass the signed XDR and the
   * `hash` to `submitSigned`. The transaction expires at `validUntilLedger`.
   */
  async prepareCreateEscrow(params: PrepareCreateEscrowParams): Promise<PreparedTransaction> {
    await this.ensureNetworkVerified();
    if ((params.feeRecipient === undefined) !== (params.feeBps === undefined)) {
      throw new TypeError("feeRecipient and feeBps must be given together, or both omitted");
    }
    if (params.feeBps !== undefined && (!Number.isInteger(params.feeBps) || params.feeBps < 0 || params.feeBps > MAX_FEE_BPS)) {
      throw new RangeError(`feeBps must be an integer between 0 and ${MAX_FEE_BPS} (10 %)`);
    }
    if (params.conditionRef.length > MAX_CONDITION_REF_LENGTH) {
      throw new Error(
        `conditionRef must be at most ${MAX_CONDITION_REF_LENGTH} bytes, got ${params.conditionRef.length}`
      );
    }
    const validForLedgers = params.validForLedgers ?? PREPARED_TX_TTL_LEDGERS;
    const authValidForLedgers = params.authValidForLedgers ?? validForLedgers;
    assertLedgerWindow("validForLedgers", validForLedgers);
    assertLedgerWindow("authValidForLedgers", authValidForLedgers);
    const source = params.source ?? params.payer;
    const client = this.publicContractClient(source);
    const createParams = {
      payer: params.payer,
      payee: params.payee,
      token: params.token,
      amount: params.amount,
      condition_ref: params.conditionRef,
      releaser: params.releaser,
      refund_after: params.refundAfter,
      notify_payee: params.notifyPayee ?? false,
      refund_to: params.refundTo,
      fee_recipient: params.feeRecipient,
      fee_bps: params.feeBps,
    };
    const assembled = params.releaseNotBefore === undefined
      ? await client.create_escrow(createParams)
      : await client.create_escrow_release_time({
          ...createParams,
          release_not_before: params.releaseNotBefore,
        });
    return this.finishPrepare(assembled, source, validForLedgers, authValidForLedgers, "create_escrow");
  }

  /**
   * Builds and simulates a `release` for a releaser that signs offline (a cold
   * key, a hardware signer, or a classic multisig account) and returns the
   * unsigned envelope. Nothing is signed or submitted. Sign `xdr` on the
   * offline machine; for a multisig releaser collect one signed copy per
   * signer and combine them with `mergeSignatures`; then send the result
   * through `submitSigned` from anywhere.
   *
   * The source account's sequence number is fixed when the transaction is
   * prepared. If that account sends anything else first, the prepared
   * transaction is dead: `submitSigned` detects it (`StaleSequenceError`) and
   * you must prepare and sign again. Single-releaser escrows only; M-of-N
   * quorum escrows settle through `releaseWithApprovals`.
   */
  async prepareRelease(params: PrepareSettlementParams): Promise<PreparedTransaction> {
    return this.prepareSettlement("release", params);
  }

  /** Like `prepareRelease`, but for `refund`. */
  async prepareRefund(params: PrepareSettlementParams): Promise<PreparedTransaction> {
    return this.prepareSettlement("refund", params);
  }

  private async prepareSettlement(
    method: "release" | "refund",
    params: PrepareSettlementParams,
  ): Promise<PreparedTransaction> {
    await this.ensureNetworkVerified();
    const validForLedgers = params.validForLedgers ?? OFFLINE_PREPARED_TX_TTL_LEDGERS;
    const authValidForLedgers = params.authValidForLedgers ?? validForLedgers;
    assertLedgerWindow("validForLedgers", validForLedgers);
    assertLedgerWindow("authValidForLedgers", authValidForLedgers);
    const source = params.source ?? params.releaser;
    const client = this.publicContractClient(source);
    const args = { escrow_id: params.escrowId, caller: params.releaser };
    const assembled = method === "release" ? await client.release(args) : await client.refund(args);
    return this.finishPrepare(assembled, source, validForLedgers, authValidForLedgers, method);
  }

  /**
   * Combines signed copies of one prepared transaction into a single envelope
   * (see `mergeSignatures` in the offline-signing docs). Throws
   * `SignedTransactionMismatchError` if any copy is a different transaction.
   */
  mergeSignatures(signedXdrs: string[]): string {
    return mergeSignedTransactions(signedXdrs, this.networkPassphrase);
  }

  /**
   * Signs the Soroban auth entries addressed to `signer` in a prepared
   * transaction, for the case where `source` is a different account (see
   * `PreparedTransaction.authSigners`). Returns the updated envelope and its
   * new hash, so use the returned `hash` as `expectedHash` afterwards. Must run
   * before the envelope is signed. `validUntilLedger` is the auth entry's
   * expiration ledger (pass the prepared `authValidUntilLedger`); it defaults to
   * about a day from the current ledger.
   */
  async signAuthEntries(
    preparedXdr: string,
    signer: Keypair,
    options: { validUntilLedger?: number } = {},
  ): Promise<{ xdr: string; hash: string; signedEntries: number }> {
    const validUntilLedger = options.validUntilLedger
      ?? (await this.rpc.getLatestLedger()).sequence + OFFLINE_PREPARED_TX_TTL_LEDGERS;
    return signAuthEntriesInEnvelope(preparedXdr, signer, validUntilLedger, this.networkPassphrase);
  }

  /** Bounds a simulated transaction to a ledger window and describes it. */
  private async finishPrepare(
    assembled: AssembledTransaction<unknown>,
    source: string,
    validForLedgers: number,
    authValidForLedgers: number,
    label: string,
  ): Promise<PreparedTransaction> {
    if (assembled.isReadCall) {
      throw new Error(`${label} was simulated as a read call; no transaction was assembled.`);
    }
    const latest = await this.rpc.getLatestLedger();
    const validUntilLedger = latest.sequence + validForLedgers;
    const bounded = setLedgerBounds(assembled.toXDR(), validUntilLedger);
    const tx = TransactionBuilder.fromXDR(bounded, this.networkPassphrase) as Transaction;
    return {
      xdr: bounded,
      hash: tx.hash().toString("hex"),
      validUntilLedger,
      source,
      authSigners: authSignersOf(tx).filter((address) => address !== source),
      authValidUntilLedger: latest.sequence + authValidForLedgers,
    };
  }

  /**
   * Submits a transaction that was prepared here and signed elsewhere, and
   * waits for it to land.
   *
   * Before sending it checks, in order: that the envelope is signed, that its
   * hash matches `expectedHash` (when given), that its ledger window has not
   * passed (`PreparedTransactionExpiredError`), and that the source account's
   * sequence number has not moved (`StaleSequenceError`). With a
   * `feeBumpSigner` it first confirms the transaction only touches this
   * escrow contract (`assertSponsorable`), then wraps it in a capped fee-bump.
   * Returns the new escrow id when the transaction was a `create_escrow`.
   */
  async submitSigned(signedXdr: string, options: SubmitSignedOptions = {}): Promise<SubmitSignedResult> {
    await this.ensureNetworkVerified();
    const parsed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    if (!(parsed instanceof Transaction)) {
      throw new TypeError("submitSigned expects a regular signed transaction, not an already fee-bumped envelope.");
    }
    const hash = parsed.hash().toString("hex");
    if (options.expectedHash !== undefined && options.expectedHash.toLowerCase() !== hash) {
      throw new SignedTransactionMismatchError(options.expectedHash.toLowerCase(), hash);
    }
    if (parsed.signatures.length === 0) throw new UnsignedTransactionError();

    const validUntilLedger = ledgerBoundsMax(parsed);
    if (validUntilLedger !== undefined) {
      const latest = await this.rpc.getLatestLedger();
      if (latest.sequence > validUntilLedger) {
        throw new PreparedTransactionExpiredError(validUntilLedger, latest.sequence);
      }
    }

    const source = parsed.source;
    const expectedSequence = BigInt(parsed.sequence) - 1n;
    const onChainSequence = BigInt((await this.rpc.getAccount(source)).sequenceNumber());
    if (onChainSequence !== expectedSequence) {
      throw new StaleSequenceError(source, expectedSequence, onChainSequence);
    }

    let toSend: Transaction | FeeBumpTransaction = parsed;
    if (options.feeBumpSigner) {
      this.assertSponsorable(signedXdr);
      // A fee-bump's base fee must be at least the inner transaction's fee
      // rate, and a Soroban transaction's fee includes its resource fee, so
      // the network-minimum default would be rejected. Default to the inner
      // rate (rounded up); `maxFee` still caps what the sponsor can pay.
      const innerRate = (BigInt(parsed.fee) + BigInt(parsed.operations.length) - 1n) / BigInt(parsed.operations.length);
      const bumped = this.feeBump(signedXdr, options.feeBumpSigner, {
        maxFee: options.maxFee ?? DEFAULT_SUBMIT_MAX_FEE,
        baseFee: options.baseFee ?? innerRate,
      });
      toSend = TransactionBuilder.fromXDR(bumped.xdr, this.networkPassphrase) as FeeBumpTransaction;
      // `feeBump` caps baseFee x (ops + 1); stellar-base then adds the Soroban
      // resource fee on top. Hold the sponsor to the fee actually charged.
      const maxFee = options.maxFee ?? DEFAULT_SUBMIT_MAX_FEE;
      const charged = BigInt(toSend.fee);
      if (charged > maxFee) throw new MaxFeeExceededError(charged, maxFee);
    }

    const sent = await this.rpc.sendTransaction(toSend);
    if (sent.status === "ERROR") {
      const reason = sendErrorName(sent);
      if (reason === "txTooLate") {
        throw new PreparedTransactionExpiredError(validUntilLedger ?? 0, (await this.rpc.getLatestLedger()).sequence);
      }
      if (reason === "txBadSeq") {
        throw new StaleSequenceError(source, expectedSequence, onChainSequence);
      }
      throw new Error(`Transaction ${sent.hash} was rejected${reason ? `: ${reason}` : ""}.`);
    }
    if (sent.status === "TRY_AGAIN_LATER") {
      throw new Error(`The RPC node asked to try again later; transaction ${sent.hash} was not accepted.`);
    }

    const final = await this.rpc.pollTransaction(sent.hash, { attempts: options.pollAttempts ?? 30 });
    if (final.status === Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction ${sent.hash} failed on-chain.`);
    }
    if (final.status !== Api.GetTransactionStatus.SUCCESS) {
      throw new Error(
        `Transaction ${sent.hash} was not confirmed after ${options.pollAttempts ?? 30} polls; ` +
          `it may still land, so check its hash before retrying.`
      );
    }

    const returnValue = final.returnValue;
    const escrowId = returnValue && returnValue.switch().name === "scvU64"
      ? BigInt(scValToNative(returnValue) as bigint | number | string)
      : undefined;
    return {
      txHash: sent.hash,
      innerTxHash: hash,
      ...(escrowId !== undefined ? { escrowId } : {}),
    };
  }

  private async authorizeSettlement(
    settlement: "release" | "refund",
    params: RelayedAuthorizationParams,
  ): Promise<RelayedAuthorization> {
    await this.ensureNetworkVerified();
    const client = this.contractClient(params.relayer);
    const tx = settlement === "release"
      ? await client.release({ escrow_id: params.escrowId, caller: params.releaser.publicKey() })
      : await client.refund({ escrow_id: params.escrowId, caller: params.releaser.publicKey() });

    if (tx.isReadCall) {
      throw new Error(`${settlement} was simulated as a read call; no transaction was assembled.`);
    }

    const latestLedger = await this.rpc.getLatestLedger();
    const expiresAtLedger = latestLedger.sequence + RELAYED_AUTH_TTL_LEDGERS;

    // The relayer is the transaction source, so the envelope signature covers
    // its own auth; only the releaser's separate auth entry needs signing here.
    if (tx.needsNonInvokerSigningBy().includes(params.releaser.publicKey())) {
      await tx.signAuthEntries({
        signAuthEntry: params.releaser,
        expiration: expiresAtLedger,
      });
    }

    return { transaction: tx.toJSON(), expiresAtLedger };
  }

  /**
   * Signs a relayed authorization's envelope as `relayer` and submits it.
   * Rejects an authorization for a different settlement method than the one
   * named, so a `release` authorization cannot be smuggled through `refund`.
   * Returns the submitted transaction's hash.
   */
  async submitRelayed(
    settlement: "release" | "refund",
    authorization: RelayedAuthorization,
    relayer: EscrowSigner,
  ): Promise<{ txHash: string }> {
    let method: unknown;
    try {
      method = (JSON.parse(authorization.transaction) as { method?: unknown }).method;
    } catch (error) {
      throw new TypeError(`Relayed authorization is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (method !== settlement) {
      throw new TypeError(
        `Relayed authorization is for ${String(method) || "an unknown method"}, not ${settlement}.`
      );
    }

    await this.ensureNetworkVerified();
    const client = this.contractClient(relayer);
    const tx = client.txFromJSON<Result<void>>(authorization.transaction);
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Estimates what a contract call will cost, in stroops, by simulating it
   * against the configured RPC. Nothing is signed or submitted.
   *
   * The resource fee carries a 20% buffer over the simulated minimum (rounded
   * up), because simulation can be a strop or two short of the real charge;
   * `minResourceFee` exposes the raw figure for callers that want their own
   * margin. Sponsors should treat `total` as the expected cost, not a promise
   * — fee-bump it with `maxFee` set to the most they are willing to pay.
   */
  async estimate(call: EstimateCallParams): Promise<FeeEstimate> {
    await this.ensureNetworkVerified();
    const contractId = call.contractId ?? this.contractId;
    const account = await this.rpc.getAccount(signerAddress(call.source));
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: call.method,
          args: call.args ?? [],
        }),
      )
      .setTimeout(30)
      .build();

    const estimateAttributes = isInstrumentationEnabled(this.instrumentation)
      ? { "contract.id": contractId, "contract.function": call.method }
      : EMPTY_SPAN_ATTRIBUTES;
    const simulation = await tracePhase(
      this.instrumentation,
      "simulate",
      estimateAttributes,
      () => this.rpc.simulateTransaction(transaction),
    );
    if (Api.isSimulationError(simulation)) {
      throw new Error(`Simulation failed for ${call.method}: ${simulation.error}`);
    }
    return computeFeeEstimate({
      minResourceFee: BigInt(simulation.minResourceFee),
      inclusionFee: BigInt(BASE_FEE) * BigInt(transaction.operations.length),
    });
  }

  /**
   * Wraps an already-signed transaction in a fee-bump paid by `sponsorSigner`.
   *
   * The wrapper's fee is `baseFee × (inner operations + 1)`, charged by the
   * fee-bump envelope; the cap is checked before anything is built, so a spike
   * either fits `maxFee` or throws `MaxFeeExceededError` — it is never silently
   * exceeded. Run `guardSponsorship` first when the inner transaction comes
   * from someone else.
   */
  feeBump(signedXdr: string, sponsorSigner: Keypair, options: FeeBumpOptions): FeeBumpResult {
    const inner = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    if (!(inner instanceof Transaction)) {
      throw new TypeError("feeBump expects a regular signed transaction, not an already fee-bumped envelope.");
    }
    const baseFee = options.baseFee ?? BigInt(BASE_FEE);
    if (baseFee < 1n) throw new RangeError("baseFee must be at least 1 strop.");
    const maxFee = BigInt(options.maxFee);
    if (maxFee < 0n) throw new RangeError("maxFee must not be negative.");

    // A fee-bump envelope carries one operation (the wrapped inner tx), so it
    // costs baseFee × (inner ops + 1). The inner fee itself is refunded.
    const fee = baseFee * BigInt(inner.operations.length + 1);
    if (fee > maxFee) throw new MaxFeeExceededError(fee, maxFee);

    const bump = TransactionBuilder.buildFeeBumpTransaction(
      sponsorSigner,
      baseFee.toString(),
      inner,
      this.networkPassphrase,
    );
    bump.sign(sponsorSigner);
    return { xdr: bump.toXDR(), fee, innerTxHash: inner.hash().toString("hex") };
  }

  /**
   * Verifies that a transaction only touches this escrow contract before a
   * sponsor pays for it. Every operation is inspected, and so is every
   * contract-address auth entry — an invocation can otherwise smuggle in a
   * transfer authorized against another contract. Account-address auth entries
   * (the payer/releaser signatures) are expected and allowed.
   */
  guardSponsorship(signedXdr: string): GuardResult {
    const reasons: string[] = [];
    const invokedContracts = new Set<string>();

    let inner: Transaction | FeeBumpTransaction;
    try {
      inner = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    } catch (error) {
      return {
        ok: false,
        reasons: [`could not decode transaction envelope: ${error instanceof Error ? error.message : String(error)}`],
        invokedContracts: [],
      };
    }
    // A fee-bump envelope is not sponsorable again; unwrap it so the inner
    // transaction is what gets judged (its hash is what executes).
    const transaction = inner instanceof FeeBumpTransaction ? inner.innerTransaction : inner;
    if (inner instanceof FeeBumpTransaction) {
      reasons.push("envelope is already a fee-bump transaction");
    }

    for (const operation of transaction.operations) {
      if (operation.type !== "invokeHostFunction") {
        reasons.push(`operation type "${operation.type}" is not a contract invocation`);
        continue;
      }
      const fn = operation.func;
      if (fn.switch().name !== "hostFunctionTypeInvokeContract") {
        reasons.push(`host function "${fn.switch().name}" is not a contract invocation`);
        continue;
      }
      const contractId = contractAddressOf(fn.invokeContract().contractAddress());
      if (!contractId) {
        reasons.push("contract invocation has no contract address");
        continue;
      }
      invokedContracts.add(contractId);
      if (contractId !== this.contractId) {
        reasons.push(`operation invokes foreign contract ${contractId}`);
      }

      for (const entry of operation.auth ?? []) {
        const credentials = entry.credentials();
        if (credentials.switch().name !== "sorobanCredentialsAddress") continue;
        const authContract = contractAddressOf(credentials.address().address());
        if (authContract && authContract !== this.contractId) {
          reasons.push(`auth entry targets foreign contract ${authContract}`);
        }
      }
    }

    if (transaction.operations.length === 0) reasons.push("transaction has no operations");
    return { ok: reasons.length === 0, reasons, invokedContracts: [...invokedContracts] };
  }

  /** Throws `SponsorshipGuardError` when `guardSponsorship` would reject. */
  assertSponsorable(signedXdr: string): void {
    const result = this.guardSponsorship(signedXdr);
    if (!result.ok) throw new SponsorshipGuardError(result.reasons);
  }

  /**
   * Releases an M-of-N escrow to its payee with at least `threshold`
   * distinct releaser approvals (docs/adr/0007). Each supplied keypair signs
   * the contract auth entry for this exact call; the first also pays the fee.
   * Returns the transaction's hash.
   */
  async releaseWithApprovals(params: SettlementApprovalsParams): Promise<{ txHash: string }> {
    return this.settleWithApprovals("release", params);
  }

  /**
   * Refunds an M-of-N escrow back to its payer with at least `threshold`
   * distinct releaser approvals (docs/adr/0007). The `refundAfter` timeout
   * path (`refund`) stays open to anyone and needs no approvals. Returns the
   * transaction's hash.
   */
  async refundWithApprovals(params: SettlementApprovalsParams): Promise<{ txHash: string }> {
    return this.settleWithApprovals("refund", params);
  }

  private async settleWithApprovals(
    settlement: "release" | "refund",
    params: SettlementApprovalsParams
  ): Promise<{ txHash: string }> {
    if (params.approvers.length === 0) {
      throw new Error("approvers must contain at least one releaser keypair");
    }
    const [invoker, ...additionalSigners] = params.approvers;
    const approverAddresses = params.approvers.map(signerAddress);
    if (new Set(approverAddresses).size !== approverAddresses.length) {
      throw new Error("approvers must not repeat a releaser keypair");
    }

    const client = this.contractClient(invoker);
    const sent = await this.invoke(
      settlement === "release" ? "release_with_approvals" : "refund_with_approvals",
      params.escrowId,
      () =>
        settlement === "release"
          ? client.release_with_approvals({ escrow_id: params.escrowId, approvers: approverAddresses })
          : client.refund_with_approvals({ escrow_id: params.escrowId, approvers: approverAddresses }),
      {
        address: signerAddress(invoker),
        beforeSign: async (tx) => {
          // Every non-invoker approver signs the contract auth entry. This is
          // part of the "sign" phase, so one span covers all signatures.
          for (const signer of additionalSigners) {
            await tx.signAuthEntries({ signAuthEntry: signer });
          }
        },
      },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /** Reads one page of lifecycle events emitted by this escrow contract. */
  async getEvents(params: GetEventsParams): Promise<GetEventsResult> {
    if (params.cursor !== undefined && params.fromLedger !== undefined) {
      throw new TypeError("Provide either cursor or fromLedger, not both.");
    }
    if (params.fromLedger !== undefined && (!Number.isSafeInteger(params.fromLedger) || params.fromLedger < 1)) {
      throw new RangeError("fromLedger must be a positive safe integer.");
    }
    // Validate the arguments before any network work, so a bad call fails
    // fast and never depends on RPC availability.
    await this.ensureNetworkVerified();
    const filter: Api.EventFilter = { type: "contract", contractIds: [this.contractId] };
    const request: Api.GetEventsRequest = "cursor" in params && params.cursor !== undefined
      ? { cursor: params.cursor, filters: [filter], limit: 100 }
      : { startLedger: params.fromLedger, filters: [filter], limit: 100 };
    let response: Api.GetEventsResponse;
    try {
      response = await this.rpc.getEvents(request);
    } catch (error) {
      if (isRetentionError(error)) throw new EventCursorExpiredError(error instanceof Error ? error.message : undefined);
      throw error;
    }
    const allowed = params.types ? new Set(params.types) : undefined;
    const events: EscrowEvent[] = [];
    for (const raw of response.events) {
      if (raw.type !== "contract" || raw.contractId?.toString() !== this.contractId) continue;
      const nativeTopics = raw.topic.map(safeScValToNative);
      const eventName = nativeTopics.find((v) => v === "created" || v === "released" || v === "refunded" || v === "cancelled") as EscrowEventType | undefined;
      const unknownName = nativeTopics.find((v) => typeof v === "string") as string | undefined;
      const type = eventName;
      if (type && allowed && !allowed.has(type)) continue;
      const rawId = nativeTopics.find((v): v is bigint | number => typeof v === "bigint" || (typeof v === "number" && Number.isSafeInteger(v)));
      const escrowId = rawId === undefined ? undefined : BigInt(rawId);
      if (params.escrowId !== undefined && escrowId !== params.escrowId) continue;
      const base = { ledger: raw.ledger, cursor: raw.id, transactionHash: raw.txHash, data: safeScValToNative(raw.value) };
      if (type && escrowId !== undefined) events.push({ ...base, type, escrowId });
      else events.push({ ...base, type: "unknown", ...(unknownName ? { eventName: unknownName } : {}), ...(escrowId !== undefined ? { escrowId } : {}), topics: nativeTopics });
    }
    return { events, nextCursor: response.cursor };
  }

  /**
   * Moves a `Funded` single-releaser escrow's `refund_after` later with the
   * payer's and releaser's consent (issue #41, docs/adr/0004). The current
   * deadline must exist and not have passed, and `newDeadline` must be
   * strictly later. The payer is the transaction source; the releaser signs
   * its own auth entry unless it is the same address. Returns the
   * transaction's hash.
   */
  async extendRefundAfter(params: ExtendRefundAfterParams): Promise<{ txHash: string }> {
    const payer = signerAddress(params.payer);
    const releaser = signerAddress(params.releaser);
    const client = this.contractClient(params.payer);
    const sent = await this.invoke(
      "extend_refund_after",
      params.escrowId,
      () => client.extend_refund_after({ escrow_id: params.escrowId, new_deadline: params.newDeadline }),
      {
        address: payer,
        beforeSign: async (tx) => {
          const pending = tx.needsNonInvokerSigningBy();
          const unknown = pending.filter((address) => address !== releaser);
          if (unknown.length > 0) {
            throw new Error(`extend_refund_after needs authorization from ${unknown.join(", ")}, which is neither the payer nor the releaser.`);
          }
          if (pending.includes(releaser)) {
            await tx.signAuthEntries({ signAuthEntry: params.releaser });
          }
        },
      },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Polls event pages in order. Each handler call is awaited before the next
   * event is delivered, so slow handlers apply back-pressure without drops.
   * The returned stop function ends polling; persist the last delivered
   * event cursor (or the cursor from getEvents) to resume after restart.
   */
  subscribe(handler: (event: EscrowEvent) => void | Promise<void>, options: SubscribeOptions = {}): () => void {
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) throw new RangeError("pollIntervalMs must be at least 1.");
    let stopped = false;
    let cursor = options.cursor;
    const poll = async (): Promise<void> => {
      while (!stopped) {
        try {
          const page = cursor !== undefined
            ? await this.getEvents({ cursor, types: options.types, escrowId: options.escrowId })
            : await this.getEvents({ fromLedger: (await this.rpc.getLatestLedger()).sequence, types: options.types, escrowId: options.escrowId });
          for (const event of page.events) {
            if (stopped) break;
            await handler(event);
            cursor = event.cursor;
          }
          // Advance across pages with no matching events, including filtered events.
          cursor = page.nextCursor;
        } catch (error) {
          if (!stopped) {
            if (options.onError) options.onError(error);
            else queueMicrotask(() => { throw error; });
          }
          return;
        }
        if (!stopped) await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    };
    void poll();
    return () => { stopped = true; };
  }
}

export {
  FakeClock,
  FakeEscrowClient,
  FakeEscrowError,
  type FakeEscrowErrorCode,
  type FakeFailure,
  type FakeFailureKind,
  type FakeOperation,
} from "./testing.js";
