// Token conformance harness (issue #133, Phase E7).
//
// The escrow contract claims to work with *any* SEP-41 token. Until now the
// test suite only ever pointed it at the Stellar Asset Contract (and at
// deliberately broken mock tokens, which are a different thing: they test the
// contract's defences, not its compatibility).
//
// This module is the parameterisation: a `TokenKind` describes a token
// *implementation*, and every lifecycle case below runs against each of them.
// The suite lives in `tests/token_conformance.rs`, which generates one test
// module per token kind.
//
// The matrix:
//
// | kind                | what it is                                             |
// |---------------------|--------------------------------------------------------|
// | `NativeSac`         | the Stellar Asset Contract for XLM (the native asset)   |
// | `IssuedSac`         | the SAC for an issued asset, no issuer flags set        |
// | `CustomSep41`       | a Wasm contract implementing SEP-41 (OZ-style token)     |
//
// `CustomSep41` takes the number of decimals as a parameter, so the suite
// also covers tokens that are *not* 7-decimal (USDC and friends).
//
// What is deliberately **not** here: issuer-flag behaviour (clawback,
// auth-required). Those are properties of an *issuer*, not of a token
// implementation, and they are tracked separately in the threat model
// (`docs/threat-model.md`, T5). The issued SAC below is registered with no
// flags at all.

pub mod oz_token;

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use oz_token::{OzToken, OzTokenClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    xdr, Address, Env, String, TryFromVal, TryIntoVal, Vec,
};
use std::rc::Rc;

/// How much the payer is funded with in every fixture.
pub const SUPPLY: i128 = 1_000;
/// The amount escrowed in the standard fixture.
pub const AMOUNT: i128 = 300;
/// Ledger close time used by the timeout-refund case.
pub const CREATED_AT: u64 = 1_000;
/// The timeout-refund deadline — always strictly after `CREATED_AT`.
pub const DEADLINE: u64 = 1_100;

/// The token implementations the escrow is proven against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    /// The Stellar Asset Contract for the native asset (XLM).
    NativeSac,
    /// The Stellar Asset Contract for an issued (credit) asset. The issuer
    /// has **no flags**: no clawback, no auth-required (issue #133 keeps
    /// flag behaviour out of this suite).
    IssuedSac,
    /// A custom SEP-41 token contract, with the given number of decimals.
    CustomSep41 { decimals: u32 },
}

impl TokenKind {
    /// The number of decimals the token reports.
    ///
    /// Both Stellar Asset Contracts are 7-decimal by construction — that is
    /// baked into the protocol's SAC — so only a custom implementation can
    /// offer anything else.
    pub fn decimals(&self) -> u32 {
        match self {
            TokenKind::NativeSac | TokenKind::IssuedSac => 7,
            TokenKind::CustomSep41 { decimals } => *decimals,
        }
    }

    /// A short, human-readable name for the token, used in assertion
    /// messages.
    pub fn label(&self) -> std::string::String {
        match self {
            TokenKind::NativeSac => "native SAC (XLM)".to_string(),
            TokenKind::IssuedSac => "issued-asset SAC (no issuer flags)".to_string(),
            TokenKind::CustomSep41 { decimals } => {
                format!("custom SEP-41 token ({decimals} decimals)")
            }
        }
    }
}

/// A registered token under test, plus the small amount of plumbing needed
/// to give an address a balance in it.
pub struct TokenUnderTest<'a> {
    kind: TokenKind,
    address: Address,
    env: &'a Env,
}

impl<'a> TokenUnderTest<'a> {
    /// Registers the token implementation in `env`.
    pub fn register(env: &'a Env, kind: TokenKind) -> Self {
        let address = match kind {
            TokenKind::NativeSac => register_native_sac(env),
            TokenKind::IssuedSac => env
                .register_stellar_asset_contract_v2(Address::generate(env))
                .address(),
            TokenKind::CustomSep41 { decimals } => {
                let admin = Address::generate(env);
                env.register(
                    OzToken,
                    (
                        admin,
                        decimals,
                        String::from_str(env, "Conformance Token"),
                        String::from_str(env, "CONF"),
                    ),
                )
            }
        };

        Self { kind, address, env }
    }

    pub fn address(&self) -> &Address {
        &self.address
    }

