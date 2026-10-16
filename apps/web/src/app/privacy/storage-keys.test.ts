import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../../", import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
});

test("the privacy page lists every fv.* browser storage key the app writes", () => {
  const privacy = readFileSync(join(SRC, "app/privacy/page.tsx"), "utf8");
  const keys: string[] = [];
  // "fv.scanSession", `fv.pendingEvent.${order}`, `fv.devwallet.${slot}`: the fixed part of the key
  const pattern = /["'`](fv\.[A-Za-z]+(?:\.)?)(?:\$\{|["'`])/g;
  for (const f of files(SRC)) {
    if (f.endsWith(join("privacy", "page.tsx"))) continue;
    const text = readFileSync(f, "utf8");
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text))) if (!keys.includes(m[1])) keys.push(m[1]);
  }
  assert.ok(keys.length >= 6, `found ${keys.join(", ")}`);
  keys.forEach((k) => assert.ok(privacy.includes(k), `${k} is written by the app but not listed on /privacy`));
});
