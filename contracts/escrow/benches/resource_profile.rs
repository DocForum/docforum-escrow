#![allow(deprecated)]

use docforum_escrow::{
    CreateItem, EscrowContract, EscrowContractClient, SettleAction, MAX_BATCH_SIZE,
    MAX_CONDITION_REF_LEN, MAX_FEE_BPS, MAX_SETTLE_OPS,
};
use soroban_sdk::{
    contract, contracterror, contractimpl,
    testutils::{Address as _, Events as _, Ledger as _},
    token::StellarAssetClient,
    xdr::{Limits, WriteXdr},
    Address, Env, String, Vec,
};

const CREATED_AT: u64 = 1_000;
const FUNDING_DEADLINE: u64 = CREATED_AT + 1_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
enum HookError {
    Rejected = 1,
}

/// A contract payee whose release callback succeeds. Used by the
/// `settle_many` profile so the worst case includes the cross-contract
/// `on_escrow_released` invoke, not just the token transfer.
#[contract]
struct PayeeHook;

#[contractimpl]
impl PayeeHook {
    pub fn on_escrow_released(_env: Env, _escrow_id: u64, _amount: i128) -> Result<(), HookError> {
        Ok(())
    }
}

struct Fixture<'a> {
    env: Env,
    client: EscrowContractClient<'a>,
    pause_admin: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    token: Address,
}

fn fixture() -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(CREATED_AT);
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    let asset = StellarAssetClient::new(&env, &token);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &10_000_000);
    // The constructor also takes the immutable pause admin (docs/adr/0011).
    let pause_admin = Address::generate(&env);
    let contract = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), pause_admin.clone()),
    );
    let client = EscrowContractClient::new(&env, &contract);
    Fixture {
        env,
        client,
        pause_admin,
        payer,
        payee,
        releaser,
        token,
    }
}

impl Fixture<'_> {
    /// The longest `condition_ref` the contract accepts (threat model T10).
    fn long_ref(&self) -> String {
        String::from_str(&self.env, &"r".repeat(MAX_CONDITION_REF_LEN as usize))
    }

    fn create(&self) -> u64 {
        self.client.create_escrow(
            &self.payer,
            &self.payee,
            &self.token,
            &100,
            &String::from_str(&self.env, "resource-profile"),
            &self.releaser,
            &None,
            &false,
            &None,
            &None,
            &None,
        )
    }

    /// Worst-case settlement input: the maximum fee, an opted-in payee
    /// callback and the longest condition reference.
    fn create_fee_and_callback(&self, payee: &Address, amount: i128) -> u64 {
        self.client.create_escrow(
            &self.payer,
            payee,
            &self.token,
            &amount,
            &self.long_ref(),
            &self.releaser,
            &None,
            &true,
            &None,
            &Some(Address::generate(&self.env)),
            &Some(MAX_FEE_BPS),
        )
    }

    /// Worst-case releaser set: ten distinct addresses, threshold 1 (the
    /// highest threshold `settle_many` accepts), callback opted in and the
    /// longest condition reference.
    fn create_ten_releasers(&self, payee: &Address) -> u64 {
        let mut releasers = Vec::new(&self.env);
        releasers.push_back(self.releaser.clone());
        for _ in 1..10 {
            releasers.push_back(Address::generate(&self.env));
        }
        self.client.create_escrow_with_releasers(
            &self.payer,
            payee,
            &self.token,
            &1_000,
            &self.long_ref(),
            &releasers,
            &1,
            &None,
            &true,
            &None,
        )
    }

    fn create_pooled(&self, target: i128) -> u64 {
        self.client.create_pooled_escrow(
            &self.payer,
            &self.payee,
            &self.token,
            &target,
            &self.long_ref(),
            &self.releaser,
            &FUNDING_DEADLINE,
        )
    }
}

fn measure(name: &str, env: &Env, operation: impl FnOnce()) {
    env.cost_estimate().budget().reset_tracker();
    operation();
    println!(
        "{name}: cpu_insns={}, memory_bytes={}",
        env.cost_estimate().budget().cpu_instruction_cost(),
        env.cost_estimate().budget().memory_bytes_cost(),
    );
}

