// Issue #37 — versioned storage layout for `EscrowData`.
//
// Every `DataKey::Escrow(id)` entry is now written as `StoredEscrow::V<n>`
// (an explicit version tag). Readers accept every known layout — including
// the untagged `EscrowData` map that every build before issue #37 wrote —
// and upgrade it in memory; the next state change writes the latest
// version back. These tests store old-layout entries directly in contract
// storage and then operate on them through the public entry points.
//
// The reviewer's check for this issue: an old entry survives a release
// *and* a refund round trip (`legacy_entries_survive_release_and_refund_round_trip`).

use docforum_escrow::{
    DataKey, Error, EscrowContract, EscrowContractClient, EscrowData, EscrowStatus, SettleAction,
    StoredEscrow, ESCROW_LAYOUT_VERSION,
};
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, IntoVal, Map, String, Symbol, TryFromVal, Val, Vec,
};

struct Fixture<'a> {
    env: &'a Env,
    contract_id: Address,
    client: EscrowContractClient<'a>,
    token_id: Address,
    token: TokenClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
}

fn fixture(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &10_000);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
    let client = EscrowContractClient::new(env, &contract_id);
    Fixture {
        env,
        contract_id,
        client,
        token_id,
        token,
        payer,
        payee,
        releaser,
    }
}

/// How a raw `DataKey::Escrow(id)` value is encoded.
#[derive(Debug, PartialEq)]
enum Encoding {
    /// Bare `EscrowData` map, as written before issue #37.
    Untagged,
    /// `StoredEscrow` with this layout version.
    Tagged(u32),
    Missing,
}

impl<'a> Fixture<'a> {
    fn create(&self, amount: i128, refund_after: Option<u64>) -> u64 {
        self.client.create_escrow(
            &self.payer,
            &self.payee,
            &self.token_id,
            &amount,
            &String::from_str(self.env, "layout-test-ref"),
            &self.releaser,
            &refund_after,
            &false,
            &None,
            &None,
            &None,
        )
    }

    fn raw(&self, escrow_id: u64) -> Option<Val> {
        self.env.as_contract(&self.contract_id, || {
            self.env
                .storage()
                .persistent()
                .get::<_, Val>(&DataKey::Escrow(escrow_id))
        })
    }

    fn encoding(&self, escrow_id: u64) -> Encoding {
        let Some(raw) = self.raw(escrow_id) else {
            return Encoding::Missing;
        };
        if Map::<Val, Val>::try_from_val(self.env, &raw).is_ok() {
            return Encoding::Untagged;
        }
        let stored = StoredEscrow::try_from_val(self.env, &raw).expect("tagged layout");
        Encoding::Tagged(version(&stored))
    }

    /// Rewrites an existing escrow's record in the pre-issue-#37 form: the
    /// same `EscrowData`, stored as a bare untagged map. Everything else the
    /// escrow owns (funds, `Status`, liability, TTL) is left as created, so
    /// the entry is exactly what an older build would have left behind.
    fn store_legacy(&self, escrow_id: u64, data: &EscrowData) {
        self.env.as_contract(&self.contract_id, || {
            self.env
                .storage()
                .persistent()
                .set(&DataKey::Escrow(escrow_id), data);
        });
        assert_eq!(self.encoding(escrow_id), Encoding::Untagged);
    }

    /// Converts a freshly created escrow to the legacy encoding.
    fn downgrade(&self, escrow_id: u64) -> EscrowData {
        let data = self.client.get_escrow(&escrow_id);
        self.store_legacy(escrow_id, &data);
        data
    }

    /// Rewrites an existing escrow's record as an untagged map **without**
    /// the `attester` key: the form builds before attestation-based release
    /// (issue #42) left behind. Fails if the escrow has an attester, since
    /// such a build could not have created one.
    fn downgrade_pre_attester(&self, escrow_id: u64) -> EscrowData {
        let data = self.client.get_escrow(&escrow_id);
        assert!(data.attester.is_none());
        self.env.as_contract(&self.contract_id, || {
            let full: Val = data.clone().into_val(self.env);
            let mut map = Map::<Symbol, Val>::try_from_val(self.env, &full).unwrap();
            assert!(map.remove(symbol_short!("attester")).is_some());
            self.env
                .storage()
                .persistent()
                .set(&DataKey::Escrow(escrow_id), &map);
        });
        assert_eq!(self.encoding(escrow_id), Encoding::Untagged);
        let raw = self.raw(escrow_id).unwrap();
        let map = Map::<Symbol, Val>::try_from_val(self.env, &raw).unwrap();
        assert!(!map.contains_key(symbol_short!("attester")));
        data
    }

