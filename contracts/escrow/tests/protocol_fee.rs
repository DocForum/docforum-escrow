// Phase E5 tests (issue #30) — optional protocol fee, fixed at creation
// and taken at release (docs/adr/0010). Per AGENTS.md hard rule 2:
// contract logic changes need tests here in the same PR.
//
// What the issue asks to be pinned down, and the ADR decisions backing
// each:
//   - fee (recipient + bps) taken at release, remainder to the payee;
//     the two transfers always sum to exactly the stored `amount` (the
//     reviewer's check; invariant I7, ADR 0010 decisions 4 and 7).
//   - fee rounded down; remainder stays with the payee (decision 3) —
//     including rounding all the way to zero for tiny amounts.
//   - bps capped at MAX_FEE_BPS = 1 000 (10 %); bps = 0 allowed
//     (decision 2).
//   - recipient must not be the escrow contract itself (decision 5) but
//     may be any other address, including the payee.
//   - refunds (releaser or post-deadline stranger) return the FULL
//     amount — no fee on the refund path (decision 6).
//   - fee readable from get_escrow before relying on the escrow.
//   - `top_up` grows the escrowed amount, so the bps fee grows with it;
//     the larger fee math is re-checked before the top-up transfer.

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus, MAX_FEE_BPS};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

const CREATED_AT: u64 = 1_000;
const DEADLINE: u64 = 1_100;
/// 10 % of the escrowed amount.
const TEN_PCT: u32 = 1_000;

fn setup<'a>(env: &Env) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &contract_id.address());
    let asset = StellarAssetClient::new(env, &contract_id.address());
    (contract_id.address(), token, asset)
}

fn deploy(env: &Env) -> (Address, EscrowContractClient<'_>) {
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env), None::<Address>));
    (
        contract_id.clone(),
        EscrowContractClient::new(env, &contract_id),
    )
}

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    contract_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    fee_recipient: Address,
    escrow_id: u64,
}

/// Creates a `Funded` escrow of `amount` with the given optional fee
/// (recipient = fresh `fee_recipient`), the payer pre-minted 1_000.
fn fund_escrow(env: &Env, amount: i128, fee_bps: Option<u32>) -> Fixture<'_> {
    env.ledger().set_timestamp(CREATED_AT);

    let (token_id, token, asset) = setup(env);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    let fee_recipient = Address::generate(env);
    asset.mint(&payer, &1_000);

    let (contract_id, client) = deploy(env);

    // The fee is one (recipient, bps) pair: `fee_bps = None` means no
    // fee at all — both args must be `None` or creation would reject.
    let (fee_recipient_arg, fee_bps_arg) = match fee_bps {
        Some(bps) => (Some(fee_recipient.clone()), Some(bps)),
        None => (None, None),
    };

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &amount,
        &String::from_str(env, "opaque-condition-ref"),
        &releaser,
        &None,
        &false,
        &None,
        &fee_recipient_arg,
        &fee_bps_arg,
    );

    Fixture {
        client,
        token,
        contract_id,
        payer,
        payee,
        releaser,
        fee_recipient,
        escrow_id,
    }
}

// --- release splits off the fee (the reviewer's sum invariant) ---

#[test]
fn release_with_fee_pays_recipient_and_remainder_summing_to_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300, Some(TEN_PCT));

    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.fee_recipient), 30); // 10 % of 300
    assert_eq!(f.token.balance(&f.payee), 270); // the remainder
                                                // Fee + payout == the released amount exactly: no dust lost.
    assert_eq!(
        f.token.balance(&f.fee_recipient) + f.token.balance(&f.payee),
        300
    );
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

#[test]
fn escrow_without_fee_pays_the_full_amount_to_the_payee_as_before() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300, None);

    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.fee_recipient), 0);
    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

// --- rounding: fee floors, remainder stays with the payee ---

