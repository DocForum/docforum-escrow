import { scValToNative } from "@stellar/stellar-sdk";
import type { SorobanEvent } from "@subql/types-stellar";
import { Escrow, EscrowEvent } from "../entities";

/** Lifecycle snapshots: topics are `("ESCROW", action, escrow_id)`. */
const SNAPSHOT_ACTIONS = new Set(["created", "released", "refunded", "cancelled"]);

/**
 * Events that change one field of an escrow without publishing a snapshot.
 * Their topics are `(action, escrow_id)` (issue #346).
 */
type PartialAction = "pay_xfer" | "rotate" | "top_up" | "accepted" | "contrib" | "claimed";
const PARTIAL_ACTIONS = new Set<string>([
  "pay_xfer",
  "rotate",
  "top_up",
  "accepted",
  "contrib",
  "claimed",
]);

const ESCROW_TOPIC_NAMESPACE = "ESCROW";

/**
 * Index one contract event. Lifecycle snapshots rewrite the stored escrow;
 * the narrower settlement/administration events update only the field they
 * carry. Unknown topics, malformed payloads and events for escrows this
 * indexer never saw (created before its start ledger) are ignored, never fatal.
 */
export async function handleEscrowEvent(event: SorobanEvent): Promise<void> {
  if (event.type !== "contract" || !event.contractId || event.topic.length < 2) return;

  const topics = event.topic.map((topic) => scValToNative(topic));
  const [first, second, third] = topics;

  if (first === ESCROW_TOPIC_NAMESPACE && typeof second === "string" && SNAPSHOT_ACTIONS.has(second)) {
    await applySnapshot(event, second, third);
    return;
  }
  if (typeof first === "string" && PARTIAL_ACTIONS.has(first)) {
    await applyPartial(event, first as PartialAction, second);
  }
}

/** Applies a 12- or 13-field `ESCROW` snapshot. */
async function applySnapshot(event: SorobanEvent, action: string, rawId: unknown): Promise<void> {
  const escrowId = toBigInt(rawId);
  if (escrowId === undefined) return;

  const raw = scValToNative(event.value);
  // 13 fields since the optional protocol fee was appended as one nested
  // (recipient, bps) pair (docs/adr/0010); older 12-field events are still
  // indexed fee-free.
  if (!Array.isArray(raw) || (raw.length !== 12 && raw.length !== 13)) return;
  const [payer, payee, token, rawAmount, conditionRef, rawReleasers, rawThreshold, rawRefundAfter, notifyPayee, requiresAcceptance, rawAcceptedAt, status, rawFee] = raw;
  const [feeRecipient, rawFeeBps] = Array.isArray(rawFee) ? rawFee : [null, null];
  if (typeof conditionRef !== "string" || typeof status !== "string" || typeof notifyPayee !== "boolean" || typeof requiresAcceptance !== "boolean" || !Array.isArray(rawReleasers)) return;

  const ledger = eventLedger(event);
  if (ledger === null) return;
  const amount = toBigInt(rawAmount) ?? 0n;
  const releasers = rawReleasers.map(String);
  const threshold = toBigInt(rawThreshold) ?? 0n;

  const record =
    (await Escrow.get(escrowId.toString())) ??
    // The generated entity constructor takes every non-nullable field, so seed
    // it with this snapshot and then apply the nullable ones below.
    new Escrow(escrowId.toString(), escrowId, String(payer), String(payee), String(token), amount, conditionRef, releasers, threshold, notifyPayee, requiresAcceptance, status, ledger);
  record.escrowId = escrowId;
  record.payer = String(payer);
  record.payee = String(payee);
  record.token = String(token);
  record.amount = amount;
  record.conditionRef = conditionRef;
  record.releasers = releasers;
  record.threshold = threshold;
  record.refundAfter = rawRefundAfter == null ? undefined : toBigInt(rawRefundAfter);
  record.notifyPayee = notifyPayee;
  record.requiresAcceptance = requiresAcceptance;
  record.acceptedAt = rawAcceptedAt == null ? undefined : toBigInt(rawAcceptedAt);
  record.feeRecipient = feeRecipient == null ? undefined : String(feeRecipient);
  record.feeBps = rawFeeBps == null ? undefined : toBigInt(rawFeeBps);
  record.status = status;
  record.updatedLedger = ledger;
  await record.save();

  await recordEvent(event, escrowId, action, ledger);
}

