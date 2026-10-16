import { test } from "node:test";
import assert from "node:assert/strict";
import { Role, Tier } from "@flaconvault/proof";
import { cameraOn, escrowScanWarning, initialRole, iosSignHint, needsPartnerWallet, partnerWalletGate, roleChoices, timedStep, type ScanStep, type WalletEnv } from "./scan-steps";

const ALL: ScanStep[] = ["session", "tap", "preview", "camera", "read", "verify", "tx", "done", "dead"];

test("the camera runs only on the camera step of a running session (S17)", () => {
  for (const step of ALL) {
    assert.equal(cameraOn(step, false), step === "camera", step);
    assert.equal(cameraOn(step, true), false, `${step}, expired`);
  }
});

test("the session countdown stops once the server has signed", () => {
  assert.deepEqual(ALL.filter((s) => !timedStep(s)), ["tx", "done", "dead"]);
});

// ---- certified scans (M4 handoff: iPhone Safari without an injected wallet) -----------------------------------

const env = (o: Partial<WalletEnv> = {}): WalletEnv => ({ connected: false, ios: false, injectedWallet: false, walletConnect: true, ...o });

test("tiers 3/4 and the vault/partner roles need the partner wallet (the verifier answers not_partner otherwise)", () => {
  assert.equal(needsPartnerWallet(Tier.BIRTH, Role.PARTNER), true);
  assert.equal(needsPartnerWallet(Tier.CERTIFIED, Role.VAULT), true);
  assert.equal(needsPartnerWallet(Tier.SELF_MEDIA, Role.PARTNER), true);
  assert.equal(needsPartnerWallet(Tier.SELF_MEDIA, Role.OWNER), false);
  assert.equal(needsPartnerWallet(Tier.SELF, Role.BUYER), false);
});

test("the certified flow offers only the vault and partner roles (owner/seller/buyer would fail on chain after signing)", () => {
  assert.deepEqual(roleChoices(true), [Role.VAULT, Role.PARTNER]);
  assert.deepEqual(roleChoices(false), [Role.OWNER, Role.SELLER, Role.BUYER]);
  assert.equal(initialRole(Role.PARTNER, true), Role.PARTNER);
  assert.equal(initialRole(Role.VAULT, true), Role.VAULT);
  // /scan?tier=4 without a role (Number(null) = 0), or with an owner role: partner
  assert.equal(initialRole(0, true), Role.PARTNER);
  assert.equal(initialRole(Role.BUYER, true), Role.PARTNER);
  // the plain flow never starts as vault/partner
  assert.equal(initialRole(Role.PARTNER, false), Role.OWNER);
  assert.equal(initialRole(Role.SELLER, false), Role.SELLER);
  assert.equal(initialRole(Number.NaN, false), Role.OWNER);
});

test("no gate when no partner is needed or the wallet is connected", () => {
  assert.equal(partnerWalletGate(Tier.SELF_MEDIA, Role.OWNER, env({ ios: true })), null);
  assert.equal(partnerWalletGate(Tier.BIRTH, Role.PARTNER, env({ connected: true, ios: true })), null);
});

test("iPhone Safari with WalletConnect: connect the partner wallet before the signature, and how", () => {
  const g = partnerWalletGate(Tier.BIRTH, Role.PARTNER, env({ ios: true }))!;
  assert.equal(g.canConnect, true);
  assert.match(g.text, /signed for the partner wallet that is connected when you press “Get signature”/);
  assert.match(g.text, /choose WalletConnect/);
  assert.match(g.text, /Tapping the seal reloads this page.*press it once/);
});

test("iPhone Safari without WalletConnect: no dead end at “Get signature”, the page says what works instead", () => {
  const g = partnerWalletGate(Tier.BIRTH, Role.PARTNER, env({ ios: true, walletConnect: false }))!;
  assert.equal(g.canConnect, false);
  assert.match(g.text, /no WalletConnect set up/);
  assert.match(g.text, /Android Chrome/);
});

test("other browsers (or the wallet app's own browser on iPhone): connect first", () => {
  for (const e of [env(), env({ ios: true, injectedWallet: true }), env({ walletConnect: false })]) {
    const g = partnerWalletGate(Tier.CERTIFIED, Role.VAULT, e)!;
    assert.equal(g.canConnect, true);
    assert.match(g.text, /Connect it here, best before you start/);
  }
});

test("the iPhone anchor step names a way to sign, and the wallet a certified scan is bound to", () => {
  assert.match(iosSignHint({ walletConnect: true, canResume: true, signedFor: null }), /WalletConnect.*or continue in the wallet app's browser/);
  assert.match(iosSignHint({ walletConnect: true, canResume: false, signedFor: "PartnerWa11etPubkey1111111111111111111111111" }), /WalletConnect.*signed for wallet Part…1111: only that wallet/);
  assert.match(iosSignHint({ walletConnect: false, canResume: true, signedFor: null }), /continues in the wallet app's browser/);
  assert.match(iosSignHint({ walletConnect: false, canResume: false, signedFor: null }), /cannot be signed in this browser/);
  assert.doesNotMatch(iosSignHint({ walletConnect: true, canResume: true, signedFor: null }), /Safari cannot connect a wallet/);
});

// ---- escrow scans (vision handoff) --------------------------------------------------------------------------

test("seller and buyer are warned before signing a scan the order page could not use", () => {
  const read = (heat: number, humidity: number) => ({ found: true, heat, humidity });
  assert.equal(escrowScanWarning(Role.SELLER, read(0, 0)), null);
  assert.equal(escrowScanWarning(Role.BUYER, read(1, 0)), null);
  assert.match(escrowScanWarning(Role.SELLER, read(2, 0))!, /shipping scan \(heat unreadable\)/);
  assert.match(escrowScanWarning(Role.BUYER, read(0, 3))!, /receipt scan \(humidity not read\)/);
  // no photo (tier 1) or card not found: nothing was read
  assert.match(escrowScanWarning(Role.BUYER, null)!, /heat not read, humidity not read.*Restart and photograph the card\.$/);
  assert.match(escrowScanWarning(Role.SELLER, read(2, 0))!, /Photograph the card again\.$/);
  assert.match(escrowScanWarning(Role.SELLER, { found: false, heat: 0, humidity: 0 })!, /heat not read/);
  // owners and partners have no order step
  assert.equal(escrowScanWarning(Role.OWNER, null), null);
  assert.equal(escrowScanWarning(Role.PARTNER, read(2, 2)), null);
});
