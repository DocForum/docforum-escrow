---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] SDK `rotateReleaser` with two-party authorization (issue #326):
  `prepareRotateReleaser` / `signRotationAuth` / `submitRotation`; each party
  signs only its own `rotate_releaser` auth entry and the submitter needs
  neither key. Tests: `sdk/tests/rotation.test.ts`.
