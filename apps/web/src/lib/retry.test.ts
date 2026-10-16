import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Unavailable } from "@/components/badges";
import { retryBoundary } from "./retry";

/** Depth-first search through a rendered element tree (plain function components are not expanded). */
function find(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) { for (const n of node) { const hit = find(n, pred); if (hit) return hit; } return null; }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (pred(el)) return el;
  return find(el.props.children as ReactNode, pred);
}
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("") : typeof node === "string" ? node : isValidElement(node) ? text((node.props as { children?: ReactNode }).children) : "";

test("the outage page's 'Try again' is a full page load, not a cached client navigation (S2)", () => {
  for (const retry of ["/p/SN-2026-000001", "/t?tap=12&k=abc", "/wallet/11111111111111111111111111111111"]) {
    const tree = Unavailable({ what: "Passport", retry });
    const again = find(tree, (el) => text(el.props.children as ReactNode) === "Try again");
    assert.ok(again, "a Try again control");
    // a full page load always reaches the server; a next/link <Link> could reuse a client router payload of this page
    assert.equal(again.type, "a", "a plain <a>, never next/link");
    assert.equal(again.props.href, retry);
  }
});

test("an error boundary's retry refetches the server payload, then resets, in one transition", () => {
  const calls: string[] = [];
  let inTransition = false;
  const start = (fn: () => void) => { inTransition = true; fn(); inTransition = false; calls.push("transition-end"); };
  const router = { refresh: () => calls.push(`refresh${inTransition ? "@t" : ""}`) };
  retryBoundary(router, () => calls.push(`reset${inTransition ? "@t" : ""}`), start);
  assert.deepEqual(calls, ["refresh@t", "reset@t", "transition-end"]);
  // the default uses React's startTransition (runs synchronously outside a render)
  const seen: string[] = [];
  retryBoundary({ refresh: () => seen.push("refresh") }, () => seen.push("reset"));
  assert.deepEqual(seen, ["refresh", "reset"]);
});
