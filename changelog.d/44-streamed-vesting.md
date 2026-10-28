Issue #44 (Phase E5): added fixed-total linear vesting streams
(`create_streamed_escrow`, `withdraw`, `get_vesting`; ADR 0012). The payee
withdraws vested funds while the escrow is funded; `release` pays whatever is
still unwithdrawn; a refund splits vested-but-unwithdrawn funds to the payee
and the unvested remainder to `refund_to`. Streams reject `top_up`. New
contract errors 35–39 are appended after main's codes. The generated SDK
bindings were regenerated.
