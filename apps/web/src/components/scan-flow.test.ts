import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The scan page is a client component with hooks (wallet adapter, router), so its wiring is checked on its source;
// the rules it wires are tested in lib/scan-steps.test.ts, lib/handoff.test.ts and lib/public-record.test.ts.
const source = readFileSync(new URL("./scan-flow.tsx", import.meta.url), "utf8");
/** The body of `const <name> = useCallback(async () => { … }, [` in the scan page. */
const callback = (name: string): string => {
  const m = new RegExp(`const ${name} = useCallback\\(async \\(\\) => \\{([\\s\\S]*?)\\n  \\}, \\[`).exec(source);
  assert.ok(m, `scan-flow.tsx has no ${name} callback`);
  return m[1];
};

test("the page asks /health once per page load whether the verifier has the public record, and the relay path needs a yes", () => {
  // one request at mount (no dependencies), whose answer decides the path; nothing re-asks it later
  assert.match(source, /useEffect\(\(\) => \{\s*let alive = true;\s*verifierHasPublicRecord\(PUBLIC_VERIFY_URL\)\.then\(\(yes\) => \{ if \(alive\) setPublicRecord\(yes\); \}\);\s*return \(\) => \{ alive = false; \};\s*\}, \[\]\);/);
  assert.equal(source.match(/verifierHasPublicRecord\(/g)?.length, 1);
  assert.match(source, /useState<boolean \| null>\(null\)/);
  assert.match(source, /scanPath\(\{ certified, flow: params\.get\("flow"\), tier, role, step, txSig, publicRecord \}\)/);
});

test("the relay button, its place note and its order note only under `relay`; the wallet flow keeps its own place note", () => {
  // the place note of the consumer path ("the place stays in FlaconVault's own database") needs `relay`
  assert.match(source, /\{relay \? PLACE_NOTE : WALLET_PLACE_NOTE\}/);
  assert.equal(source.match(/\bPLACE_NOTE\b/g)?.length, 2, "PLACE_NOTE: the import and the one conditional use");
  assert.match(source, /\{relay \? \(\s*<button onClick=\{\(\) => requestSignature\("relay"\)\}/);
  assert.equal(source.match(/requestSignature\("relay"\)/g)?.length, 1, "one relay button");
  assert.match(source, /\{relay && \(role === Role\.SELLER \|\| role === Role\.BUYER\) && <p role="note"/);
  // and the request itself is never made without it
  assert.match(source, /if \(anchor === "relay" && !relay\) return;/);
  assert.match(source, /anchor: anchor === "relay" \? "relay" : undefined,/);
});

test("the record step: polling that ends without a terminal record leaves only its text, never a spinner for good", () => {
  assert.match(source, /onEnd: \(end, e\) => \{ setRecord\(null\); setRecordGone\(recordStatusAfterPoll\(end, e\)\); \},/);
  assert.doesNotMatch(source, /onStop:/);
  // the pending line and the text are never shown together
  assert.match(source, /\{record && <RecordLine record=\{record\} serial=\{verify\.serial\} \/>\}/);
  assert.match(source, /\{!record && !recordGone && <p className="text-sm text-muted">\{NOT_SAVED\}<\/p>\}/);
  assert.match(source, /\{!record && recordGone && <p className="text-sm text-muted">\{recordGone\}<\/p>\}/);
});

test("New scan: the finished scan stays until the new session is there; a failed start goes to the session step", () => {
  const body = callback("startSession");
  const awaited = body.indexOf("await api.session()");
  assert.ok(awaited > 0);
  // the reset (which empties the record, verify and done steps) runs only after the request answered
  assert.doesNotMatch(body.slice(0, body.indexOf("const reset")), /set(?!Error\(null\))\w+\(/, "only the old error is cleared before the request");
  assert.doesNotMatch(body.slice(0, awaited), /\breset\(\);/, "no reset before the request");
  const [tryPart, catchPart] = body.split("} catch (e) {");
  assert.ok(catchPart, "startSession catches a failed request");
  assert.match(tryPart, /const s = await api\.session\(\);\s*reset\(\);\s*adoptSession\(s\);\s*setStep\(stepAfterSessionStart\(true\)\);/);
  assert.match(catchPart, /reset\(\); setSession\(null\); setClock\(null\);\s*setStep\(stepAfterSessionStart\(false\)\);\s*setError\(friendly\(e\)\);/);
  // the session step renders without any scan data, always with its "Start session" button
  assert.match(source, /\{step === "session" && \(/);
  assert.match(source, /<button onClick=\{startSession\} disabled=\{!!walletGate\} className="btn">Start session/);
});