    /// The generic SEP-41 client — the same interface the escrow contract
    /// itself uses (`soroban_sdk::token::Client`).
    pub fn client(&self) -> TokenClient<'static> {
        TokenClient::new(self.env, &self.address)
    }

    pub fn balance(&self, id: &Address) -> i128 {
        self.client().balance(id)
    }

    pub fn decimals(&self) -> u32 {
        self.client().decimals()
    }

    /// Gives `id` a balance of `amount` in this token.
    ///
    /// How that is done depends on the implementation, and that difference is
    /// exactly what `docs/token-conformance.md` tabulates:
    ///
    ///  - an issued SAC is minted by its administrator;
    ///  - a custom token mints through its own admin function;
    ///  - the native asset **cannot be minted at all**, so the balance is
    ///    moved from a ledger account that already holds XLM — the way a real
    ///    payment happens.
    pub fn fund(&self, id: &Address, amount: i128) {
        match self.kind {
            TokenKind::NativeSac => {
                let holder = create_native_account(self.env, NATIVE_HOLDER_BALANCE);
                self.client().transfer(&holder, id, &amount);
            }
            TokenKind::IssuedSac => {
                StellarAssetClient::new(self.env, &self.address).mint(id, &amount);
            }
            TokenKind::CustomSep41 { .. } => {
                OzTokenClient::new(self.env, &self.address).mint(id, &amount);
            }
        }
    }

    /// Gives an **account** address a balance of `amount`, creating the
    /// trustline first if this token kind needs one.
    pub fn fund_account(&self, account: &Address, amount: i128) {
        if account_balance(self.kind) == AccountBalance::Trustline {
            self.trust_account(account);
        }
        match self.kind {
            TokenKind::NativeSac => {
                write_account_balance(self.env, account, amount as i64);
            }
            TokenKind::IssuedSac => {
                StellarAssetClient::new(self.env, &self.address).mint(account, &amount);
            }
            TokenKind::CustomSep41 { .. } => {
                OzTokenClient::new(self.env, &self.address).mint(account, &amount);
            }
        }
    }

    /// Gives an account address a balance **without** the trustline a credit
    /// asset needs, and reports whether the token allowed it.
    ///
    /// This is the raw attempt, so a test can observe what the token does
    /// when the account has not asked for a trustline.
    pub fn fund_account_without_trustline(&self, account: &Address, amount: i128) -> bool {
        match self.kind {
            TokenKind::NativeSac => {
                write_account_balance(self.env, account, amount as i64);
                true
            }
            TokenKind::IssuedSac => StellarAssetClient::new(self.env, &self.address)
                .try_mint(account, &amount)
                .is_ok(),
            TokenKind::CustomSep41 { .. } => OzTokenClient::new(self.env, &self.address)
                .try_mint(account, &amount)
                .is_ok(),
        }
    }

    /// Creates the trustline an account needs before it can hold a credit
    /// asset. A no-op for token kinds that have no trustlines.
    pub fn trust_account(&self, account: &Address) {
        match self.kind {
            TokenKind::IssuedSac => {
                StellarAssetClient::new(self.env, &self.address).trust(account);
            }
            // The native asset and custom tokens have no trustlines.
            TokenKind::NativeSac | TokenKind::CustomSep41 { .. } => {}
        }
    }
}

/// XLM the funding account holds in the native-asset case.
const NATIVE_HOLDER_BALANCE: i64 = 1_000_000;

/// How an account address (`G...`) holds a balance in a given token kind.
///
/// This is the difference that bites integrators: a credit asset is held in a
/// *trustline* on the account, so the account has to ask for one before it
/// can hold anything — and before the escrow can pay it. XLM lives on the
/// account itself, and a custom token keeps its own ledger, so neither needs
/// anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountBalance {
    /// The account holds the token directly — no extra setup.
    Direct,
    /// The account needs a trustline for the asset first.
    Trustline,
}

/// How accounts hold a balance in this token kind.
pub fn account_balance(kind: TokenKind) -> AccountBalance {
    match kind {
        // XLM is the account's own balance: there is no trustline for it.
        TokenKind::NativeSac => AccountBalance::Direct,
        // A credit asset is held in a trustline on the account.
        TokenKind::IssuedSac => AccountBalance::Trustline,
        // A custom token keeps its own ledger: no trustlines at all.
        TokenKind::CustomSep41 { .. } => AccountBalance::Direct,
    }
}