#[test]
fn fee_rounds_down_and_the_remainder_stays_with_the_payee() {
    let env = Env::default();
    env.mock_all_auths();
    // 10 % of 305 is 30.5 — floored to 30, and the extra half-token
    // stays with the payee (docs/adr/0010, decision 3).
    let f = fund_escrow(&env, 305, Some(TEN_PCT));

    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.fee_recipient), 30);
    assert_eq!(f.token.balance(&f.payee), 275);
    assert_eq!(
        f.token.balance(&f.fee_recipient) + f.token.balance(&f.payee),
        305
    );
}

#[test]
fn fee_floored_to_zero_gives_the_payee_everything() {
    let env = Env::default();
    env.mock_all_auths();
    // 10 % of 9 is 0.9, floored to 0: no fee transfer happens at all and
    // the tiny escrow still releases fine (docs/adr/0010, decision 3).
    let f = fund_escrow(&env, 9, Some(TEN_PCT));

    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.fee_recipient), 0);
    assert_eq!(f.token.balance(&f.payee), 9);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

// --- bps cap and allowed values ---

#[test]
fn create_escrow_rejects_fee_bps_above_the_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let (contract_id, client) = deploy(&env);

    // Just past the cap, and far past it: both reject as InvalidFee.
    let over_cap = (Some(fee_recipient.clone()), Some(MAX_FEE_BPS + 1));
    let way_over = (Some(fee_recipient.clone()), Some(10_000));

    let over = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "ref-over"),
        &releaser,
        &None,
        &false,
        &None,
        &over_cap.0,
        &over_cap.1,
    );
    let way = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "ref-way"),
        &releaser,
        &None,
        &false,
        &None,
        &way_over.0,
        &way_over.1,
    );

    assert_eq!(over, Err(Ok(Error::InvalidFee)));
    assert_eq!(way, Err(Ok(Error::InvalidFee)));
    // Rejected creations locked nothing and created nothing.
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
    assert!(client.try_get_status(&0).is_err());
}

#[test]
fn create_escrow_rejects_a_fee_recipient_without_a_rate_and_vice_versa() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let (_, client) = deploy(&env);

    // A coherent fee is one (recipient, bps) pair: half a pair is not a
    // fee anyone can read or predict (docs/adr/0010, decision 1).
    let recipient_only = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "ref-half-a"),
        &releaser,
        &None,
        &false,
        &None,
        &Some(fee_recipient.clone()),
        &None,
    );
    let bps_only = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "ref-half-b"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &Some(TEN_PCT),
    );

    assert_eq!(recipient_only, Err(Ok(Error::InvalidFee)));
    assert_eq!(bps_only, Err(Ok(Error::InvalidFee)));
    // Rejected creations locked nothing.
    assert_eq!(token.balance(&payer), 1_000);
    assert!(client.try_get_status(&0).is_err());
}

#[test]
fn create_escrow_accepts_fee_bps_at_the_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300, Some(MAX_FEE_BPS)); // exactly 10 %
    let data = f.client.get_escrow(&f.escrow_id);

    assert_eq!(data.fee_bps, Some(MAX_FEE_BPS));
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

#[test]
fn fee_bps_zero_is_accepted_and_transfers_nothing() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300, Some(0));

    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.fee_recipient), 0);
    assert_eq!(f.token.balance(&f.payee), 300);
}

// --- recipient validated, but otherwise any address ---

#[test]
fn create_escrow_rejects_fee_recipient_equal_to_the_contract_itself() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let (contract_id, client) = deploy(&env);

    let fee = (Some(contract_id.clone()), Some(TEN_PCT));

    let result = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "ref-self"),
        &releaser,
        &None,
        &false,
        &None,
        &fee.0,
        &fee.1,
    );

    assert_eq!(result, Err(Ok(Error::InvalidFee)));
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
fn fee_recipient_may_be_the_payee_and_receives_both_payouts() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(CREATED_AT);

    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let (contract_id, client) = deploy(&env);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "ref-payee"),
        &releaser,
        &None,
        &false,
        &None,
        &Some(payee.clone()),
        &Some(TEN_PCT),
    );

    client.release(&escrow_id, &releaser);

    // The fee transfer and the remainder both land on the same address.
    assert_eq!(token.balance(&payee), 300);
    assert_eq!(token.balance(&contract_id), 0);
}

