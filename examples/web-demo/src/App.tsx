import { useMemo, useState, type FormEvent } from "react";
import {
  useEscrow,
  useEscrowActions,
  useEscrowTimeline,
  type Escrow,
  type EscrowSigner,
} from "@docforum/escrow-react";
import { formatAmount, parseAmount, signerAddress } from "@docforum/escrow-sdk";
import { connectWallet } from "./wallet.js";

const configured = Boolean(import.meta.env.VITE_ESCROW_CONTRACT_ID);

// The demo treats every amount as a 7-decimal token, which is what the native
// XLM Stellar Asset Contract uses on testnet. Change both when demoing another
// token.
const XLM_DECIMALS = 7;
const TESTNET_XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const code = { fontFamily: "ui-monospace, monospace", overflowWrap: "anywhere" } as const;
const muted = { color: "#555" } as const;
const row = { display: "grid", gridTemplateColumns: "11rem 1fr", gap: "0.25rem 1rem", margin: 0 } as const;
const cell = { margin: 0 } as const;
const notice = {
  borderLeft: "4px solid #b45309",
  background: "#fffbeb",
  padding: "0.5rem 0.75rem",
  margin: "0.75rem 0",
} as const;

function shortTime(unixSeconds: bigint): string {
  // Unix seconds fit in a JS number for any realistic deadline.
  return new Date(Number(unixSeconds) * 1_000).toLocaleString();
}

function Address({ value, viewer }: { value: string; viewer?: string }) {
  return (
    <code style={code}>
      {value}
      {viewer === value ? " (you)" : ""}
    </code>
  );
}

/**
 * Everything a payee should read before trusting a `Funded` escrow, mirroring
 * threat model T8 (releasers/threshold, refundAfter, refundTo) plus the fee
 * from ADR 0010 and the remaining `Escrow` fields.
 */
function PayeeReview({ escrow, viewer }: { escrow: Escrow; viewer?: string }) {
  const payerIsReleaser = escrow.releasers.includes(escrow.payer);
  const refundsElsewhere = escrow.refundTo !== escrow.payer;
  const fee =
    escrow.feeBps !== undefined
      ? `${escrow.feeBps} bps (${(escrow.feeBps / 100).toFixed(2)}%) to ${escrow.feeRecipient ?? "—"}`
      : "None — the payee receives the full amount";

  return (
    <section aria-label="Payee review" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "0.75rem 1rem" }}>
      <h3 style={{ marginTop: 0 }}>Payee review — read this before accepting</h3>
      <p style={muted}>
        A <code>Funded</code> status only means the funds are locked under the releasers&apos; control. It does not
        mean the funds are committed to the payee (threat model T8).
      </p>

      <dl style={row}>
        <dt>Status</dt>
        <dd style={cell}>{escrow.status}</dd>

        <dt>Payer</dt>
        <dd style={cell}>
          <Address value={escrow.payer} viewer={viewer} />
        </dd>

        <dt>Payee (release destination)</dt>
        <dd style={cell}>
          <Address value={escrow.payee} viewer={viewer} />
        </dd>

        <dt>Amount</dt>
        <dd style={cell}>
          {formatAmount(escrow.amount, XLM_DECIMALS)} ({escrow.amount.toString()} stroops)
        </dd>

        <dt>Token</dt>
        <dd style={cell}>
          <Address value={escrow.token} />
        </dd>

        <dt>Condition ref (public)</dt>
        <dd style={cell}>
          <code style={code}>{escrow.conditionRef || "—"}</code>
        </dd>

        <dt>Releasers / threshold</dt>
        <dd style={cell}>
          {escrow.threshold} of {escrow.releasers.length} must approve a settlement
        </dd>

        <dt>Releaser addresses</dt>
        <dd style={cell}>
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {escrow.releasers.map((address) => (
              <li key={address}>
                <Address value={address} viewer={viewer} />
              </li>
            ))}
          </ul>
        </dd>

        <dt>Refund after (deadline)</dt>
        <dd style={cell}>
          {escrow.refundAfter === undefined
            ? "No deadline — refunds stay releaser-only"
            : `${shortTime(escrow.refundAfter)} (unix ${escrow.refundAfter.toString()})`}
        </dd>

        <dt>Refund destination</dt>
        <dd style={cell}>
          <Address value={escrow.refundTo} viewer={viewer} />
          {refundsElsewhere ? " — refunds do not go back to the payer" : " (the payer)"}
        </dd>

        <dt>Release not before</dt>
        <dd style={cell}>
          {escrow.releaseNotBefore === undefined
            ? "None — release is not time-locked"
            : shortTime(escrow.releaseNotBefore)}
        </dd>

        <dt>Fee</dt>
        <dd style={cell}>{fee}</dd>

        <dt>Payee callback</dt>
        <dd style={cell}>{escrow.notifyPayee ? "Yes — release calls the payee's contract hook" : "No"}</dd>

        <dt>Acceptance</dt>
        <dd style={cell}>
          {escrow.requiresAcceptance ? "Required" : "Not required"} ·{" "}
          {escrow.acceptedAt === undefined ? "not accepted yet" : `accepted ${shortTime(escrow.acceptedAt)}`}
        </dd>
      </dl>

      {payerIsReleaser && (
        <p style={notice} role="note">
          The payer is one of the releasers. The payer can therefore choose release or refund, so this escrow gives
          the payee no independent settlement protection.
        </p>
      )}
      {refundsElsewhere && (
        <p style={notice} role="note">
          A refund pays <code style={code}>{escrow.refundTo}</code>, not the payer. Funds can be reversed to that
          address if the releasers refund or the deadline passes.
        </p>
      )}
    </section>
  );
}

