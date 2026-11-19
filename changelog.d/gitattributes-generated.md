Generated files (SDK bindings, `contract-errors.generated.ts`,
`deployments.generated.ts`, `contract-spec.json`, contract test snapshots) are
marked `linguist-generated` in `.gitattributes`, so GitHub collapses them in PR
diffs; each entry names the command that regenerates it. CI now also checks
that `sdk/src/deployments.generated.ts` matches `deployments.json`.
