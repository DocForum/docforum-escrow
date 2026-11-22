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
