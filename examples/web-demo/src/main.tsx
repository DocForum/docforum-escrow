import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EscrowClient } from "@docforum/escrow-sdk";
import { EscrowProvider } from "@docforum/escrow-react";
import { App } from "./App.js";

// Testnet only (hard rule 4). Set VITE_ESCROW_CONTRACT_ID to a testnet
// deployment; the demo never defaults to a mainnet contract id.
const contractId = import.meta.env.VITE_ESCROW_CONTRACT_ID ?? "";
const client = new EscrowClient({
  contractId,
  ...(import.meta.env.VITE_RPC_URL ? { rpcUrl: import.meta.env.VITE_RPC_URL } : {}),
  // Issue #129: timestamp each phase without pulling in OpenTelemetry. Swap
  // `onEvent` for `instrumentation: { tracer: await otelTracer() }` when your
  // app already runs OTel.
  onEvent: (event) => console.debug("[escrow]", event.name, event.durationMs, event.attributes),
});

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <EscrowProvider client={client} clientKey={contractId || "unconfigured"}>
        <App />
      </EscrowProvider>
    </QueryClientProvider>
  </StrictMode>,
);
