//! Token conformance suite (issue #133).
//!
//! The escrow contract accepts any SEP-41 token, but most tests use one
//! issued-asset Stellar Asset Contract (SAC). This suite runs the same
//! lifecycle scenarios against every token implementation we can exercise in
//! the test environment, so the "any SEP-41 token" claim is checked, not
//! assumed. Per-token differences are tabulated in `docs/token-conformance.md`.
//!
//! Token kinds:
//! - `NativeSac`: the built-in SAC for native XLM (7 decimals, balances of
//!   accounts live in account entries, contract balances in contract data).
//! - `IssuedSac`: a SAC for an issued asset with no issuer flags (7 decimals).
//!   Issuer-flag edge cases (clawback, auth required) are out of scope here.
//! - `Custom(d)`: a plain contract-implemented SEP-41 token (`ReferenceToken`
//!   below) with `d` decimals. 0, 6 and 18 are run so decimals other than 7
//!   are covered.
//!
//! Every scenario is a function taking a `Token` and is run for every kind by
//! the `conformance!` macro, so adding a kind adds it to every scenario.

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus, SettleAction};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    xdr, Address, Env, IntoVal, MuxedAddress, String, TryIntoVal, Vec,
};

// --- reference custom SEP-41 token (test-only) ---

#[contracttype]
#[derive(Clone)]
enum TokKey {
    Decimals,
    Balance(Address),
    Allowance(Address, Address),
}

fn bal(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&TokKey::Balance(id.clone()))
        .unwrap_or(0)
}

fn set_bal(env: &Env, id: &Address, v: i128) {
    env.storage()
        .persistent()
        .set(&TokKey::Balance(id.clone()), &v);
}

/// Minimal SEP-41 implementation with the standard checks: positive-or-zero
/// amounts, `from` authorization, insufficient-balance panics, allowances.
#[contract]
pub struct ReferenceToken;

#[contractimpl]
impl ReferenceToken {
    pub fn __constructor(env: Env, decimals: u32) {
        env.storage().instance().set(&TokKey::Decimals, &decimals);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let b = bal(&env, &to);
        set_bal(&env, &to, b + amount);
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&TokKey::Decimals).unwrap()
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "Reference")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "REF")
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        bal(&env, &id)
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .temporary()
            .get(&TokKey::Allowance(from, spender))
            .unwrap_or(0)
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, _live_until: u32) {
        from.require_auth();
        env.storage()
            .temporary()
            .set(&TokKey::Allowance(from, spender), &amount);
    }

    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        Self::do_transfer(&env, &from, &to.address(), amount);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        let allowed = Self::allowance(env.clone(), from.clone(), spender.clone());
        assert!(allowed >= amount, "insufficient allowance");
        env.storage().temporary().set(
            &TokKey::Allowance(from.clone(), spender),
            &(allowed - amount),
        );
        Self::do_transfer(&env, &from, &to, amount);
    }

    fn do_transfer(env: &Env, from: &Address, to: &Address, amount: i128) {
        assert!(amount >= 0, "negative amount");
        let fb = bal(env, from);
        assert!(fb >= amount, "insufficient balance");
        set_bal(env, from, fb - amount);
        let tb = bal(env, to);
        set_bal(env, to, tb + amount);
    }
}

// --- token fixtures ---

#[derive(Clone, Copy, Debug)]
enum Kind {
    NativeSac,
    IssuedSac,
    Custom(u32),
}

struct Token<'a> {
    env: &'a Env,
    kind: Kind,
    address: Address,
}

impl<'a> Token<'a> {
    fn new(env: &'a Env, kind: Kind) -> Self {
        let address = match kind {
            Kind::NativeSac => {
                let create = xdr::HostFunction::CreateContract(xdr::CreateContractArgs {
                    contract_id_preimage: xdr::ContractIdPreimage::Asset(xdr::Asset::Native),
                    executable: xdr::ContractExecutable::StellarAsset,
                });
                let v = env.host().invoke_function(create).unwrap();
                v.try_into_val(env).unwrap()
            }
            Kind::IssuedSac => env
                .register_stellar_asset_contract_v2(Address::generate(env))
                .address(),
            Kind::Custom(d) => env.register(ReferenceToken, (d,)),
        };
        Token { env, kind, address }
    }

