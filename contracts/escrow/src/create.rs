//! Escrow creation entry points and payee acceptance.

use crate::*;
use crate::internal::Funding;

#[contractimpl]
impl EscrowContract {
    /// Locks `amount` of `token` pulled from `payer` and holds it for `payee`.
    /// `condition_ref` is bounded (docs/threat-model.md T10 and ROADMAP.md
    /// Phase E5). `releaser` is the
    /// address permitted to call `release`/`refund` on this escrow
    /// (docs/adr/0002). `refund_after` is optional (docs/adr/0004).
    /// `notify_payee` opts an implementing contract payee into
    /// `on_escrow_released(escrow_id, amount)` (docs/adr/0005-release-callback).
    /// The payer
    /// must authorize creation, and the payee must also authorize if
    /// `notify_payee` is true. `refund_to` is the optional refund
    /// destination for a sponsored escrow where the funder (`payer`) is
    /// not who should get the money back (docs/adr/0009): `None` means
    /// `payer`; it may not be this contract's own address, and the
    /// `payer`'s auth on this call covers it. `condition_ref` is stored
    /// verbatim and is public on-chain forever (docs/threat-model.md T9):
    /// pass an opaque id, never private or personal data. For M-of-N
    /// releasers use `create_escrow_with_releasers`.
    ///
    /// This is a deposit path, so it is gated by the emergency pause
    /// (docs/adr/0011): while paused it fails with `Paused` before any
    /// funds move, no escrow id is consumed and nothing is stored. The
    /// same check covers every creation entry point, and `top_up` applies
    /// it too.
    /// `fee_recipient`/`fee_bps` are the optional protocol fee, fixed at
    /// creation and taken at release — never on refund — with `fee_bps ≤`
    /// [`MAX_FEE_BPS`] (10 %), floor rounding, and both given together or
    /// not at all (docs/adr/0010). `None` on both means no fee.
    /// Creates an escrow that releases directly to up to eight unique
    /// recipients. Shares must be positive and total exactly 10,000 bps.
    /// Rounding remainder goes to the final recipient. If the callback is
    /// enabled, it is invoked on the first recipient; refunds use refund_to.
    pub fn create_split_escrow(
        env: Env,
        payer: Address,
        payees: Vec<PayeeShare>,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
        notify_payee: bool,
        refund_to: Option<Address>,
        fee_recipient: Option<Address>,
        fee_bps: Option<u32>,
    ) -> Result<u64, Error> {
        let primary_payee = payees.get(0).ok_or(Error::InvalidPayeeList)?.payee;
        let mut releasers = Vec::new(&env);
        releasers.push_back(releaser);
        Self::create_escrow_with_payees_inner(
            &env,
            payer,
            primary_payee,
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
            fee_recipient,
            fee_bps,
            None,
            false,
            Some(payees),
            Funding::Transfer,
        )
    }

