//! Read-only status, single-record and bounded batch queries.

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Returns the escrow id indexed for a uniqueness-enabled `(payer,
    /// condition_ref)` pair, if one exists. The index is retained through
    /// settlement and expires with its persistent storage TTL.
    pub fn get_unique_escrow(env: Env, payer: Address, condition_ref: String) -> Option<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::UniqueRef(payer, condition_ref))
    }
    /// Returns the next id that a creation entry point will assign. It is a
    /// read-only view of the instance counter; an undeployed or untouched
    /// contract reports zero.
    pub fn next_escrow_id(env: Env) -> u64 {
        Self::extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    /// Reads up to `MAX_GET_ESCROWS` funded escrow records in one call.
    /// Unknown ids and settled ids whose full records were reclaimed return
    /// `None`; use `get_status` for a settled id's terminal status. The
    /// over-cap case returns `BatchTooLarge` before any persistent read.
    pub fn get_escrows(env: Env, ids: Vec<u64>) -> Result<Vec<Option<EscrowData>>, Error> {
        Self::extend_instance_ttl(&env);
        if ids.len() > MAX_GET_ESCROWS {
            return Err(Error::BatchTooLarge);
        }
        let mut records = Vec::new(&env);
        for id in ids.iter() {
            records.push_back(env.storage().persistent().get(&DataKey::Escrow(id)));
        }
        Ok(records)
    }

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
