# Ledger signer manual test

`LedgerSigner` is exposed from `@docforum/escrow-sdk/signers/ledger`. The
adapter accepts an injected `@ledgerhq/hw-app-str` instance, so transport
selection stays with the caller:

```ts
import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import Str from "@ledgerhq/hw-app-str";
import { LedgerSigner } from "@docforum/escrow-sdk/signers/ledger";

const transport = await TransportWebHID.create();
const app = new Str(transport);
const signer = await LedgerSigner.connect({
  app,
  path: "44'/148'/0'",
  networkPassphrase: "Test SDF Network ; September 2015",
  displayAddress: true,
});
```

For Node HID, construct `@ledgerhq/hw-transport-node-hid` instead. Use a
Ledger Stellar app version that supports Soroban authorization signing and
enable hash signing in the app settings. `LedgerSigner` checks the app
configuration before each signature and throws `LedgerHashSigningDisabledError`
if it is disabled. It never exports or uses a software private key.

Manual checklist: verify the displayed address, sign one simulated testnet
transaction, sign one Soroban authorization entry, reject once on-device,
and unplug or time out once. Confirm rejected/transport errors are surfaced
and no transaction is submitted after a failed signature.
