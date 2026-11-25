use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use docforum_payee_callback::PayeeCallbackClient;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

struct Fixture<'a> {
    escrow: EscrowContractClient<'a>,
    payee: PayeeCallbackClient<'a>,
    payee_address: Address,
    token: TokenClient<'a>,
    payer: Address,
    releaser: Address,
    id: u64,
}

fn fixture(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(&env, &token_id.address());
    let asset = StellarAssetClient::new(&env, &token_id.address());
    let payer = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let payee_address = env.register(docforum_payee_callback::PayeeCallback, ());
    let payee = PayeeCallbackClient::new(&env, &payee_address);
    let escrow_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let escrow = EscrowContractClient::new(&env, &escrow_id);
    let id = escrow.create_escrow(
        &payer,
        &payee_address,
        &token_id.address(),
        &300,
        &String::from_str(&env, "callback-example"),
        &releaser,
        &None,
        &true,
        &None,
        &None,
        &None,
    );
    // The payee must recognise the escrow before it accepts the payout.
    payee.register_escrow(&id);

    Fixture {
        escrow,
        payee,
        payee_address,
        token,
        payer,
        releaser,
        id,
    }
}

#[test]
fn opted_in_contract_payee_receives_release_callback() {
    let env = Env::default();
    let f = fixture(&env);
    f.escrow.release(&f.id, &f.releaser);
    assert_eq!(f.escrow.get_status(&f.id), EscrowStatus::Released);
    assert_eq!(f.payee.last_payout(), (f.id, 300));
    assert_eq!(f.payee.total_received(), 300);
    assert_eq!(f.token.balance(&f.payee_address), 300);
}

#[test]
fn release_with_fee_pays_net_amount_to_callback() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(&env, &token_id.address());
    let asset = StellarAssetClient::new(&env, &token_id.address());
    let fee_recipient = Address::generate(&env);
    let payer = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let payee_address = env.register(docforum_payee_callback::PayeeCallback, ());
    let payee = PayeeCallbackClient::new(&env, &payee_address);
    let escrow_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let escrow = EscrowContractClient::new(&env, &escrow_id);
    // 100 bps (1%) fee: 300 amount -> 3 fee, 297 to payee.
    let id = escrow.create_escrow(
        &payer,
        &payee_address,
        &token_id.address(),
        &300,
        &String::from_str(&env, "fee-example"),
        &releaser,
        &None,
        &true,
        &None,
        &Some(fee_recipient.clone()),
        &Some(100u32),
    );
    payee.register_escrow(&id);

    escrow.release(&id, &releaser);
    assert_eq!(escrow.get_status(&id), EscrowStatus::Released);
    // Callback receives the net amount (300 - floor(300*100/10000)=3).
    assert_eq!(payee.last_payout(), (id, 297));
    assert_eq!(payee.total_received(), 297);
    assert_eq!(token.balance(&fee_recipient), 3);
}

#[test]
fn callback_error_reverts_release_but_refund_still_works() {
    let env = Env::default();
    let f = fixture(&env);
    f.payee.set_reject(&true);
    assert_eq!(
        f.escrow.try_release(&f.id, &f.releaser),
        Err(Ok(Error::CallbackFailed))
    );
    // The release reverted: escrow stays funded and the payee received nothing.
    assert_eq!(f.escrow.get_status(&f.id), EscrowStatus::Funded);
    assert_eq!(f.payee.last_payout(), (0, 0));
    assert_eq!(f.token.balance(&f.payer), 700);
    // Refund still works and recovers the funds.
    f.escrow.refund(&f.id, &f.releaser);
    assert_eq!(f.escrow.get_status(&f.id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

#[test]
fn unknown_escrow_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(&env, &token_id.address());
    let asset = StellarAssetClient::new(&env, &token_id.address());
    let payer = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let payee_address = env.register(docforum_payee_callback::PayeeCallback, ());
    let payee = PayeeCallbackClient::new(&env, &payee_address);
    // NOTE: this payee registers NO escrows, so every callback is unknown.
    let escrow_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let escrow = EscrowContractClient::new(&env, &escrow_id);
    let id = escrow.create_escrow(
        &payer,
        &payee_address,
        &token_id.address(),
        &300,
        &String::from_str(&env, "unknown-example"),
        &releaser,
        &None,
        &true,
        &None,
        &None,
        &None,
    );

    assert_eq!(
        escrow.try_release(&id, &releaser),
        Err(Ok(Error::CallbackFailed))
    );
    assert_eq!(escrow.get_status(&id), EscrowStatus::Funded);
    assert_eq!(payee.total_received(), 0);
    let _ = token;
    let _ = asset;
}
