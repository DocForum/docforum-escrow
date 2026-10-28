use soroban_sdk::{testutils::AuthorizedInvocation, Address, Env};

/// Assert exactly which address(es) the most recent invocation required.
/// MockAuth additionally pins each address to the expected invocation tree.
pub fn assert_auth_addresses(env: &Env, expected: &[Address]) {
    let actual: std::vec::Vec<(Address, AuthorizedInvocation)> = env.auths();
    assert_eq!(actual.len(), expected.len(), "unexpected authorization count");
    for address in expected {
        assert!(actual.iter().any(|(actual, _)| actual == address), "missing expected signer");
    }
}
