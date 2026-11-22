use super::*;
extern crate alloc;

use alloc::vec::Vec as StdVec;
use ed25519_dalek::{Signer, SigningKey};
use proptest::prelude::*;
use soroban_sdk::{
    auth::ContractContext,
    testutils::{Address as _, Ledger as _},
    vec, IntoVal,
};

fn signer(env: &Env, seed: u8) -> (SigningKey, BytesN<32>) {
    let key = SigningKey::from_bytes(&[seed; 32]);
    let public = BytesN::from_array(env, &key.verifying_key().to_bytes());
    (key, public)
}

fn quiet_env() -> Env {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env
}

#[test]
fn quorum_requires_distinct_registered_ed25519_signers() {
    let env = Env::default();
    let escrow = Address::generate(&env);
    let (one, one_public) = signer(&env, 1);
    let (two, two_public) = signer(&env, 2);
    let (_three, three_public) = signer(&env, 3);
    let account_id = env.register(
        ReleaserAccount,
        (
            &escrow,
            &vec![&env, one_public.clone(), two_public.clone()],
            &2u32,
            &3u32,
            &10u32,
        ),
    );
    let payload = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"escrow authorization"))
        .to_bytes();
    let message = payload.to_array();
    let one_sig = SignerSignature {
        public_key: one_public.clone(),
        signature: BytesN::from_array(&env, &one.sign(&message).to_bytes()),
    };
    let two_sig = SignerSignature {
        public_key: two_public.clone(),
        signature: BytesN::from_array(&env, &two.sign(&message).to_bytes()),
    };
    let unregistered = SignerSignature {
        public_key: three_public,
        signature: BytesN::from_array(&env, &[0; 64]),
    };

    assert!(env
        .as_contract(&account_id, || {
            verify_signatures(
                &env,
                &payload,
                &vec![&env, one_sig.clone(), two_sig.clone()],
                2,
                2,
            )
        })
        .is_ok());
    assert_eq!(
        env.as_contract(&account_id, || verify_signatures(
            &env,
            &payload,
            &vec![&env, one_sig.clone()],
            2,
            2
        )),
        Err(Error::InvalidSignature)
    );
    assert_eq!(
        env.as_contract(&account_id, || verify_signatures(
            &env,
            &payload,
            &vec![&env, one_sig.clone(), one_sig.clone()],
            2,
            2,
        )),
        Err(Error::InvalidSignature)
    );
    assert_eq!(
        env.as_contract(&account_id, || verify_signatures(
            &env,
            &payload,
            &vec![&env, one_sig, unregistered],
            2,
            2,
        )),
        Err(Error::InvalidSignature)
    );
}

#[test]
fn policy_allows_only_the_configured_escrow_operation() {
    let env = Env::default();
    let escrow = Address::generate(&env);
    let (_key, public) = signer(&env, 8);
    let account = env.register(
        ReleaserAccount,
        (&escrow, &vec![&env, public], &1u32, &3u32, &10u32),
    );
    let wrong_escrow = Address::generate(&env);
    let release = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "release"),
            args: vec![&env, 7u64.into_val(&env), account.clone().into_val(&env)],
        }),
    ];
    let refund = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "refund"),
            args: vec![&env, 7u64.into_val(&env), account.clone().into_val(&env)],
        }),
    ];
    let rotate = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "rotate_releaser"),
            args: vec![
                &env,
                7u64.into_val(&env),
                account.clone().into_val(&env),
                wrong_escrow.clone().into_val(&env),
            ],
        }),
    ];
    let wrong_rotate_caller = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "rotate_releaser"),
            args: vec![
                &env,
                7u64.into_val(&env),
                wrong_escrow.clone().into_val(&env),
                account.clone().into_val(&env),
            ],
        }),
    ];
    let wrong_target = vec![
        &env,
        Context::Contract(ContractContext {
            contract: wrong_escrow.clone(),
            fn_name: Symbol::new(&env, "release"),
            args: vec![&env, 7u64.into_val(&env), account.clone().into_val(&env)],
        }),
    ];
    let management = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "add_signer"),
            args: vec![&env, account.clone().into_val(&env)],
        }),
    ];
    let wrong_caller = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "release"),
            args: vec![&env, 7u64.into_val(&env), wrong_escrow.into_val(&env)],
        }),
    ];
    let nested = vec![&env, release.get(0).unwrap(), refund.get(0).unwrap()];
    env.as_contract(&account, || {
        assert!(escrow_operation_only(&env, &escrow, &release));
        assert!(escrow_operation_only(&env, &escrow, &refund));
        assert!(escrow_operation_only(&env, &escrow, &rotate));
        assert!(!escrow_operation_only(&env, &escrow, &wrong_rotate_caller));
        assert!(!escrow_operation_only(&env, &escrow, &wrong_target));
        assert!(!escrow_operation_only(&env, &escrow, &management));
        assert!(!escrow_operation_only(&env, &escrow, &wrong_caller));
        assert!(!escrow_operation_only(&env, &escrow, &nested));
    });
}

