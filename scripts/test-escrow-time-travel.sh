#!/usr/bin/env bash
# Time-travel tests of the escrow's window branches (programs/escrow/tests/time_travel.rs) in LiteSVM.
# LiteSVM 0.10 (Agave 3.1) cannot load the SBPF v3 binary `anchor build` produces, so the same source is built
# for SBPF v2 into target/sbf-v2 first. Needs the Solana CLI (cargo build-sbf) on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build-sbf --manifest-path programs/escrow/Cargo.toml --tools-version v1.57 --arch v2 --sbf-out-dir target/sbf-v2 -- --locked
FV_ESCROW_SO="$PWD/target/sbf-v2/escrow.so" cargo test -p escrow --locked --test time_travel -- --ignored
