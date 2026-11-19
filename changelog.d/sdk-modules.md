The SDK's `src/index.ts` no longer holds every public type: its top-level types,
constants and errors moved into topical modules (`escrow-types`, `events`,
`milestones`, `networks`, `contract-version`, `batch`, `client-config`,
`lifecycle`, `pooled`, `relayed-auth`, `prepare-submit`, `fees`,
`archived-entries`), re-exported from `index.ts`, which keeps the
`EscrowClient` class. Private helpers shared between them are in
`internal.ts`. The package's exports are unchanged (all 170, with identical
types).
