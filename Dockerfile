# Reproducible build environment for dominion_silver_mint.
# Pins Solana 1.18.26 + Anchor 0.30.1 + Rust 1.79 + Node 20.
# Used for: anchor build, anchor test, and reproducible binary verification.
#
# Build:   docker build -t dominion-builder .
# Run:     docker run --rm -v "$PWD":/work -w /work dominion-builder anchor build

FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG SOLANA_VERSION=2.1.20
ARG ANCHOR_VERSION=0.31.1
ARG RUST_VERSION=1.79.0
ARG NODE_VERSION=20

# Base tooling.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        git \
        build-essential \
        pkg-config \
        libssl-dev \
        libudev-dev \
        ca-certificates \
        gnupg \
        wget \
    && rm -rf /var/lib/apt/lists/*

# Node.js (for tests + ts-mocha).
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    npm install -g yarn ts-node typescript

# Rust (pinned).
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
        sh -s -- --default-toolchain ${RUST_VERSION} -y --profile minimal && \
    rustup component add rustfmt clippy

# Solana CLI (pinned).
RUN sh -c "$(curl -sSfL https://release.solana.com/v${SOLANA_VERSION}/install)"
ENV PATH=/root/.local/share/solana/install/active_release/bin:$PATH

# Anchor via AVM.
RUN cargo install --git https://github.com/coral-xyz/anchor avm --locked --force && \
    avm install ${ANCHOR_VERSION} && avm use ${ANCHOR_VERSION}

WORKDIR /work

CMD ["bash"]