#[test]
fn management_digests_are_bound_to_action_and_nonce() {
    let env = Env::default();
    let escrow = Address::generate(&env);
    let (_key, public) = signer(&env, 9);
    let account_id = env.register(
        ReleaserAccount,
        (&escrow, &vec![&env, public.clone()], &1u32, &3u32, &10u32),
    );
    let add = ManagementAction::AddSigner(public.clone());
    let remove = ManagementAction::RemoveSigner(public);
    let at_zero = env.as_contract(&account_id, || management_digest(&env, &add, 0).to_bytes());
    let at_one = env.as_contract(&account_id, || management_digest(&env, &add, 1).to_bytes());
    let other_action = env.as_contract(&account_id, || {
        management_digest(&env, &remove, 0).to_bytes()
    });
    assert_ne!(at_zero, at_one);
    assert_ne!(at_zero, other_action);
}

#[test]
fn signer_management_uses_the_current_quorum_and_advances_nonce() {
    let env = Env::default();
    let escrow = Address::generate(&env);
    let (current_signer, current_public) = signer(&env, 11);
    let (_new_signer, new_public) = signer(&env, 12);
    let account_id = env.register(
        ReleaserAccount,
        (&escrow, &vec![&env, current_public], &1u32, &3u32, &10u32),
    );
    let client = ReleaserAccountClient::new(&env, &account_id);
    let action = ManagementAction::AddSigner(new_public);
    let digest = client.management_payload(&action);
    let signature = SignerSignature {
        public_key: BytesN::from_array(&env, &current_signer.verifying_key().to_bytes()),
        signature: BytesN::from_array(&env, &current_signer.sign(&digest.to_array()).to_bytes()),
    };

    client.manage(&action, &vec![&env, signature]);
    assert_eq!(client.signer_count(), 2);
    assert_eq!(client.management_nonce(), 1);
    assert_ne!(client.management_payload(&action), digest);
}

#[test]
fn policy_updates_require_every_signer_and_usage_rolls_over_at_window_boundary() {
    let env = Env::default();
    let escrow = Address::generate(&env);
    let (one, one_public) = signer(&env, 21);
    let (two, two_public) = signer(&env, 22);
    let account_id = env.register(
        ReleaserAccount,
        (
            &escrow,
            &vec![&env, one_public.clone(), two_public.clone()],
            &1u32,
            &2u32,
            &10u32,
        ),
    );
    let client = ReleaserAccountClient::new(&env, &account_id);

    let policy_change = ManagementAction::SetPolicy(1, 10);
    let policy_digest = client.management_payload(&policy_change);
    let one_signature = SignerSignature {
        public_key: one_public.clone(),
        signature: BytesN::from_array(&env, &one.sign(&policy_digest.to_array()).to_bytes()),
    };
    let two_signature = SignerSignature {
        public_key: two_public.clone(),
        signature: BytesN::from_array(&env, &two.sign(&policy_digest.to_array()).to_bytes()),
    };
    assert!(client
        .try_manage(&policy_change, &vec![&env, one_signature.clone()])
        .is_err());
    client.manage(&policy_change, &vec![&env, one_signature, two_signature]);
    assert_eq!(client.policy(), (1, 10));

    let cap_policy = ManagementAction::SetPolicy(2, 10);
    let cap_digest = client.management_payload(&cap_policy);
    let cap_signatures = vec![
        &env,
        SignerSignature {
            public_key: one_public,
            signature: BytesN::from_array(&env, &one.sign(&cap_digest.to_array()).to_bytes()),
        },
        SignerSignature {
            public_key: two_public,
            signature: BytesN::from_array(&env, &two.sign(&cap_digest.to_array()).to_bytes()),
        },
    ];
    client.manage(&cap_policy, &cap_signatures);

    env.ledger().set_sequence_number(9);
    assert_eq!(
        env.as_contract(&account_id, || consume_operation_slot(&env)),
        Ok(())
    );
    assert_eq!(
        env.as_contract(&account_id, || consume_operation_slot(&env)),
        Ok(())
    );
    assert_eq!(
        env.as_contract(&account_id, || consume_operation_slot(&env)),
        Err(Error::RateLimited)
    );
    assert_eq!(client.window_usage(&0), 2);

    env.ledger().set_sequence_number(11);
    assert_eq!(
        env.as_contract(&account_id, || consume_operation_slot(&env)),
        Ok(())
    );
    assert_eq!(client.window_usage(&1), 1);
}

