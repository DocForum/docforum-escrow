//! Read-only `get_status` and `get_escrow`.

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Read-only status query. Reads the lightweight `Status` entry, which
    /// outlives the full record: a settled escrow keeps answering after its
    /// record is reclaimed (docs/adr/0013), so `NotFound` means exactly one
    /// thing: this id was never created.
    pub fn get_status(env: Env, escrow_id: u64) -> Result<EscrowStatus, Error> {
        Self::extend_instance_ttl(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Status(escrow_id))
            .ok_or(Error::NotFound)
    }

    /// Read-only accessor for everything stored about `escrow_id` — payer,
    /// payee, token, amount, `condition_ref`, status, the releaser set with
    /// its threshold, `refund_after`, `refund_to` and the optional fee
    /// (`fee_recipient`/`fee_bps`, exactly as declared at creation). Exists
    /// so payees and integrators can check who can settle, when, where a
    /// refund goes and the exact fee before relying on a `Funded` escrow
    /// (docs/adr/0004, threat model T8; docs/adr/0010). Errors on an
    /// unknown id. Only `Funded` escrows have a full record: once settled it
    /// is reclaimed (docs/adr/0013) and this returns `NotFound` — use
    /// `get_status` for a settled id and the settlement event for its history.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowData, Error> {
        Self::extend_instance_ttl(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)
    }
}
