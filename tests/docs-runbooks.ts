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
    // routes_dev.py guards the reset with require_admin (403 while FV_ADMIN_TOKEN is unset or wrong): no doc may call
    // the reset open, or say it needs the token only "when set".
    expect(read("apps/verify/fv/routes_dev.py")).to.match(/@router\.post\("\/reset", dependencies=\[[^\]]*Depends\(require_admin\)/);
    expect(adminRow).to.match(/403/).and.not.to.match(/open to anyone/);
    for (const { where, text } of lines()) {
      if (/dev\/reset/.test(text)) expect(text, where).not.to.match(/when (`?FV_ADMIN_TOKEN`? is )?set|open to anyone/);
    }
  });

  it("deploys are manual: nothing claims that a push deploys, and deploy.md has the real commands", () => {
    for (const { where, text } of [...lines(), ...read(".github/workflows/ci.yml").split("\n").map((t, i) => ({ where: `ci.yml:${i + 1}`, text: t }))]) {
      expect(text, where).not.to.match(/deploy(s|ed)? on push|Git integrations?|Git deploys|push(es|ing)? (to )?`?main`? (starts|triggers|deploys(?! nothing))|switch(ing)? to Git/i);
    }
    const deploy = read("docs/deploy.md");
    expect(deploy).to.match(/\*\*not\*\* connected to GitHub/);
    expect(deploy).to.match(/vercel --cwd "\$D" --prod --yes/).and.to.match(/git archive "\$SHA"/);
    expect(deploy).to.match(/railway variable set FV_BUILD_SHA="\$SHA" --service verify --skip-deploys/);
    expect(deploy).to.match(/railway up --service verify --detach --ci/);
  });

  it("every web environment variable the code reads is in apps/web/.env.example and the deploy.md web table", () => {
    const src = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? src(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [read(path.join(dir, e.name))] : []);
    const names = new Set(src("apps/web/src").flatMap((t) => [...t.matchAll(/process\.env\.((?:NEXT_PUBLIC_)[A-Z0-9_]+|VERIFY_URL)/g)].map((m) => m[1])));
    expect([...names]).to.include.members(["NEXT_PUBLIC_VERIFY_URL", "NEXT_PUBLIC_ESCROW_ADMIN_CONTACT", "VERIFY_URL"]);
    const example = read("apps/web/.env.example");
    const deploy = read("docs/deploy.md");
    for (const n of names) {
      expect(example, `apps/web/.env.example: ${n}`).to.match(new RegExp(`^#? ?${n}=`, "m"));
      expect(deploy, `docs/deploy.md: ${n}`).to.include(`| \`${n}\` |`);
    }
  });

  it("the manual CI anchor job runs the escrow time-travel tests", () => {
    const ci = read(".github/workflows/ci.yml");
    const anchorJob = ci.slice(ci.indexOf("\n  anchor:"));
    expect(anchorJob).to.match(/run: bash scripts\/test-escrow-time-travel\.sh/);
    expect(anchorJob.indexOf("test-escrow-time-travel.sh")).to.be.lessThan(anchorJob.indexOf("anchor test --validator legacy"));
    expect(fs.existsSync(path.join(ROOT, "scripts/test-escrow-time-travel.sh"))).to.equal(true);
  });

  it("README security claims stay within what the code does", () => {
    const readme = read("README.md");
    const resume = readme.split("\n").find((l) => /wallet-app resume link/.test(l)) ?? "";
    expect(resume, "the resume token works while the scan is pending, it is not consumed").not.to.match(/single-use/);
    expect(resume).to.match(/pending/);
    // the grade rule of record_scan and the verifier: VOID and C sticky, A/B/D from the latest scan
    const sticky = readme.split("\n").find((l) => /VOID and C are sticky/.test(l)) ?? "";
    expect(sticky, "README grade sentence").to.match(/A\/B\/D follow the latest scan/);
    expect(sticky, "sticky grades are on devnet only after the upgrade").to.match(/devnet/);
    for (const { where, text } of lines()) expect(text, where).not.to.match(/[Gg]rades? only (ever )?gets? worse|the worse of DB and chain/);
  });

  it("every backticked repo path in the docs exists (repo-relative, or relative to the doc's own folder)", () => {
    // `apps/web/src/vision/vote.ts` stayed in hardware-day.md after the file was deleted; catch such dead references.
    // A path stops at a placeholder or glob (`<…>`, `*`, `{…}`, `$VAR`, `…`), which is then not checked.
    const repoPath = /(?:^|[\s"'(=:])((?:apps|packages|programs|scripts|docs|tests|\.github)\/[A-Za-z0-9_.@/-]*)(.?)/g;
    const dead: string[] = [];
    let checked = 0;
    for (const f of DOCS) {
      read(f).split("\n").forEach((text, i) => {
        for (const span of text.matchAll(/`([^`\n]+)`/g)) {
          for (const m of span[1].matchAll(repoPath)) {
            if (m[2] && "<*{$…".includes(m[2])) continue;
            const rel = m[1].replace(/[.,:;)]+$/, "");
            checked++;
            if (![ROOT, path.join(ROOT, path.dirname(f))].some((base) => fs.existsSync(path.join(base, rel)))) dead.push(`${f}:${i + 1}: ${rel}`);
          }
        }
      });
    }
    expect(checked).to.be.greaterThan(50);
    expect(dead, dead.join("\n")).to.deep.equal([]);
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
