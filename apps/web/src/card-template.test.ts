// The printable card served at /card-template.svg (used by /certify) must stay the card in docs/card. The copy is
// tracked because Vercel deployments do not upload docs/card (.vercelignore).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("public/card-template.svg is identical to docs/card/Einlegekarte_RevC.svg", () => {
  const served = readFileSync(resolve(here, "../public/card-template.svg"));
  const source = readFileSync(resolve(here, "../../../docs/card/Einlegekarte_RevC.svg"));
  assert.ok(served.equals(source), "copy docs/card/Einlegekarte_RevC.svg to apps/web/public/card-template.svg");
});
