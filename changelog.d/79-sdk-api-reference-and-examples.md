Issue #79 (Phase E6): published SDK API reference and runnable examples.
Added `sdk/typedoc.json` to generate an HTML reference for every exported
symbol, with a missing-doc lint — `npm run docs` fails on undocumented
exports, broken doc links, or unexpectedly non-exported types
(`treatValidationWarningsAsErrors`). Added doc comments to the exported
symbols that lacked them. New `sdk/examples/` directory with one runnable,
secret-free script per major flow (create/release, timeout refund, M-of-N
quorum, and the estimate → prepare/sign → guard → fee-bump → submit
sponsorship flow): every keypair is generated at runtime and Friendbot-funded,
testnet only. CI type-checks the examples (`typecheck:examples`) and adds an
`sdk-docs` job; a new `.github/workflows/docs.yml` publishes the reference to GitHub Pages
(enabling Pages is a one-time human step). Docs-only: no contract or SDK API
change, so the generated bindings and the SDK version are unchanged.