    fn decimals(&self) -> u32 {
        match self.kind {
            Kind::Custom(d) => d,
            _ => 7,
        }
    }

    /// `n` whole units in the token's smallest denomination.
    fn units(&self, n: i128) -> i128 {
        n * 10i128.pow(self.decimals())
    }

    fn client(&self) -> TokenClient<'a> {
        TokenClient::new(self.env, &self.address)
    }

    fn balance(&self, who: &Address) -> i128 {
        self.client().balance(who)
    }

    fn fund(&self, who: &Address, amount: i128) {
        match self.kind {
            Kind::NativeSac => {
                // Native balances sit in the holder's account ledger entry.
                let ScAddr(account) = ScAddr::of(who);
                let key = std::rc::Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
                    account_id: account.clone(),
                }));
                let entry = std::rc::Rc::new(xdr::LedgerEntry {
                    data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
                        account_id: account,
                        balance: i64::try_from(amount).unwrap(),
                        flags: 0,
                        home_domain: Default::default(),
                        inflation_dest: None,
                        num_sub_entries: 0,
                        seq_num: xdr::SequenceNumber(0),
                        thresholds: xdr::Thresholds([1; 4]),
                        signers: xdr::VecM::default(),
                        ext: xdr::AccountEntryExt::V0,
                    }),
                    last_modified_ledger_seq: 0,
                    ext: xdr::LedgerEntryExt::V0,
                });
                self.env
                    .host()
                    .add_ledger_entry(&key, &entry, None)
                    .unwrap();
            }
            Kind::IssuedSac => StellarAssetClient::new(self.env, &self.address).mint(who, &amount),
            Kind::Custom(_) => {
                ReferenceTokenClient::new(self.env, &self.address).mint(who, &amount);
            }
        }
    }
}

fn account_address(env: &Env) -> Address {
    // A contract address's bytes reinterpreted as an ed25519 key: unique and valid
    // for the host, which never verifies a signature under mock_all_auths.
    let seed = Address::generate(env);
    let bytes = match xdr::ScAddress::from(&seed) {
        xdr::ScAddress::Contract(xdr::ContractId(h)) => h.0,
        _ => unreachable!(),
    };
    let id = xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(bytes)));
    xdr::ScAddress::Account(id).try_into_val(env).unwrap()
}

struct ScAddr(xdr::AccountId);

impl ScAddr {
    fn of(a: &Address) -> ScAddr {
        match xdr::ScAddress::from(a) {
            xdr::ScAddress::Account(id) => ScAddr(id),
            _ => panic!("expected an account address"),
        }
    }
}

struct Fx<'a> {
    env: &'a Env,
    c: EscrowContractClient<'a>,
    contract: Address,
    tok: Token<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
}

impl<'a> Fx<'a> {
    fn new(env: &'a Env, kind: Kind) -> Self {
        env.mock_all_auths();
        let tok = Token::new(env, kind);
        // Native XLM balances of classic accounts live in account entries, so the
        // native payer must be an account address; contracts hold contract data.
        let payer = match kind {
            Kind::NativeSac => account_address(env),
            _ => Address::generate(env),
        };
        tok.fund(&payer, tok.units(1_000));
        let contract = env.register(
            EscrowContract,
            (Vec::<Address>::new(env), Address::generate(env)),
        );
        Fx {
            env,
            c: EscrowContractClient::new(env, &contract),
            contract,
            tok,
            payer,
            payee: Address::generate(env),
            releaser: Address::generate(env),
        }
    }

    fn create(&self, amount: i128, refund_after: Option<u64>) -> u64 {
        self.c.create_escrow(
            &self.payer,
            &self.payee,
            &self.tok.address,
            &amount,
            &String::from_str(self.env, "conformance"),
            &self.releaser,
            &refund_after,
            &false,
            &None,
            &None,
            &None,
        )
    }
}