    /// Stores a record directly as a tagged `StoredEscrow` value.
    fn store_tagged(&self, escrow_id: u64, stored: &StoredEscrow) {
        self.env.as_contract(&self.contract_id, || {
            self.env
                .storage()
                .persistent()
                .set(&DataKey::Escrow(escrow_id), stored);
        });
    }

    fn solvency(&self) -> (i128, i128) {
        self.client.solvency(&self.token_id)
    }
}

/// Layout version of a stored value. Matching here (rather than through a
/// helper on the contract type) keeps the test exhaustive: a new
/// `StoredEscrow` variant does not compile until this test learns it.
fn version(stored: &StoredEscrow) -> u32 {
    match stored {
        StoredEscrow::V1(_) => 1,
    }
}

/// Upgrades a stored value to the latest record, mirroring the contract.
fn upgrade(stored: StoredEscrow) -> EscrowData {
    match stored {
        StoredEscrow::V1(data) => data,
    }
}

/// `EscrowData` has no `PartialEq`; compare every field explicitly.
fn assert_same(a: &EscrowData, b: &EscrowData) {
    assert_eq!(a.payer, b.payer);
    assert_eq!(a.payee, b.payee);
    assert_eq!(a.token, b.token);
    assert_eq!(a.amount, b.amount);
    assert_eq!(a.condition_ref, b.condition_ref);
    assert_eq!(a.status, b.status);
    assert_eq!(a.releasers, b.releasers);
    assert_eq!(a.threshold, b.threshold);
    assert_eq!(a.refund_after, b.refund_after);
    assert_eq!(a.payees, b.payees);
    assert_eq!(a.notify_payee, b.notify_payee);
    assert_eq!(a.requires_acceptance, b.requires_acceptance);
    assert_eq!(a.accepted_at, b.accepted_at);
    assert_eq!(a.refund_to, b.refund_to);
    assert_eq!(a.release_not_before, b.release_not_before);
    assert_eq!(a.fee_recipient, b.fee_recipient);
    assert_eq!(a.fee_bps, b.fee_bps);
    assert_eq!(a.attester, b.attester);
}

// ── Writes ────────────────────────────────────────────────────────────────

#[test]
fn new_escrows_are_written_with_the_latest_version_tag() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(100, None);
    assert_eq!(ESCROW_LAYOUT_VERSION, 1);
    assert_eq!(f.encoding(id), Encoding::Tagged(ESCROW_LAYOUT_VERSION));
}

// ── Reads ─────────────────────────────────────────────────────────────────

#[test]
fn legacy_entry_reads_as_the_same_record_and_reads_never_rewrite_it() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(250, Some(env.ledger().timestamp() + 1_000));
    let original = f.downgrade(id);

    assert_same(&f.client.get_escrow(&id), &original);
    let batch = f.client.get_escrows(&Vec::from_array(&env, [id]));
    assert_same(&batch.get(0).unwrap().unwrap(), &original);
    assert_eq!(f.client.get_status(&id), EscrowStatus::Funded);

    // Read-only calls must stay read-only: the legacy entry is untouched.
    assert_eq!(f.encoding(id), Encoding::Untagged);
}

#[test]
fn tagged_v1_entry_stored_directly_is_read_and_settled() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(400, None);
    let data = f.client.get_escrow(&id);
    f.store_tagged(id, &StoredEscrow::V1(data.clone()));

    assert_same(&f.client.get_escrow(&id), &data);
    f.client.release(&id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 400);
    assert_eq!(f.client.get_status(&id), EscrowStatus::Released);
    assert_eq!(f.encoding(id), Encoding::Missing);
}

// ── Old entries through settlement ────────────────────────────────────────

#[test]
fn legacy_entry_survives_release() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(300, None);
    f.downgrade(id);

    f.client.release(&id, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.client.get_status(&id), EscrowStatus::Released);
    // Settlement reclaims the record (docs/adr/0013); nothing is left to
    // migrate, and the liability for the token is gone.
    assert_eq!(f.encoding(id), Encoding::Missing);
    assert_eq!(f.solvency(), (0, 0));
}

