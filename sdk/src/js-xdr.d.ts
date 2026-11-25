// @stellar/js-xdr ships no bundled type declarations. It is a transitive
// dependency of @stellar/stellar-sdk and is used here only to serialize a
// ScVal to its canonical XDR bytes for the management digest. The runtime
// shape matches what stellar-sdk uses internally.
declare module "@stellar/js-xdr" {
  export class XdrWriter {
    constructor();
    toArray(): Uint8Array;
  }
}
