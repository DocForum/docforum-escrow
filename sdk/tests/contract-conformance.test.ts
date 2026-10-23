import { Keypair } from "@stellar/stellar-sdk";
import { EscrowClient } from "../src/index.js";
import { registerEscrowConformanceSuite } from "./conformance.js";

// Point these variables at a locally deployed Soroban contract and a funded
// test token/account set to run the same scenarios as the in-memory fake.
const config = {
  rpcUrl: process.env.DOCFORUM_LOCAL_RPC_URL,
  networkPassphrase: process.env.DOCFORUM_LOCAL_NETWORK_PASSPHRASE,
  contractId: process.env.DOCFORUM_LOCAL_CONTRACT_ID,
  payerSecret: process.env.DOCFORUM_LOCAL_PAYER_SECRET,
  releaserSecret: process.env.DOCFORUM_LOCAL_RELEASER_SECRET,
  strangerSecret: process.env.DOCFORUM_LOCAL_STRANGER_SECRET,
  payee: process.env.DOCFORUM_LOCAL_PAYEE,
  token: process.env.DOCFORUM_LOCAL_TOKEN_ID,
};
const missing = Object.values(config).some((value) => !value);

registerEscrowConformanceSuite(
  "Local Soroban contract conformance",
  () => {
    if (missing) throw new Error("Local Soroban conformance environment is not configured");
    const payer = Keypair.fromSecret(config.payerSecret!);
    const releaser = Keypair.fromSecret(config.releaserSecret!);
    const stranger = Keypair.fromSecret(config.strangerSecret!);
    return {
      client: new EscrowClient({
        contractId: config.contractId!,
        rpcUrl: config.rpcUrl,
        networkPassphrase: config.networkPassphrase,
      }),
      payer,
      payee: config.payee!,
      token: config.token!,
      releaser,
      stranger,
      amount: 100n,
      conditionRef: `local-conformance-${Date.now()}`,
    };
  },
  missing,
);