/// Deploys the Stellar Asset Contract for the native asset (XLM).
///
/// `Env::register_stellar_asset_contract_v2` only covers *issued* assets, so
/// the native contract is created with the host function the network itself
/// uses: `CreateContract` with a `ContractIdPreimage::Asset(Native)`. The
/// resulting contract id is the deterministic, well-known native asset
/// contract id — the same address on every network.
pub fn register_native_sac(env: &Env) -> Address {
    let create = xdr::HostFunction::CreateContract(xdr::CreateContractArgs {
        contract_id_preimage: xdr::ContractIdPreimage::Asset(xdr::Asset::Native),
        executable: xdr::ContractExecutable::StellarAsset,
    });
    let deployed = env
        .host()
        .invoke_function(create)
        .expect("the native asset contract must deploy");
    Address::try_from_val(env, &deployed).expect("the native asset contract address")
}

/// Creates a ledger account (`G...`) holding native balance.
///
/// The native asset cannot be minted, so the payer is funded the way a real
/// payment funds it: from an account that already holds XLM. The test
/// environment has no faucet, so the account entry is written straight into
/// the ledger — the same thing the SDK itself does when it creates the
/// issuer account for a Stellar Asset Contract.
fn create_native_account(env: &Env, balance: i64) -> Address {
    let account = create_account_address(env);
    write_account_balance(env, &account, balance);
    account
}

/// Creates an account address (`G...`) and its ledger entry.
///
/// Every account on the network has a ledger entry, and the token contracts
/// read it (an account that holds a credit asset needs one to attach its
/// trustline to). The test environment has no accounts, so the entry is
/// written here.
///
/// `Env::with_generator` is crate-private in the SDK, so the 32 deterministic
/// bytes of the seeded test generator are borrowed from an address the SDK
/// generates instead. The result is stable across runs, which keeps the
/// committed test snapshots deterministic (see CONTRIBUTING.md).
pub fn create_account_address(env: &Env) -> Address {
    let seed = Address::generate(env);
    let key = match xdr::ScAddress::from(&seed) {
        xdr::ScAddress::Contract(id) => {
            let xdr::Hash(key) = id.0;
            key
        }
        _ => unreachable!("Address::generate returns a contract address"),
    };
    let account_id = xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(key)));
    let account: Address = xdr::ScAddress::Account(account_id)
        .try_into_val(env)
        .expect("a G address");
    write_account_balance(env, &account, 0);
    account
}

/// Writes an account entry with a native balance into the ledger.
fn write_account_balance(env: &Env, account: &Address, balance: i64) {
    let account_id: xdr::AccountId = account.try_into().expect("a G address");
    let key = xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
        account_id: account_id.clone(),
    });
    let entry = xdr::LedgerEntry {
        data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
            account_id,
            balance,
            seq_num: xdr::SequenceNumber(0),
            num_sub_entries: 0,
            inflation_dest: None,
            flags: 0,
            home_domain: Default::default(),
            thresholds: xdr::Thresholds([1; 4]),
            signers: xdr::VecM::default(),
            ext: xdr::AccountEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: xdr::LedgerEntryExt::V0,
    };
    env.host()
        .add_ledger_entry(&Rc::new(key), &Rc::new(entry), None)
        .expect("the account must exist");
}

/// A funded escrow, ready to be settled.
pub struct Fixture<'a> {
    pub client: EscrowContractClient<'a>,
    pub token: TokenUnderTest<'a>,
    pub contract_id: Address,
    pub payer: Address,
    pub payee: Address,
    pub releaser: Address,
    pub escrow_id: u64,
}

/// Registers the token and the escrow contract, funds the payer, and creates
/// an escrow of `amount`.
pub fn setup<'a>(env: &'a Env, kind: TokenKind, amount: i128) -> Fixture<'a> {
    env.mock_all_auths();

    let token = TokenUnderTest::register(env, kind);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    token.fund(&payer, SUPPLY);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        token.address(),
        &amount,
        &String::from_str(env, "conformance-ref"),
        &releaser,
        &None,
        &false,
    );

    Fixture {
        client,
        token,
        contract_id,
        payer,
        payee,
        releaser,
        escrow_id,
    }
}

/// The same, but the escrow is created with the payee-acceptance gate on.
pub fn setup_with_acceptance<'a>(env: &'a Env, kind: TokenKind, amount: i128) -> Fixture<'a> {
    env.mock_all_auths();

    let token = TokenUnderTest::register(env, kind);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    token.fund(&payer, SUPPLY);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_escrow_with_acceptance(
        &payer,
        &payee,
        token.address(),
        &amount,
        &String::from_str(env, "conformance-acceptance-ref"),
        &releaser,
        &None,
        &true,
    );

    Fixture {
        client,
        token,
        contract_id,
        payer,
        payee,
        releaser,
        escrow_id,
    }
}

