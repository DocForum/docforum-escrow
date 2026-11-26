// Releaser custom account client (Phase E6, issue #358).
//
// The releaser custom account (`contracts/releaser-account`) is an M-of-N
// Ed25519 account that authorises `release`/`refund`/settle_many on an escrow.
// Its management operations are gated on a digest that covers the account
// address, a monotonic nonce and the management action. This module
// reproduces that digest client-side so integrators can build and sign
// management and settlement credentials without reverse-engineering
// `management_digest` from Rust.
//
// The digest matches `ReleaserAccount::management_digest` exactly:
//   SHA-256( XDR-encode( Vec<ScVal> [
//     ScSymbol("DOCESCROW"),
//     ScAddress::Contract(contractId),
//     ScU64(nonce),
//     ScVal::Vec([ ScSymbol(variantName), ...fieldScVals ]),   // ManagementAction
//   ] ))
//
// The ManagementAction encoding mirrors the contract's generated `IntoVal`:
//   SetThreshold(n)    -> [ "SetThreshold", n(u32) ]
//   AddSigner(key)     -> [ "AddSigner", key(bytes) ]
//   RemoveSigner(key)  -> [ "RemoveSigner", key(bytes) ]
//   SetPolicy(a, w)    -> [ "SetPolicy", a(u32), w(u32) ]
//
// `SignerSignature` (public_key + signature) encodes as
//   ScVal::Vec([ ScBytes(publicKey), ScBytes(signature) ])

import {
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import { Server as RpcServer } from "@stellar/stellar-sdk/rpc";

/** Hex-encoded ed25519 public key (32 bytes). */
export type PublicKey = string;
/** Hex-encoded ed25519 signature (64 bytes). */
export type Signature = string;

/** Mirrors the contract's `ManagementAction`. */
export type ReleaserAccountAction =
  | { kind: "AddSigner"; publicKey: PublicKey }
  | { kind: "RemoveSigner"; publicKey: PublicKey }
  | { kind: "SetThreshold"; threshold: number }
  | { kind: "SetPolicy"; maxOperationsPerWindow: number; windowLedgers: number };

/** One management signature, mirroring the contract's `SignerSignature`. */
export interface SignerSignature {
  publicKey: PublicKey;
  signature: Signature;
}

/** Configuration for {@link ReleaserAccountClient}. */
export interface ReleaserAccountClientConfig {
  /** On-chain address of the deployed releaser account contract (C…). */
  contractAddress: string;
  /** Soroban RPC URL. Defaults to testnet. */
  rpcUrl?: string;
  /** Network passphrase. Defaults to testnet. */
  networkPassphrase?: string;
  /** Signer used as transaction source / fee payer for `manage`. */
  signer?: Keypair;
}

/** Namespace for management payload computation. */
export namespace ManagementPayload {
  const DOMAIN = "DOCESCROW";

  function toScValBytes(scVal: xdr.ScVal): Buffer {
    // Canonical XDR bytes of the ScVal, as the contract hashes them.
    return scVal.toXDR();
  }

  /** Encode a `ManagementAction` as the ScVal the contract expects. */
  export function encodeAction(action: ReleaserAccountAction): xdr.ScVal {
    const fields: xdr.ScVal[] = [xdr.ScVal.scvSymbol(action.kind)];
    switch (action.kind) {
      case "AddSigner":
      case "RemoveSigner":
        fields.push(xdr.ScVal.scvBytes(Buffer.from(action.publicKey, "hex")));
        break;
      case "SetThreshold":
        fields.push(xdr.ScVal.scvU32(action.threshold));
        break;
      case "SetPolicy":
        fields.push(
          xdr.ScVal.scvU32(action.maxOperationsPerWindow),
          xdr.ScVal.scvU32(action.windowLedgers),
        );
        break;
    }
    return xdr.ScVal.scvVec(fields);
  }

  /** Encode a `SignerSignature` as the ScVal the contract expects. */
  export function encodeSignature(sig: SignerSignature): xdr.ScVal {
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvBytes(Buffer.from(sig.publicKey, "hex")),
      xdr.ScVal.scvBytes(Buffer.from(sig.signature, "hex")),
    ]);
  }

  /**
   * Compute the exact management digest the releaser account contract expects
   * for `management_payload(action)` / `manage(action, signatures)`.
   *
   * The `nonce` is the account's current management nonce: read it on-chain
   * (`management_nonce()`) and never cache it, since it advances on every
   * management operation and prevents replay.
   */
  export function compute(
    contractAddress: string,
    action: ReleaserAccountAction,
    nonce: number | bigint,
  ): Buffer {
    const address = Address.fromString(contractAddress);
    if (address.type !== "contract") {
      throw new Error(`Not a contract address: ${contractAddress}`);
    }
    // `Address.toScVal()` yields the ScAddress ScVal for the contract id, which
    // is exactly the `current_contract_address()` value the contract hashes.
    const addressScVal = address.toScVal();
    const payload = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(DOMAIN),
      addressScVal,
      nativeToScVal(BigInt(nonce)),
      encodeAction(action),
    ]);
    return hash(toScValBytes(payload));
  }
}

