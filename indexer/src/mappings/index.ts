import { scValToNative } from "@stellar/stellar-sdk";
import type { SorobanEvent } from "@subql/types-stellar";
import { Escrow, EscrowEvent } from "../types";

const ACTIONS = new Set(["created", "released", "refunded"]);

/** Index known lifecycle snapshots; unrelated/future events are ignored. */
export async function handleEscrowEvent(event: SorobanEvent): Promise<void> {
  if (event.type !== "contract" || !event.contractId || event.topic.length < 3) return;

  const topics = event.topic.map((topic) => scValToNative(topic));
  const [namespace, action, rawId] = topics;
  if (namespace !== "ESCROW" || typeof action !== "string" || !ACTIONS.has(action)) return;

  const raw = scValToNative(event.value);
  if (!Array.isArray(raw) || raw.length !== 8) return;
  const [payer, payee, token, rawAmount, conditionRef, releaser, rawRefundAfter, status] = raw;
  if (typeof conditionRef !== "string" || typeof status !== "string") return;

  const escrowId = BigInt(String(rawId));
  const amount = BigInt(String(rawAmount));
  const record = await Escrow.get(escrowId.toString()) ?? new Escrow(escrowId.toString());
  record.escrowId = escrowId;
  record.payer = String(payer);
  record.payee = String(payee);
  record.token = String(token);
  record.amount = amount;
  record.conditionRef = conditionRef;
  record.releaser = String(releaser);
  record.refundAfter = rawRefundAfter == null ? undefined : BigInt(String(rawRefundAfter));
  record.status = status;
  record.updatedLedger = BigInt(event.ledger);
  await record.save();

  const history = new EscrowEvent(`${event.txHash}-${event.id}`);
  history.escrowId = escrowId;
  history.action = action;
  history.transactionHash = event.txHash;
  history.ledger = BigInt(event.ledger);
  await history.save();
}
