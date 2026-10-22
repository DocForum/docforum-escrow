### Added

- `sdk/src/factory.ts`: `predictInstanceAddress(factoryId, salt, networkPassphrase?)`
  derives the contract address a factory's `deploy_instance` will create,
  offline, using the CAP-0046 preimage (deployer address + salt + network id).
- `FactoryClient` (`deployInstance`, `getInstance`, `forIntegrator`) for a
  factory that exposes `deploy_instance(integrator, salt)` and
  `get_instance(integrator)`, plus `randomSalt()`.
- `EscrowClient.forIntegrator(factoryClient, integrator)` builds a client bound
  to an integrator's instance.
- `sdk/tests/factory.test.ts` pins a golden derivation vector, and the live
  factory suites only run when `TESTNET_FACTORY_ID` points at a deployed
  factory (none ships in this repo yet).

Closes #205.
