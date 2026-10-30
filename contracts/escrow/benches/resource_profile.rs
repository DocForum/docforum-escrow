#![allow(deprecated)]

use docforum_escrow::{EscrowContract, EscrowContractClient};
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env, String, Vec};

struct Fixture<'a> {
    env: Env,
    client: EscrowContractClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
    token: Address,
}

fn fixture() -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    let asset = StellarAssetClient::new(&env, &token);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &10_000);
    let contract = env.register(EscrowContract, (Vec::<Address>::new(&env), None::<Address>));
    let client = EscrowContractClient::new(&env, &contract);
    Fixture {
        env,
        client,
        payer,
        payee,
        releaser,
        token,
    }
}

impl Fixture<'_> {
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
}