/**
 * Applies a non-lifecycle event to an escrow this indexer already has. Only the
 * field(s) the event carries are touched; `status`, the parties, the releaser
 * set and the other fields stay as the last snapshot left them.
 */
async function applyPartial(event: SorobanEvent, action: PartialAction, rawId: unknown): Promise<void> {
  const escrowId = toBigInt(rawId);
  if (escrowId === undefined) return;

  const ledger = eventLedger(event);
  if (ledger === null) return;

  const record = await Escrow.get(escrowId.toString());
  // Escrows created before the indexer's start ledger were never snapshotted.
  // Their partial events cannot be applied to a record that does not exist.
  if (!record) return;

  // Ordering guard: SubQuery delivers events in chain order, but a replayed or
  // out-of-order older event must never overwrite fields a newer snapshot (or
  // newer partial event) already set.
  if (ledger >= record.updatedLedger) {
    const raw = scValToNative(event.value);
    const values = Array.isArray(raw) ? raw : [];
    const applied = applyPartialFields(action, values, record);
    if (!applied) return;
    record.updatedLedger = ledger;
    await record.save();
  }

  await recordEvent(event, escrowId, action, ledger);
}

/** Applies one event's fields; returns false when the payload is malformed. */
function applyPartialFields(action: PartialAction, values: unknown[], record: Escrow): boolean {
  switch (action) {
    case "pay_xfer": {
      if (values.length < 2) return false;
      const [, newPayee] = values;
      if (newPayee == null) return false;
      record.payee = String(newPayee);
      return true;
    }
    case "rotate": {
      if (values.length < 2) return false;
      const [oldReleaser, newReleaser] = values;
      if (oldReleaser == null || newReleaser == null) return false;
      record.releasers = rotateReleaser(record.releasers ?? [], String(oldReleaser), String(newReleaser));
      return true;
    }
    case "top_up": {
      if (values.length < 2) return false;
      const updatedAmount = toBigInt(values[1]);
      if (updatedAmount === undefined) return false;
      record.amount = updatedAmount;
      return true;
    }
    case "accepted": {
      if (values.length < 2) return false;
      const acceptedAt = toBigInt(values[1]);
      if (acceptedAt === undefined) return false;
      record.acceptedAt = acceptedAt;
      return true;
    }
    case "contrib": {
      if (values.length < 3) return false;
      const funded = toBigInt(values[2]);
      if (funded === undefined) return false;
      // `contribute` accumulates into the pooled escrow's amount and emits the
      // new funded total, not the delta.
      record.amount = funded;
      return true;
    }
    case "claimed": {
      if (values.length < 2) return false;
      const refundAmount = toBigInt(values[1]);
      if (refundAmount === undefined) return false;
      // `claim_refund` pays a contributor out of the pooled total and emits the
      // amount refunded, so the escrow's remaining amount shrinks by it.
      const remaining = (record.amount ?? 0n) - refundAmount;
      record.amount = remaining > 0n ? remaining : 0n;
      return true;
    }
  }
}

/** Replaces one releaser in place, keeping the set's order and uniqueness. */
function rotateReleaser(releasers: string[], oldReleaser: string, newReleaser: string): string[] {
  const index = releasers.indexOf(oldReleaser);
  if (index === -1) {
    return releasers.includes(newReleaser) ? releasers : [...releasers, newReleaser];
  }
  const next = [...releasers];
  next[index] = newReleaser;
  return next.filter((releaser, position) => next.indexOf(releaser) === position);
}

async function recordEvent(event: SorobanEvent, escrowId: bigint, action: string, ledger: bigint): Promise<void> {
  await new EscrowEvent(`${event.txHash}-${event.id}`, escrowId, action, event.txHash, ledger).save();
}

/** The event's ledger sequence, or null when SubQuery did not resolve it. */
function eventLedger(event: SorobanEvent): bigint | null {
  const sequence = event.ledger?.sequence;
  return typeof sequence === "number" ? BigInt(sequence) : null;
}

/** Converts a decoded Soroban integer to bigint, or undefined when it is not one. */
function toBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return undefined;
}