/**
 * Sign a management payload with each keypair, producing the
 * `Vec<SignerSignature>` the contract's `manage` expects.
 */
export function signManagement(
  keypairs: Keypair[],
  payload: Buffer,
): SignerSignature[] {
  return keypairs.map((kp) => ({
    publicKey: StrKey.decodeEd25519PublicKey(kp.publicKey()).toString("hex"),
    signature: kp.sign(payload).toString("hex"),
  }));
}

/**
 * Build the `Vec<SignerSignature>` credential for a `release`/`refund` auth
 * entry: each keypair signs the settlement payload, distinct keys only.
 */
export function buildSettleSignatures(
  keypairs: Keypair[],
  payload: Buffer,
): SignerSignature[] {
  return signManagement(keypairs, payload);
}

/** Client for deploying and managing a releaser custom account. */
export class ReleaserAccountClient {
  private readonly contractAddress: string;
  private readonly networkPassphrase: string;
  private readonly rpc: RpcServer | undefined;
  private readonly signer: Keypair | undefined;

  constructor(config: ReleaserAccountClientConfig) {
    this.contractAddress = config.contractAddress;
    this.networkPassphrase = config.networkPassphrase ?? Networks.TESTNET;
    this.signer = config.signer;
    this.rpc = config.rpcUrl ? new RpcServer(config.rpcUrl) : undefined;
  }

  /** The management digest for `action` at the given `nonce`. */
  managementPayload(
    action: ReleaserAccountAction,
    nonce: number | bigint,
  ): Buffer {
    return ManagementPayload.compute(this.contractAddress, action, nonce);
  }

  /** Sign `payload` with `keypairs`, producing management signatures. */
  signManagement(keypairs: Keypair[], payload: Buffer): SignerSignature[] {
    return signManagement(keypairs, payload);
  }

  /** Build settle (release/refund) auth-entry signatures from `keypairs`. */
  buildSettleSignatures(
    keypairs: Keypair[],
    payload: Buffer,
  ): SignerSignature[] {
    return buildSettleSignatures(keypairs, payload);
  }

  /**
   * Execute `manage(action, signatures)` on the releaser account contract.
   * `signatures` must be `M` distinct valid signatures over the management
   * digest for `action` at the account's current nonce (read `management_nonce`
   * first, never cache it). The configured signer pays the transaction fee.
   */
  async manage(
    action: ReleaserAccountAction,
    signatures: SignerSignature[],
  ): Promise<{ txHash: string }> {
    if (!this.rpc || !this.signer) {
      throw new Error("ReleaserAccountClient requires rpcUrl and signer to manage");
    }
    const actionScVal = ManagementPayload.encodeAction(action);
    const signaturesScVal = xdr.ScVal.scvVec(
      signatures.map(ManagementPayload.encodeSignature),
    );
    const source = await this.rpc.getAccount(this.signer.publicKey());
    const tx = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.contractAddress,
          function: "manage",
          args: [actionScVal, signaturesScVal],
        }),
      )
      .setTimeout(300)
      .build();
    tx.sign(this.signer);
    const sent = await this.rpc.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(
        `manage submit failed: ${JSON.stringify(sent.errorResult)}`,
      );
    }
    return { txHash: sent.hash };
  }
}
