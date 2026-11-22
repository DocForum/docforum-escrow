//! `transfer_payee`.

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Lets the current `payee` reassign future payout rights to a new
    /// address. Only the current `payee` may authorise this — no one
    /// else (not the payer, not the releaser) can redirect where a
    /// release will go (see invariant I1 and docs/threat-model.md).
    ///
    /// Restrictions:
    /// - Only while the escrow is `Funded` (no effect after release or
    ///   refund; the transfer is a payout-claim reassignment, not an
    ///   undo of a settlement).
    /// - `new_payee` may not be the contract's own address (it can never
    ///   sign to claim funds) or the `payer`'s address (preventing a
    ///   payer from using a colluding payee to redirect the escrow to
    ///   themselves).
    ///
    /// This helps a payee who is *rotating* their wallet — it does NOT
    /// help a payee who has already *lost* their key and can no longer
    /// sign: they cannot authorise this call. Key loss is an operational
    /// risk the payee must mitigate off-chain before it happens.
    ///
    /// Emits a `pay_xfer` event with `(escrow_id, old_payee, new_payee)`.
    pub fn transfer_payee(
        env: Env,
        escrow_id: u64,
        current_payee: Address,
        new_payee: Address,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        current_payee.require_auth();

        let mut data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;

        if current_payee != data.payee {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        if new_payee == env.current_contract_address() || new_payee == data.payer {
            return Err(Error::InvalidNewPayee);
        }

        let old_payee = data.payee.clone();
        data.payee = new_payee.clone();
        // Reset notify_payee on transfer so transferring to an account or a contract
        // without the callback hook cannot leave release permanently failing with
        // CallbackFailed (issue #286).
        data.notify_payee = false;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);

        env.events().publish(
            (symbol_short!("pay_xfer"), escrow_id),
            (old_payee, new_payee),
        );
        Ok(())
    }
}
