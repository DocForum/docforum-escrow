Issue #356 (Phase E7): added a path-filtered `web-demo` CI job that builds the
SDK and React hooks package from this checkout, verifies TypeScript and Vite
resolve those local build outputs, then type-checks and production-builds the
demo. No public SDK or contract API changed.