#[test]
fn usage_entry_is_extended_beyond_short_persistent_minimum_until_window_end() {
    let env = Env::default();
    env.ledger().set_max_entry_ttl(20);
    env.ledger().set_min_persistent_entry_ttl(2);
    let escrow = Address::generate(&env);
    let (_signer, public) = signer(&env, 31);
    let account_id = env.register(
        ReleaserAccount,
        (&escrow, &vec![&env, public], &1u32, &2u32, &15u32),
    );

    assert_eq!(
        env.as_contract(&account_id, || consume_operation_slot(&env)),
        Ok(())
    );
    env.ledger().set_sequence_number(14);
    let client = ReleaserAccountClient::new(&env, &account_id);
    assert_eq!(client.window_usage(&0), 1);
}

#[test]
fn window_counter_expires_for_previous_window() {
    let env = Env::default();
    env.ledger().set_max_entry_ttl(20);
    env.ledger().set_min_persistent_entry_ttl(2);
    let escrow = Address::generate(&env);
    let (_signer, public) = signer(&env, 41);
    let account_id = env.register(
        ReleaserAccount,
        (&escrow, &vec![&env, public], &1u32, &2u32, &5u32),
    );

    env.ledger().set_sequence_number(0);
    assert_eq!(
        env.as_contract(&account_id, || consume_operation_slot(&env)),
        Ok(())
    );
    let client = ReleaserAccountClient::new(&env, &account_id);
    assert_eq!(client.window_usage(&0), 1);

    // Move well past the window (and its TTL) so the counter expires.
    env.ledger().set_sequence_number(20);
    assert_eq!(client.window_usage(&0), 0);
}

#[test]
fn cap_hit_at_window_boundary() {
    let env = Env::default();
    let escrow = Address::generate(&env);
    let (_signer, public) = signer(&env, 42);
    let account_id = env.register(
        ReleaserAccount,
        (&escrow, &vec![&env, public], &1u32, &1u32, &10u32),
    );

    // Last ledger of window 0: cap (1) can be hit here.
    env.ledger().set_sequence_number(10);
    assert_eq!(
        env.as_contract(&account_id, || consume_operation_slot(&env)),
        Ok(())
    );
    assert_eq!(
        env.as_contract(&account_id, || consume_operation_slot(&env)),
        Err(Error::RateLimited)
    );

    // First ledger of window 1: fresh counter, slot available again.
    env.ledger().set_sequence_number(11);
    assert_eq!(
        env.as_contract(&account_id, || consume_operation_slot(&env)),
        Ok(())
    );
    assert_eq!(
        ReleaserAccountClient::new(&env, &account_id).window_usage(&1),
        1
    );
}

proptest! {
    #[test]
    fn every_distinct_registered_signature_quorum_is_order_independent(
        signer_count in 1u8..=6,
        threshold in 1u8..=6,
        rotation in 0u8..=5,
    ) {
        prop_assume!(threshold <= signer_count);

        let env = quiet_env();
        let escrow = Address::generate(&env);
        let mut keys: StdVec<(SigningKey, BytesN<32>)> = StdVec::new();
        let mut registered = soroban_sdk::Vec::new(&env);
        for index in 0..signer_count {
            let (key, public) = signer(&env, index + 1);
            keys.push((key, public.clone()));
            registered.push_back(public);
        }
        let account_id = env.register(
            ReleaserAccount,
            (&escrow, &registered, &(threshold as u32), &3u32, &10u32),
        );
        let payload = env
            .crypto()
            .sha256(&Bytes::from_slice(&env, b"property payload"))
            .to_bytes();

        let mut signatures = soroban_sdk::Vec::new(&env);
        for offset in 0..threshold {
            let index = (offset + rotation) % signer_count;
            let (key, public) = &keys[index as usize];
            signatures.push_back(SignerSignature {
                public_key: public.clone(),
                signature: BytesN::from_array(
                    &env,
                    &key.sign(&payload.to_array()).to_bytes(),
                ),
            });
        }

        let verification = env.as_contract(&account_id, || {
            verify_signatures(
                &env,
                &payload,
                &signatures,
                threshold as u32,
                signer_count as u32,
            )
        });
        prop_assert_eq!(verification, Ok(()));
    }

    #[test]
    fn rate_limit_allows_exactly_the_cap_and_resets_at_the_next_window(
        cap in 1u8..=8,
        window_ledgers in 1u32..=50,
    ) {
        let env = quiet_env();
        let escrow = Address::generate(&env);
        let (_key, public) = signer(&env, 200);
        let account_id = env.register(
            ReleaserAccount,
            (
                &escrow,
                &vec![&env, public],
                &1u32,
                &(cap as u32),
                &window_ledgers,
            ),
        );
        let client = ReleaserAccountClient::new(&env, &account_id);

        // Ledger 1 is in window 0. Repeating the operation cannot bypass the cap.
        env.ledger().set_sequence_number(1);
        for _ in 0..cap {
            prop_assert_eq!(
                env.as_contract(&account_id, || consume_operation_slot(&env)),
                Ok(())
            );
        }
        prop_assert_eq!(client.window_usage(&0), cap as u32);
        prop_assert_eq!(
            env.as_contract(&account_id, || consume_operation_slot(&env)),
            Err(Error::RateLimited)
        );

        // The last ledger of window 0 is still capped; the first ledger of
        // window 1 gets a fresh counter.
        env.ledger().set_sequence_number(window_ledgers);
        prop_assert_eq!(
            env.as_contract(&account_id, || consume_operation_slot(&env)),
            Err(Error::RateLimited)
        );
        env.ledger().set_sequence_number(window_ledgers + 1);
        prop_assert_eq!(
            env.as_contract(&account_id, || consume_operation_slot(&env)),
            Ok(())
        );
        prop_assert_eq!(client.window_usage(&1), 1);
    }
}

