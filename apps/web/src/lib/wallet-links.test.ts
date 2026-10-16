import { test } from "node:test";
import assert from "node:assert/strict";
import { autoConnectPolicy, noInjectedWallet, resumeRef, resumeUrl, walletBrowseLinks } from "./wallet-links";

const TOKEN = "Zm9vYmFyYmF6cXV4MTIzNA"; // 22 url-safe characters, like secrets.token_urlsafe(16)

test("resume link carries eventId + token, never signed scan data (contract C1)", () => {
  const u = new URL(resumeUrl({ eventId: 42, token: TOKEN, tier: 4, role: 4, siteId: 3 }, "https://app.example"));
  assert.equal(u.pathname, "/scan");
  assert.equal(u.searchParams.get("resume"), `42.${TOKEN}`);
  assert.equal(u.searchParams.get("tier"), "4");
  assert.equal(u.searchParams.get("role"), "4");
  assert.equal(u.searchParams.get("site"), "3");
  assert.deepEqual(Array.from(u.searchParams.keys()).sort(), ["resume", "role", "site", "tier"]);
  assert.doesNotMatch(u.toString(), /msg|sig|nonce/i);
  assert.equal(new URL(resumeUrl({ eventId: 1, token: TOKEN, tier: 1, role: 0, siteId: 0 }, "https://app.example")).searchParams.has("site"), false);
});

test("resume reference parsing is strict", () => {
  assert.deepEqual(resumeRef.decode(`42.${TOKEN}`), { eventId: 42, token: TOKEN });
  assert.equal(resumeRef.encode({ eventId: 42, token: TOKEN }), `42.${TOKEN}`);
  for (const bad of ["", null, "42", `.${TOKEN}`, `0.${TOKEN}`, `-1.${TOKEN}`, "42.short", `42.${TOKEN}.x`, `42.${TOKEN}/`, "eyJ2Ijp7fX0", `99999999999999999.${TOKEN}`]) {
    assert.equal(resumeRef.decode(bad), null, String(bad));
  }
});

test("wallet browse links wrap the target URL", () => {
  const l = walletBrowseLinks("https://app.example/scan?resume=1.x", "https://app.example");
  assert.ok(l.phantom.startsWith("https://phantom.com/ul/browse/https%3A%2F%2Fapp.example%2Fscan%3Fresume%3D1.x?ref="));
  assert.ok(l.solflare.startsWith("https://solflare.com/ul/v1/browse/"));
});

test("WalletConnect does not auto-connect on page load; a wallet picked in this page view does", () => {
  const remembered = autoConnectPolicy("WalletConnect", "WalletConnect");
  assert.equal(remembered("WalletConnect"), false, "page load: no QR modal by itself");
  assert.equal(remembered("WalletConnect"), true, "picked again by the user: connects");
  const fresh = autoConnectPolicy("WalletConnect", null);
  assert.equal(fresh("WalletConnect"), true, "nothing remembered: this is a user selection");
  const other = autoConnectPolicy("WalletConnect", "Phantom");
  assert.equal(other("Phantom"), true, "other wallets reconnect as before");
});

test("demo and relay wallets do not count as an injected wallet", () => {
  assert.equal(noInjectedWallet([{ name: "Dev wallet A (seller)", installed: true }, { name: "WalletConnect", installed: true }, { name: "Burner Wallet", installed: true }]), true);
  assert.equal(noInjectedWallet([{ name: "Phantom", installed: true }]), false);
  assert.equal(noInjectedWallet([{ name: "Phantom", installed: false }]), true);
});
