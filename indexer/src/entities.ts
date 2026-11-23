// The SubQuery entity classes are generated from schema.graphql by
// `npm run codegen` (see indexer/README.md) and are not committed. The mapping
// imports them through this module so its logic has one entity dependency and
// unit tests can substitute in-memory fakes with `vi.mock("../../src/entities")`.
export { Escrow, EscrowEvent } from "./types";
