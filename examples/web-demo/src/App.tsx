import { useMemo, useState } from "react";
import { useEscrow, useEscrowActions, useEscrowTimeline, type EscrowSigner } from "@docforum/escrow-react";
import { connectWallet } from "./wallet.js";

const configured = Boolean(import.meta.env.VITE_ESCROW_CONTRACT_ID);

export function App() {
  const [escrowIdText, setEscrowIdText] = useState("0");
  const [signer, setSigner] = useState<EscrowSigner>();
  const [walletStatus, setWalletStatus] = useState("Wallet not connected");
  const [lastAction, setLastAction] = useState<string>();

  const escrowId = useMemo(() => {
    try {
      return BigInt(escrowIdText);
    } catch {
      return 0n;
    }
  }, [escrowIdText]);

  const { data: escrow, isPending, error, refetch } = useEscrow(escrowId, {
    enabled: configured,
  });
  const timeline = useEscrowTimeline(escrow);
  const actions = useEscrowActions(signer);

  async function onConnect() {
    try {
      const connected = await connectWallet();
      setSigner(connected);
      setWalletStatus(`Connected as ${connected.address}`);
    } catch (cause) {
      setWalletStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function settle(kind: "release" | "refund") {
    setLastAction(undefined);
    try {
      const result = kind === "release"
        ? await actions.release(escrowId)
        : await actions.refund(escrowId);
      setLastAction(result.status === "rejected" ? "Rejected in wallet" : `Sent — ${result.data.txHash}`);
    } catch (cause) {
      setLastAction(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "2rem auto", lineHeight: 1.5 }}>
      <h1>docforum-escrow browser demo</h1>
      <p>
        Testnet only. {configured
          ? "Reads and settles a real escrow through the SDK and React hooks."
          : "Set VITE_ESCROW_CONTRACT_ID to a testnet deployment first."}
      </p>

      <section>
        <h2>Wallet</h2>
        <button onClick={onConnect}>Connect wallet</button>
        <p>{walletStatus}</p>
      </section>

      <section>
        <h2>Escrow</h2>
        <label>
          Escrow id <input value={escrowIdText} onChange={(event) => setEscrowIdText(event.target.value)} />
        </label>
        <button onClick={() => void refetch()}>Refresh</button>

        {isPending && <p>Loading…</p>}
        {error && <p role="alert">{error.message}</p>}
        {escrow && (
          <>
            <p>Status: {escrow.status}</p>
            <p>Payee: {escrow.payee}</p>
            <p>Amount (stroops): {escrow.amount.toString()}</p>
            <p>
              Refund deadline: {timeline.hasDeadline
                ? timeline.expired
                  ? "passed (anyone may refund, back to the payer)"
                  : `${Math.ceil((timeline.remainingMs ?? 0) / 1000)}s remaining`
                : "none"}
            </p>

            <button disabled={!signer || escrow.status !== "Funded"} onClick={() => void settle("release")}>
              Release
            </button>
            <button disabled={!signer || escrow.status !== "Funded"} onClick={() => void settle("refund")}>
              Refund
            </button>
            {actions.isPending && <p>Waiting for the wallet…</p>}
            {lastAction && <p>{lastAction}</p>}
          </>
        )}
      </section>
    </main>
  );
}
