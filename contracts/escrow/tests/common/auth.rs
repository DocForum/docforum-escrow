use soroban_sdk::{
    testutils::{AuthorizedInvocation, MockAuthInvoke},
    Address, Env,
};

/// Assert the complete authorization tree recorded for one signer.
///
/// Checking only the signer is insufficient: a contract can require the
/// right address for the wrong function or omit a nested token transfer. The
/// same `MockAuthInvoke` used to configure the call is converted to the
/// recorded representation so the helper checks function, arguments, and
/// child invocations together.
#[allow(dead_code)] // shared by every test module, each uses a subset
pub fn assert_auth_tree(env: &Env, address: &Address, expected: &MockAuthInvoke<'_>) {
    let actual = env.auths();
    assert_eq!(actual.len(), 1, "unexpected authorization count");
    assert_eq!(&actual[0].0, address, "unexpected authorization signer");

    let expected = AuthorizedInvocation::from_xdr(
        env,
        &soroban_sdk::xdr::SorobanAuthorizedInvocation::from(expected),
    );
    assert_eq!(actual[0].1, expected, "unexpected authorization tree");
}

/// Assert the complete authorization tree recorded for each of several signers.
///
/// The order the host records entries in is not meaningful, so this compares
/// each `(signer, tree)` pair independently, like [`assert_auth_tree`] but for
/// calls that need more than one signature (payer + releaser, or the threshold
/// approvers plus the payer).
#[allow(dead_code)] // shared by every test module, each uses a subset
pub fn assert_auth_trees(env: &Env, expected: &[(&Address, &MockAuthInvoke<'_>)]) {
    let actual = env.auths();
    assert_eq!(
        actual.len(),
        expected.len(),
        "unexpected authorization count"
    );
    for (address, invoke) in expected {
        let tree = AuthorizedInvocation::from_xdr(
            env,
            &soroban_sdk::xdr::SorobanAuthorizedInvocation::from(*invoke),
        );
        let matches = actual
            .iter()
            .filter(|(signer, recorded)| signer == *address && *recorded == tree)
            .count();
        assert_eq!(matches, 1, "missing or duplicated authorization tree");
    }
}
