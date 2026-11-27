Issue #312 (Phase E7): added golden tests in `contracts/escrow/tests/events.rs`
that pin the exact topics and payload of every non-lifecycle event:
`accepted`, `top_up`, `rotate`, `pay_xfer`, `contrib`, `claimed`,
`PayeeRefunded`, `Paused` and `Unpaused`. Each test ends on the emitting call
and names the indexer mapping or SDK decoder that consumes the event, so any
change to these shapes shows up as a deliberate, reviewed diff. Test-only: no
contract change, so the generated bindings are unchanged.