    pub fn create_escrow(
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
        fee_recipient: Option<Address>,
        fee_bps: Option<u32>,
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
            fee_recipient,
            fee_bps,
            None,
            false,
        )
    }

    /// Creates a single-releaser escrow with an optional earliest release time.
    /// Release is allowed at the configured timestamp. Accepts the same
    /// optional `fee_recipient`/`fee_bps` pair as `create_escrow`
    /// (docs/adr/0010).
    pub fn create_escrow_release_time(
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
        release_not_before: Option<u64>,
        fee_recipient: Option<Address>,
        fee_bps: Option<u32>,
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
            release_not_before,
            fee_recipient,
            fee_bps,
            None,
            false,
        )
    }

    /// Creates an escrow with an opt-in payee acceptance gate. Existing
    /// integrations can keep using `create_escrow`, which defaults this off.
    pub fn create_escrow_with_acceptance(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
        requires_acceptance: bool,
        refund_to: Option<Address>,
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
            false,
            requires_acceptance,
            refund_to,
            None,
            None,
            None,
            None,
            false,
        )
    }

    /// Records the payee's acceptance for an opted-in funded escrow.
    pub fn accept(env: Env, escrow_id: u64, payee: Address) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        payee.require_auth();
        let mut data = Self::load(&env, escrow_id)?;
        if data.payee != payee {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        if !data.requires_acceptance {
            return Err(Error::AcceptanceNotConfigured);
        }
        if data.accepted_at.is_some() {
            return Err(Error::AlreadyAccepted);
        }
        let accepted_at = env.ledger().timestamp();
        data.accepted_at = Some(accepted_at);
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);
        Self::extend_escrow_ttl(&env, escrow_id, data.refund_after);
        env.events()
            .publish((symbol_short!("accepted"), escrow_id), (payee, accepted_at));
        Ok(())
    }

    /// Same as `create_escrow`, but the escrow is settled by M-of-N
    /// releasers instead of one address (docs/adr/0007): `threshold`
    /// distinct addresses from `releasers` must authorize a settlement.
    /// The set is stored at creation and cannot be changed afterwards —
    /// there is no admin and no setter. Rejects an empty set, more than
    /// 10 releasers, duplicate addresses, and a threshold of 0 or one
    /// larger than the set.
    pub fn create_escrow_with_releasers(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releasers: Vec<Address>,
        threshold: u32,
        refund_after: Option<u64>,
        notify_payee: bool,
        refund_to: Option<Address>,
    ) -> Result<u64, Error> {
        Self::create_escrow_inner(
            &env,
            payer,
            payee,
            token,
            amount,
            condition_ref,
            releasers,
            threshold,
            refund_after,
            notify_payee,
            false,
            refund_to,
            None,
            None,
            None,
            None,
            false,
        )
    }

    /// Batch version of `create_escrow`. Creates one escrow per item, in
    /// input order, and returns the new ids in the same order as `items`.
    /// `payer` authorizes once for the whole call. Fails atomically: if
    /// any item is invalid (bad amount, past `refund_after`, oversized
    /// `condition_ref`, short-delivering token) the whole call reverts and
    /// no escrows are created.
    ///
    /// `items.len()` must be `<= MAX_BATCH_SIZE` — see docs/adr/0012.
    pub fn create_escrows(
        env: Env,
        payer: Address,
        items: Vec<CreateItem>,
    ) -> Result<Vec<u64>, Error> {
        if items.len() > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }
        payer.require_auth();

        let mut ids: Vec<u64> = Vec::new(&env);
        for item in items.iter() {
            let mut releasers = Vec::new(&env);
            releasers.push_back(item.releaser.clone());
            let id = Self::create_escrow_inner(
                &env,
                payer.clone(),
                item.payee.clone(),
                item.token.clone(),
                item.amount,
                item.condition_ref.clone(),
                releasers,
                1,
                item.refund_after,
                false,
                false,
                None,
                None,
                None,
                None,
                None,
                true,
            )?;
            ids.push_back(id);
        }
        Ok(ids)
    }

    /// Creates a fixed-total escrow with a linear vesting schedule.
    pub fn create_streamed_escrow(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
        schedule: VestingSchedule,
    ) -> Result<u64, Error> {
        if schedule.start >= schedule.end
            || schedule
                .cliff
                .is_some_and(|cliff| cliff < schedule.start || cliff > schedule.end)
        {
            return Err(Error::InvalidVestingSchedule);
        }
        let id = Self::create_escrow(
            env.clone(),
            payer,
            payee,
            token,
            amount,
            condition_ref,
            releaser,
            refund_after,
            false,
            None,
            None,
            None,
        )?;
        env.storage()
            .persistent()
            .set(&DataKey::Vesting(id), &schedule);
        env.storage()
            .persistent()
            .set(&DataKey::Withdrawn(id), &0_i128);
        env.storage()
            .persistent()
            .set(&DataKey::TotalAmount(id), &amount);
        Ok(id)
    }
}
