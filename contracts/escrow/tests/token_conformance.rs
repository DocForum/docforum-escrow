// Token conformance suite (issue #133, Phase E7).
//
// The contract claims to work with any SEP-41 token. This suite runs the
// whole escrow lifecycle against each kind of token implementation:
//
//   * the Stellar Asset Contract for the native asset (XLM),
//   * the Stellar Asset Contract for an issued asset, with no issuer flags,
//   * a custom SEP-41 token contract (an OpenZeppelin-style Wasm token),
//     with 7 decimals and with 6 decimals.
//
// Every lifecycle case below is generated once per token kind, so a token that
// behaves differently from the others fails a test that names it.
//
// The behaviour differences between the implementations, and the tokens we
// recommend to integrators, are written up in `docs/token-conformance.md`.

mod conformance;

use conformance::{TokenKind, TokenUnderTest};
use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, Address, Env, String, Vec,
};

/// Generates the lifecycle suite for one token implementation.
///
/// The token kind is the only thing that changes between the generated
/// modules — every case runs the same assertions against a different token.
macro_rules! token_suite {
    ($module:ident, $kind:expr) => {
        mod $module {
            use super::conformance::{self, TokenKind};

            #[test]
            fn create_escrow_locks_funds_and_reports_funded() {
                conformance::create_locks_funds_and_reports_funded($kind);
            }

            #[test]
            fn release_pays_the_payee() {
                conformance::release_pays_the_payee($kind);
            }

            #[test]
            fn release_rejects_a_second_settlement() {
                conformance::release_rejects_a_second_settlement($kind);
            }

            #[test]
            fn release_rejects_a_stranger() {
                conformance::release_rejects_a_stranger($kind);
            }

            #[test]
            fn refund_returns_funds_to_the_payer() {
                conformance::refund_returns_funds_to_the_payer($kind);
            }

            #[test]
            fn refund_rejects_a_stranger() {
                conformance::refund_rejects_a_stranger($kind);
            }

            #[test]
            fn refund_after_release_is_rejected() {
                conformance::refund_after_release_is_rejected($kind);
            }

            #[test]
            fn top_up_adds_funds_to_a_funded_escrow() {
                conformance::top_up_adds_funds_to_a_funded_escrow($kind);
            }

            #[test]
            fn payee_acceptance_gates_the_release() {
                conformance::payee_acceptance_gates_the_release($kind);
            }

            #[test]
            fn quorum_release_needs_distinct_approvals() {
                conformance::quorum_release_needs_distinct_approvals($kind);
            }

            #[test]
            fn timeout_refund_opens_to_anyone_after_the_deadline() {
                conformance::timeout_refund_opens_to_anyone_after_the_deadline($kind);
            }

            #[test]
            fn the_amount_is_an_opaque_integer_unit() {
                conformance::the_amount_is_an_opaque_integer_unit($kind);
            }

            #[test]
            fn an_account_payer_needs_a_trustline_only_for_credit_assets() {
                conformance::an_account_payer_needs_a_trustline_only_for_credit_assets($kind);
            }

            #[test]
            fn a_payee_that_cannot_hold_the_asset_is_not_paid() {
                conformance::a_payee_that_cannot_hold_the_asset_is_not_paid($kind);
            }
        }
    };
}

token_suite!(native_sac, TokenKind::NativeSac);
token_suite!(issued_sac, TokenKind::IssuedSac);
token_suite!(custom_sep41_7, TokenKind::CustomSep41 { decimals: 7 });
token_suite!(custom_sep41_6, TokenKind::CustomSep41 { decimals: 6 });

/// The "native SAC" of the matrix is the very contract address integrators
/// use for XLM — the same on every network, because the contract id is
/// derived from the native asset itself.
#[test]
fn the_native_asset_contract_is_the_canonical_one() {
    let env = Env::default();
    let address = conformance::register_native_sac(&env);

    assert_eq!(
        soroban_sdk::xdr::ScAddress::from(&address).to_string(),
        "CB56OQJZFJXSSKFK3MXJZ4TLJAJFWH6KXN6BAWHQSJDZPHZFVBJ353HU"
    );
}

/// The escrow never rescales an amount: whatever the token's decimals are,
/// the number the caller passes is the number that moves.
///
/// This is the decimals edge case of issue #133. The Stellar Asset Contract
/// is 7-decimal by construction, so a custom implementation is the only way
/// to exercise a token with a different number of decimals.
#[test]
fn amounts_pass_through_unchanged_for_every_decimals_setting() {
    let env = Env::default();
    env.mock_all_auths();

    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);

    for decimals in [0u32, 2, 6, 9, 18] {
        let token = TokenUnderTest::register(&env, TokenKind::CustomSep41 { decimals });
        assert_eq!(token.decimals(), decimals);

        token.fund(&payer, 10);
        let escrow_id = client.create_escrow(
            &payer,
            &payee,
            token.address(),
            &1,
            &String::from_str(&env, "decimals-ref"),
            &releaser,
            &None,
            &false,
        );

        assert_eq!(client.get_escrow(&escrow_id).amount, 1);
        assert_eq!(token.balance(&contract_id), 1);

        client.release(&escrow_id, &releaser);
        assert_eq!(token.balance(&payee), 1);
    }
}

// --- a token whose destination type is not SEP-41's ---

#[contracttype]
#[derive(Clone)]
enum LegacyKey {
    Balance(Address),
}

/// A token that looks like SEP-41 but is not quite: its `transfer` takes a
/// plain `Address` destination where SEP-41 (and the Stellar Asset Contract)
/// take a `MuxedAddress`.
///
/// The escrow still works with it: the contract never pays a muxed
/// destination, so it always hands the token a plain address, which this
/// token accepts. The test pins that — it is the one place where "almost
/// SEP-41" is good enough for this contract, and the one place where it is
/// still not a conformant token (it cannot receive muxed payments).
#[contract]
pub struct LegacyStyleToken;

#[contractimpl]
impl LegacyStyleToken {
    pub fn balance(env: Env, id: Address) -> i128 {
        Self::balance_of(&env, &id)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let current = Self::balance_of(&env, &to);
        env.storage()
            .persistent()
            .set(&LegacyKey::Balance(to), &(current + amount));
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let from_balance = Self::balance_of(&env, &from);
        let to_balance = Self::balance_of(&env, &to);
        env.storage()
            .persistent()
            .set(&LegacyKey::Balance(from), &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&LegacyKey::Balance(to), &(to_balance + amount));
    }

    fn balance_of(env: &Env, id: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&LegacyKey::Balance(id.clone()))
            .unwrap_or(0)
    }
}

#[test]
fn a_token_that_takes_a_plain_address_destination_still_works() {
    let env = Env::default();
    env.mock_all_auths();

    let token_id = env.register(LegacyStyleToken, ());
    let token = LegacyStyleTokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    token.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "legacy-destination-ref"),
        &releaser,
        &None,
        &false,
    );

    assert_eq!(token.balance(&payer), 700);
    assert_eq!(token.balance(&contract_id), 300);

    client.release(&escrow_id, &releaser);

    assert_eq!(token.balance(&payee), 300);
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Released);
}
