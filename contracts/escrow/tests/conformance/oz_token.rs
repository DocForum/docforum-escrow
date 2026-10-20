// A custom SEP-41 token contract, modelled on OpenZeppelin's Stellar
// contracts (the `FungibleToken` module of `openzeppelin-contracts`).
//
// Why this exists: issue #133 asks for a conformance suite that proves the
// escrow works with *any* SEP-41 implementation, not just the Stellar Asset
// Contract. This contract is the "third implementation" of the matrix: it is
// deployed like any other Wasm contract, it has its own storage layout, and
// its metadata (including the number of decimals) is chosen by whoever
// deploys it.
//
// It is a **test double**, not a production token: it lives in the test tree
// and exists only so the suite can point the escrow at something that is not
// a SAC. Two properties matter for the suite:
//
//  1. it implements SEP-41 faithfully — `transfer` takes a `MuxedAddress`
//     destination, exactly like the SAC and the SEP-41 interface; and
//  2. it is *not* a SAC: no issuer, no trustlines, no admin flags, balances
//     in its own contract storage.
//
// The number of decimals is a constructor argument, so the same code covers
// 7-decimal tokens and 6-decimal ones (USDC and friends). The escrow never
// looks at it — see `docs/token-conformance.md`.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, MuxedAddress, String,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
#[repr(u32)]
pub enum TokenError {
    /// The account does not hold enough tokens for the operation.
    InsufficientBalance = 1,
    /// The spender's allowance is smaller than the amount it tried to move.
    InsufficientAllowance = 2,
    /// The caller is not the token administrator.
    Unauthorized = 3,
    /// The amount is negative.
    InvalidAmount = 4,
    /// The resulting balance would overflow.
    Overflow = 5,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Balance(Address),
    Allowance(Address, Address),
    Admin,
    Decimals,
    Name,
    Symbol,
    TotalSupply,
}

/// The SEP-41 `transfer` event.
#[contractevent]
pub struct Transfer {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

/// The SEP-41 `approve` event.
#[contractevent]
pub struct Approve {
    #[topic]
    pub from: Address,
    #[topic]
    pub spender: Address,
    pub amount: i128,
    pub live_until_ledger: u32,
}

/// The `mint` event of this implementation.
#[contractevent]
pub struct Mint {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

/// The SEP-41 `burn` event.
#[contractevent]
pub struct Burn {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contract]
pub struct OzToken;

#[contractimpl]
impl OzToken {
    /// Deploy-time setup, mirroring OpenZeppelin's `FungibleToken`: an
    /// administrator, the token metadata, and the number of decimals.
    pub fn __constructor(env: Env, admin: Address, decimals: u32, name: String, symbol: String) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);
    }

    // --- metadata (SEP-41) ---

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Decimals).unwrap()
    }

    pub fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name).unwrap()
    }

    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::Symbol).unwrap()
    }

    // --- balances and allowances (SEP-41) ---

    pub fn balance(env: Env, id: Address) -> i128 {
        Self::balance_of(&env, &id)
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        Self::allowance_of(&env, &from, &spender)
    }

    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        live_until_ledger: u32,
    ) {
        from.require_auth();
        if amount < 0 {
            panic_with_error!(env, TokenError::InvalidAmount);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Allowance(from.clone(), spender.clone()), &amount);
        Approve {
            from,
            spender,
            amount,
            live_until_ledger,
        }
        .publish(&env);
    }

    /// Moves `amount` from `from` to `to`.
    ///
    /// The destination is a `MuxedAddress`, exactly as SEP-41 requires and as
    /// the Stellar Asset Contract does. A custom token that declared a plain
    /// `Address` here would be *unreachable* for the escrow: the escrow calls
    /// `transfer` through the SEP-41 client, which always sends a
    /// `MuxedAddress`. `tests/token_conformance.rs` pins that behaviour.
    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        let to_address = to.address();
        Self::move_balance(&env, &from, &to_address, amount);
        Transfer {
            from,
            to: to_address,
            amount,
        }
        .publish(&env);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        let allowed = Self::allowance_of(&env, &from, &spender);
        if allowed < amount {
            panic_with_error!(env, TokenError::InsufficientAllowance);
        }
        env.storage().persistent().set(
            &DataKey::Allowance(from.clone(), spender.clone()),
            &(allowed - amount),
        );
        Self::move_balance(&env, &from, &to, amount);
        Transfer { from, to, amount }.publish(&env);
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::decrease_balance(&env, &from, amount);
        Self::decrease_total_supply(&env, amount);
        Burn { from, amount }.publish(&env);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        let allowed = Self::allowance_of(&env, &from, &spender);
        if allowed < amount {
            panic_with_error!(env, TokenError::InsufficientAllowance);
        }
        env.storage().persistent().set(
            &DataKey::Allowance(from.clone(), spender.clone()),
            &(allowed - amount),
        );
        Self::decrease_balance(&env, &from, amount);
        Self::decrease_total_supply(&env, amount);
        Burn { from, amount }.publish(&env);
    }

    // --- administrator functions (not part of SEP-41) ---

    /// Mints new tokens. Administrator only — SEP-41 deliberately has no
    /// minting function, so every implementation names it differently.
    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if amount < 0 {
            panic_with_error!(env, TokenError::InvalidAmount);
        }
        Self::increase_balance(&env, &to, amount);
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap();
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(supply + amount));
        Mint { to, amount }.publish(&env);
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalSupply).unwrap()
    }

    // --- internals ---

    fn move_balance(env: &Env, from: &Address, to: &Address, amount: i128) {
        Self::decrease_balance(env, from, amount);
        Self::increase_balance(env, to, amount);
    }

    fn increase_balance(env: &Env, id: &Address, amount: i128) {
        let current = Self::balance_of(env, id);
        let updated = current
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(env, TokenError::Overflow));
        env.storage()
            .persistent()
            .set(&DataKey::Balance(id.clone()), &updated);
    }

    fn decrease_balance(env: &Env, id: &Address, amount: i128) {
        let current = Self::balance_of(env, id);
        if current < amount {
            panic_with_error!(env, TokenError::InsufficientBalance);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Balance(id.clone()), &(current - amount));
    }

    fn decrease_total_supply(env: &Env, amount: i128) {
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap();
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(supply - amount));
    }

    fn balance_of(env: &Env, id: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id.clone()))
            .unwrap_or(0)
    }

    fn allowance_of(env: &Env, from: &Address, spender: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Allowance(from.clone(), spender.clone()))
            .unwrap_or(0)
    }
}
