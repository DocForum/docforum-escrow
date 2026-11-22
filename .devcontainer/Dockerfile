FROM mcr.microsoft.com/devcontainers/rust:1-1.96-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/stellar-cli-version /tmp/stellar-cli-version

RUN set -eux; \
    version=$(sed -n 's/^version=//p' /tmp/stellar-cli-version); \
    case "$(uname -m)" in \
      x86_64) arch=x86_64; key=linux-x86_64-sha256 ;; \
      aarch64|arm64) arch=aarch64; key=linux-aarch64-sha256 ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    checksum=$(sed -n "s/^${key}=//p" /tmp/stellar-cli-version); \
    curl -fsSL -o /tmp/stellar-cli.tar.gz "https://github.com/stellar/stellar-cli/releases/download/v${version}/stellar-cli-${version}-${arch}-unknown-linux-gnu.tar.gz"; \
    echo "${checksum}  /tmp/stellar-cli.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/stellar-cli.tar.gz -C /usr/local/bin stellar; \
    rm /tmp/stellar-cli.tar.gz /tmp/stellar-cli-version; \
    rustup target add wasm32v1-none; \
    stellar --version
