// Soroban escrow contract.
//
// Phase E1 (see ROADMAP.md): create_escrow, get_status.
// Phase E2: release, refund. Both restricted to the escrow's `releaser`
// address, set at create_escrow time — see docs/adr/0002 for why a
// per-escrow releaser was chosen over a single contract-level admin.
// Phase E4 (issue #11): optional `refund_after` timeout refund — see
// docs/adr/0004. After that deadline anyone may refund, but only back to
// the payer, so a lost `releaser` key can no longer lock funds forever.
// Phase E5: split payouts and protocol fee support — see docs/adr/0005.
// Splits are basis points summing to 10,000; fee is bps taken off the top.
//
// Hard rule (see ARCHITECTURE_ESSENTIALS.md / docs/adr/0001): the contract
// enforces WHO may act, not WHY. `condition_ref` is opaque — the contract
// never interprets it. Keep it that way; domain logic belongs in the
// consuming application (docforum-core), never here.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, String, Vec,
};

/// Basis points denominator: splits and fee are expressed in bps of
/// 10,000 (100%). See docs/adr/0005.
pub const BPS_DENOMINATOR: u32 = 10_000;

/// Maximum number of split recipients accepted by `create_escrow`.
/// Enforced on-chain and mirrored client-side in the SDK.
pub const MAX_RECIPIENTS: u32 = 10;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Funded,
    Released,
    Refunded,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SplitRecipient {
    pub address: Address,
    /// Share of the escrowed amount in basis points (of 10,000).
    pub bps: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct EscrowData {
    pub payer: Address,
    pub payee: Address,
    pub token: Address,
    pub amount: i128,
    pub condition_ref: String,
    pub status: EscrowStatus,
    /// The only address permitted to call `release`/`refund` on this
    /// escrow. Set once at `create_escrow` time — see docs/adr/0002.
    pub releaser: Address,
    /// Optional deadline (unix seconds) after which `refund` opens to
    /// anyone — still only back to `payer`. `None` means no timeout,
    /// behaviour identical to before this field existed — see docs/adr/0004.
    pub refund_after: Option<u64>,
    /// Split recipients in bps. Empty means a single payout to `payee`
    /// (legacy behaviour). When non-empty, sums to 10,000 bps — see
    /// docs/adr/0005.
    pub splits: Vec<SplitRecipient>,
    /// Protocol fee in bps (of 10,000), taken off the top before splits
    /// are applied. `0` means no fee. See docs/adr/0005.
    pub fee_bps: u32,
    /// Address receiving the protocol fee. Ignored when `fee_bps == 0`.
    pub fee_recipient: Address,
}

#[contracttype]
enum DataKey {
    Escrow(u64),
    NextId,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    InvalidAmount = 2,
    Unauthorized = 3,
    NotFunded = 4,
    /// `refund_after` was not strictly in the future at creation — see
    /// docs/adr/0004: a deadline that has already passed would let
    /// anyone refund the escrow before the releaser could ever act.
    InvalidRefundAfter = 5,
    /// The contract's token balance didn't rise by exactly `amount`
    /// across `create_escrow`'s transfer (a lying or short-delivering
    /// token) — see docs/threat-model.md T5.
    BalanceMismatch = 6,
    /// Splits were provided but do not sum to exactly 10,000 bps, or a
    /// recipient had zero bps — see docs/adr/0005.
    InvalidSplits = 7,
    /// More than `MAX_RECIPIENTS` split recipients were provided.
    TooManyRecipients = 8,
    /// `fee_bps` exceeded 10,000 (would consume the entire amount).
    InvalidFee = 9,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Locks `amount` of `token` pulled from `payer`, held for `payee`,
    /// tagged with an opaque `condition_ref`. `releaser` is the only
    /// address that will later be permitted to call `release`/`refund`
    /// on this escrow (see docs/adr/0002). `refund_after` is an optional
    /// unix timestamp after which `refund` opens to any caller, always
    /// back to `payer` (docs/adr/0004); `None` means no timeout.
    /// `splits` is an optional list of `(recipient, bps)` pairs summing
    /// to 10,000 bps; empty means a single payout to `payee`. `fee_bps`
    /// is an optional protocol fee in bps taken off the top and sent to
    /// `fee_recipient` on release — see docs/adr/0005.
    /// Requires `payer` auth (the contract moves their funds). Returns
    /// the new escrow's id.
    pub fn create_escrow(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
        splits: Vec<SplitRecipient>,
        fee_bps: u32,
        fee_recipient: Address,
    ) -> Result<u64, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if let Some(deadline) = refund_after {
            if deadline <= env.ledger().timestamp() {
                return Err(Error::InvalidRefundAfter);
            }
        }
        if fee_bps > BPS_DENOMINATOR {
            return Err(Error::InvalidFee);
        }
        if splits.len() > MAX_RECIPIENTS {
            return Err(Error::TooManyRecipients);
        }
        if !splits.is_empty() {
            let mut total: u32 = 0;
            for recipient in splits.iter() {
                if recipient.bps == 0 {
                    return Err(Error::InvalidSplits);
                }
                total = total.checked_add(recipient.bps).ok_or(Error::InvalidSplits)?;
            }
            if total != BPS_DENOMINATOR {
                return Err(Error::InvalidSplits);
            }
        }
        payer.require_auth();

        let token_client = token::Client::new(&env, &token);
        let contract_address = env.current_contract_address();
        let balance_before = token_client.balance(&contract_address);
        token_client.transfer(&payer, &contract_address, &amount);
        let balance_after = token_client.balance(&contract_address);
        if balance_after.checked_sub(balance_before) != Some(amount) {
            return Err(Error::BalanceMismatch);
        }

        let id = Self::next_id(&env);
        let data = EscrowData {
            payer,
            payee,
            token,
            amount,
            condition_ref,
            status: EscrowStatus::Funded,
            releaser,
            refund_after,
            splits,
            fee_bps,
            fee_recipient,
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &data);
        Ok(id)
    }

    /// Read-only status query. Errors if `escrow_id` doesn't exist.
    pub fn get_status(env: Env, escrow_id: u64) -> Result<EscrowStatus, Error> {
        let data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;
        Ok(data.status)
    }

    /// Read-only accessor for everything stored about `escrow_id` —
    /// payer, payee, token, amount, `condition_ref`, status, `releaser`
    /// and `refund_after`. Exists so payees and integrators can check
    /// the deadline before relying on a `Funded` escrow (docs/adr/0004,
    /// threat model T8). Errors on an unknown id.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowData, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)
    }

    /// Pure helper: computes per-recipient payout amounts for `escrow`
    /// using the contract's exact rounding rule (floor division, with
    /// any dust from the fee and each split share assigned to the last
    /// split recipient so the sum equals `amount`). Shared test vectors
    /// in `contracts/escrow/tests/vectors/` and `sdk/tests/vectors/`
    /// pin this behaviour bit-for-bit — see docs/adr/0005.
    ///
    /// Returns `(fee_amount, payouts)` where `payouts` mirrors the
    /// escrow's `splits` order (or a single entry for `payee` when
    /// `splits` is empty).
    pub fn preview_payout(
        env: Env,
        escrow_id: u64,
    ) -> Result<(i128, Vec<(Address, i128)>), Error> {
        let data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;
        Ok(Self::compute_payout(&data))
    }

    /// Moves the escrowed `amount` to `payee`. Only the escrow's
    /// `releaser` (set at `create_escrow` time) may call this — the
    /// contract enforces WHO, never WHY (ADR 0001). Errors if the
    /// escrow doesn't exist, `caller` isn't the releaser, or the escrow
    /// isn't currently `Funded` (no double-release, no releasing a
    /// refunded escrow).
    ///
    /// Deliberately **not** gated by `refund_after` (docs/adr/0004): after
    /// the deadline the releaser can still release, racing any timeout
    /// refund — whoever lands first wins and the other fails `NotFunded`.
    pub fn release(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;

        if caller != data.releaser {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }

        let token_client = token::Client::new(&env, &data.token);
        let contract_address = env.current_contract_address();
        let (fee_amount, payouts) = Self::compute_payout(&data);
        if fee_amount > 0 {
            token_client.transfer(&contract_address, &data.fee_recipient, &fee_amount);
        }
        for (recipient, payout) in payouts.iter() {
            if payout > 0 {
                token_client.transfer(&contract_address, &recipient, &payout);
            }
        }

        data.status = EscrowStatus::Released;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &data);
        Ok(())
    }

    /// Returns the escrowed `amount` to `payer`. Same state rule as
    /// `release` (only while `Funded`), but two callers are authorised:
    ///
    /// - the escrow's `releaser` (docs/adr/0002), always; or
    /// - **anyone**, once `refund_after` has been reached — the timeout
    ///   refund path for a lost/unsignable `releaser` key (docs/adr/0004).
    ///
    /// The destination never changes: timeout or not, funds only ever go
    /// back to the stored `payer`. With no `refund_after` set, behaviour
    /// is identical to before the timeout existed — releaser only.
    pub fn refund(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;

        let timeout_passed = match data.refund_after {
            Some(deadline) => env.ledger().timestamp() >= deadline,
            None => false,
        };
        if caller != data.releaser && !timeout_passed {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }

        let token_client = token::Client::new(&env, &data.token);
        token_client.transfer(&env.current_contract_address(), &data.payer, &data.amount);

        data.status = EscrowStatus::Refunded;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &data);
        Ok(())
    }

    /// The contract's single source of truth for payout math. Floor
    /// division on the fee, then floor division per split share, with
    /// the residual (dust) assigned to the last split recipient so the
    /// payouts always sum to exactly `amount - fee_amount`. Mirrored
    /// bit-for-bit by `previewPayout` in the SDK — see docs/adr/0005.
    fn compute_payout(env: &Env, data: &EscrowData) -> (i128, Vec<(Address, i128)>) {
        let denom = BPS_DENOMINATOR as i128;
        let fee_amount: i128 = if data.fee_bps == 0 {
            0
        } else {
            data.amount * (data.fee_bps as i128) / denom
        };
        let distributable = data.amount - fee_amount;

        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        if data.splits.is_empty() {
            payouts.push_back((data.payee.clone(), distributable));
            return (fee_amount, payouts);
        }

        let count = data.splits.len();
        let mut distributed: i128 = 0;
        for (i, recipient) in data.splits.iter().enumerate() {
            let share: i128 = if (i as u32) + 1 == count {
                distributable - distributed
            } else {
                distributable * (recipient.bps as i128) / denom
            };
            distributed += share;
            payouts.push_back((recipient.address.clone(), share));
        }
        (fee_amount, payouts)
    }

    fn next_id(env: &Env) -> u64 {
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }
}
