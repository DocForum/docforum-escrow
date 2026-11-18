// Flow: create a 2-of-3 M-of-N releaser escrow (docs/adr/0007), show that a
// single releaser cannot settle it alone, then release it with two approvals.
//
//   npm run build && node examples/quorum-release.ts   (from sdk/)
//
// Note: the escrow contract this points at must be a build that includes the