/// The same, but the escrow is settled by an M-of-N releaser set.
pub fn setup_with_releasers<'a>(
    env: &'a Env,
    kind: TokenKind,
    amount: i128,
    releaser_count: usize,
    threshold: u32,
) -> Fixture<'a> {
    env.mock_all_auths();

    let token = TokenUnderTest::register(env, kind);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    token.fund(&payer, SUPPLY);

    let mut releasers = Vec::new(env);
    for _ in 0..releaser_count {
        releasers.push_back(Address::generate(env));
    }

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_escrow_with_releasers(
        &payer,
        &payee,
        token.address(),
        &amount,
        &String::from_str(env, "conformance-quorum-ref"),
        &releasers,
        &threshold,
        &None,
        &false,
    );

    let releaser = releasers.get(0).unwrap();

    Fixture {
        client,
        token,
        contract_id,
        payer,
        payee,
        releaser,
        escrow_id,
    }
}

/// The releaser set of a quorum fixture.
pub fn releasers(env: &Env, fixture: &Fixture<'_>, count: usize) -> Vec<Address> {
    let data = fixture.client.get_escrow(&fixture.escrow_id);
    let mut out = Vec::new(env);
    for index in 0..count {
        out.push_back(data.releasers.get(index as u32).unwrap());
    }
    out
}

// --- the lifecycle, one function per case ---

/// `create_escrow` locks the funds and reports `Funded`.
pub fn create_locks_funds_and_reports_funded(kind: TokenKind) {
    let env = Env::default();
    let f = setup(&env, kind, AMOUNT);

    assert_eq!(
        f.token.balance(&f.payer),
        SUPPLY - AMOUNT,
        "{}: the payer keeps the rest",
        kind.label()
    );
    assert_eq!(
        f.token.balance(&f.contract_id),
        AMOUNT,
        "{}: the escrow contract holds the escrowed amount",
        kind.label()
    );
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);

    let data = f.client.get_escrow(&f.escrow_id);
    assert_eq!(&data.payer, &f.payer);
    assert_eq!(&data.payee, &f.payee);
    assert_eq!(&data.token, f.token.address());
    assert_eq!(data.amount, AMOUNT);
    assert_eq!(data.status, EscrowStatus::Funded);
}

/// `release` pays the payee and settles the escrow.
pub fn release_pays_the_payee(kind: TokenKind) {
    let env = Env::default();
    let f = setup(&env, kind, AMOUNT);

    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(
        f.token.balance(&f.payee),
        AMOUNT,
        "{}: the payee is paid the escrowed amount",
        kind.label()
    );
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

/// A settled escrow cannot be settled again.
pub fn release_rejects_a_second_settlement(kind: TokenKind) {
    let env = Env::default();
    let f = setup(&env, kind, AMOUNT);

    f.client.release(&f.escrow_id, &f.releaser);
    let second = f.client.try_release(&f.escrow_id, &f.releaser);

    assert!(second.is_err(), "{}: a second release fails", kind.label());
    assert_eq!(
        f.token.balance(&f.payee),
        AMOUNT,
        "{}: the payee is paid exactly once",
        kind.label()
    );
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

/// Only the escrow's releaser may release.
pub fn release_rejects_a_stranger(kind: TokenKind) {
    let env = Env::default();
    let f = setup(&env, kind, AMOUNT);
    let stranger = Address::generate(&env);

    let result = f.client.try_release(&f.escrow_id, &stranger);

    assert!(
        result.is_err(),
        "{}: a stranger cannot release",
        kind.label()
    );
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.contract_id), AMOUNT);
}

/// `refund` returns the funds to the payer.
pub fn refund_returns_funds_to_the_payer(kind: TokenKind) {
    let env = Env::default();
    let f = setup(&env, kind, AMOUNT);

    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(
        f.token.balance(&f.payer),
        SUPPLY,
        "{}: the payer is made whole",
        kind.label()
    );
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
}

/// Only the escrow's releaser may refund before the deadline.
pub fn refund_rejects_a_stranger(kind: TokenKind) {
    let env = Env::default();
    let f = setup(&env, kind, AMOUNT);
    let stranger = Address::generate(&env);

    let result = f.client.try_refund(&f.escrow_id, &stranger);

    assert!(
        result.is_err(),
        "{}: a stranger cannot refund",
        kind.label()
    );
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payer), SUPPLY - AMOUNT);
}

