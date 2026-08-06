# Build environment for dominion_silver_mint.
#
# AUDIT FINDING S-07: this header used to claim "Pins Solana 1.18.26 + Anchor 0.30.1 + Rust 1.79"
# while the ARGs three lines below set 2.1.20 / 0.31.1 / 1.79.0. Two of the three were simply wrong,
# and the word "Reproducible" over a stale header is how two operators end up on different toolchains
# believing they are on the same one. The header now reads its values from the ARGs, which are the
# only thing docker actually uses.
#
# THIS IS NOT THE RELEASE PATH. The authoritative toolchain is documented in
# docs/MAINNET_LAUNCH_RUNBOOK.md (Solana 3.0.0 / platform-tools 1.51 / SBF rustc 1.84.1 /
# anchor 0.31.1), and third-party reproducibility is attested by the `reproducible-build` CI job via
# solana-verify. This image is a convenience for local builds and tests only.
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
