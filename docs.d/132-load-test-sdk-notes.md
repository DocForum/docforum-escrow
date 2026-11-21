---
file: ARCHITECTURE_ESSENTIALS.md
after: "points with declarations for both; browser-aware bundlers use its ESM entry."
---

`ChannelAccountPool` (`sdk/src/channel-accounts.ts`) hands out exclusive use of
funded source accounts so concurrent submissions do not contend on one sequence
number; it does no network I/O itself. `scripts/load/` is the local-network
throughput harness built on it — local only, never public testnet (see
`docs/performance.md`).
