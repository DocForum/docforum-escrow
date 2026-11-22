// Phase E4 tests (issue #300): role overlaps are intentional configuration,
// not validation errors. Each test covers one pair in the T8 matrix.

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

#[derive(Clone, Copy)]
enum Overlap {
    PayerPayee,
    PayerReleaser,
    PayerRefundTo,
    PayerFeeRecipient,
    PayeeReleaser,
    PayeeRefundTo,
    PayeeFeeRecipient,
    ReleaserRefundTo,
    ReleaserFeeRecipient,
    RefundToFeeRecipient,
}

fn assert_overlap_is_allowed(overlap: Overlap, settle_as_refund: bool) {
    let env = Env::default();
    env.mock_all_auths();

    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);

    let payer = Address::generate(&env);
    let mut payee = Address::generate(&env);
    let mut releaser = Address::generate(&env);
    let mut refund_to = Address::generate(&env);
    let mut fee_recipient = Address::generate(&env);

    match overlap {
        Overlap::PayerPayee => payee = payer.clone(),
        Overlap::PayerReleaser => releaser = payer.clone(),
        Overlap::PayerRefundTo => refund_to = payer.clone(),
        Overlap::PayerFeeRecipient => fee_recipient = payer.clone(),
        Overlap::PayeeReleaser => releaser = payee.clone(),
        Overlap::PayeeRefundTo => refund_to = payee.clone(),
        Overlap::PayeeFeeRecipient => fee_recipient = payee.clone(),
        Overlap::ReleaserRefundTo => refund_to = releaser.clone(),
        Overlap::ReleaserFeeRecipient => fee_recipient = releaser.clone(),
        Overlap::RefundToFeeRecipient => fee_recipient = refund_to.clone(),
    }

    asset.mint(&payer, &1_000);
    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(&env),
            Address::generate(&env),
            soroban_sdk::Vec::<(Address, i128)>::new(&env),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client
        .try_create_escrow(
            &payer,
            &payee,
            &token_id,
            &100,
            &String::from_str(&env, "issue-300"),
            &releaser,
            &None,
            &false,
            &Some(refund_to),
            &Some(fee_recipient),
            &Some(1_000),
        )
        .expect("contract invocation must complete")
        .expect("documented role overlap must be accepted");

    if settle_as_refund {
        client.refund(&id, &releaser);
    } else {
        client.release(&id, &releaser);
    }
    assert_eq!(
        client.get_status(&id),
        if settle_as_refund {
            EscrowStatus::Refunded
        } else {
            EscrowStatus::Released
        }
    );
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
fn payer_and_payee_overlap_is_allowed() {
    assert_overlap_is_allowed(Overlap::PayerPayee, false);
}

#[test]
fn payer_and_releaser_overlap_is_allowed() {
    assert_overlap_is_allowed(Overlap::PayerReleaser, false);
}

#[test]
fn payer_and_refund_to_overlap_is_allowed() {
    assert_overlap_is_allowed(Overlap::PayerRefundTo, true);
}

#[test]
fn payer_and_fee_recipient_overlap_is_allowed() {
    assert_overlap_is_allowed(Overlap::PayerFeeRecipient, false);
}

#[test]
fn payee_and_releaser_overlap_is_allowed() {
    assert_overlap_is_allowed(Overlap::PayeeReleaser, false);
}

#[test]
fn payee_and_refund_to_overlap_is_allowed() {
    assert_overlap_is_allowed(Overlap::PayeeRefundTo, true);
}

#[test]
fn payee_and_fee_recipient_overlap_is_allowed() {
    assert_overlap_is_allowed(Overlap::PayeeFeeRecipient, false);
}

#[test]
fn releaser_and_refund_to_overlap_is_allowed() {
    assert_overlap_is_allowed(Overlap::ReleaserRefundTo, true);
}

#[test]
fn releaser_and_fee_recipient_overlap_is_allowed() {
    assert_overlap_is_allowed(Overlap::ReleaserFeeRecipient, false);
}

#[test]
fn refund_to_and_fee_recipient_overlap_is_allowed() {
    assert_overlap_is_allowed(Overlap::RefundToFeeRecipient, true);
}
