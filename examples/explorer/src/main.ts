import { EscrowClient, EventCursorExpiredError, formatAmount, networks, type Escrow, type EscrowEvent } from "@docforum/escrow-sdk";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<div class="shell"><header class="hero"><p class="eyebrow">DOCFORUM · ESCROW</p><h1>Inspect an escrow before you rely on it.</h1><p class="lede">A read-only view of the terms stored on Stellar testnet. No wallet, keys, or signing required.</p><span class="network-pill"><span></span> Testnet only</span></header><section class="panel search-panel"><h2>Look up an escrow</h2><form id="lookup-form"><label>Contract ID <input id="contract-id" required spellcheck="false" autocomplete="off" placeholder="C…" /></label><label>Escrow ID <input id="escrow-id" required inputmode="numeric" pattern="[0-9]+" value="0" /></label><button type="submit">Inspect escrow <span aria-hidden="true">→</span></button></form><p class="hint">This page only reads public chain data; it never requests a wallet or submits transactions.</p></section><div id="output" aria-live="polite"></div></div>`;

const form = document.querySelector<HTMLFormElement>("#lookup-form")!;
const contractInput = document.querySelector<HTMLInputElement>("#contract-id")!;
const escrowInput = document.querySelector<HTMLInputElement>("#escrow-id")!;
const output = document.querySelector<HTMLDivElement>("#output")!;
contractInput.value = networks.testnet.contractIds.escrow;
form.addEventListener("submit", (event) => { event.preventDefault(); void inspect(); });

async function inspect(): Promise<void> {
  const contractId = contractInput.value.trim();
  const idText = escrowInput.value.trim();
  if (!/^C[A-Z2-7]{55}$/.test(contractId)) return showError("Enter a valid Stellar contract address (C…).");
  if (!/^\d+$/.test(idText)) return showError("Escrow ID must be a non-negative integer.");
  output.innerHTML = `<section class="panel loading"><span class="spinner"></span><p>Reading the testnet ledger…</p></section>`;
  try {
    const client = new EscrowClient({ contractId, network: networks.testnet });
    const escrowId = BigInt(idText);
    let escrow: Escrow | undefined;
    let status: Escrow["status"];
    try { escrow = await client.getEscrow(escrowId); status = escrow.status; }
    catch { status = await client.getStatus(escrowId); }
    const history = await loadHistory(client, escrowId);
    const tokenInfo = escrow ? await client.getTokenInfo(escrow.token).catch(() => undefined) : undefined;
    renderResult(escrowId, escrow, status, tokenInfo, history);
  } catch (error) { showError(error instanceof Error ? error.message : String(error)); }
}

async function loadHistory(client: EscrowClient, escrowId: bigint): Promise<EscrowEvent[]> {
  try { return (await client.getEvents({ fromLedger: 1, escrowId })).events; }
  catch (error) { if (error instanceof EventCursorExpiredError) return []; return []; }
}

function renderResult(id: bigint, escrow: Escrow | undefined, status: Escrow["status"], tokenInfo: { symbol: string; decimals: number } | undefined, history: EscrowEvent[]): void {
  if (!escrow) { output.innerHTML = `<section class="panel"><div class="result-heading"><div><p class="eyebrow">ESCROW #${id}</p><h2>${status}</h2></div><span class="status ${status.toLowerCase()}">${status}</span></div><p class="muted">The full record was reclaimed after settlement; the status remains available on-chain.</p>${historyMarkup(history)}</section>`; return; }
  const symbol = tokenInfo?.symbol || "unknown token";
  const amount = tokenInfo ? `${formatAmount(escrow.amount, tokenInfo.decimals)} ${escapeHtml(symbol)}` : `${escrow.amount.toString()} raw units`;
  output.innerHTML = `<section class="panel result"><div class="result-heading"><div><p class="eyebrow">ESCROW #${id}</p><h2>${escapeHtml(escrow.conditionRef || "Untitled escrow")}</h2></div><span class="status ${status.toLowerCase()}">${status}</span></div>${warningMarkup(escrow)}<div class="grid"><div><span>Payer</span><code>${escrow.payer}</code></div><div><span>Payee</span><code>${escrow.payee}</code></div><div><span>Token</span><code>${escrow.token}</code><strong>${amount}</strong></div><div><span>Releaser${escrow.releasers.length > 1 ? "s" : ""}</span><code>${escrow.releasers.join("<br>")}</code><strong>${escrow.threshold} approval${escrow.threshold === 1 ? "" : "s"} required</strong></div><div><span>Refund destination</span><code>${escrow.refundTo}</code></div><div><span>Refund deadline</span><strong>${deadlineMarkup(escrow.refundAfter)}</strong></div></div>${historyMarkup(history)}</section>`;
}

function warningMarkup(escrow: Escrow): string {
  const warnings: string[] = [];
  if (escrow.releasers.includes(escrow.payer)) warnings.push("The releaser is the payer, so the payer can refund this escrow.");
  if (escrow.refundAfter === undefined) warnings.push("There is no timeout refund; if the releaser cannot sign, funds may remain locked.");
  else if (escrow.refundAfter * 1000n <= BigInt(Date.now())) warnings.push("The refund deadline has passed; anyone may refund to the stored refund destination.");
  if (escrow.refundTo !== escrow.payer) warnings.push("A refund goes to a destination different from the payer; verify it before relying on this escrow.");
  return warnings.length ? `<aside class="warnings"><strong>Payee checks</strong><ul>${warnings.map((warning) => `<li>${warning}</li>`).join("")}</ul></aside>` : "";
}

function deadlineMarkup(deadline: bigint | undefined): string {
  if (deadline === undefined) return "None";
  const remaining = Number(deadline * 1000n - BigInt(Date.now()));
  if (remaining <= 0) return `Passed · ${new Date(Number(deadline) * 1000).toLocaleString()}`;
  const days = Math.ceil(remaining / 86_400_000);
  return `${days === 1 ? "In 1 day" : `In ${days} days`} · ${new Date(Number(deadline) * 1000).toLocaleString()}`;
}

function historyMarkup(history: EscrowEvent[]): string {
  if (!history.length) return `<div class="history"><h3>Transaction history</h3><p class="muted">No retained lifecycle events were found for this escrow.</p></div>`;
  return `<div class="history"><h3>Transaction history</h3><ol>${history.map((event) => `<li><span>${event.type}</span><small>ledger ${event.ledger}</small><a href="https://stellar.expert/explorer/testnet/tx/${event.transactionHash}" target="_blank" rel="noreferrer">${event.transactionHash.slice(0, 12)}…</a></li>`).join("")}</ol></div>`;
}

function showError(message: string): void { output.innerHTML = `<section class="panel error"><strong>Could not inspect this escrow</strong><p>${escapeHtml(message)}</p><p class="muted">Check the contract and escrow ID, then try again.</p></section>`; }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!); }