/// A settled escrow cannot be refunded.
pub fn refund_after_release_is_rejected(kind: TokenKind) {
    let env = Env::default();
    let f = setup(&env, kind, AMOUNT);

    f.client.release(&f.escrow_id, &f.releaser);
    let result = f.client.try_refund(&f.escrow_id, &f.releaser);

    assert!(
        result.is_err(),
        "{}: a refund after release fails",
        kind.label()
    );
    assert_eq!(f.token.balance(&f.payer), SUPPLY - AMOUNT);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

/// `top_up` adds to a funded escrow and the extra is paid out with it.
pub fn top_up_adds_funds_to_a_funded_escrow(kind: TokenKind) {
    let env = Env::default();
    let f = setup(&env, kind, AMOUNT);

    f.client.top_up(&f.escrow_id, &f.payer, &200);

    let data = f.client.get_escrow(&f.escrow_id);
    assert_eq!(data.amount, AMOUNT + 200);
    assert_eq!(f.token.balance(&f.payer), SUPPLY - AMOUNT - 200);
    assert_eq!(f.token.balance(&f.contract_id), AMOUNT + 200);

    f.client.release(&f.escrow_id, &f.releaser);
    assert_eq!(
        f.token.balance(&f.payee),
        AMOUNT + 200,
        "{}: the top-up is paid out too",
        kind.label()
    );
}

/// The payee-acceptance gate holds the release back until the payee accepts.
pub fn payee_acceptance_gates_the_release(kind: TokenKind) {
    let env = Env::default();
    let f = setup_with_acceptance(&env, kind, AMOUNT);

    let blocked = f.client.try_release(&f.escrow_id, &f.releaser);
    assert!(
        blocked.is_err(),
        "{}: release waits for acceptance",
        kind.label()
    );
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);

    f.client.accept(&f.escrow_id, &f.payee);
    let data = f.client.get_escrow(&f.escrow_id);
    assert!(data.requires_acceptance);
    assert!(data.accepted_at.is_some());

    f.client.release(&f.escrow_id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), AMOUNT);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

