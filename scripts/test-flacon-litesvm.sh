#!/usr/bin/env bash
# LiteSVM tests of the v2 public record (programs/flacon/tests/record_scan_v2.rs): record_scan_v2 sent by a fee payer
# that is in no instruction, the actor rules, the ±600 s window and key validity under a Clock override, the setup
# instructions, and a byte-for-byte replay of docs/vectors.json v2.scans. LiteSVM 0.10 (Agave 3.1) cannot load the
# SBPF v3 binary `anchor build` produces, so the same source is built for SBPF v2 into target/sbf-v2 first. Needs the
# Solana CLI (cargo build-sbf) on PATH. The vector replay needs declare_id! to be the devnet id: run it before
# `anchor keys sync`.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build-sbf --manifest-path programs/flacon/Cargo.toml --tools-version v1.57 --arch v2 --sbf-out-dir target/sbf-v2 -- --locked
FV_FLACON_SO="$PWD/target/sbf-v2/flacon.so" cargo test -p flacon --locked --test record_scan_v2 -- --ignored --nocapture
