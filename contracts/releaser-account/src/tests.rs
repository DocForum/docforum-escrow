use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    auth::ContractContext,
    testutils::{Address as _, Register as _},
    vec,
};

fn signer(env: &Env, seed: u8) -> (SigningKey, BytesN<32>) {
    let key = SigningKey::from_bytes(&[seed; 32]);
    let public = BytesN::from_array(env, &key.verifying_key().to_bytes());
    (key, public)
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
fn policy_allows_only_the_configured_escrow_release_or_refund() {
    let env = Env::default();
    let escrow = Address::generate(&env);
    let account = Address::generate(&env);
    let wrong_escrow = Address::generate(&env);
    let release = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "release"),
            args: vec![&env, &7u64, &account],
        }),
    ];
    let refund = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "refund"),
            args: vec![&env, &7u64, &account],
        }),
    ];
    let wrong_target = vec![
        &env,
        Context::Contract(ContractContext {
            contract: wrong_escrow,
            fn_name: Symbol::new(&env, "release"),
            args: vec![&env, &7u64, &account],
        }),
    ];
    let management = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "add_signer"),
            args: vec![&env, &account],
        }),
    ];
    let wrong_caller = vec![
        &env,
        Context::Contract(ContractContext {
            contract: escrow.clone(),
            fn_name: Symbol::new(&env, "release"),
            args: vec![&env, &7u64, &wrong_escrow],
        }),
    ];
    let nested = vec![&env, release.get(0).unwrap(), refund.get(0).unwrap()];
    env.as_contract(&account, || {
        assert!(release_or_refund_only(&env, &escrow, &release));
        assert!(release_or_refund_only(&env, &escrow, &refund));
        assert!(!release_or_refund_only(&env, &escrow, &wrong_target));
        assert!(!release_or_refund_only(&env, &escrow, &management));
        assert!(!release_or_refund_only(&env, &escrow, &wrong_caller));
        assert!(!release_or_refund_only(&env, &escrow, &nested));
    });
}

#[test]
fn management_digests_are_bound_to_action_and_nonce() {
    let env = Env::default();
    let escrow = Address::generate(&env);
    let (_key, public) = signer(&env, 9);
    let account_id = env.register(
        ReleaserAccount,
        (&escrow, &vec![&env, public.clone()], &1u32),
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
        (&escrow, &vec![&env, current_public], &1u32),
    );
    let client = ReleaserAccountClient::new(&env, &account_id);
    let action = ManagementAction::AddSigner(new_public);
    let digest = client.management_payload(&action);
    let signature = SignerSignature {
        public_key: BytesN::from_array(&env, &current_signer.verifying_key().to_bytes()),
        signature: BytesN::from_array(&env, &current_signer.sign(&digest.to_array()).to_bytes()),
    };

    assert_eq!(client.manage(&action, &vec![&env, signature]), Ok(()));
    assert_eq!(client.signer_count(), 2);
    assert_eq!(client.management_nonce(), 1);
    assert_ne!(client.management_payload(&action), digest);
}
