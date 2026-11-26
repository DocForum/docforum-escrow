//! Attestation-based release (issue #42).
//!
//! A releaser normally has to submit a release transaction itself, which
//! means holding a hot key online. Instead, an escrow can be created with
//! an `attester` — an ed25519 public key whose holder signs an attestation
//! offline ("escrow N may be released") and lets anyone submit it.
//!
//! The signed message is domain-separated and binds the contract, the
//! network, the escrow and the action, so an attestation for one contract
//! or network cannot be replayed on another:
//!
//! ```text
//! "docforum-escrow:release-attestation:v1"
//! || contract id (strkey, 56 bytes)
//! || network id (32 bytes, the network passphrase hash)
//! || escrow id (8 bytes, big-endian)
//! || "release"
//! ```
//!
//! A bad signature traps the invocation (`ed25519_verify` panics on
//! failure), so there is no error variant for it. Replay needs no extra
//! state: a successful attestation settles the escrow, and a settled id
//! fails `NotFunded` on any second attempt. The attester is an additional
//! release path — the stored releaser can still release as before.

use crate::*;

/// Domain separator for release attestations.
const ATTESTATION_DOMAIN: &[u8] = b"docforum-escrow:release-attestation:v1";
/// The only action an attestation can authorise.
const ATTESTATION_ACTION_RELEASE: &[u8] = b"release";

#[contractimpl]
impl EscrowContract {
    /// Same as `create_escrow`, but the escrow also records an optional
    /// `attester`: an ed25519 public key that may release it later with a
    /// signed off-chain attestation (`release_with_attestation`). `None`
    /// means no attestation path exists, exactly as before this change.
    /// The stored releaser is unchanged and can still release as normal.
    pub fn create_escrow_with_attester(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
        notify_payee: bool,
        refund_to: Option<Address>,
        attester: Option<BytesN<32>>,
    ) -> Result<u64, Error> {
        let mut releasers = Vec::new(&env);
        releasers.push_back(releaser);
        Self::create_escrow_inner(
            &env,
            payer,
            payee,
            token,
            amount,
            condition_ref,
            releasers,
            1,
            refund_after,
            notify_payee,
            false,
            refund_to,
            None,
            None,
            None,
            attester,
            false,
        )
    }

    /// Releases the escrow on a signed attestation from its stored
    /// attester. Anyone may submit it — the signature is the authority,
    /// so no address authorizes this call. The escrow must be `Funded`
    /// and have an attester; a pooled escrow must be fully funded, like
    /// `release`. Settles exactly like `release` (fees, callback,
    /// record reclaim), so the attestation cannot be used twice.
    ///
    /// Deliberately **not** gated by the emergency pause (docs/adr/0011):
    /// funds must always be able to leave an existing escrow.
    pub fn release_with_attestation(
        env: Env,
        escrow_id: u64,
        signature: BytesN<64>,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        let mut data = Self::load(&env, escrow_id)?;
        let attester = data.attester.as_ref().ok_or(Error::AttesterNotConfigured)?;
        Self::check_funded(&data)?;
        Self::check_pooled_fully_funded(&env, escrow_id, &data)?;
        let message = Self::release_attestation_message(&env, escrow_id);
        env.crypto().ed25519_verify(attester, &message, &signature);
        Self::settle_full(&env, escrow_id, &mut data, EscrowStatus::Released)
    }
}

impl EscrowContract {
    /// The exact bytes an attester signs for `release_with_attestation`.
    /// Strkeys are always 56 characters, so every field here is
    /// fixed-width and the layout cannot be ambiguous.
    pub(crate) fn release_attestation_message(env: &Env, escrow_id: u64) -> Bytes {
        let mut message = Bytes::new(env);
        message.append(&Bytes::from_slice(env, ATTESTATION_DOMAIN));
        let contract_id = env.current_contract_address().to_string();
        let mut contract_id_bytes = [0u8; 56];
        contract_id.copy_into_slice(&mut contract_id_bytes);
        message.append(&Bytes::from_array(env, &contract_id_bytes));
        message.append(&Bytes::from_array(
            env,
            &env.ledger().network_id().to_array(),
        ));
        message.append(&Bytes::from_array(env, &escrow_id.to_be_bytes()));
        message.append(&Bytes::from_slice(env, ATTESTATION_ACTION_RELEASE));
        message
    }
}
