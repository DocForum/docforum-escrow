Issue #22 adds immutable split recipients to escrow creation. Release deducts any
protocol fee first, distributes the remaining amount by basis-point shares,
and sends rounding remainder to the final recipient. Refund destinations and
authorization rules are unchanged.
