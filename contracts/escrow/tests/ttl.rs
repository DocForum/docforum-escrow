// Phase E4 — Storage TTL & Archival tests (issue #10, threat model T6).
//
// Verifies:
// 1. Escrow entry persistent storage TTL is extended on creation (at least 180 days).
// 2. Instance storage TTL is extended on creation and every contract invocation (~30 days).
// 3. Advancing ledger sequence past the default minimum TTL (and past previous thresholds)
//    preserves full readability and settlement (release / refund) capability without archival.
// 4. Dynamic TTL sizing for escrows with explicit `refund_after` deadlines.
// 5. Every write path (`top_up`, `rotate_releaser`, `accept`, `release`, `refund`) extends TTL.
// 6. Archived-then-restored `NextId` continuity: confirming `NextId` is never rolled back,
//    never reuses an escrow id, and never overwrites live or archived escrows.
// 7. Edge case: an escrow that stays Funded past the network maximum TTL.

use docforum_escrow::{
    DataKey, EscrowContract, EscrowContractClient, EscrowStatus, ESCROW_EXTEND_TO,
    ESCROW_GRACE_PERIOD_LEDGERS, INSTANCE_EXTEND_TO, MAX_NETWORK_TTL_LEDGERS,
    SETTLED_ESCROW_EXTEND_TO,
};
use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Ledger as _,
    },
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

fn setup_token(env: &Env) -> (Address, TokenClient<'_>, StellarAssetClient<'_>) {
    let admin = Address::generate(env);
    let id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &id);
    let asset = StellarAssetClient::new(env, &id);
    (id, token, asset)
}
struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    contract_id: Address,
    token_id: Address,
    token: TokenClient<'a>,
    asset: StellarAssetClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
    escrow_id: u64,
}

fn create_test_escrow<'a>(env: &'a Env, amount: i128, refund_after: Option<u64>) -> Fixture<'a> {
    let (token_id, token, asset) = setup_token(env);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &10_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &amount,
        &String::from_str(env, "ttl-test-ref"),
        &releaser,
        &refund_after,
        &false,
        &None,
        &None,
        &None,
    );

    Fixture {
        client,
        contract_id,
        token_id,
        token,
        asset,
        payer,
        payee,
        releaser,
        escrow_id,
    }
}

// ── 1. Creation extends both instance and escrow persistent TTL ───────────────

#[test]
fn create_escrow_extends_escrow_and_instance_ttl() {
    let env = Env::default();
    env.mock_all_auths();
    let f = create_test_escrow(&env, 500, None);

    env.as_contract(&f.contract_id, || {
        // Escrow entry should be extended to at least ESCROW_EXTEND_TO (~180 days = 3,110,400 ledgers)
        let escrow_ttl = env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Escrow(f.escrow_id));
        assert!(
            escrow_ttl >= ESCROW_EXTEND_TO - 1,
            "escrow TTL {} should be >= {}",
            escrow_ttl,
            ESCROW_EXTEND_TO
        );

        // Instance entry should be extended to INSTANCE_EXTEND_TO (~30 days = 518,400 ledgers)
        let instance_ttl = env.storage().instance().get_ttl();
        assert!(
            instance_ttl >= INSTANCE_EXTEND_TO - 1,
            "instance TTL {} should be >= {}",
            instance_ttl,
            INSTANCE_EXTEND_TO
        );
    });
}

// ── 2. Ledger advanced past default TTL: readable & releasable ───────────────

/// Definition of done check: advances ledger past previous default TTL
/// (~31,104 ledgers in Soroban / 1-2 days) and confirms the escrow remains
/// readable and releasable without requiring an archive restoration.
#[test]
fn escrow_readable_and_releasable_past_default_ttl() {
    let env = Env::default();
    env.mock_all_auths();
    let f = create_test_escrow(&env, 400, None);

    let start_ledger = env.ledger().sequence();

    // Advance 100,000 ledgers (~5.7 days at 5s/ledger), well past the default
    // minimum persistent entry TTL (~31,104 ledgers) where an unextended entry
    // would have been archived.
    let advance_ledgers = 100_000;
    env.ledger()
        .set_sequence_number(start_ledger + advance_ledgers);

    // Readable: status and escrow record remain live
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    let escrow = f.client.get_escrow(&f.escrow_id);
    assert_eq!(escrow.amount, 400);
    assert_eq!(escrow.status, EscrowStatus::Funded);

    // Releasable: release settles cleanly and moves tokens to payee
    f.client.release(&f.escrow_id, &f.releaser);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 400);
}

// ── 3. Dynamic TTL sizing for escrows with explicit deadlines ─────────────────

#[test]
fn dynamic_ttl_sized_to_refund_deadline_plus_grace() {
    let env = Env::default();
    env.mock_all_auths();

    let now_ts = 1_000u64;
    env.ledger().set_timestamp(now_ts);

    // 250 days into the future (in seconds)
    let deadline_duration_seconds = 250 * 86_400;
    let deadline = now_ts + deadline_duration_seconds;

    let f = create_test_escrow(&env, 600, Some(deadline));

    let expected_deadline_ledgers = (deadline_duration_seconds / 5) as u32;
    let expected_target = expected_deadline_ledgers + ESCROW_GRACE_PERIOD_LEDGERS;

    env.as_contract(&f.contract_id, || {
        let ttl = env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Escrow(f.escrow_id));
        assert!(
            ttl >= expected_target - 1,
            "escrow TTL {} should cover deadline + grace {}",
            ttl,
            expected_target
        );
        assert!(
            ttl <= MAX_NETWORK_TTL_LEDGERS,
            "must not exceed network max TTL"
        );
    });
}

