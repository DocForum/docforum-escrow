//! The `RefundDeadlineExtended` event.

use crate::*;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefundDeadlineExtended {
    #[topic]
    pub escrow_id: u64,
    pub old_deadline: u64,
    pub new_deadline: u64,
}

// Note: the SDK typed-decoding work for non-lifecycle events (issue E6) also
// requires typed SDK variants for the other emitted events; this module only
// owns the `RefundDeadlineExtended` contract event definition.
