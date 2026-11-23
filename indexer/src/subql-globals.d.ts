// SubQuery injects `store`, `logger`, `unsafeApi` and friends into every
// mapping at run time. The generated entity classes under src/types (see
// `npm run codegen`) reference those globals, so include the ambient
// declarations here; without this the build reports "Cannot find name 'store'".
import "@subql/types-stellar/dist/global";