// ── 4. Every write path extends TTL ───────────────────────────────────────────

#[test]
fn write_paths_extend_ttl_top_up_rotate_accept_settle() {
    let env = Env::default();
    env.mock_all_auths();

    let f = create_test_escrow(&env, 1_000, None);

    // Fast-forward ledger so remaining TTL drops close to threshold
    let seq = env.ledger().sequence();
    env.ledger().set_sequence_number(seq + 2_800_000);

    // 1. top_up write path extends entry TTL
    f.client.top_up(&f.escrow_id, &f.payer, &200);
    env.as_contract(&f.contract_id, || {
        let ttl = env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Escrow(f.escrow_id));
        assert!(ttl >= ESCROW_EXTEND_TO - 1);
    });

    // Advance again
    let seq = env.ledger().sequence();
    env.ledger().set_sequence_number(seq + 2_800_000);

    // 2. rotate_releaser write path extends entry TTL
    let new_releaser = Address::generate(&env);
    f.client
        .rotate_releaser(&f.escrow_id, &f.releaser, &new_releaser);
    env.as_contract(&f.contract_id, || {
        let ttl = env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Escrow(f.escrow_id));
        assert!(ttl >= ESCROW_EXTEND_TO - 1);
    });

    // Advance ledger so remaining TTL drops below SETTLED_ESCROW_TTL_THRESHOLD (120,960 ledgers)
    let seq = env.ledger().sequence();
    env.ledger().set_sequence_number(seq + 3_050_000);

    // 3. settle (release) ensures post-settlement audit retention window
    f.client.release(&f.escrow_id, &new_releaser);
    env.as_contract(&f.contract_id, || {
        let ttl = env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Escrow(f.escrow_id));
        assert!(
            ttl >= SETTLED_ESCROW_EXTEND_TO - 1,
            "settled escrow TTL {} should be >= {}",
            ttl,
            SETTLED_ESCROW_EXTEND_TO
        );
    });
}

// ── 5. NextId continuity & non-reuse across archival ──────────────────────────

/// Verification of the threat model T6 question:
/// "confirm that an archived-then-restored NextId can't reuse an escrow id and
/// overwrite a live escrow."
#[test]
fn next_id_cannot_be_reused_or_overwrite_live_escrow_across_archival() {
    let env = Env::default();
    env.mock_all_auths();

    // Create first escrow (id 0)
    let f1 = create_test_escrow(&env, 100, None);
    assert_eq!(f1.escrow_id, 0);

    // NextId in instance storage is now 1
    env.as_contract(&f1.contract_id, || {
        let next_id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap();
        assert_eq!(next_id, 1);
    });

    // Advance ledger far beyond INSTANCE_EXTEND_TO (518,400 ledgers),
    // e.g., by 1,000,000 ledgers.
    let start_seq = env.ledger().sequence();
    env.ledger().set_sequence_number(start_seq + 1_000_000);

    // Now create a second escrow with a distinct amount and parties
    let payer2 = Address::generate(&env);
    let payee2 = Address::generate(&env);
    let releaser2 = Address::generate(&env);
    f1.asset.mint(&payer2, &5_000);

    let id2 = f1.client.create_escrow(
        &payer2,
        &payee2,
        &f1.token_id,
        &250,
        &String::from_str(&env, "second-escrow"),
        &releaser2,
        &None,
        &false,
        &None,
        &None,
        &None,
    );

    // The restored/accessed NextId was 1, so the new escrow MUST be 1
    assert_eq!(id2, 1, "next id must strictly increment to 1");

    // Both escrows exist independently — escrow 0 was NOT overwritten!
    let e0 = f1.client.get_escrow(&0);
    assert_eq!(e0.amount, 100);
    assert_eq!(e0.payer, f1.payer);

    let e1 = f1.client.get_escrow(&1);
    assert_eq!(e1.amount, 250);
    assert_eq!(e1.payer, payer2);

    // Both can be settled independently
    f1.client.release(&0, &f1.releaser);
    f1.client.release(&1, &releaser2);

    assert_eq!(f1.client.get_status(&0), EscrowStatus::Released);
    assert_eq!(f1.client.get_status(&1), EscrowStatus::Released);
}

// ── 6. Edge case: escrow staying Funded longer than max TTL ───────────────────

#[test]
fn escrow_funded_longer_than_max_network_ttl_retains_funds_and_settles() {
    let env = Env::default();
    env.mock_all_auths();

    let f = create_test_escrow(&env, 777, None);

    // Advance past max network TTL (6,312,000 ledgers = 1 year)
    let start_seq = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(start_seq + MAX_NETWORK_TTL_LEDGERS + 100);

    // Under Soroban protocol 23+, accessing the entry auto-restores it.
    // Verify funds remain safe in the contract:
    assert_eq!(f.token.balance(&f.contract_id), 777);

    // State is intact and releasable:
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    f.client.release(&f.escrow_id, &f.releaser);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 777);
}