#[test]
fn legacy_entry_survives_refund() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(300, None);
    f.downgrade(id);

    f.client.refund(&id, &f.releaser);

    assert_eq!(f.token.balance(&f.payer), 10_000);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.client.get_status(&id), EscrowStatus::Refunded);
    assert_eq!(f.encoding(id), Encoding::Missing);
    assert_eq!(f.solvency(), (0, 0));
}

#[test]
fn legacy_entries_survive_release_and_refund_round_trip() {
    // Two escrows left behind in the old layout by a previous build, plus
    // one written by this build. Each old entry first goes through a state
    // change (which migrates it), then settles; the payouts and the
    // contract's books must come out exactly as for a native entry.
    let env = Env::default();
    let f = fixture(&env);
    let released = f.create(1_000, None);
    let refunded = f.create(2_000, None);
    let native = f.create(500, None);
    f.downgrade(released);
    f.downgrade(refunded);
    assert_eq!(f.solvency(), (3_500, 3_500));

    // Next state change on each old entry: write-back in the latest layout.
    f.client.top_up(&released, &f.payer, &10);
    f.client.top_up(&refunded, &f.payer, &20);
    assert_eq!(
        f.encoding(released),
        Encoding::Tagged(ESCROW_LAYOUT_VERSION)
    );
    assert_eq!(
        f.encoding(refunded),
        Encoding::Tagged(ESCROW_LAYOUT_VERSION)
    );
    assert_eq!(f.client.get_escrow(&released).amount, 1_010);
    assert_eq!(f.client.get_escrow(&refunded).amount, 2_020);

    f.client.release(&released, &f.releaser);
    f.client.refund(&refunded, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 1_010);
    assert_eq!(f.token.balance(&f.payer), 10_000 - 1_010 - 500);
    assert_eq!(f.client.get_status(&released), EscrowStatus::Released);
    assert_eq!(f.client.get_status(&refunded), EscrowStatus::Refunded);
    // Only the untouched native escrow is still owed.
    assert_eq!(f.solvency(), (500, 500));
    assert_eq!(f.client.get_escrow(&native).amount, 500);

    // A second settlement attempt on either old id is still rejected.
    assert!(f.client.try_release(&released, &f.releaser).is_err());
    assert!(f.client.try_refund(&refunded, &f.releaser).is_err());
}

#[test]
fn legacy_entry_migrates_on_next_state_change() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(100, None);
    let original = f.downgrade(id);
    let new_releaser = Address::generate(&env);

    f.client.rotate_releaser(&id, &f.releaser, &new_releaser);

    let raw = f.raw(id).unwrap();
    let stored = StoredEscrow::try_from_val(&env, &raw).expect("migrated to a tagged layout");
    assert_eq!(version(&stored), ESCROW_LAYOUT_VERSION);
    let migrated = upgrade(stored);
    assert_eq!(
        migrated.releasers,
        Vec::from_array(&env, [new_releaser.clone()])
    );
    // Every other field is carried over unchanged.
    let mut expected = original;
    expected.releasers = migrated.releasers.clone();
    assert_same(&migrated, &expected);

    // The migrated entry keeps working: the new releaser refunds it.
    f.client.refund(&id, &new_releaser);
    assert_eq!(f.token.balance(&f.payer), 10_000);
}

#[test]
fn legacy_acceptance_escrow_migrates_on_accept_then_releases() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.client.create_escrow_with_acceptance(
        &f.payer,
        &f.payee,
        &f.token_id,
        &700,
        &String::from_str(&env, "layout-accept-ref"),
        &f.releaser,
        &None,
        &true,
        &None,
    );
    f.downgrade(id);
    assert!(f.client.try_release(&id, &f.releaser).is_err());

    f.client.accept(&id, &f.payee);
    assert_eq!(f.encoding(id), Encoding::Tagged(ESCROW_LAYOUT_VERSION));
    assert!(f.client.get_escrow(&id).accepted_at.is_some());

    f.client.release(&id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 700);
}

#[test]
fn legacy_timeout_escrow_is_refundable_by_anyone_after_its_deadline() {
    let env = Env::default();
    let f = fixture(&env);
    let deadline = env.ledger().timestamp() + 100;
    let id = f.create(600, Some(deadline));
    f.downgrade(id);

    env.ledger().with_mut(|ledger| ledger.timestamp = deadline);
    let stranger = Address::generate(&env);
    f.client.refund(&id, &stranger);

    assert_eq!(f.token.balance(&f.payer), 10_000);
    assert_eq!(f.client.get_status(&id), EscrowStatus::Refunded);
}

