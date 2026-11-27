DEV_NETWORK := escrow-local
DEV_RPC := http://quickstart:8000/rpc
DEV_PASSPHRASE := Standalone Network ; February 2017
WASM := contracts/escrow/target/wasm32v1-none/release/docforum_escrow.wasm

.PHONY: dev dev-build dev-deploy dev-sdk-test

dev: dev-build dev-deploy dev-sdk-test

dev-build:
	cd contracts/escrow && cargo test
	cd contracts/escrow && cargo build --target wasm32v1-none --release

dev-deploy:
	@set -eu; \
	for attempt in $$(seq 1 90); do \
	  if curl -fsS -X POST "$(DEV_RPC)" -H 'Content-Type: application/json' \
	    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null; then break; fi; \
	  if [ "$$attempt" -eq 90 ]; then echo "local quickstart RPC did not become healthy" >&2; exit 1; fi; \
	  sleep 2; \
	done; \
	stellar network add "$(DEV_NETWORK)" --rpc-url "$(DEV_RPC)" --network-passphrase "$(DEV_PASSPHRASE)" || true; \
	for name in deployer payer releaser stranger payee; do \
	  stellar keys generate "$$name" --network "$(DEV_NETWORK)" --overwrite >/dev/null; \
	done; \
	for name in deployer payer releaser stranger payee; do \
	  for attempt in $$(seq 1 60); do \
	    if stellar keys fund "$$name" --network "$(DEV_NETWORK)" >/dev/null 2>&1; then break; fi; \
	    if [ "$$attempt" -eq 60 ]; then echo "friendbot did not fund $$name" >&2; exit 1; fi; \
	    sleep 2; \
	  done; \
	done; \
	stellar contract alias remove native-token --network "$(DEV_NETWORK)" >/dev/null 2>&1 || true; \
	stellar contract alias remove escrow --network "$(DEV_NETWORK)" >/dev/null 2>&1 || true; \
	test -f "$(WASM)"; \
	stellar contract asset deploy --asset native --source-account deployer --network "$(DEV_NETWORK)" --alias native-token >/dev/null; \
	token_id=$$(stellar contract alias show native-token --network "$(DEV_NETWORK)"); \
	stellar contract deploy --wasm "$(WASM)" --source-account deployer --network "$(DEV_NETWORK)" --alias escrow -- --allowed_tokens '[]' --pause_admin "$$(stellar keys public-key deployer)" >/dev/null; \
	contract_id=$$(stellar contract alias show escrow --network "$(DEV_NETWORK)"); \
	{ \
	  printf 'DOCFORUM_LOCAL_RPC_URL=%s\n' "$(DEV_RPC)"; \
	  printf 'DOCFORUM_LOCAL_NETWORK_PASSPHRASE=%s\n' "'$(DEV_PASSPHRASE)'"; \
	  printf 'DOCFORUM_LOCAL_CONTRACT_ID=%s\n' "$$contract_id"; \
	  printf 'DOCFORUM_LOCAL_PAYER_SECRET=%s\n' "$$(stellar keys secret payer)"; \
	  printf 'DOCFORUM_LOCAL_RELEASER_SECRET=%s\n' "$$(stellar keys secret releaser)"; \
	  printf 'DOCFORUM_LOCAL_STRANGER_SECRET=%s\n' "$$(stellar keys secret stranger)"; \
	  printf 'DOCFORUM_LOCAL_PAYEE=%s\n' "$$(stellar keys public-key payee)"; \
	  printf 'DOCFORUM_LOCAL_TOKEN_ID=%s\n' "$$token_id"; \
	} > .dev-env.local; \
	chmod 600 .dev-env.local; \
	echo "Local deployment written to .dev-env.local"

dev-sdk-test:
	@set -eu; \
	test -f .dev-env.local; \
	cd sdk; \
	npm ci; \
	npm run typecheck; \
	npm run build; \
	set -a; \
	. ../.dev-env.local; \
	set +a; \
	npx vitest run tests/contract-conformance.test.ts
