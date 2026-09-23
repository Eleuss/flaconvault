// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.
//
// Registry seeding lives in scripts/seed-devnet.ts (idempotent, run separately).

import * as anchor from "@anchor-lang/core";

module.exports = async function (provider: anchor.AnchorProvider) {
  anchor.setProvider(provider);
};