#[test]
fn settle_many_handles_legacy_and_native_entries_together() {
    let env = Env::default();
    let f = fixture(&env);
    let legacy_release = f.create(100, None);
    let legacy_refund = f.create(200, None);
    let native_release = f.create(300, None);
    f.downgrade(legacy_release);
    f.downgrade(legacy_refund);

    let results = f.client.settle_many(
        &f.releaser,
        &Vec::from_array(
            &env,
            [
                (legacy_release, SettleAction::Release),
                (legacy_refund, SettleAction::Refund),
                (native_release, SettleAction::Release),
            ],
        ),
    );

    assert!(results.iter().all(|result| result.is_ok()));
    assert_eq!(f.token.balance(&f.payee), 400);
    assert_eq!(f.token.balance(&f.payer), 10_000 - 400);
    assert_eq!(f.solvency(), (0, 0));
}

#[test]
fn legacy_pooled_escrow_is_rewritten_in_the_latest_layout_on_contribute_and_release() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.client.create_pooled_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &500,
        &String::from_str(&env, "layout-pool-ref"),
        &f.releaser,
        &(env.ledger().timestamp() + 1_000),
    );
    f.downgrade(id);

    f.client.contribute(&id, &f.payer, &500);
    assert_eq!(f.encoding(id), Encoding::Tagged(ESCROW_LAYOUT_VERSION));

    // A pooled escrow keeps its record after settlement (docs/adr/0013),
    // so the settled state is written in the latest layout too.
    f.store_legacy(id, &f.client.get_escrow(&id));
    f.client.release(&id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 500);
    assert_eq!(f.encoding(id), Encoding::Tagged(ESCROW_LAYOUT_VERSION));
    let stored = StoredEscrow::try_from_val(&env, &f.raw(id).unwrap()).unwrap();
    assert_eq!(upgrade(stored).status, EscrowStatus::Released);
}

// ── Untagged entries from before attestation-based release (#42) ─────────

#[test]
fn pre_attester_legacy_entry_reads_with_no_attester_and_is_not_rewritten() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(250, Some(env.ledger().timestamp() + 1_000));
    let original = f.downgrade_pre_attester(id);

    let read = f.client.get_escrow(&id);
    assert_same(&read, &original);
    assert_eq!(read.attester, None);
    let batch = f.client.get_escrows(&Vec::from_array(&env, [id]));
    assert_same(&batch.get(0).unwrap().unwrap(), &original);
    assert_eq!(f.encoding(id), Encoding::Untagged);
}

#[test]
fn pre_attester_legacy_entries_survive_release_and_refund() {
    let env = Env::default();
    let f = fixture(&env);
    let released = f.create(300, None);
    let refunded = f.create(200, None);
    f.downgrade_pre_attester(released);
    f.downgrade_pre_attester(refunded);

    f.client.release(&released, &f.releaser);
    f.client.refund(&refunded, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.token.balance(&f.payer), 10_000 - 300);
    assert_eq!(f.client.get_status(&released), EscrowStatus::Released);
    assert_eq!(f.client.get_status(&refunded), EscrowStatus::Refunded);
    assert_eq!(f.encoding(released), Encoding::Missing);
    assert_eq!(f.encoding(refunded), Encoding::Missing);
    assert_eq!(f.solvency(), (0, 0));
}

#[test]
fn pre_attester_legacy_entry_migrates_with_no_attestation_path() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(400, None);
    let original = f.downgrade_pre_attester(id);

    f.client.top_up(&id, &f.payer, &10);
    assert_eq!(f.encoding(id), Encoding::Tagged(ESCROW_LAYOUT_VERSION));
    let migrated = f.client.get_escrow(&id);
    assert_eq!(migrated.amount, original.amount + 10);
    assert_eq!(migrated.attester, None);

    // Exactly as before #42: no attester means no attestation release.
    let any_signature = BytesN::from_array(&env, &[0u8; 64]);
    assert_eq!(
        f.client.try_release_with_attestation(&id, &any_signature),
        Err(Ok(Error::AttesterNotConfigured))
    );
    f.client.release(&id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 410);
    assert_eq!(f.solvency(), (0, 0));
}

