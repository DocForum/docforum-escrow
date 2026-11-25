//! `extend_refund_after`.

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Moves an active refund deadline later with the payer's and the
    /// single releaser's consent. Quorum escrows use their threshold path.
    pub fn extend_refund_after(env: Env, escrow_id: u64, new_deadline: u64) -> Result<(), Error> {
        let mut data = Self::load(&env, escrow_id)?;
        Self::check_funded(&data)?;
        let current_deadline = data.refund_after.ok_or(Error::InvalidRefundExtension)?;
        if env.ledger().timestamp() >= current_deadline || new_deadline <= current_deadline {
            return Err(Error::InvalidRefundExtension);
        }
        if data.threshold != 1 {
            return Err(Error::ThresholdNotMet);
        }
        data.payer.require_auth();
        let releaser = data.releasers.get(0).ok_or(Error::InvalidReleaser)?;
        releaser.require_auth();
        data.refund_after = Some(new_deadline);
        Self::write_escrow(&env, escrow_id, &data);
        // A later deadline needs the entries to live at least that long.
        Self::extend_escrow_ttl(&env, escrow_id, data.refund_after);
        RefundDeadlineExtended {
            escrow_id,
            old_deadline: current_deadline,
            new_deadline,
        }
        .publish(&env);
        Ok(())
    }
}
