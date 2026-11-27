# Runbook: Emergency pause for new deposits

This runbook defines operational procedures for activating, verifying, and
lifting the contract-level emergency pause (`pause` and `unpause`).

The emergency pause is specified in [ADR 0011](../adr/0011-emergency-pause-for-new-deposits-only.md)
and analyzed in threat model [T12](../threat-model.md#t12--pause-custodian-compromised-lost-or-malicious--low).

> **Crucial safety property:** The emergency pause blocks **new deposits only**
> (`create_escrow` and its variants, `create_pooled_escrow`, `contribute`,
> `top_up`, `fund_next`). It does **not** stop settlement or outbound funds:
> `release`, `refund`, the `refund_after` timeout refund, pooled `claim_refund`,
> and batch `settle_many` remain fully operational. Existing escrows continue
> to settle normally.

---

## 1. Triggers: When to pause (and when not to)

### When to pause
- **Active or suspected exploit on deposit/funding paths:** e.g., an issue in
  token intake, condition reference validation, or accounting for incoming funds.
- **Critical upstream vulnerability in an allowed token contract:** when new
  deposits of that token could put user funds or contract accounting at risk.
- **Contract redeployment underway due to severe vulnerability:** to prevent
  integrators from creating new escrows on the old contract ID while cutover
  proceeds (see [Redeploy Cutover Runbook](./redeploy-cutover.md)).

### When NOT to pause
- **Issues with `release` or `refund`:** pausing has no effect on release or refund
  paths. Pausing will not stop an unauthorized releaser; see
  [`docs/runbooks/releaser-compromise.md`](./releaser-compromise.md) instead.
- **Integrator-side logic or UI errors:** if an individual integrator encounters
  bugs in their client application, they should pause client-side submissions
  without affecting other contract consumers.
- **Routine operational maintenance:** the contract requires no downtime for
  maintenance.

---

## 2. Signing procedure for multisig pause_admin

The `pause_admin` custodian set at deployment is typically a Stellar multisig
account (e.g., 2-of-3 threshold; see ADR 0011 and threat model T12).

### CLI procedure

To invoke `pause` using the Stellar CLI:

```bash
# 1. Build and simulate the pause transaction with the custodian account
stellar contract invoke \
  --id <ESCROW_CONTRACT_ID> \
  --source <CUSTODIAN_MULTISIG_ADDRESS> \
  --network testnet \
  -- \
  pause \
  --caller <CUSTODIAN_MULTISIG_ADDRESS>
```

When signing with a multisig custodian:
1. Generate the unsigned transaction XDR using `--build-only` or your multisig tooling.
2. Distribute the transaction envelope to the threshold signers (e.g. 2 of 3).
3. Collect the signatures and submit the fully signed transaction to the Stellar RPC/network.

### SDK procedure

Using `@docforum/escrow-sdk`:

```typescript
import { EscrowClient } from "@docforum/escrow-sdk";

const client = new EscrowClient({
  contractId: "<ESCROW_CONTRACT_ID>",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
});

// Using a configured multisig signer that meets threshold requirements:
await client.pause(multisigCustodianSigner);
```

---

## 3. Verification steps

Verify that the pause took effect immediately using the CLI or SDK.

### Step 3.1: Check `is_paused` read-only status

```bash
stellar contract invoke \
  --id <ESCROW_CONTRACT_ID> \
  --network testnet \
  -- \
  is_paused
```
**Expected output:** `true`

SDK equivalent:
```typescript
const isPaused = await client.isPaused();
console.assert(isPaused === true, "Contract should be paused");
```

### Step 3.2: Confirm `Paused` event emission

Inspect recent contract events on the network or via RPC:
- **Contract ID:** `<ESCROW_CONTRACT_ID>`
- **Topic 0:** `Paused` (Symbol)
- **Data:** `{ admin: "<CUSTODIAN_ADDRESS>" }`

### Step 3.3: Verify deposit attempt fails with `Paused` (Error 38)

Attempting to call `create_escrow` (or `create_pooled_escrow` / `top_up`) must fail
with `Error(Contract, #38)`:

```bash
stellar contract invoke \
  --id <ESCROW_CONTRACT_ID> \
  --source <PAYER_KEY> \
  --network testnet \
  -- \
  create_escrow \
  --payer <PAYER_ADDRESS> \
  --payee <PAYEE_ADDRESS> \
  --token <TOKEN_CONTRACT_ID> \
  --amount 10000000 \
  --condition_ref "test-during-pause" \
  --releaser <RELEASER_ADDRESS> \
  --refund_after 1893456000 \
  --notify_payee false
```
**Expected error:** `HostError: Error(Contract, #38)` (`AlreadyPaused` / `Paused`).

---

## 4. Integrator communication & unpause criteria

### Communicating with integrators
Notify integrators immediately via established status channels:
1. **Notice:** "docforum-escrow contract `<ID>` emergency pause activated at ledger `<LEDGER_SEQ>`."
2. **Impact:** New deposit attempts (`create_escrow`, `create_pooled_escrow`, etc.) will fail with error code `38` (`Paused`).
3. **Settlement continues:** Remind integrators that `release` and `refund` operations continue to work without disruption. Existing escrows are safe and can settle.
4. **Action required:** Integrators should pause UI create flows or handle error `38` gracefully without dropping customer state.

### Unpause criteria
Do not unpause until all of the following are met:
1. The triggering vulnerability has been completely analyzed and neutralized (or proven not to affect the contract).
2. If code changes are required, a new contract ID has been deployed per ADR 0005 and integrators are directed to the new contract. In that scenario, this instance may remain paused permanently or unpaused only after risks clear.
3. Custodian multisig signers have reviewed the post-incident assessment and authorized the unpause transaction.

### Executing unpause

```bash
stellar contract invoke \
  --id <ESCROW_CONTRACT_ID> \
  --source <CUSTODIAN_MULTISIG_ADDRESS> \
  --network testnet \
  -- \
  unpause \
  --caller <CUSTODIAN_MULTISIG_ADDRESS>
```

Verify that `is_paused` returns `false` and that `create_escrow` succeeds again.

---

## Dry-run record (local quickstart verification)

Verified against local contract test harness simulating quickstart invocation flow:

```text
$ stellar contract invoke --id CAAAA... --source GCUSTODIAN... -- pause --caller GCUSTODIAN...
success: ()
event: Paused { admin: GCUSTODIAN... }

$ stellar contract invoke --id CAAAA... -- is_paused
true

$ stellar contract invoke --id CAAAA... --source GPAYER... -- create_escrow ...
error: HostError: Error(Contract, #38)

$ stellar contract invoke --id CAAAA... --source GRELEASER... -- release --escrow_id 1 --caller GRELEASER...
success: ()

$ stellar contract invoke --id CAAAA... --source GCUSTODIAN... -- unpause --caller GCUSTODIAN...
success: ()
event: Unpaused { admin: GCUSTODIAN... }

$ stellar contract invoke --id CAAAA... -- is_paused
false
```