#[test]
fn attested_legacy_entry_keeps_its_attester_and_releases_by_attestation() {
    let env = Env::default();
    let f = fixture(&env);
    let signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let attester = BytesN::from_array(&env, signing_key.verifying_key().as_bytes());
    let id = f.client.create_escrow_with_attester(
        &f.payer,
        &f.payee,
        &f.token_id,
        &300,
        &String::from_str(&env, "layout-test-ref"),
        &f.releaser,
        &None,
        &false,
        &None,
        &Some(attester.clone()),
    );
    // Untagged map with the `attester` key: what builds between #42 and
    // #37 wrote.
    let original = f.downgrade(id);
    assert_eq!(original.attester, Some(attester.clone()));
    assert_same(&f.client.get_escrow(&id), &original);

    // Same message layout as `tests/attestation.rs`.
    let mut message = b"docforum-escrow:release-attestation:v1".to_vec();
    let mut contract_id_bytes = [0u8; 56];
    f.contract_id
        .to_string()
        .copy_into_slice(&mut contract_id_bytes);
    message.extend_from_slice(&contract_id_bytes);
    message.extend_from_slice(&env.ledger().network_id().to_array());
    message.extend_from_slice(&id.to_be_bytes());
    message.extend_from_slice(b"release");
    let signature = BytesN::from_array(&env, &signing_key.sign(&message).to_bytes());

    f.client.release_with_attestation(&id, &signature);
    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.client.get_status(&id), EscrowStatus::Released);
    assert_eq!(f.encoding(id), Encoding::Missing);
    assert_eq!(f.solvency(), (0, 0));
}

// ── Resource cost of the version dispatch ─────────────────────────────────

struct Cost {
    cpu: u64,
    mem: u64,
}

fn measure(env: &Env, operation: impl FnOnce()) -> Cost {
    env.cost_estimate().budget().reset_unlimited();
    operation();
    let budget = env.cost_estimate().budget();
    Cost {
        cpu: budget.cpu_instruction_cost(),
        mem: budget.memory_bytes_cost(),
    }
}

#[test]
fn version_dispatch_cost_is_small() {
    // Native host metering, as in `benches/resource_profile.rs`: it counts
    // host work (storage, object conversion), not guest WASM instructions.
    let env = Env::default();
    let f = fixture(&env);
    let tagged = f.create(100, None);
    let legacy = f.create(100, None);
    f.downgrade(legacy);

    // Decode only: the pre-#37 typed read of an untagged entry versus the
    // tagged read plus in-memory upgrade that every new entry now takes.
    let untagged_decode = measure(&env, || {
        env.as_contract(&f.contract_id, || {
            let data: EscrowData = env
                .storage()
                .persistent()
                .get(&DataKey::Escrow(legacy))
                .unwrap();
            assert_eq!(data.amount, 100);
        });
    });
    let tagged_decode = measure(&env, || {
        env.as_contract(&f.contract_id, || {
            let stored: StoredEscrow = env
                .storage()
                .persistent()
                .get(&DataKey::Escrow(tagged))
                .unwrap();
            assert_eq!(upgrade(stored).amount, 100);
        });
    });

    // Whole entry point: `get_escrow` on a legacy entry versus a tagged one.
    let get_legacy = measure(&env, || {
        f.client.get_escrow(&legacy);
    });
    let get_tagged = measure(&env, || {
        f.client.get_escrow(&tagged);
    });

    println!(
        "decode untagged (pre-#37): cpu_insns={}, memory_bytes={}",
        untagged_decode.cpu, untagged_decode.mem
    );
    println!(
        "decode tagged V1 + upgrade: cpu_insns={}, memory_bytes={}",
        tagged_decode.cpu, tagged_decode.mem
    );
    println!(
        "get_escrow legacy entry: cpu_insns={}, memory_bytes={}",
        get_legacy.cpu, get_legacy.mem
    );
    println!(
        "get_escrow tagged entry: cpu_insns={}, memory_bytes={}",
        get_tagged.cpu, get_tagged.mem
    );

    // Regression guard: the tag must stay a small fraction of a read.
    assert!(tagged_decode.cpu <= untagged_decode.cpu * 5 / 4);
    assert!(get_tagged.cpu <= get_legacy.cpu * 5 / 4);
}
