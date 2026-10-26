import { EscrowClient, Keypair } from "../../src/index.ts";

const signer = Keypair.random();
const client = new EscrowClient({ contractId: signer.publicKey(), rpcUrl: "https://rpc.example.test" });
document.querySelector("#result")!.textContent = JSON.stringify({
  keypairCreated: signer.publicKey().startsWith("G"),
  clientCreated: client instanceof EscrowClient,
});