// --- fees are validated before funds are locked ---

#[test]
fn create_escrow_rejects_fee_math_overflow_before_locking_anything() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let (contract_id, client) = deploy(&env);

    // An amount so large that amount × 1000 exceeds i128 — checked at
    // creation (ADR 0010, decision 3), before the funding transfer.
    let result = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &i128::MAX,
        &String::from_str(&env, "ref-overflow"),
        &releaser,
        &None,
        &false,
        &None,
        &Some(fee_recipient),
        &Some(MAX_FEE_BPS),
    );

    assert_eq!(result, Err(Ok(Error::InvalidFee)));
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
}

// --- top-ups grow the escrowed amount, so they grow the bps fee ---

#[test]
fn top_up_increases_the_fee_taken_at_release() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300, Some(TEN_PCT));

    f.client.top_up(&f.escrow_id, &f.payer, &100);
    f.client.release(&f.escrow_id, &f.releaser);

    // 10 % of the topped-up 400.
    assert_eq!(f.token.balance(&f.fee_recipient), 40);
    assert_eq!(f.token.balance(&f.payee), 360);
    assert_eq!(
        f.token.balance(&f.fee_recipient) + f.token.balance(&f.payee),
        400
    );
}

#[test]
fn top_up_rejects_fee_math_overflow_before_transferring() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300, Some(MAX_FEE_BPS));

    // amount + top-up is representable, but the sum × bps is not: reject
    // the top-up before any funds move rather than fail the later release.
    let huge = i128::MAX / i128::from(MAX_FEE_BPS) + 1;
    let result = f.client.try_top_up(&f.escrow_id, &f.payer, &huge);

    assert_eq!(result, Err(Ok(Error::InvalidFee)));
    assert_eq!(f.token.balance(&f.contract_id), 300);
    assert_eq!(f.token.balance(&f.payee), 0);
}

// --- refunds never take the fee (ADR 0010, decision 6) ---

#[test]
fn releaser_refund_returns_the_full_amount_with_no_fee() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300, Some(TEN_PCT));

    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payer), 1_000); // the full 300 back
    assert_eq!(f.token.balance(&f.fee_recipient), 0); // never touched
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
}

#[test]
fn timeout_refund_by_a_stranger_also_returns_the_full_amount_with_no_fee() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(CREATED_AT);

    // Like fund_escrow, but with a `refund_after` deadline set, so the
    // post-deadline stranger refund is open (docs/adr/0004).
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let (contract_id, client) = deploy(&env);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "opaque-condition-ref"),
        &releaser,
        &Some(DEADLINE),
        &false,
        &None,
        &Some(fee_recipient.clone()),
        &Some(TEN_PCT),
    );
    let stranger = Address::generate(&env);

    env.ledger().set_timestamp(DEADLINE + 1);
    client.refund(&escrow_id, &stranger);

    assert_eq!(token.balance(&payer), 1_000); // full 300 back
    assert_eq!(token.balance(&fee_recipient), 0);
    assert_eq!(token.balance(&payee), 0);
    assert_eq!(token.balance(&contract_id), 0);
}

// --- fee is readable before relying on the escrow ---

#[test]
fn get_escrow_exposes_the_fee_exactly_as_declared_at_creation() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 305, Some(TEN_PCT));

    let data = f.client.get_escrow(&f.escrow_id);

    assert_eq!(data.fee_bps, Some(TEN_PCT));
    assert_eq!(data.fee_recipient, Some(f.fee_recipient));
}

#[test]
fn get_escrow_reports_no_fee_when_none_was_set() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300, None);

    let data = f.client.get_escrow(&f.escrow_id);

    assert_eq!(data.fee_recipient, None);
    assert_eq!(data.fee_bps, None);
}