/// An M-of-N escrow needs `threshold` distinct approvers.
pub fn quorum_release_needs_distinct_approvals(kind: TokenKind) {
    let env = Env::default();
    let f = setup_with_releasers(&env, kind, AMOUNT, 3, 2);

    let too_few = releasers(&env, &f, 1);
    assert_eq!(
        f.client.try_release_with_approvals(&f.escrow_id, &too_few),
        Err(Ok(Error::ThresholdNotMet)),
        "{}: one approval is not enough for 2-of-3",
        kind.label()
    );

    let approvers = releasers(&env, &f, 2);
    f.client.release_with_approvals(&f.escrow_id, &approvers);

    assert_eq!(
        f.token.balance(&f.payee),
        AMOUNT,
        "{}: the quorum pays the payee",
        kind.label()
    );
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

/// After the deadline anyone may refund, and the money still goes to the
/// payer.
pub fn timeout_refund_opens_to_anyone_after_the_deadline(kind: TokenKind) {
    let env = Env::default();
    env.ledger().set_timestamp(CREATED_AT);
    let f = setup_with_deadline(&env, kind, AMOUNT, DEADLINE);
    let stranger = Address::generate(&env);

    let too_early = f.client.try_refund(&f.escrow_id, &stranger);
    assert!(
        too_early.is_err(),
        "{}: before the deadline only the releaser may refund",
        kind.label()
    );

    env.ledger().set_timestamp(DEADLINE);
    f.client.refund(&f.escrow_id, &stranger);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(
        f.token.balance(&f.payer),
        SUPPLY,
        "{}: the timeout refund goes back to the payer",
        kind.label()
    );
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

/// The escrowed amount is an opaque integer amount: the contract never
/// rescales it, whatever the token's decimals are.
pub fn the_amount_is_an_opaque_integer_unit(kind: TokenKind) {
    let env = Env::default();
    // The smallest amount the token can express.
    let f = setup(&env, kind, 1);

    assert_eq!(
        f.token.decimals(),
        kind.decimals(),
        "{}: the token reports its own decimals",
        kind.label()
    );

    let data = f.client.get_escrow(&f.escrow_id);
    assert_eq!(
        data.amount,
        1,
        "{}: the stored amount is the raw integer, not a scaled one",
        kind.label()
    );
    assert_eq!(f.token.balance(&f.contract_id), 1);

    f.client.release(&f.escrow_id, &f.releaser);
    assert_eq!(
        f.token.balance(&f.payee),
        1,
        "{}: the raw integer amount reaches the payee",
        kind.label()
    );
}

/// An account payer (`G...`) holds the token directly for the native asset
/// and for a custom token; a credit asset needs a trustline first.
///
/// This is the difference that surprises integrators: the escrow looks the
/// same from the outside, but an account cannot hold a credit asset — let
/// alone escrow one — before it has asked for a trustline.
pub fn an_account_payer_needs_a_trustline_only_for_credit_assets(kind: TokenKind) {
    let env = Env::default();
    env.mock_all_auths();

    let token = TokenUnderTest::register(&env, kind);
    let payer = create_account_address(&env);
    let releaser = Address::generate(&env);

    // Fund the account the hard way: without the trustline a credit asset
    // needs.
    let funded = token.fund_account_without_trustline(&payer, SUPPLY);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let payee = Address::generate(&env);

    match account_balance(kind) {
        AccountBalance::Direct => {
            assert!(
                funded,
                "{}: the account holds the token directly",
                kind.label()
            );
            let escrow_id = client.create_escrow(
                &payer,
                &payee,
                token.address(),
                &AMOUNT,
                &String::from_str(&env, "account-payer-ref"),
                &releaser,
                &None,
                &false,
            );
            assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
            assert_eq!(token.balance(&contract_id), AMOUNT);
        }
        AccountBalance::Trustline => {
            assert!(
                !funded,
                "{}: a credit asset cannot be held without a trustline",
                kind.label()
            );
            // With the trustline, the very same account works.
            token.fund_account(&payer, SUPPLY);
            let escrow_id = client.create_escrow(
                &payer,
                &payee,
                token.address(),
                &AMOUNT,
                &String::from_str(&env, "account-payer-ref"),
                &releaser,
                &None,
                &false,
            );
            assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
            assert_eq!(token.balance(&contract_id), AMOUNT);
        }
    }
}

/// A payee that cannot hold the asset is not paid — and the failed payout
/// leaves the escrow funded, exactly like any other failed transfer.
pub fn a_payee_that_cannot_hold_the_asset_is_not_paid(kind: TokenKind) {
    let env = Env::default();
    env.mock_all_auths();

    let token = TokenUnderTest::register(&env, kind);
    let payer = Address::generate(&env);
    let payee = create_account_address(&env);
    let releaser = Address::generate(&env);
    token.fund(&payer, SUPPLY);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        token.address(),
        &AMOUNT,
        &String::from_str(&env, "account-payee-ref"),
        &releaser,
        &None,
        &false,
    );

    let released = client.try_release(&escrow_id, &releaser);
    match account_balance(kind) {
        AccountBalance::Direct => {
            assert!(
                released.is_ok(),
                "{}: the payee is paid without any extra setup",
                kind.label()
            );
            assert_eq!(token.balance(&payee), AMOUNT);
            assert_eq!(client.get_status(&escrow_id), EscrowStatus::Released);
        }
        AccountBalance::Trustline => {
            assert!(
                released.is_err(),
                "{}: a credit asset payee needs a trustline",
                kind.label()
            );
            // The failed payout rolled back: the escrow is still funded and
            // the money is still in the contract. The payee's balance is not
            // read here — for a credit asset the token cannot even report it
            // before the trustline exists.
            assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
            assert_eq!(token.balance(&contract_id), AMOUNT);

            // Give the payee the trustline it was missing and settle the
            // very same escrow.
            token.trust_account(&payee);
            client.release(&escrow_id, &releaser);
            assert_eq!(token.balance(&payee), AMOUNT);
            assert_eq!(client.get_status(&escrow_id), EscrowStatus::Released);
        }
    }
}

/// The same, for a token with a timeout deadline.
fn setup_with_deadline<'a>(
    env: &'a Env,
    kind: TokenKind,
    amount: i128,
    deadline: u64,
) -> Fixture<'a> {
    env.mock_all_auths();

    let token = TokenUnderTest::register(env, kind);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    token.fund(&payer, SUPPLY);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        token.address(),
        &amount,
        &String::from_str(env, "conformance-timeout-ref"),
        &releaser,
        &Some(deadline),
        &false,
    );

    Fixture {
        client,
        token,
        contract_id,
        payer,
        payee,
        releaser,
        escrow_id,
    }
}