// --- scenarios, each run for every token kind ---

fn create_locks_funds(kind: Kind) {
    let env = Env::default();
    let f = Fx::new(&env, kind);
    let amt = f.tok.units(10);
    let id = f.create(amt, None);
    assert_eq!(f.tok.balance(&f.contract), amt);
    assert_eq!(f.tok.balance(&f.payer), f.tok.units(990));
    assert_eq!(f.c.get_status(&id), EscrowStatus::Funded);
}

fn release_pays_payee(kind: Kind) {
    let env = Env::default();
    let f = Fx::new(&env, kind);
    let amt = f.tok.units(10);
    let id = f.create(amt, None);
    f.c.release(&id, &f.releaser);
    assert_eq!(f.tok.balance(&f.payee), amt);
    assert_eq!(f.tok.balance(&f.contract), 0);
    assert_eq!(f.c.get_status(&id), EscrowStatus::Released);
}

fn refund_returns_to_payer(kind: Kind) {
    let env = Env::default();
    let f = Fx::new(&env, kind);
    let id = f.create(f.tok.units(10), None);
    f.c.refund(&id, &f.releaser);
    assert_eq!(f.tok.balance(&f.payer), f.tok.units(1_000));
    assert_eq!(f.tok.balance(&f.contract), 0);
    assert_eq!(f.c.get_status(&id), EscrowStatus::Refunded);
}

fn settled_escrow_cannot_settle_again(kind: Kind) {
    let env = Env::default();
    let f = Fx::new(&env, kind);
    let id = f.create(f.tok.units(1), None);
    f.c.release(&id, &f.releaser);
    assert!(f.c.try_refund(&id, &f.releaser).is_err());
    assert!(f.c.try_release(&id, &f.releaser).is_err());
}

fn top_up_then_release(kind: Kind) {
    let env = Env::default();
    let f = Fx::new(&env, kind);
    let id = f.create(f.tok.units(10), None);
    f.c.top_up(&id, &f.payer, &f.tok.units(5));
    assert_eq!(f.tok.balance(&f.contract), f.tok.units(15));
    f.c.release(&id, &f.releaser);
    assert_eq!(f.tok.balance(&f.payee), f.tok.units(15));
}

fn split_settlement(kind: Kind) {
    let env = Env::default();
    let f = Fx::new(&env, kind);
    let id = f.create(f.tok.units(10), None);
    f.c.settle(&id, &f.releaser, &f.tok.units(4));
    assert_eq!(f.tok.balance(&f.payee), f.tok.units(4));
    assert_eq!(f.tok.balance(&f.payer), f.tok.units(996));
    assert_eq!(f.tok.balance(&f.contract), 0);
}

fn release_takes_protocol_fee(kind: Kind) {
    let env = Env::default();
    let f = Fx::new(&env, kind);
    let fee_to = Address::generate(&env);
    let amt = f.tok.units(100);
    let id = f.c.create_escrow(
        &f.payer,
        &f.payee,
        &f.tok.address,
        &amt,
        &String::from_str(&env, "fee"),
        &f.releaser,
        &None,
        &false,
        &None,
        &Some(fee_to.clone()),
        &Some(250u32),
    );
    f.c.release(&id, &f.releaser);
    // 2.5 %
    assert_eq!(f.tok.balance(&fee_to), amt / 40);
    assert_eq!(f.tok.balance(&f.payee), amt - amt / 40);
    assert_eq!(f.tok.balance(&f.contract), 0);
}

fn timeout_refund_by_anyone(kind: Kind) {
    let env = Env::default();
    env.ledger().set_timestamp(1_000);
    let f = Fx::new(&env, kind);
    let id = f.create(f.tok.units(10), Some(2_000));
    let stranger = Address::generate(&env);
    assert!(f.c.try_refund(&id, &stranger).is_err());
    env.ledger().set_timestamp(2_000);
    f.c.refund(&id, &stranger);
    assert_eq!(f.tok.balance(&f.payer), f.tok.units(1_000));
}

