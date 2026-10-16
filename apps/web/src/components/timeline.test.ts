import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { EventType } from "@flaconvault/proof";
import type { PassportEvent } from "@/lib/api";
import { Timeline } from "./timeline";

/** Every element of a rendered tree (plain function components are not expanded). */
function all(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) { node.forEach((n) => all(n, out)); return out; }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  out.push(el);
  all(el.props.children as ReactNode, out);
  return out;
}
const ev = (o: Partial<PassportEvent>): PassportEvent => ({
  id: 1, type: EventType.SCAN, ts: 1000, actor: null, actorLabel: null, txSig: null, status: "confirmed", sealUidHash: null,
  payload: { tier: 2, indicators: { heat: 0, humidity: 0 }, counter: 1 }, arBundle: null, arMedia: null, gradeAfter: null, location: null, ...o,
});
const explorerLinks = (events: PassportEvent[]) => all(Timeline({ events })).filter((el) => el.type === "a" && String(el.props.href).includes("explorer.solana.com/tx/"));

test("the timeline links real transactions to the explorer, but not the demo seed's made-up signatures", () => {
  assert.equal(explorerLinks([ev({ id: 1, txSig: "RealSig111" })]).length, 1);
  assert.equal(explorerLinks([ev({ id: 2, txSig: "SeedSig111", payload: { seed: true, tier: 2, indicators: {}, counter: 1 } })]).length, 0);
});