export function App() {
  const [escrowIdText, setEscrowIdText] = useState("0");
  const [signer, setSigner] = useState<EscrowSigner>();
  const [walletStatus, setWalletStatus] = useState("Wallet not connected");
  const [lastAction, setLastAction] = useState<string>();

  const [payee, setPayee] = useState("");
  const [token, setToken] = useState(TESTNET_XLM_SAC);
  const [amountText, setAmountText] = useState("1");
  const [conditionRef, setConditionRef] = useState("demo-escrow-1");
  const [releaser, setReleaser] = useState("");
  const [refundAfterText, setRefundAfterText] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [requiresAcceptance, setRequiresAcceptance] = useState(true);

  const escrowId = useMemo(() => {
    try {
      return BigInt(escrowIdText);
    } catch {
      return 0n;
    }
  }, [escrowIdText]);

  const viewer = signer ? signerAddress(signer) : undefined;
  const { data: escrow, isPending, error, refetch } = useEscrow(escrowId, {
    enabled: configured,
  });
  const timeline = useEscrowTimeline(escrow);
  const actions = useEscrowActions(signer);

  // Both actions exist only while the escrow is Funded, configured for
  // acceptance, and not yet accepted — exactly the window the contract allows.
  const acceptancePending =
    escrow !== undefined &&
    escrow.status === "Funded" &&
    escrow.requiresAcceptance &&
    escrow.acceptedAt === undefined;
  const isPayee = viewer !== undefined && viewer === escrow?.payee;
  const isPayer = viewer !== undefined && viewer === escrow?.payer;
  const acceptanceSatisfied = escrow !== undefined && (!escrow.requiresAcceptance || escrow.acceptedAt !== undefined);
  const canSettle = Boolean(signer) && escrow?.status === "Funded" && acceptanceSatisfied;

  async function onConnect() {
    try {
      const connected = await connectWallet();
      setSigner(connected);
      setWalletStatus(`Connected as ${connected.address}`);
    } catch (cause) {
      setWalletStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function act(kind: "release" | "refund" | "accept" | "cancel") {
    setLastAction(undefined);
    try {
      const result =
        kind === "release"
          ? await actions.release(escrowId)
          : kind === "refund"
            ? await actions.refund(escrowId)
            : kind === "accept"
              ? await actions.accept(escrowId)
              : await actions.cancel(escrowId);
      if (result.status === "success") {
        setLastAction(`Sent — ${result.data.txHash}`);
      } else if (result.status === "rejected") {
        setLastAction("Rejected in wallet");
      } else {
        setLastAction(`Refused before signing: ${result.error.code} — ${result.error.message}`);
      }
    } catch (cause) {
      setLastAction(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setLastAction(undefined);
    if (!signer) {
      setLastAction("Connect a wallet first — the payer signs the creation.");
      return;
    }
    try {
      const amount = parseAmount(amountText, XLM_DECIMALS);
      const refundAfter =
        refundAfterText === ""
          ? undefined
          : BigInt(Math.floor(new Date(refundAfterText).getTime() / 1_000));
      const result = await actions.createEscrow({
        payee: payee.trim(),
        token: token.trim(),
        amount,
        conditionRef: conditionRef.trim(),
        // Leaving the releaser blank uses the connected wallet. The demo
        // default keeps payer == releaser, which is exactly the T8 case the
        // review panel warns about.
        releaser: releaser.trim() === "" ? signerAddress(signer) : releaser.trim(),
        requiresAcceptance,
        ...(refundAfter === undefined ? {} : { refundAfter }),
        ...(refundTo.trim() === "" ? {} : { refundTo: refundTo.trim() }),
      });
      if (result.status === "success") {
        setEscrowIdText(result.data.escrowId.toString());
        setLastAction(`Created escrow #${result.data.escrowId} — ${result.data.txHash}`);
      } else if (result.status === "rejected") {
        setLastAction("Rejected in wallet");
      } else {
        setLastAction(`Refused before signing: ${result.error.code} — ${result.error.message}`);
      }
    } catch (cause) {
      setLastAction(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 760, margin: "2rem auto", lineHeight: 1.5 }}>
      <h1>docforum-escrow browser demo</h1>
      <p>
        Testnet only.{" "}
        {configured
          ? "Creates, reviews, accepts, cancels, releases and refunds a real escrow through the SDK and React hooks."
          : "Set VITE_ESCROW_CONTRACT_ID to a testnet deployment first."}
      </p>

      <section>
        <h2>Wallet</h2>
        <button onClick={onConnect}>Connect wallet</button>
        <p>{walletStatus}</p>
      </section>

      <section>
        <h2>Create escrow</h2>
        <form onSubmit={(event) => void onCreate(event)}>
          <p>
            <label>
              Payee address <input size={58} value={payee} onChange={(event) => setPayee(event.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Releaser address{" "}
              <input
                size={58}
                placeholder="defaults to the connected wallet"
                value={releaser}
                onChange={(event) => setReleaser(event.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              Token contract <input size={58} value={token} onChange={(event) => setToken(event.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Amount ({XLM_DECIMALS}-decimal units){" "}
              <input value={amountText} onChange={(event) => setAmountText(event.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Condition ref{" "}
              <input
                size={40}
                value={conditionRef}
                onChange={(event) => setConditionRef(event.target.value)}
              />
            </label>
            <br />
            <small style={muted}>
              Public on-chain forever — use an opaque id, never personal or sensitive data.
            </small>
          </p>
          <p>
            <label>
              Refund deadline (optional){" "}
              <input
                type="datetime-local"
                value={refundAfterText}
                onChange={(event) => setRefundAfterText(event.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              Refund destination (optional){" "}
              <input
                size={58}
                placeholder="defaults to the payer"
                value={refundTo}
                onChange={(event) => setRefundTo(event.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              <input
                type="checkbox"
                checked={requiresAcceptance}
                onChange={(event) => setRequiresAcceptance(event.target.checked)}
              />{" "}
              Require payee acceptance before release
            </label>
            <br />
            <small style={muted}>
              Until the payee accepts, the payer may cancel. The contract does not allow a fee on an acceptance
              escrow.
            </small>
          </p>
          <button type="submit" disabled={!configured || !signer}>
            Create escrow
          </button>
        </form>
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
            <p>
              Amount: {formatAmount(escrow.amount, XLM_DECIMALS)} XLM ({escrow.amount.toString()} stroops)
            </p>
            <p>
              Refund deadline:{" "}
              {timeline.hasDeadline
                ? timeline.expired
                  ? "passed (anyone may refund, back to the refund destination)"
                  : `${Math.ceil((timeline.remainingMs ?? 0) / 1000)}s remaining`
                : "none"}
            </p>
            {escrow.acceptedAt !== undefined && <p>Payee accepted at {shortTime(escrow.acceptedAt)}.</p>}

            {acceptancePending && <PayeeReview escrow={escrow} viewer={viewer} />}

            <h3>Actions</h3>
            {escrow.requiresAcceptance && escrow.status === "Funded" && escrow.acceptedAt !== undefined && (
              <p style={muted}>
                Cancel is no longer available: the payee accepted this escrow, so only a releaser can settle it.
              </p>
            )}
            <button disabled={!canSettle} onClick={() => void act("release")}>
              Release
            </button>{" "}
            <button disabled={!signer || escrow.status !== "Funded"} onClick={() => void act("refund")}>
              Refund
            </button>{" "}
            {acceptancePending && (
              <>
                <button disabled={!isPayee} onClick={() => void act("accept")}>
                  Accept
                </button>{" "}
                <button disabled={!isPayer} onClick={() => void act("cancel")}>
                  Cancel
                </button>
              </>
            )}
            {acceptancePending && !isPayee && (
              <p style={muted}>Accept is enabled only for the escrow&apos;s payee.</p>
            )}
            {acceptancePending && !isPayer && (
              <p style={muted}>Cancel is enabled only for the escrow&apos;s payer.</p>
            )}
            {!acceptanceSatisfied && (
              <p style={muted}>Release stays disabled until the payee accepts.</p>
            )}
            {actions.isPending && <p>Waiting for the wallet…</p>}
            {lastAction && <p>{lastAction}</p>}
          </>
        )}
      </section>
    </main>
  );
}
