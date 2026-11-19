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
