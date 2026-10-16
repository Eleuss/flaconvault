import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The console is a client component with hooks, so it is checked on its source; the request itself is tested in
// lib/verify-api.test.ts ("the simulator reset carries the admin token").
const source = readFileSync(new URL("./dev-console.tsx", import.meta.url), "utf8");

test("Reset + Seed goes through api.simReset with the entered admin token, never a bare POST", () => {
  // POST /api/dev/reset always needs x-admin-token; the console's own api() helper cannot send one
  assert.doesNotMatch(source, /\bapi(?:<[^>]*>)?\(\s*["'`]\/api\/dev\/reset/);
  assert.match(source, /verifyApi\.simReset\(adminToken\)/);
  assert.match(source, /type="password"/);
});

test("the admin token is never written to browser storage", () => {
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|indexedDB)\b/);
});

test("console errors are shown as readable text (friendly), not as raw status + JSON", () => {
  assert.match(source, /throw await apiError\(path, r\)/);
  assert.doesNotMatch(source, /\(e as Error\)\.message/);
});