/// Like `measure`, plus the ledger footprint the call modelled and the XDR
/// size of the events it emitted. For the batch entry points those are the
/// Mainnet per-transaction limits a batch can hit (docs/adr/0012).
fn measure_with_events(name: &str, env: &Env, operation: impl FnOnce()) {
    env.cost_estimate().budget().reset_tracker();
    operation();
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let memory = env.cost_estimate().budget().memory_bytes_cost();
    let resources = env.cost_estimate().resources();
    let events_bytes: usize = env
        .events()
        .all()
        .events()
        .iter()
        .map(|event| event.to_xdr(Limits::none()).unwrap().len())
        .sum();
    println!(
        "{name}: cpu_insns={cpu}, memory_bytes={memory}, events_bytes={events_bytes}, \
         write_entries={}, write_bytes={}",
        resources.write_entries, resources.write_bytes,
    );
}

fn main() {
    let f = fixture();
    measure("create_escrow", &f.env, || {
        f.create();
    });

    let f = fixture();
    measure("create_escrow_release_time", &f.env, || {
        f.client.create_escrow_release_time(
            &f.payer,
            &f.payee,
            &f.token,
            &100,
            &String::from_str(&f.env, "resource-profile"),
            &f.releaser,
            &None,
            &false,
            &None,
            &Some(1_000),
            &None,
            &None,
        );
    });

    let f = fixture();
    measure("create_escrow_with_acceptance", &f.env, || {
        f.client.create_escrow_with_acceptance(
            &f.payer,
            &f.payee,
            &f.token,
            &100,
            &String::from_str(&f.env, "resource-profile"),
            &f.releaser,
            &None,
            &true,
            &None,
        );
    });

    let f = fixture();
    let releasers = soroban_sdk::vec![&f.env, f.releaser.clone()];
    measure("create_escrow_with_releasers", &f.env, || {
        f.client.create_escrow_with_releasers(
            &f.payer,
            &f.payee,
            &f.token,
            &100,
            &String::from_str(&f.env, "resource-profile"),
            &releasers,
            &1,
            &None,
            &false,
            &None,
        );
    });

    // Worst-case batch: MAX_BATCH_SIZE items, each with a distinct payee,
    // the longest condition reference and a refund deadline set.
    let f = fixture();
    let mut items = Vec::new(&f.env);
    for _ in 0..MAX_BATCH_SIZE {
        items.push_back(CreateItem {
            payee: Address::generate(&f.env),
            token: f.token.clone(),
            amount: 1_000,
            condition_ref: f.long_ref(),
            releaser: f.releaser.clone(),
            refund_after: Some(u64::MAX),
        });
    }
    f.env.cost_estimate().budget().reset_unlimited();
    measure_with_events("create_escrows", &f.env, || {
        let ids = f.client.create_escrows(&f.payer, &items);
        assert_eq!(ids.len(), MAX_BATCH_SIZE);
    });

    let f = fixture();
    let id = f.client.create_escrow_with_acceptance(
        &f.payer,
        &f.payee,
        &f.token,
        &100,
        &String::from_str(&f.env, "resource-profile"),
        &f.releaser,
        &None,
        &true,
        &None,
    );
    measure("accept", &f.env, || {
        f.client.accept(&id, &f.payee);
    });

    let f = fixture();
    let id = f.create();
    measure("get_status", &f.env, || {
        f.client.get_status(&id);
    });

    let f = fixture();
    let id = f.create();
    measure("get_escrow", &f.env, || {
        f.client.get_escrow(&id);
    });

    let f = fixture();
    let id = f.create();
    let replacement = Address::generate(&f.env);
    measure("rotate_releaser", &f.env, || {
        f.client.rotate_releaser(&id, &f.releaser, &replacement);
    });

    let f = fixture();
    let id = f.create();
    measure("top_up", &f.env, || {
        f.client.top_up(&id, &f.payer, &10);
    });

    let f = fixture();
    let id = f.create();
    measure("release", &f.env, || {
        f.client.release(&id, &f.releaser);
    });

    let f = fixture();
    let id = f.client.create_escrow_with_releasers(
        &f.payer,
        &f.payee,
        &f.token,
        &100,
        &String::from_str(&f.env, "resource-profile"),
        &soroban_sdk::vec![&f.env, f.releaser.clone()],
        &1,
        &None,
        &false,
        &None,
    );
    let approvers = soroban_sdk::vec![&f.env, f.releaser.clone()];
    measure("release_with_approvals", &f.env, || {
        f.client.release_with_approvals(&id, &approvers);
    });

    let f = fixture();
    let id = f.create();
    measure("refund", &f.env, || {
        f.client.refund(&id, &f.releaser);
    });

    let f = fixture();
    let id = f.client.create_escrow_with_releasers(
        &f.payer,
        &f.payee,
        &f.token,
        &100,
        &String::from_str(&f.env, "resource-profile"),
        &soroban_sdk::vec![&f.env, f.releaser.clone()],
        &1,
        &None,
        &false,
        &None,
    );
    let approvers = soroban_sdk::vec![&f.env, f.releaser.clone()];
    measure("refund_with_approvals", &f.env, || {
        f.client.refund_with_approvals(&id, &approvers);
    });

    // Worst-case batch: MAX_SETTLE_OPS releases, each escrow carrying the
    // maximum fee and an opted-in payee callback, with the longest
    // condition reference.
    let f = fixture();
    let hook = f.env.register(PayeeHook, ());
    let mut ops = Vec::new(&f.env);
    for _ in 0..MAX_SETTLE_OPS {
        let id = f.create_fee_and_callback(&hook, 1_000);
        ops.push_back((id, SettleAction::Release));
    }
    f.env.cost_estimate().budget().reset_unlimited();
    measure_with_events("settle_many", &f.env, || {
        let results = f.client.settle_many(&f.releaser, &ops);
        assert_eq!(results.len(), MAX_SETTLE_OPS);
        assert!(results.iter().all(|r| r.is_ok()));
    });

    // Releaser-set comparison for the same worst-case batch size. A protocol
    // fee and a ten-address releaser set cannot both be set at creation
    // (only `create_escrow*` takes a fee), so the fee + callback shape above
    // is the baseline and this measures the other expensive dimension.
    let f = fixture();
    let hook = f.env.register(PayeeHook, ());
    let mut ops = Vec::new(&f.env);
    for _ in 0..MAX_SETTLE_OPS {
        let id = f.create_ten_releasers(&hook);
        ops.push_back((id, SettleAction::Release));
    }
    f.env.cost_estimate().budget().reset_unlimited();
    measure_with_events("settle_many_ten_releasers", &f.env, || {
        let results = f.client.settle_many(&f.releaser, &ops);
        assert_eq!(results.len(), MAX_SETTLE_OPS);
        assert!(results.iter().all(|r| r.is_ok()));
    });

    let f = fixture();
    measure("create_pooled_escrow", &f.env, || {
        f.create_pooled(1_000);
    });

    let f = fixture();
    let id = f.create_pooled(1_000);
    let contributor = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&contributor, &1_000);
    measure("contribute", &f.env, || {
        f.client.contribute(&id, &contributor, &1_000);
    });

    // A failed round: the deadline has passed with the target unmet, so the
    // contributor pulls their full recorded amount back.
    let f = fixture();
    let id = f.create_pooled(1_000);
    let contributor = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&contributor, &400);
    f.client.contribute(&id, &contributor, &400);
    f.env.ledger().set_timestamp(FUNDING_DEADLINE);
    measure("claim_refund", &f.env, || {
        f.client.claim_refund(&id, &contributor);
    });

    let f = fixture();
    let id = f.client.create_escrow_with_acceptance(
        &f.payer,
        &f.payee,
        &f.token,
        &100,
        &String::from_str(&f.env, "resource-profile"),
        &f.releaser,
        &None,
        &true,
        &None,
    );
    measure("cancel", &f.env, || {
        f.client.cancel(&id, &f.payer);
    });

    let f = fixture();
    let id = f.create();
    let new_payee = Address::generate(&f.env);
    measure("transfer_payee", &f.env, || {
        f.client.transfer_payee(&id, &f.payee, &new_payee);
    });

    let f = fixture();
    measure("pause", &f.env, || {
        f.client.pause(&f.pause_admin);
    });

    let f = fixture();
    f.client.pause(&f.pause_admin);
    measure("unpause", &f.env, || {
        f.client.unpause(&f.pause_admin);
    });

    // Two funded escrows so the liability read is not trivially zero.
    let f = fixture();
    f.create();
    f.create();
    measure("solvency", &f.env, || {
        f.client.solvency(&f.token);
    });
}