fn payer_cancels_unaccepted_escrow(kind: Kind) {
    let env = Env::default();
    let f = Fx::new(&env, kind);
    let id = f.c.create_escrow_with_acceptance(
        &f.payer,
        &f.payee,
        &f.tok.address,
        &f.tok.units(10),
        &String::from_str(&env, "accept"),
        &f.releaser,
        &None,
        &true,
        &None,
    );
    assert_eq!(
        f.c.try_release(&id, &f.releaser)
            .err()
            .map(std::result::Result::ok),
        Some(Some(Error::AcceptanceRequired))
    );
    f.c.cancel(&id, &f.payer);
    assert_eq!(f.tok.balance(&f.payer), f.tok.units(1_000));
    assert_eq!(f.c.get_status(&id), EscrowStatus::Cancelled);
}

fn settle_many_mixed(kind: Kind) {
    let env = Env::default();
    let f = Fx::new(&env, kind);
    let a = f.create(f.tok.units(3), None);
    let b = f.create(f.tok.units(7), None);
    let mut ops = Vec::new(&env);
    ops.push_back((a, SettleAction::Release));
    ops.push_back((b, SettleAction::Refund));
    let results = f.c.settle_many(&f.releaser, &ops);
    assert_eq!(results.len(), 2);
    assert_eq!(f.tok.balance(&f.payee), f.tok.units(3));
    assert_eq!(f.tok.balance(&f.payer), f.tok.units(997));
    assert_eq!(f.tok.balance(&f.contract), 0);
}

fn escrows_share_one_contract_balance(kind: Kind) {
    let env = Env::default();
    let f = Fx::new(&env, kind);
    let a = f.create(f.tok.units(3), None);
    let b = f.create(f.tok.units(7), None);
    assert_eq!(f.tok.balance(&f.contract), f.tok.units(10));
    f.c.release(&a, &f.releaser);
    assert_eq!(f.tok.balance(&f.contract), f.tok.units(7));
    f.c.refund(&b, &f.releaser);
    assert_eq!(f.tok.balance(&f.contract), 0);
}

fn underfunded_payer_cannot_create(kind: Kind) {
    let env = Env::default();
    let f = Fx::new(&env, kind);
    let too_much = f.tok.units(1_001);
    let r = f.c.try_create_escrow(
        &f.payer,
        &f.payee,
        &f.tok.address,
        &too_much,
        &String::from_str(&env, "x"),
        &f.releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    assert!(r.is_err());
    assert_eq!(f.tok.balance(&f.payer), f.tok.units(1_000));
}

macro_rules! conformance {
    ($($scenario:ident),* $(,)?) => {
        mod native_sac { use super::*; $(#[test] fn $scenario() { super::$scenario(Kind::NativeSac) })* }
        mod issued_sac { use super::*; $(#[test] fn $scenario() { super::$scenario(Kind::IssuedSac) })* }
        mod custom_0_decimals { use super::*; $(#[test] fn $scenario() { super::$scenario(Kind::Custom(0)) })* }
        mod custom_6_decimals { use super::*; $(#[test] fn $scenario() { super::$scenario(Kind::Custom(6)) })* }
        mod custom_18_decimals { use super::*; $(#[test] fn $scenario() { super::$scenario(Kind::Custom(18)) })* }
    };
}

conformance!(
    create_locks_funds,
    release_pays_payee,
    refund_returns_to_payer,
    settled_escrow_cannot_settle_again,
    top_up_then_release,
    split_settlement,
    release_takes_protocol_fee,
    timeout_refund_by_anyone,
    payer_cancels_unaccepted_escrow,
    settle_many_mixed,
    escrows_share_one_contract_balance,
    underfunded_payer_cannot_create,
);

// Keep `IntoVal` imported for the host conversions above on all SDK patch levels.
#[allow(dead_code)]
fn _uses(env: &Env, a: &Address) -> soroban_sdk::Val {
    a.into_val(env)
}
