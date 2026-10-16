import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isValidElement, type ReactElement } from "react";
import PassportPage, { generateMetadata as passportMetadata } from "./p/[serial]/page";
import WalletPage from "./wallet/[pubkey]/page";
import OrderPage, { generateMetadata as orderMetadata } from "./market/o/[order]/page";
import PassportOrdersPage, { generateMetadata as marketMetadata } from "./market/[serial]/page";
import TagLanding, { generateMetadata as tapMetadata } from "./t/page";
import { Unavailable } from "@/components/badges";
import { TapGate } from "@/components/tap-gate";
import { OrderDetail, PassportOrders } from "@/components/order-detail";
import * as actionsJson from "./actions.json/route";

/**
 * Next 15 passes `params` and `searchParams` to pages and generateMetadata as Promises. These tests call the dynamic
 * pages the way Next 15 does and check that the awaited values reach the page (decoded where the page decodes).
 */
const asElement = (node: unknown): ReactElement<Record<string, unknown>> => {
  assert.ok(isValidElement(node), "the page returns a React element");
  return node as ReactElement<Record<string, unknown>>;
};

/** Verifier stub: every request answers 503 (an outage) and is recorded; console.error from lib/api is silenced. */
function verifierDown(t: TestContext): string[] {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response("down", { status: 503 });
  });
  t.mock.method(console, "error", () => {});
  return urls;
}

test("generateMetadata awaits params and decodes the segment (p, market, market/o)", async () => {
  assert.deepEqual(await passportMetadata({ params: Promise.resolve({ serial: "SN%202026-000007" }) }), { title: "Passport SN 2026-000007" });
  assert.deepEqual(await marketMetadata({ params: Promise.resolve({ serial: "SN-2026-000007" }) }), { title: "Market · SN-2026-000007" });
  assert.deepEqual(await orderMetadata({ params: Promise.resolve({ order: "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2" }) }), { title: "Order · 7GhXQ2fV…" });
  // a lone "%" is not a valid escape: the raw segment is kept instead of crashing the page
  assert.deepEqual(await passportMetadata({ params: Promise.resolve({ serial: "SN%" }) }), { title: "Passport SN%" });
});

test("market pages hand the awaited, decoded segment to their client components", async () => {
  const order = asElement(await OrderPage({ params: Promise.resolve({ order: "Abc%2Fdef" }) }));
  assert.equal(order.type, OrderDetail);
  assert.equal(order.props.orderPda, "Abc/def");
  const orders = asElement(await PassportOrdersPage({ params: Promise.resolve({ serial: "SN-2026-000007" }) }));
  assert.equal(orders.type, PassportOrders);
  assert.equal(orders.props.serial, "SN-2026-000007");
});

test("passport and wallet pages read the awaited param (verifier down: outage page, retry link re-encoded)", async (t) => {
  const urls = verifierDown(t);
  const passport = asElement(await PassportPage({ params: Promise.resolve({ serial: "SN%202026-000007" }) }));
  assert.equal(passport.type, Unavailable);
  assert.equal(passport.props.what, "Passport SN 2026-000007");
  assert.equal(passport.props.retry, "/p/SN%202026-000007");
  const wallet = asElement(await WalletPage({ params: Promise.resolve({ pubkey: "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2" }) }));
  assert.equal(wallet.type, Unavailable);
  assert.equal(wallet.props.retry, "/wallet/7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2");
  assert.deepEqual(urls.map((u) => new URL(u).pathname), ["/api/passport/SN%202026-000007", "/api/attester/7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2"]);
});

test("/t awaits searchParams: SUN parameters go to the tap gate without a verifier call", async (t) => {
  const urls = verifierDown(t);
  // NXP TagWriter mirror: uid=<UID>x<CTR>x<MAC>
  const tw = asElement(await TagLanding({ searchParams: Promise.resolve({ uid: "04a1b2c3d4e5f6x00002ax0011223344556677" }) }));
  assert.equal(tw.type, TapGate);
  assert.deepEqual(tw.props.params, { uid: "04a1b2c3d4e5f6", ctr: "00002a", cmac: "0011223344556677" });
  const enc = asElement(await TagLanding({ searchParams: Promise.resolve({ picc_data: "AABB", cmac: "CCDD", enc: "EEFF" }) }));
  assert.equal(enc.type, TapGate);
  assert.deepEqual(enc.props.params, { uid: "", ctr: "", cmac: "CCDD", piccData: "AABB", enc: "EEFF" });
  assert.deepEqual(await tapMetadata({ searchParams: Promise.resolve({}) }), { title: "Seal check" });
  assert.deepEqual(urls, []);
});

test("/t?tap=…&k=… with the verifier down keeps tap and k in the retry link", async (t) => {
  verifierDown(t);
  const page = asElement(await TagLanding({ searchParams: Promise.resolve({ tap: "12", k: "a b" }) }));
  assert.equal(page.type, Unavailable);
  assert.equal(page.props.retry, "/t?tap=12&k=a%20b");
  assert.deepEqual(await tapMetadata({ searchParams: Promise.resolve({ tap: "12" }) }), { title: "Seal check" });
});

test("/actions.json serves the fixed discovery document with CORS and a 5 minute browser cache", async () => {
  const r = actionsJson.GET();
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.headers.get("cache-control"), "public, max-age=300");
  const body = (await r.json()) as { rules: { pathPattern: string; apiPath: string }[] };
  assert.deepEqual(body.rules.map((x) => x.pathPattern), ["/market/o/*", "/market/*"]);
});

test("/actions.json answers the CORS preflight a Blink client's Actions headers trigger (GET and OPTIONS carry CORS)", () => {
  // a prerendered (force-static) route is served as a file and answers OPTIONS with 405: the route must stay dynamic
  assert.notEqual((actionsJson as Record<string, unknown>).dynamic, "force-static");
  const pre = actionsJson.OPTIONS();
  assert.equal(pre.status, 204);
  const get = actionsJson.GET();
  for (const r of [pre, get]) {
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("access-control-allow-methods"), "GET,OPTIONS");
    const allowed = (r.headers.get("access-control-allow-headers") ?? "").split(",").map((h) => h.trim().toLowerCase());
    for (const h of ["content-type", "x-accept-action-version", "x-accept-blockchain-ids"]) assert.ok(allowed.includes(h), `allows ${h}`);
  }
});
