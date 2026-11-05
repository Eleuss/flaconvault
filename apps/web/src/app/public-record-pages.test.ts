import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { EventType } from "@flaconvault/proof";
import type { Passport } from "@/lib/api";
import { DRAWER_TEXT, DRAWER_TITLE } from "@/lib/public-record";
import PassportPage from "./p/[serial]/page";
import TagLanding from "./t/page";
import { LiveCheck } from "@/components/live-check";
import { TestPhaseNotice } from "@/components/public-record";
import { TapRecord } from "@/components/tap-record";
import { Timeline } from "@/components/timeline";

/** Every element of a rendered tree (plain function components are not expanded). */
function all(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) { node.forEach((n) => all(n, out)); return out; }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  out.push(el);
  all(el.props.children as ReactNode, out);
  return out;
}
const strings = (el: ReactElement<Record<string, unknown>>): string[] => {
  const c = el.props.children as ReactNode;
  return (Array.isArray(c) ? c : [c]).filter((x): x is string => typeof x === "string");
};
/** The verifier answers every request with `body` (JSON, 200). */
function verifierAnswers(t: TestContext, body: unknown): void {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

const tapView = (o: Record<string, unknown> = {}) => ({
  tapId: 31, ts: 1_790_000_000, verdict: "VALID", counter: 9, serial: "SN-2026-000001", serialHash: "0x" + "11".repeat(32),
  uidHash: "0x" + "22".repeat(32), sealKind: 1, sealDead: false, uid: null, message: "Seal genuine · tap 9", ...o,
});

test("/t shows the tap's public record under the verdict (TAP pending, polled by the client)", async (t) => {
  const record = { state: "pending", purpose: "TAP", eventId: 77, dueAt: 1_790_000_185, txSig: null, reason: null, cluster: "DEVNET" };
  verifierAnswers(t, tapView({ record }));
  const page = await TagLanding({ searchParams: Promise.resolve({ tap: "31", k: "tok" }) });
  const rec = all(page).filter((el) => el.type === TapRecord);
  assert.equal(rec.length, 1);
  assert.deepEqual(rec[0].props.initial, record);
  assert.equal(rec[0].props.tapId, 31);
  assert.equal(rec[0].props.serial, "SN-2026-000001");
  assert.equal(typeof rec[0].props.serverNow, "number");
});

test("/t without a record (an older verifier, or nothing queued) shows no record line", async (t) => {
  verifierAnswers(t, tapView());
  assert.equal(all(await TagLanding({ searchParams: Promise.resolve({ tap: "31" }) })).filter((el) => el.type === TapRecord).length, 0);
  verifierAnswers(t, tapView({ record: { state: "replaced", purpose: "TAP", eventId: 1 } }));
  assert.equal(all(await TagLanding({ searchParams: Promise.resolve({ tap: "31" }) })).filter((el) => el.type === TapRecord).length, 0);
});

const passport: Passport = {
  serial: "SN-2026-000001", serialHash: "0x" + "11".repeat(32), brand: "Maison", name: "No. 1", batch: "B1",
  asset: null, issuer: null, issuerLabel: null, grade: 0, void: false, createdAt: 1_790_000_000,
  seals: [], sealStatus: "INTACT", stats: { scanCount: 1, attesterCount: 0, certifiedCount: 0, counter: 9, onChainScanCount: 1 },
  latest: null,
  events: [{ id: 77, type: EventType.SCAN, ts: 1_790_000_200, actor: null, actorLabel: null, txSig: "Sig77", status: "confirmed", sealUidHash: null,
    payload: { tier: 0, counter: 9, anchor: "relay", purpose: "TAP" }, arBundle: null, arMedia: null, gradeAfter: null, location: null, scanBy: "VISITOR", purpose: "TAP" }],
};

test("/p: the test-phase notice under the header, the history, and the closed drawer with the on-chain block and live check", async (t) => {
  verifierAnswers(t, passport);
  const tree = all(await PassportPage({ params: Promise.resolve({ serial: "SN-2026-000001" }) }));
  assert.equal(tree.filter((el) => el.type === TestPhaseNotice).length, 1);
  assert.equal(tree.filter((el) => el.type === Timeline).length, 1);
  const drawer = tree.filter((el) => el.type === "details");
  assert.equal(drawer.length, 1);
  assert.notEqual(drawer[0].props.open, true, "closed by default");
  const inside = all(drawer[0].props.children as ReactNode);
  assert.ok(inside.some((el) => el.type === "summary" && strings(el).includes(DRAWER_TITLE)));
  assert.ok(inside.some((el) => el.type === "p" && strings(el).includes(DRAWER_TEXT)));
  assert.ok(inside.some((el) => el.type === "p" && strings(el).includes("On-chain")));
  // "Check live on-chain" lives only in the drawer now
  assert.equal(inside.filter((el) => el.type === LiveCheck).length, 1);
  assert.equal(tree.filter((el) => el.type === LiveCheck).length, 1);
});