#[test]
fn policy_authorizes_settle_many_and_counts_operations() {
    let env = Env::default();
    let escrow = Address::generate(&env);
    let (_key, public) = signer(&env, 51);
    let account = env.register(
        ReleaserAccount,
        (&escrow, &vec![&env, public], &1u32, &5u32, &10u32),
    );
    let wrong_escrow = Address::generate(&env);

    let ops = vec![
        &env,
        (1u64, SettleAction::Release),
        (2u64, SettleAction::Refund),
    ];
    let valid_settle_many = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "settle_many"),
            args: vec![&env, account.clone().into_val(&env), ops.clone().into_val(&env)],
        }),
    ];

    let wrong_target_settle = vec![
        &env,
        Context::Contract(ContractContext {
            contract: wrong_escrow.clone(),
            fn_name: Symbol::new(&env, "settle_many"),
            args: vec![&env, account.clone().into_val(&env), ops.clone().into_val(&env)],
        }),
    ];

    let wrong_caller_settle = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "settle_many"),
            args: vec![&env, wrong_escrow.into_val(&env), ops.clone().into_val(&env)],
        }),
    ];

    let empty_ops: Vec<(u64, SettleAction)> = vec![&env];
    let empty_settle = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "settle_many"),
            args: vec![&env, account.clone().into_val(&env), empty_ops.into_val(&env)],
        }),
    ];

    let malformed_settle = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "settle_many"),
            args: vec![&env, account.clone().into_val(&env), 12345u32.into_val(&env)],
        }),
    ];

    env.as_contract(&account, || {
        assert_eq!(authorize_context(&env, &escrow, &valid_settle_many), Ok(2));
        assert_eq!(authorize_context(&env, &escrow, &wrong_target_settle), Err(Error::UnauthorizedContext));
        assert_eq!(authorize_context(&env, &escrow, &wrong_caller_settle), Err(Error::UnauthorizedContext));
        assert_eq!(authorize_context(&env, &escrow, &empty_settle), Err(Error::UnauthorizedContext));
        assert_eq!(authorize_context(&env, &escrow, &malformed_settle), Err(Error::UnauthorizedContext));
    });
}

#[test]
fn settle_many_batch_consumes_n_slots_and_rejects_over_cap() {
    let env = Env::default();
    let escrow = Address::generate(&env);
    let (_key, public) = signer(&env, 52);
    let account = env.register(
        ReleaserAccount,
        (&escrow, &vec![&env, public], &1u32, &4u32, &10u32),
    );
    let client = ReleaserAccountClient::new(&env, &account);

    env.as_contract(&account, || {
        assert_eq!(consume_operation_slots(&env, 3), Ok(()));
        assert_eq!(consume_operation_slots(&env, 1), Ok(()));
        assert_eq!(consume_operation_slots(&env, 1), Err(Error::RateLimited));
    });
    assert_eq!(client.window_usage(&0), 4);

    env.ledger().set_sequence_number(11);
    env.as_contract(&account, || {
        assert_eq!(consume_operation_slots(&env, 5), Err(Error::RateLimited));
    });
    assert_eq!(client.window_usage(&1), 0);
}
