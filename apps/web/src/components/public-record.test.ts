import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import Link from "next/link";
import { NOT_SAVED, SAVED, SAVING, SAVING_TAP_SOON, TEST_PHASE_NOTICE, VIEW_RECORD, type PublicRecord } from "@/lib/public-record";
import { RecordLine, TestPhaseNotice } from "./public-record";

/** Every element of a rendered tree (plain function components are not expanded). */
function all(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) { node.forEach((n) => all(n, out)); return out; }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  out.push(el);
  all(el.props.children as ReactNode, out);
  return out;
}
/** The text of a rendered tree, in reading order. */
const words = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(words).join("");
  return isValidElement(node) ? words((node.props as { children?: ReactNode }).children) : "";
};
const rec = (o: Partial<PublicRecord>): PublicRecord => ({ state: "pending", purpose: "CHECK", eventId: 5, ...o });

test("the record line says saving, saved with 'view record' to the history row, or not saved", () => {
  assert.equal(words(RecordLine({ record: rec({}), serial: "SN-1", nowS: 100 })), SAVING);
  assert.equal(words(RecordLine({ record: rec({ purpose: "TAP", dueAt: 200 }), serial: "SN-1", nowS: 100 })), SAVING_TAP_SOON);
  const saved = RecordLine({ record: rec({ state: "recorded", txSig: "Sig" }), serial: "SN-1", nowS: 100 });
  assert.equal(words(saved), "Saved to the public record \u2713 \u00b7 view record");
  assert.equal(words(saved), `${SAVED} · ${VIEW_RECORD}`);
  const link = all(saved).find((el) => el.type === Link);
  assert.equal(link?.props.href, "/p/SN-1#e5");
  assert.equal(words(RecordLine({ record: rec({ state: "failed", reason: "relay_off" }), serial: "SN-1", nowS: 100 })), NOT_SAVED);
});

test("the test-phase notice is shown off mainnet and gone on mainnet", () => {
  assert.equal(TestPhaseNotice({ cluster: "mainnet" }), null);
  assert.equal(words(TestPhaseNotice({ cluster: "devnet" })), TEST_PHASE_NOTICE);
  assert.equal(words(TestPhaseNotice({ cluster: "localnet" })), TEST_PHASE_NOTICE);
  // default: the configured cluster (devnet while NEXT_PUBLIC_SOLANA_CLUSTER is unset)
  assert.equal(words(TestPhaseNotice({})), TEST_PHASE_NOTICE);
});
