use docforum_releaser_account::{ManagementAction, ReleaserAccount, ReleaserAccountClient};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Vec};

// Shared management digest vector, verified byte-for-byte against the
// TypeScript `ManagementPayload.compute` in sdk/src/releaser-account.ts.
// Inputs: contract address = the registered releaser account, nonce = 0
// (initial management nonce), action = ManagementAction::SetThreshold(2).
#[test]
fn management_digest_known_vector() {
    let env = Env::default();
    let signers: Vec<BytesN<32>> = Vec::from_array(
        &env,
        [BytesN::from_array(&env, &[42u8; 32])],
    );
    let id: Address = env.register(
        ReleaserAccount,
        (
            &Address::generate(&env),
            &signers,
            &1u32,
            &5u32,
            &10u32,
        ),
    );
    let contract = ReleaserAccountClient::new(&env, &id);
    let action = ManagementAction::SetThreshold(2);
    let digest = contract.management_payload(&action);
    let expected = BytesN::from_array(
        &env,
        &[
            129, 209, 93, 42, 111, 152, 103, 211, 111, 225, 184, 202, 130, 198,
            253, 207, 64, 220, 164, 18, 165, 127, 130, 178, 132, 169, 115, 213,
            220, 99, 17, 235,
        ],
    );
    assert_eq!(digest, expected);
}
