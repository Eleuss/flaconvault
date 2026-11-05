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

const text = (el: ReactElement<Record<string, unknown>>): string => {
  const c = el.props.children as ReactNode;
  return (Array.isArray(c) ? c : [c]).filter((x) => typeof x === "string").join("");
};

test("each scan row carries its scanBy label and an id for the 'view record' link; other events and old verifiers none", () => {
  const events = [
    ev({ id: 7, scanBy: "VISITOR", purpose: "TAP", payload: { tier: 0, counter: 3 } }),
    ev({ id: 8, scanBy: "HOLDER", purpose: "CHECK", payload: { tier: 2, counter: 4, indicators: {} } }),
    ev({ id: 9, scanBy: "PARTNER", payload: { tier: 3, role: 4, counter: 5, indicators: {} } }),
    ev({ id: 10, scanBy: "RECIPIENT", purpose: "RECEIPT", payload: { tier: 2, counter: 6, indicators: {} } }),
    ev({ id: 11, payload: { tier: 2, role: 0, counter: 7, indicators: {} } }), // an older verifier: no scanBy
    ev({ id: 12, type: EventType.MINT, scanBy: "VISITOR", payload: {} }),
  ];
  const tree = all(Timeline({ events }));
  const rows = tree.filter((el) => el.type === "li");
  assert.deepEqual(rows.map((el) => el.props.id), ["e7", "e8", "e9", "e10", "e11", "e12"]);
  // the label chip (a v1 partner scan also lists its role "Partner" among the details, which is not the chip)
  const labels = tree.filter((el) => el.type === "span" && String(el.props.className).includes("rounded-full") && ["Visitor", "Holder", "Partner", "Recipient"].includes(text(el))).map(text);
  assert.deepEqual(labels, ["Visitor", "Holder", "Partner", "Recipient"]);
});

test("a recorded scan links its public record; other events keep the tx link", () => {
  const links = all(Timeline({ events: [ev({ id: 1, txSig: "ScanSig" }), ev({ id: 2, type: EventType.MINT, txSig: "MintSig", payload: {} })] }))
    .filter((el) => el.type === "a" && String(el.props.href).includes("explorer.solana.com/tx/"));
  assert.deepEqual(links.map((el) => [String(el.props.href).split("/tx/")[1].split("?")[0], text(el)]), [["ScanSig", "Public record "], ["MintSig", "tx "]]);
});
