# Runbook: Moving integrators to a new contract deployment

This runbook defines the operational cutover procedure for deploying a new
version of `docforum_escrow` and moving integrators over to it.

Per [ADR 0005](../adr/0005-immutable-contract-and-redeploy-migrations.md), the
escrow contract is immutable. Upgrades or fixes deploy new code under a fresh
contract ID. Existing escrows are never migrated on-chain; they settle to completion
under the code that created them (on-chain consent-based migration of open
escrows is tracked in issue #117; this runbook covers the standard drain-and-cutover procedure).

---

## 1. Overview & prerequisites

A cutover has four main stages:
1. **Deploy & Verify:** Build and deploy the new contract ID to testnet/network,
   run automated verification, and record metadata in `deployments.json` and SDK presets.
2. **Dual-Client Operation:** Integrators configure two contract client instances
   (new ID for new escrows, old ID for existing ones).
3. **Drain & Solvency Monitoring:** Monitor the old contract's liabilities using
   `solvency()` until all open escrows have settled.
4. **Indexer Ingestion:** Configure the indexer with an additional data source
   starting at the new deployment's start ledger.

### Pre-cutover checklist
- [ ] Contract changes tested and compiled with `wasm32v1-none` target.
- [ ] `scripts/deploy` target network and constructor arguments (`--allowed-tokens`, `--pause-admin`) agreed upon.
- [ ] Integrators notified of the target deployment date and cutover schedule.

---

## 2. Deploying and verifying the new contract ID

### Step 2.1: Run deployment script
Run the deployment script to deploy the new contract WASM:

```bash
scripts/deploy \
  --network testnet \
  --allowed-tokens <TOKEN_ADDRESSES> \
  --pause-admin <PAUSE_ADMIN_ADDRESS>
```

`scripts/deploy` executes deterministic steps:
1. Checks or builds the release WASM.
2. Uploads the WASM and creates the contract instance with constructor arguments.
3. Confirms the on-chain WASM hash matches the compiled build.
4. Executes live smoke verification (create, read status, verify auth).
5. Updates `deployments.json`, `docs/testnet-deployments.md`, and SDK generated presets.

### Step 2.2: Sync SDK presets and verify interface

```bash
node scripts/deploy-record.mjs --sync
git diff sdk/src/deployments.generated.ts
node scripts/check-sdk-constants.mjs
```

Publish the updated SDK version (or provide integrators with the new contract ID
via configuration).

---

## 3. Integrator cutover: Running two client instances

During the cutover, integrators do not cancel or force-close existing escrows.
Instead, they instantiate two `EscrowClient` instances in their application:

```typescript
import { EscrowClient } from "@docforum/escrow-sdk";

// Client for new escrows
const newEscrowClient = new EscrowClient({
  contractId: NEW_CONTRACT_ID,
  rpcUrl: RPC_URL,
  networkPassphrase: NETWORK_PASSPHRASE,
});

// Client for settling legacy escrows
const legacyEscrowClient = new EscrowClient({
  contractId: OLD_CONTRACT_ID,
  rpcUrl: RPC_URL,
  networkPassphrase: NETWORK_PASSPHRASE,
});

// Routing logic:
function getClientForEscrow(escrowContractId: string): EscrowClient {
  if (escrowContractId === NEW_CONTRACT_ID) {
    return newEscrowClient;
  }
  return legacyEscrowClient;
}
```

### Operational rules for integrators
1. **Creation:** All new calls to `createEscrow`, `createQuorumEscrow`, or `createPooledEscrow`
   point exclusively to `newEscrowClient`.
2. **Settlement:** Calls to `release`, `refund`, or timeout refunds route to the contract ID
   associated with the escrow's database record.
3. **Optional pause on old contract:** Operators may optionally invoke `pause` on the old contract
   (see [`docs/runbooks/emergency-pause.md`](./emergency-pause.md)) to prevent accidental new deposits.

---

## 4. Monitoring old contract drain with `solvency()`

The old contract remains active until all open escrows reach terminal states
(`Released` or `Refunded`).

### Monitoring liabilities
Check the old contract's outstanding liabilities for each allowed token using `solvency(token)`:

```bash
stellar contract invoke \
  --id <OLD_CONTRACT_ID> \
  --network testnet \
  -- \
  solvency \
  --token <TOKEN_CONTRACT_ADDRESS>
```

SDK monitor example:
```typescript
const [balance, liabilities] = await legacyEscrowClient.getSolvency(tokenAddress);
console.log(`Remaining liabilities: ${liabilities}, Contract balance: ${balance}`);
```

When `liabilities === 0n` across all tokens, the old contract is fully drained.
Its record can be archived and the legacy client removed from production.

---

## 5. Indexer updates

The indexer tracks events across contract lifetimes:
1. Add a second project data source in the indexer configuration targeting `NEW_CONTRACT_ID`.
2. Set `startBlock` / `startLedger` to the ledger number where `NEW_CONTRACT_ID` was deployed
   (recorded in `deployments.json`).
3. Keep the old contract data source enabled so historical events remain indexed and
   settlement events on open escrows continue to be processed.

---

## 6. Rollback plan

If the new deployment exhibits unexpected behavior or an issue is discovered
immediately post-deployment:
1. **New escrows:** Point integrator creation routing back to `OLD_CONTRACT_ID` (if unpaused)
   or pause `NEW_CONTRACT_ID` immediately via its `pause_admin`.
2. **Escrows created on new ID:** Allow any escrows created on `NEW_CONTRACT_ID` to be
   refunded or released normally.
3. **SDK / Config:** Revert deployment presets in client services to reference `OLD_CONTRACT_ID`.
4. **Post-mortem:** Diagnose issue before attempting a subsequent redeployment.

---

## 7. Retrospective: 2.5.1 redeploy walk-through notes

Walk-through of the 2026-11-03 redeployment (`version() = 2.5.1` with constructor arguments):
- **Observed:** The addition of `__constructor(allowed_tokens, pause_admin)` required instance
  re-initialization at deploy time. Older contracts lacked `version()` and pause capabilities.
- **Identified gap & improvement:** `scripts/deploy` was enhanced to pass constructor arguments
  explicitly and run post-deploy verification checks before appending to `deployments.json`.
