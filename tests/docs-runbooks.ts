/**
 * The runbooks and READMEs against the code they describe: commands that must work when copied (bind-chip arguments,
 * verifiable deploys), checks that must show what they claim (replay, build commit), and security claims that must not
 * overstate the code. No validator needed:
 *   npm run mocha:unit     (or NODE_OPTIONS=--no-experimental-strip-types npx ts-mocha -p ./tsconfig.json tests/docs-runbooks.ts)
 * (also runs as part of `anchor test`).
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { parseBindChipArgs } from "../scripts/lib/cli";

const ROOT = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const DOCS = ["README.md", "programs/README.md", "apps/verify/README.md", "apps/web/README.md", "docs/deploy.md", "docs/devnet.md", "docs/hardware-day.md", "docs/demo-script.md"];
const lines = () => DOCS.flatMap((f) => read(f).split("\n").map((text, i) => ({ where: `${f}:${i + 1}`, text })));

/** Positional arguments of a usage string: `<required>` (also `"<required>"`) and `[optional]`. */
function argShape(usage: string): { required: string[]; optional: string[] } {
  const required = [...usage.matchAll(/"?<([^>]+)>"?/g)].map((m) => m[1]);
  const optional = [...usage.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  return { required, optional };
}

describe("runbooks match the code", () => {
  it("every bind-chip usage in the docs has the parser's arguments (Core asset 6th, then [kind] [verifyUrl])", () => {
    let usage = "";
    try { parseBindChipArgs([]); } catch (e) { usage = String((e as Error).message).split("\n").pop() ?? ""; }
    const want = argShape(usage.replace(/^usage: bind-chip /, ""));
    expect(want.required).to.have.length(6);
    expect(want.required[5]).to.match(/^coreAsset/);
    const uses = [...lines(), ...read("scripts/bind-chip.ts").split("\n").map((text, i) => ({ where: `scripts/bind-chip.ts:${i + 1}`, text }))]
      .flatMap(({ where, text }) => [...text.matchAll(/bind-chip\.ts ((?:"?<[^>]+>"? ?|\[[^\]]+\] ?)+)/g)].map((m) => ({ where, args: m[1] })));
    expect(uses.length).to.be.greaterThan(2);
    for (const u of uses) {
      const got = argShape(u.args);
      expect(got.required.length, `${u.where}: ${u.args}`).to.equal(want.required.length);
      expect(got.required[5], `${u.where}: the 6th argument is the Core asset`).to.match(/^coreAsset/);
      expect(got.optional.length, `${u.where}: [kind] [verifyUrl]`).to.equal(want.optional.length);
    }
  });

  it("deploys and upgrades use the verifiable build output (target/verifiable)", () => {
    for (const { where, text } of lines()) {
      for (const m of text.matchAll(/anchor upgrade (\S+)/g)) expect(m[1], where).to.match(/^target\/verifiable\//);
      if (/anchor build --verifiable/.test(text) && /anchor deploy/.test(text)) expect(text, where).to.match(/anchor deploy --verifiable/);
    }
  });

  it("the replay check replays the sticker's SUN URL, not the stored result page", () => {
    const replay = lines().filter(({ text }) => /Repeated tap/.test(text) && /URL/.test(text));
    expect(replay.length).to.be.greaterThan(2);
    for (const { where, text } of replay) {
      expect(text, where).to.match(/picc_data/);
      expect(text, where).not.to.match(/Open (an old|the same) `?\/t\?tap=/);
    }
  });

  it("a SEAL_DEAD report is confirmed by the passport's issuer or the registry authority (mark_seal_dead)", () => {
    for (const { where, text } of lines()) expect(text, where).not.to.match(/until a partner confirms/);
  });

  it("deploy.md: the build commit and the admin token are described as the verifier behaves", () => {
    const deploy = read("docs/deploy.md");
    const config = read("apps/verify/fv/config.py");
    expect(config).to.match(/e\("FV_BUILD_SHA"\) or e\("RAILWAY_GIT_COMMIT_SHA"\)/);
    const buildRow = deploy.split("\n").find((l) => l.startsWith("| `FV_BUILD_SHA` |")) ?? "";
    expect(buildRow, "FV_BUILD_SHA row").to.match(/RAILWAY_GIT_COMMIT_SHA/).and.to.match(/railway up/);
    expect(deploy).to.match(/`null` after a `railway up` without `FV_BUILD_SHA`/);
    const adminRow = deploy.split("\n").find((l) => l.startsWith("| `FV_ADMIN_TOKEN` |")) ?? "";
    expect(adminRow, "FV_ADMIN_TOKEN row").to.match(/POST \/api\/dev\/reset/);
    // While routes_dev.py checks the token only when one is set, an empty token leaves /api/dev/reset open, and the
    // table must say so (re-check this when the reset route requires a token).
    if (/if settings\.admin_token and not admin_token_ok/.test(read("apps/verify/fv/routes_dev.py"))) {
      expect(adminRow).not.to.match(/empty disables them/);
      expect(adminRow).to.match(/`POST \/api\/dev\/reset`[^|]*open/);
    }
  });

  it("README security claims stay within what the code does", () => {
    const readme = read("README.md");
    const resume = readme.split("\n").find((l) => /wallet-app resume link/.test(l)) ?? "";
    expect(resume, "the resume token works while the scan is pending, it is not consumed").not.to.match(/single-use/);
    expect(resume).to.match(/pending/);
    const sticky = readme.split("\n").find((l) => /Grades only get worse/.test(l)) ?? "";
    expect(sticky, "sticky grades are on devnet only after the upgrade").to.match(/devnet/);
  });

  it("demo-script: demo tools need demo mode, and the triggered scene never uses the featured bottle", () => {
    const demo = read("docs/demo-script.md");
    expect(demo).to.match(/NEXT_PUBLIC_DEV_SIMULATOR=true/).and.to.match(/\/dev\?demo=1/).and.to.match(/\/dev\?demo=0/);
    const featured = /app\.flaconvault\.com\/p\/(SN-[0-9-]+)/.exec(read("README.md"))?.[1];
    expect(featured).to.be.a("string");
    const scene4 = demo.split("\n").filter((l) => /^\| 4 /.test(l));
    expect(scene4).to.have.length(2);
    for (const row of scene4) expect(row.replace(new RegExp(`never ${featured}`, "g"), "")).not.to.include(featured as string);
    expect(demo).to.match(/Mint Metaplex Core/);
    expect(read("apps/web/src/components/certify-console.tsx")).to.match(/Mint Metaplex Core/);
  });
});
