/**
 * scripts/p1-rollout.sh against fake CLIs: railway, vercel, gh, solana, solana-keygen, anchor and npx are
 * tests/lib/rollout_fake.py on a fake PATH (the rehearsal's Railway stand-in too, off PATH), the repo is a throwaway git
 * repo with a bare origin, and a local HTTP server answers the verifier's /health and the web app from the same fake
 * world. Checks the order of the calls, every refusal, re-runs, --dry-run, and that no secret value reaches the output,
 * a command line or a log. No network, no real key, no transaction. Needs zsh, git and python3 (skipped without zsh):
 *   npm run mocha:unit     (or NODE_OPTIONS=--no-experimental-strip-types npx ts-mocha -p ./tsconfig.json tests/p1-rollout.ts)
 * ROLLOUT_SHOW=1 prints every run's output, duration and number of fake calls.
 */
import { expect } from "chai";
import { execFileSync, spawn, spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { bs58encode as b58 } from "../scripts/lib/cli";

const ROOT = path.join(__dirname, "..");
const SCRIPT_SRC = path.join(ROOT, "scripts/p1-rollout.sh");
const FAKE = path.join(ROOT, "tests/lib/rollout_fake.py");
const FLACON = "7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL";
const ESCROW = "9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL";
const TOOLS = ["railway", "vercel", "gh", "solana", "solana-keygen", "anchor", "npx"];
const OLD_BUILD = "8fc705b".padEnd(40, "0");
const KEY2_PUB = "ab".repeat(32);
const OTHER_PUB = "Other1111111111111111111111111111111111111";

// Recognisable fake secrets: none of them may ever show up in the script's output or on a command line.
const SECRETS: Record<string, string> = {
  FV_MASTER_KEY: "5ec7e75ec7e75ec7e75ec7e75ec7e700",
  FV_ADMIN_TOKEN: "fake-admin-token-NEVER-PRINT-0001",
  FV_SERVER_ED25519_SEED: "5eed".repeat(16),
  FV_IRYS_KEY_JSON: JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256)),
};
const RPC = "http://127.0.0.1:9/?api-key=fake-rpc-key-NEVER-PRINT";
const WALLET_SEED = Buffer.alloc(32, 0xa7);
const WALLET_PUB_BYTES = crypto.createHash("sha256").update("fake-wallet-pub").digest();
const WALLET_JSON = JSON.stringify([...WALLET_SEED, ...WALLET_PUB_BYTES]);
const EXISTING_RELAYER = JSON.stringify([...Buffer.alloc(32, 0x5c), ...crypto.createHash("sha256").update("fake-relayer").digest()]);

const WALLET_PUB = b58(WALLET_PUB_BYTES);
const RELAYER_PUB = b58(Buffer.from(JSON.parse(EXISTING_RELAYER).slice(32)));

const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;

interface World { id: string; dir: string; repo: string; home: string; bin: string; tmp: string; state: string; calls: string; sha: string; outputs: string[] }
interface Run { code: number; out: string; calls: string[] }

const worlds: World[] = [];
let server: http.Server;
let port = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Rollout Test", "-c", "user.email=rollout@example.test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const readState = (w: World) => JSON.parse(fs.readFileSync(w.state, "utf8"));
function editState(w: World, edit: (s: any) => void) {
  const s = readState(w);
  edit(s);
  fs.writeFileSync(w.state, JSON.stringify(s, null, 1));
}
const pattern = (name: string, tag: string, size: number) => Buffer.from(`${name}-${tag}-`.repeat(Math.ceil(size / (name.length + tag.length + 2)) + 1)).subarray(0, size);

/** A fresh fake world: a repo on main pushed to a bare origin with green CI, the old verifier, programs that need an upgrade. */
function makeWorld(edit?: (s: any) => void): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1-rollout-"));
  const w: World = { id: path.basename(dir), dir, repo: path.join(dir, "repo"), home: path.join(dir, "home"), bin: path.join(dir, "bin"),
    tmp: path.join(dir, "tmp"), state: path.join(dir, "state.json"), calls: path.join(dir, "calls.log"), sha: "", outputs: [] };
  for (const d of [w.repo, w.bin, w.tmp, path.join(w.home, ".config/solana"), path.join(dir, "chain")]) fs.mkdirSync(d, { recursive: true });
  // the repo: the script under test, the health check it runs, the Vercel link (ignored, like the real one)
  fs.mkdirSync(path.join(w.repo, "scripts"));
  fs.mkdirSync(path.join(w.repo, ".github/scripts"), { recursive: true });
  fs.copyFileSync(SCRIPT_SRC, path.join(w.repo, "scripts/p1-rollout.sh"));
  for (const f of [".github/scripts/check-health.py", ".github/scripts/idl-check.sh"]) fs.copyFileSync(path.join(ROOT, f), path.join(w.repo, f));
  fs.mkdirSync(path.join(w.repo, "packages/proof/src/idl"), { recursive: true });
  for (const f of ["flacon.json", "flacon.ts", "escrow.json", "escrow.ts"]) fs.writeFileSync(path.join(w.repo, "packages/proof/src/idl", f), `committed ${f}\n`);
  fs.writeFileSync(path.join(w.repo, ".gitignore"), ".vercel\ntarget\n");
  fs.mkdirSync(path.join(w.repo, ".vercel"));
  fs.writeFileSync(path.join(w.repo, ".vercel/project.json"), '{"projectId":"prj_fake","orgId":"team_fake"}');
  git(dir, "init", "-q", "-b", "main", w.repo);
  git(w.repo, "add", "-A");
  git(w.repo, "commit", "-q", "-m", "P1 public record");
  git(dir, "init", "-q", "--bare", "-b", "main", path.join(dir, "origin.git"));
  git(w.repo, "remote", "add", "origin", path.join(dir, "origin.git"));
  git(w.repo, "push", "-q", "origin", "main");
  git(w.repo, "fetch", "-q", "origin");
  w.sha = git(w.repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(w.home, ".config/solana/id.json"), WALLET_JSON, { mode: 0o600 });
  for (const t of TOOLS) fs.writeFileSync(path.join(w.bin, t), `#!/bin/sh\nexec python3 -I "${FAKE}" ${t} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "chain", `${ESCROW}.bin`), pattern("escrow", "old", 4800));
  fs.writeFileSync(path.join(dir, "chain", `${FLACON}.bin`), pattern("flacon", "old", 2900));
  fs.writeFileSync(w.calls, "");
  const s: any = {
    walletFile: path.join(w.home, ".config/solana/id.json"), walletPub: WALLET_PUB,
    balances: { [WALLET_PUB]: 3_366_307_315 },
    programs: {
      [ESCROW]: { authority: "wallet", dataLen: 6000, programdata: "EscrowProgramData1111111111111111111111111", slot: 1 },
      [FLACON]: { authority: "wallet", dataLen: 3000, programdata: "FlaconProgramData1111111111111111111111111", slot: 1 },
    },
    // escrow fits its ProgramData, flacon needs 16000 − 3000 + 4096 more bytes
    build: { escrow: { size: 5000, tag: "p1" }, flacon: { size: 16000, tag: "p1" } },
    registry: { authority: "wallet", keys: [{ id: 1, pub: "0f".repeat(32), from: 0, to: 1792176384 }, { id: 2, pub: KEY2_PUB, from: 0, to: 0 }] },
    holderConfig: null, passports: 7, holdings: 0, buffers: [],
    vars: { ...SECRETS, FV_SERVER_KEY_ID: "2", FV_PROGRAM_ID: FLACON, FV_KEY_MODE: "sdmbackend", FV_BUILD_SHA: OLD_BUILD, FV_RELAY_ENABLED: "false" },
    seedPubs: { [SECRETS.FV_SERVER_ED25519_SEED]: KEY2_PUB },
    verifier: { build: OLD_BUILD, keyId: 2, pubkeyHex: KEY2_PUB, relayEnabled: false, relayerPub: null, cluster: "devnet", programId: FLACON, p1: false, down: false, deploys: 0 },
    railway: { loggedIn: true }, web: { deploys: 0, code: 200 },
    ci: { [w.sha]: [
      { databaseId: 101, status: "completed", conclusion: "success", event: "push", headSha: w.sha },
      { databaseId: 102, status: "completed", conclusion: "success", event: "workflow_dispatch", headSha: w.sha },
    ] },
    ciJobs: { "102": [{ name: "web (typecheck, lint, unit tests, build)", conclusion: "success" }, { name: "anchor test (local validator)", conclusion: "success" }] },
    ciTriggered: 0, failOnce: {}, history: {}, sigCounter: 0, keygenCount: 0, generated: [], stdinSecrets: [], upgrades: [],
  };
  edit?.(s);
  fs.writeFileSync(w.state, JSON.stringify(s, null, 1));
  worlds.push(w);
  return w;
}

/** /<world id>/v/health = the fake verifier, /<world id>/web = the web app. */
function serve(req: http.IncomingMessage, res: http.ServerResponse) {
  const [, id, what, sub] = (req.url ?? "").split("?")[0].split("/");
  const w = worlds.find((x) => x.id === id);
  if (!w) { res.writeHead(404).end(); return; }
  const s = readState(w);
  if (what === "web") { res.writeHead(s.web.code, { "content-type": "text/html" }).end("<html>FlaconVault</html>"); return; }
  const v = s.verifier;
  if (what !== "v" || sub !== "health" || v.down) {
    res.writeHead(404, { "content-type": "application/json" }).end('{"status":"error","code":404,"message":"Application not found"}');
    return;
  }
  const tags: Record<string, number> = { mainnet: 1, devnet: 2, localnet: 3 };
  const relayOk = v.relayEnabled && !!v.relayerPub && (s.balances[v.relayerPub] ?? 0) >= 100_000_000
    && s.holderConfig?.clusterTag === tags[v.cluster];
  const body: any = { ok: true, keyId: v.keyId, pubkeyHex: v.pubkeyHex, simulator: false, programId: v.programId, build: v.build,
    arweave: { enabled: false } };
  if (v.p1) Object.assign(body, { cluster: v.cluster, relay: { enabled: v.relayEnabled, ok: relayOk } });
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const callsOf = (w: World) => fs.readFileSync(w.calls, "utf8").split("\n").filter(Boolean);

function run(w: World, args: string[], o: { input?: string; cwd?: string; env?: Record<string, string> } = {}): Promise<Run> {
  const before = callsOf(w).length;
  const env: Record<string, string> = {
    PATH: `${w.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: w.home, TMPDIR: w.tmp, LANG: "en_US.UTF-8",
    FAKE_STATE: w.state, FAKE_CALLS: w.calls, FV_ROLLOUT_RPC: RPC,
    FV_ROLLOUT_VERIFY_URL: `http://127.0.0.1:${port}/${w.id}/v`, FV_ROLLOUT_WEB_URL: `http://127.0.0.1:${port}/${w.id}/web`,
    FV_ROLLOUT_WAIT_S: "8", FV_ROLLOUT_POLL_S: "1", FV_ROLLOUT_KEY_GRACE_S: "1", ...o.env,
  };
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const p = spawn("zsh", [path.join(w.repo, "scripts/p1-rollout.sh"), ...args], { cwd: o.cwd ?? w.repo, env });
    let out = "";
    let settled = false;
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { settled = true; p.kill("SIGKILL"); reject(new Error(`timeout: ${args.join(" ")}\n${out}`)); }, 150_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;   // timed out and killed: the test has failed already (and may have removed the world)
      settled = true;
      w.outputs.push(out);
      if (process.env.ROLLOUT_SHOW) console.log(`\n----- ${args.join(" ")} (${Date.now() - t0} ms, ${callsOf(w).length - before} calls)\n${out}`);
      // every temp dir (work dir, export, secret dir) is gone on every exit path
      const left = fs.readdirSync(w.tmp);
      if (left.length) { reject(new Error(`temp dirs left by ${args.join(" ")}: ${left.join(", ")}\n${out}`)); return; }
      resolve({ code: code ?? -1, out, calls: callsOf(w).slice(before) });
    });
    // a refusal can end the script before it reads its input: the closed pipe (EPIPE) is not the test's failure
    p.stdin.on("error", () => undefined);
    p.stdin.end(o.input ?? "");
  });
}

// Calls that change something remote (Railway or its rehearsal stand-in, Vercel, GitHub, the chain) or create a key.
const REMOTE_WRITES = [/^railway(-standin)? variable set /, /^railway up /, /^vercel --cwd /, /^solana program (extend|close) /, /^solana transfer /,
  /^anchor upgrade /, /^npx tsx scripts\/holder-config\.ts init /, /^npx tsx scripts\/init-holdings\.ts$/,
  /^npx tsx scripts\/server-key\.ts (add|revoke) /, /^gh workflow run /, /^solana-keygen new /];
const writes = (calls: string[]) => calls.filter((c) => REMOTE_WRITES.some((re) => re.test(c)));
const at = (calls: string[], re: RegExp) => calls.findIndex((c) => re.test(c));
const count = (calls: string[], re: RegExp) => calls.filter((c) => re.test(c)).length;
const LOCAL_STATE = "flaconvault-rollout-local";
/** The rehearsal's Railway stand-in (FV_ROLLOUT_RAILWAY): the fake's Railway model, off PATH, logged as railway-standin. */
function standin(w: World): string {
  const p = path.join(w.dir, "standin", "railway-standin");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `#!/bin/sh\nexec python3 -I "${FAKE}" railway-standin "$@"\n`, { mode: 0o755 });
  return p;
}

/** Everything a run may change: the fake world, the chain bytes, both rollout folders, the working tree. */
function snapshot(w: World): string {
  const files = (d: string): string[] => !fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? files(path.join(d, e.name)) : [`${path.join(d, e.name)}:${crypto.createHash("sha256").update(fs.readFileSync(path.join(d, e.name))).digest("hex")}`]);
  return [fs.readFileSync(w.state, "utf8"), ...files(path.join(w.dir, "chain")), ...files(path.join(w.home, "flaconvault-rollout")),
    ...files(path.join(w.home, LOCAL_STATE)), git(w.repo, "status", "--porcelain"), git(w.repo, "rev-parse", "HEAD")].join("\n");
}

function secretsOf(w: World): string[] {
  const s = readState(w);
  return [...Object.values(SECRETS), RPC, "fake-rpc-key", WALLET_JSON, WALLET_SEED.toString("hex"), EXISTING_RELAYER,
    ...s.generated.flatMap((g: any) => [g.json, g.seedHex, g.json.slice(1, 40)]), ...s.stdinSecrets]
    .filter((x: string) => x && x.length >= 8)
    .flatMap((x: string) => /^[0-9a-f]{64}$/.test(x) ? [x, x.slice(0, 16)] : [x]);
}
function expectNoSecrets(w: World, r: Run) {
  for (const secret of secretsOf(w)) {
    expect(r.out.includes(secret), `a secret (${secret.slice(0, 6)}…) is in the output`).to.equal(false);
    if (secret !== RPC && secret !== "fake-rpc-key") {
      for (const c of r.calls) expect(c.includes(secret), `a secret (${secret.slice(0, 6)}…) is on a command line: ${c.slice(0, 60)}`).to.equal(false);
    }
  }
}

async function deployed(w: World): Promise<void> {
  const r = await run(w, ["deploy"]);
  expect(r.code, r.out).to.equal(0);
}
/** The state a successful `deploy` leaves (that step has its own tests): the verifier on this commit, the web marker. */
function markDeployed(w: World) {
  editState(w, (s) => { s.vars.FV_BUILD_SHA = w.sha; Object.assign(s.verifier, { build: w.sha, p1: true }); });
  fs.mkdirSync(path.join(w.home, "flaconvault-rollout/deployed"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(w.home, "flaconvault-rollout/deployed", w.sha), "deployed (test)\n");
}
async function chained(w: World): Promise<void> {
  markDeployed(w);
  const r = await run(w, ["chain"], { input: "j\n" });
  expect(r.code, r.out).to.equal(0);
}
/** What step relay needs from step chain (which has its own tests): the HolderConfig. */
function markChained(w: World) {
  markDeployed(w);
  editState(w, (s) => { s.holderConfig = { clusterTag: 2 }; s.holdings = s.passports; });
}

(hasZsh ? describe : describe.skip)("scripts/p1-rollout.sh with fake CLIs (no network, no keys)", function () {
  this.timeout(420_000);   // a busy Mac runs each script call several times slower; a rotation test makes about ten

  before(async () => {
    server = http.createServer(serve);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const w of worlds) fs.rmSync(w.dir, { recursive: true, force: true });
  });

  it("explains its use in German and exits non-zero without a known step, from any folder", async () => {
    const w = makeWorld();
    for (const args of [[], ["deploys"], ["deploy", "chain"], ["--dry-run"]]) {
      const r = await run(w, args, { cwd: w.dir });
      expect(r.code, args.join(" ")).to.equal(1);
      expect(r.out).to.match(/So starten: zsh scripts\/p1-rollout\.sh <schritt>/);
      expect(r.calls).to.deep.equal([]);
    }
    const r = await run(w, ["deploy", "--dry-run"], { cwd: w.home });
    expect(r.code, r.out).to.equal(0);
    expect(r.out).to.match(/Nur Vorschau \(--dry-run\): nichts verändert/);
  });

  it("deploy refuses before any change: wrong branch, dirty tree, commit not on origin/main, CI not green, relay already on", async () => {
    const cases: Array<{ name: string; prep: (w: World) => void; msg: RegExp }> = [
      { name: "branch", prep: (w) => git(w.repo, "checkout", "-q", "-b", "feature/public-record"), msg: /Zweig 'feature\/public-record'.*nicht main/ },
      { name: "dirty", prep: (w) => fs.writeFileSync(path.join(w.repo, "notes.txt"), "x"), msg: /ungespeicherte Änderungen/ },
      { name: "unpushed", prep: (w) => { fs.writeFileSync(path.join(w.repo, "x.txt"), "x"); git(w.repo, "add", "x.txt"); git(w.repo, "commit", "-q", "-m", "local"); }, msg: /nicht genau der auf GitHub/ },
      { name: "ci red", prep: (w) => editState(w, (s) => { for (const r of s.ci[w.sha]) r.conclusion = "failure"; }), msg: /Tests auf GitHub sind rot/ },
      { name: "ci missing", prep: (w) => editState(w, (s) => { s.ci = {}; }), msg: /noch keinen Testlauf/ },
      { name: "ci running", prep: (w) => editState(w, (s) => { s.ci[w.sha] = [{ databaseId: 9, status: "in_progress", conclusion: "", event: "push", headSha: w.sha }]; }), msg: /laufen noch/ },
      { name: "relay on", prep: (w) => editState(w, (s) => { s.vars.FV_RELAY_ENABLED = "true"; }), msg: /Relay ist auf Railway schon an/ },
      { name: "relay On", prep: (w) => editState(w, (s) => { s.vars.FV_RELAY_ENABLED = " On "; }), msg: /Relay ist auf Railway schon an/ },
      { name: "relay sealed", prep: (w) => editState(w, (s) => { s.vars.FV_RELAY_ENABLED = null; }), msg: /versiegelt/ },
    ];
    for (const c of cases) {
      const w = makeWorld();
      c.prep(w);
      const before = snapshot(w);
      for (const dry of [false, true]) {
        const r = await run(w, dry ? ["deploy", "--dry-run"] : ["deploy"]);
        expect(r.code, `${c.name}: ${r.out}`).to.equal(1);
        expect(r.out, c.name).to.match(c.msg).and.to.match(/STOPP: /);
        expect(writes(r.calls), c.name).to.deep.equal([]);
        expectNoSecrets(w, r);
      }
      expect(snapshot(w), c.name).to.equal(before);
    }
  });

  it("deploy --dry-run shows the plan and changes nothing; a long commit subject is cut at a word", async () => {
    const w = makeWorld();
    git(w.repo, "commit", "-q", "--allow-empty", "-m", "P1 round 2: photos stay private, Holding for new passports, web waits for /health");
    git(w.repo, "push", "-q", "origin", "main");
    const old = w.sha;
    w.sha = git(w.repo, "rev-parse", "HEAD");
    editState(w, (s) => { s.ci[w.sha] = s.ci[old].map((r: any) => ({ ...r, headSha: w.sha })); });
    const before = snapshot(w);
    const r = await run(w, ["deploy", "--dry-run"]);
    expect(r.code, r.out).to.equal(0);
    expect(r.out).to.match(/1\. Verifier: FV_BUILD_SHA=/).and.to.match(/2\. Web-App: Export/).and.to.match(/Relay bleibt aus/);
    expect(r.out).to.include(`✓ Stand ${w.sha.slice(0, 7)}: P1 round 2: photos stay private, Holding for new passports, web waits…\n`);
    expect(writes(r.calls)).to.deep.equal([]);
    expect(snapshot(w)).to.equal(before);
    expectNoSecrets(w, r);
  });

  it("deploy: FV_BUILD_SHA, railway up and /health first, then the git-archive export with the .vercel link; a re-run skips the upload", async () => {
    const w = makeWorld();
    const r = await run(w, ["deploy"]);
    expect(r.code, r.out).to.equal(0);
    const c = r.calls;
    const setSha = at(c, new RegExp(`^railway variable set FV_BUILD_SHA=${w.sha} --service verify --skip-deploys$`));
    const up = at(c, /^railway up --service verify --detach --ci$/);
    const web = at(c, /^vercel --cwd \S+\/flaconvault --prod --yes$/);
    expect(at(c, /^gh run list --workflow ci\.yml --commit /)).to.be.greaterThan(-1).and.lessThan(setSha);
    expect(at(c, /^railway variable list --service verify --json$/)).to.be.lessThan(setSha);
    expect(setSha).to.be.greaterThan(-1).and.lessThan(up);
    expect(up).to.be.lessThan(web);
    expect(count(c, /^vercel --cwd/)).to.equal(1);
    const s = readState(w);
    expect(s.verifier.build).to.equal(w.sha);
    expect(s.verifier.relayEnabled).to.equal(false);
    expect(s.web.deploys).to.equal(1);
    expect(r.out).to.match(/Verifier läuft mit [0-9a-f]{7}, Relay aus/).and.to.match(/Nächster Schritt: zsh scripts\/p1-rollout\.sh chain/);
    expect(fs.existsSync(path.join(w.home, "flaconvault-rollout/deployed", w.sha))).to.equal(true);
    expectNoSecrets(w, r);

    const again = await run(w, ["deploy"]);
    expect(again.code, again.out).to.equal(0);
    expect(again.out).to.match(/läuft schon mit [0-9a-f]{7}, wird übersprungen/);
    expect(count(again.calls, /^railway (up|variable set)/)).to.equal(0);
    expect(count(again.calls, /^vercel --cwd/)).to.equal(1);
    expectNoSecrets(w, again);
  });

  it("chain refuses before any transaction: verifier not on this commit, wrong wallet, other registry authority, too little SOL, dirty tree", async () => {
    const cases: Array<{ name: string; prep: (w: World) => void; msg: RegExp; deploy?: boolean }> = [
      { name: "not deployed", prep: () => undefined, msg: /Online läuft der Stand '8fc705b'/, deploy: false },
      { name: "verifier down", prep: (w) => editState(w, (s) => { s.verifier.down = true; }), msg: /antwortet nicht/ },
      { name: "escrow authority", prep: (w) => editState(w, (s) => { s.programs[ESCROW].authority = OTHER_PUB; }), msg: /darf escrow nicht upgraden/ },
      { name: "flacon authority", prep: (w) => editState(w, (s) => { s.programs[FLACON].authority = OTHER_PUB; }), msg: /darf flacon nicht upgraden/ },
      { name: "registry authority", prep: (w) => editState(w, (s) => { s.registry.authority = OTHER_PUB; }), msg: /nicht die Registry-Autorität/ },
      { name: "balance", prep: (w) => editState(w, (s) => { s.balances[WALLET_PUB] = 500_000_000; }), msg: /Zu wenig devnet-SOL/ },
      { name: "idl", prep: (w) => editState(w, (s) => { s.build.flacon.idlJSON = "a different IDL\n"; }), msg: /IDL\) des Builds weicht von der im Repo ab/ },
      { name: "dirty", prep: (w) => fs.writeFileSync(path.join(w.repo, "notes.txt"), "x"), msg: /ungespeicherte Änderungen/ },
    ];
    for (const c of cases) {
      const w = makeWorld();
      if (c.deploy !== false) markDeployed(w);
      c.prep(w);
      const before = readState(w);
      const r = await run(w, ["chain"], { input: "j\n" });
      expect(r.code, `${c.name}: ${r.out}`).to.equal(1);
      expect(r.out, c.name).to.match(c.msg);
      expect(writes(r.calls), c.name).to.deep.equal([]);
      expect(r.out, c.name).not.to.match(/\(j\/n\)/);
      expect(readState(w), c.name).to.deep.equal(before);
      expectNoSecrets(w, r);
    }
  });

  it("chain without the manual CI run (anchor ticked) starts it and stops", async () => {
    const w = makeWorld((s) => { s.ciJobs["102"] = [{ name: "anchor test (local validator)", conclusion: "skipped" }]; });
    markDeployed(w);
    const dry = await run(w, ["chain", "--dry-run"]);
    expect(dry.code).to.equal(1);
    expect(dry.out).to.match(/Programm-Tests auf GitHub \(CI mit anchor\) fehlen noch/);
    expect(writes(dry.calls)).to.deep.equal([]);
    const r = await run(w, ["chain"], { input: "j\n" });
    expect(r.code).to.equal(1);
    expect(r.out).to.match(/Ich habe sie gerade gestartet/);
    expect(writes(r.calls)).to.deep.equal(["gh workflow run ci.yml --ref main -f anchor=true"]);
    expect(readState(w).upgrades).to.deep.equal([]);

    // a red manual run is reported, never quietly started again
    editState(w, (s) => { s.ci[w.sha][1].conclusion = "failure"; s.ciJobs["102"] = [{ name: "anchor test (local validator)", conclusion: "failure" }]; });
    const red = await run(w, ["chain"], { input: "j\n" });
    expect(red.code).to.equal(1);
    expect(red.out).to.match(/Programm-Tests auf GitHub \(CI mit anchor\) sind rot/);
    expect(writes(red.calls)).to.deep.equal([]);
    expect(readState(w).ciTriggered).to.equal(1);
  });

  it("chain --dry-run changes nothing", async () => {
    const w = makeWorld();
    markDeployed(w);
    const none = await run(w, ["chain", "--dry-run"]);
    expect(none.code).to.equal(1);
    expect(none.out).to.match(/Für die Vorschau fehlt ein Build/);
    // a build from an earlier run (the real one keeps target/deploy)
    execFileSync(path.join(w.bin, "anchor"), ["build"], { cwd: w.repo, env: { ...process.env, FAKE_STATE: w.state, FAKE_CALLS: path.join(w.dir, "setup-calls.log") } });
    const before = snapshot(w);
    const r = await run(w, ["chain", "--dry-run"]);
    expect(r.code, r.out).to.equal(0);
    expect(r.out).to.match(/2\. flacon: Platz um 17\.096 Bytes erweitern/).and.to.match(/1\. escrow: Upgrade auf 5\.000 Bytes \(passt in die 6\.000 Bytes/)
      .and.to.match(/3\. HolderConfig anlegen: cluster devnet \(2\)/).and.to.match(/4\. Holding für 7 von 7 Pässen/)
      .and.to.match(/Nur Vorschau \(--dry-run\): nichts verändert/);
    // the owner reads German: the preview tool's English lines are not part of the plan
    expect(r.out).not.to.match(/would init|warning: no holder_config|^ *(rpc|wallet|program) /m);
    expect(r.out).not.to.match(/\(j\/n\)/);
    expect(writes(r.calls)).to.deep.equal([]);
    expect(count(r.calls, /^anchor build$/)).to.equal(0);
    expect(snapshot(w)).to.equal(before);
    expectNoSecrets(w, r);
  });

  it("chain: backups before any upgrade, escrow before flacon, extend only where needed, HolderConfig and Holdings after one question; a re-run does nothing", async () => {
    const w = makeWorld();
    await deployed(w);
    const r = await run(w, ["chain"], { input: "j\n" });
    expect(r.code, r.out).to.equal(0);
    const c = r.calls;
    expect(r.out.match(/\(j\/n\)/g)).to.have.length(1);
    const build = at(c, /^anchor build$/);
    const dumpE = at(c, new RegExp(`^solana program dump ${ESCROW} `));
    const dumpF = at(c, new RegExp(`^solana program dump ${FLACON} `));
    const firstWrite = c.findIndex((x) => writes([x]).length > 0);
    const upE = at(c, new RegExp(`^anchor upgrade target/deploy/escrow\\.so --program-id ${ESCROW} `));
    const extF = at(c, new RegExp(`^solana program extend ${FLACON} 17096 `));
    const upF = at(c, new RegExp(`^anchor upgrade target/deploy/flacon\\.so --program-id ${FLACON} `));
    const holder = at(c, /^npx tsx scripts\/holder-config\.ts init devnet$/);
    const holdingsDry = at(c, /^npx tsx scripts\/init-holdings\.ts --dry-run$/);
    const holdings = at(c, /^npx tsx scripts\/init-holdings\.ts$/);
    expect(build).to.be.greaterThan(-1).and.lessThan(dumpE);
    expect(Math.max(dumpE, dumpF)).to.be.lessThan(firstWrite);
    expect(firstWrite).to.equal(upE);
    expect(upE).to.be.lessThan(extF);
    expect(extF).to.be.lessThan(upF);
    expect(upF).to.be.lessThan(holder);
    expect(holdingsDry).to.be.lessThan(upE);
    expect(holder).to.be.lessThan(holdings);
    expect(count(c, /^solana program extend /)).to.equal(1);
    expect(count(c, new RegExp(`^solana program extend ${ESCROW}`))).to.equal(0);
    expect(c.filter((x) => /^anchor upgrade/.test(x)).every((x) => x.includes(`--provider.wallet ${path.join(w.home, ".config/solana/id.json")}`) && x.includes(`--provider.cluster ${RPC}`))).to.equal(true);
    const s = readState(w);
    expect(s.upgrades).to.deep.equal([ESCROW, FLACON]);
    expect(s.programs[FLACON].dataLen).to.equal(3000 + 16000 - 3000 + 4096);
    expect(s.programs[ESCROW].dataLen).to.equal(6000);
    expect(s.holderConfig).to.deep.equal({ clusterTag: 2 });
    expect(s.holdings).to.equal(7);
    // the backup folder: both programs before and after, the build's sha256, every signature
    const root = path.join(w.home, "flaconvault-rollout");
    const [bk] = fs.readdirSync(root).filter((d) => d.endsWith(`-${w.sha.slice(0, 7)}`));
    expect(bk).to.match(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{7}$/);
    const backup = path.join(root, bk);
    expect(fs.readFileSync(path.join(backup, "escrow-before.so")).subarray(0, 4800)).to.deep.equal(pattern("escrow", "old", 4800));
    expect(fs.readFileSync(path.join(backup, "flacon-before.so")).length).to.equal(3000);
    expect(fs.readFileSync(path.join(backup, "flacon-after.so")).subarray(0, 16000)).to.deep.equal(pattern("flacon", "p1", 16000));
    const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
    const buildTxt = fs.readFileSync(path.join(backup, "build.txt"), "utf8");
    expect(buildTxt).to.include(`commit ${w.sha}`).and.to.include(sha(pattern("escrow", "p1", 5000))).and.to.include(sha(pattern("flacon", "p1", 16000)));
    const sigs = fs.readFileSync(path.join(backup, "signatures.log"), "utf8");
    for (const label of ["upgrade-escrow", "extend-flacon", "upgrade-flacon", "holder-config", "holdings"]) expect(sigs, label).to.match(new RegExp(` ${label} [1-9A-HJ-NP-Za-km-z]{86,88}$`, "m"));
    expect(sigs.match(/ holdings /g)).to.have.length(7);
    expect(fs.statSync(backup).mode & 0o077).to.equal(0);
    expect(fs.readFileSync(path.join(root, "cluster"), "utf8").trim()).to.equal("devnet");
    expect(r.out).to.match(/Nächster Schritt: zsh scripts\/p1-rollout\.sh relay/);
    // German on screen: the tools' own lines (Anchor's deprecation notice, the per-passport lines) are in the log only
    expect(r.out).to.match(/✓ flacon um 17\.096 Bytes erweitert/).and.to.match(/HolderConfig vorhanden, cluster_tag 2 \(devnet\)/)
      .and.to.match(/^ +cluster_tag 2$/m);
    expect(r.out).not.to.match(/deprecated|Signature:|init Passport|^rpc |passports, \d+ without/m);
    const log = fs.readFileSync(path.join(backup, "rollout.log"), "utf8");
    expect(log).to.match(/'anchor upgrade' is deprecated/).and.to.match(/would init Passport0/).and.to.match(/ init Passport6 → holding Holding6 /)
      .and.to.include("rpc <RPC>").and.to.include("--provider.cluster <RPC> ").and.to.include(`extend ${FLACON} 17096 --url <RPC> `)
      .and.not.to.include("fake-rpc-key");
    expectNoSecrets(w, r);

    const again = await run(w, ["chain"], { input: "j\n" });
    expect(again.code, again.out).to.equal(0);
    expect(again.out).to.match(/Auf der Chain ist schon alles erledigt/);
    expect(again.out).not.to.match(/\(j\/n\)/);
    expect(writes(again.calls)).to.deep.equal([]);
    expect(readState(w).upgrades).to.deep.equal([ESCROW, FLACON]);
    expectNoSecrets(w, again);
  });

  it("chain extends both programs by NEW − OLD + 4096 when neither fits, at least by the CLI's minimum of 10240 bytes", async () => {
    const w = makeWorld((s) => { s.build.escrow.size = 6100; });
    markDeployed(w);
    const r = await run(w, ["chain"], { input: "ja\n" });
    expect(r.code, r.out).to.equal(0);
    const order = r.calls.filter((x) => /^(solana program extend|anchor upgrade) /.test(x))
      .map((x) => x.startsWith("solana") ? x.split(" ").slice(2, 5).join(" ") : x.split(" ").slice(1, 3).join(" "));
    // escrow: 6100 − 6000 + 4096 = 4196, raised to 10240; flacon: 16000 − 3000 + 4096 = 17096
    expect(order).to.deep.equal([`extend ${ESCROW} 10240`, "upgrade target/deploy/escrow.so", `extend ${FLACON} 17096`, "upgrade target/deploy/flacon.so"]);
  });

  it("chain resumes after a failed upgrade: the half-written buffer is closed, escrow and the extension are not repeated", async () => {
    const w = makeWorld((s) => { s.failOnce[`upgrade:${FLACON}`] = 1; });
    markDeployed(w);
    const first = await run(w, ["chain"], { input: "j\n" });
    expect(first.code).to.equal(1);
    expect(first.out).to.match(/Das Upgrade von flacon ist fehlgeschlagen/).and.to.match(/Gleich nochmal starten/);
    // a failing tool's last lines are shown (to send to Claude), the RPC URL redacted
    expect(first.out).to.match(/Ausgabe von upgrade-flacon, letzte Zeilen:\n(  .*\n)*  Error: fake network failure while writing the buffer\n/);
    expect(readState(w).upgrades).to.deep.equal([ESCROW]);
    const [buffer] = readState(w).buffers;
    expect(buffer.address).to.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const r = await run(w, ["chain"], { input: "j\n" });
    expect(r.code, r.out).to.equal(0);
    expect(r.out).to.match(/0\. 1 alte\(n\) Upload-Puffer schließen/).and.to.match(/1\. escrow: auf der Chain schon gleich dem Build/)
      .and.to.match(/✓ Alte Upload-Puffer geschlossen, [\d,]+ SOL zurück/);
    expect(r.out).not.to.match(/Buffer Address/);
    const c = r.calls;
    expect(at(c, /^solana program close --buffers /)).to.be.greaterThan(-1).and.lessThan(at(c, /^anchor upgrade target\/deploy\/flacon\.so/));
    expect(at(c, new RegExp(`^solana transaction-history ${buffer.address} --limit 1 `))).to.be.greaterThan(at(c, /^solana program close --buffers /));
    expect(count(c, /^solana program extend /)).to.equal(0);
    expect(count(c, /^anchor upgrade target\/deploy\/escrow\.so/)).to.equal(0);
    const s = readState(w);
    expect(s.upgrades).to.deep.equal([ESCROW, FLACON]);
    expect(s.buffers).to.deep.equal([]);
    // the backup of the first run stays the program from before any upgrade
    const root = path.join(w.home, "flaconvault-rollout");
    const backups = fs.readdirSync(root).filter((d) => d.endsWith(`-${w.sha.slice(0, 7)}`));
    expect(backups).to.have.length(1);
    expect(fs.readFileSync(path.join(root, backups[0], "escrow-before.so")).subarray(0, 4800)).to.deep.equal(pattern("escrow", "old", 4800));
    // the close prints no signature: it is looked up by the buffer's address and logged like every other one
    const closeSig = s.history[buffer.address].slice(-1)[0];
    expect(fs.readFileSync(path.join(root, backups[0], "signatures.log"), "utf8")).to.match(new RegExp(` close-buffers ${closeSig}$`, "m"));
    expectNoSecrets(w, r);
  });

  it("chain: answering n stops before any transaction", async () => {
    const w = makeWorld();
    markDeployed(w);
    const before = readState(w);
    for (const input of ["n\n", ""]) {
      const r = await run(w, ["chain"], { input });
      expect(r.code).to.equal(1);
      expect(r.out).to.match(/Abgebrochen\. Auf der Chain und auf Railway wurde nichts verändert/);
      expect(writes(r.calls)).to.deep.equal([]);
    }
    expect(readState(w)).to.deep.equal(before);
  });

  it("relay: a new relayer key goes to Railway through stdin from a private temp dir, is funded with 0.5 SOL, then the relay goes on; a re-run changes nothing", async () => {
    const w = makeWorld((s) => { delete s.vars.FV_RELAY_ENABLED; });
    markChained(w);
    const notYet = makeWorld();
    markDeployed(notYet);
    const refused = await run(notYet, ["relay"]);
    expect(refused.code).to.equal(1);
    expect(refused.out).to.match(/fehlt die HolderConfig/);
    expect(writes(refused.calls)).to.deep.equal([]);

    const before = snapshot(w);
    const dry = await run(w, ["relay", "--dry-run"]);
    expect(dry.code, dry.out).to.equal(0);
    expect(dry.out).to.match(/1\. Neuen Relayer-Schlüssel erzeugen/).and.to.match(/2\. Relayer mit 0,5 SOL/).and.to.match(/FV_CLUSTER=devnet FV_RELAY_ENABLED=true/);
    expect(writes(dry.calls)).to.deep.equal([]);
    expect(snapshot(w)).to.equal(before);

    const r = await run(w, ["relay"]);
    expect(r.code, r.out).to.equal(0);
    const c = r.calls;
    const keygen = at(c, /^solana-keygen new --no-bip39-passphrase --silent --force -o \S+\/relayer\.json$/);
    const setKey = at(c, /^railway variable set FV_RELAYER_KEY --stdin --service verify --skip-deploys$/);
    const fund = at(c, /^solana transfer \S+ 0\.500000000 --allow-unfunded-recipient /);
    const setCluster = at(c, /^railway variable set FV_CLUSTER=devnet --service verify --skip-deploys$/);
    const enable = at(c, /^railway variable set FV_RELAY_ENABLED=true --service verify$/);
    expect(keygen).to.be.greaterThan(-1).and.lessThan(setKey);
    expect(setKey).to.be.lessThan(fund);
    expect(fund).to.be.lessThan(setCluster);
    expect(setCluster).to.be.lessThan(enable);
    expect(enable).to.equal(c.map((x) => /^railway variable set/.test(x)).lastIndexOf(true));
    const s = readState(w);
    const [gen] = s.generated;
    expect(s.vars.FV_RELAYER_KEY).to.equal(gen.json);                    // config.py's format: the keypair JSON, unchanged
    expect(JSON.parse(s.vars.FV_RELAYER_KEY)).to.have.length(64);
    expect(fs.existsSync(gen.dir)).to.equal(false);                       // the private temp dir is gone
    expect(s.balances[gen.pub]).to.equal(500_000_000);
    expect(c.find((x) => /^solana transfer/.test(x))).to.include(` ${gen.pub} `);
    expect(r.out).to.include(`Relayer: ${gen.pub}, Guthaben 0,5 SOL`).and.to.match(/npm run verify-pass -- --rpc "\$FV_ROLLOUT_RPC" --serial <seriennummer>/)
      .and.to.match(/Saved to the public record/);
    expectNoSecrets(w, r);

    const again = await run(w, ["relay"]);
    expect(again.code, again.out).to.equal(0);
    expect(again.out).to.match(/Das Relay ist schon an und meldet ok/);
    expect(writes(again.calls)).to.deep.equal([]);
    expectNoSecrets(w, again);
  });

  it("relay never replaces an existing FV_RELAYER_KEY and tops it up only when it runs low", async () => {
    const w = makeWorld((s) => { s.vars.FV_RELAYER_KEY = EXISTING_RELAYER; s.vars.FV_CLUSTER = "devnet"; s.balances[RELAYER_PUB] = 40_000_000; });
    markChained(w);
    const r = await run(w, ["relay"]);
    expect(r.code, r.out).to.equal(0);
    expect(count(r.calls, /^solana-keygen new/)).to.equal(0);
    expect(count(r.calls, /FV_RELAYER_KEY/)).to.equal(0);
    expect(r.calls.filter((x) => /^solana transfer/.test(x))).to.have.length(1).and.to.satisfy((l: string[]) => l[0].startsWith(`solana transfer ${RELAYER_PUB} 0.460000000 `));
    expect(writes(r.calls).filter((x) => /^railway/.test(x))).to.deep.equal(["railway variable set FV_RELAY_ENABLED=true --service verify"]);
    const s = readState(w);
    expect(s.vars.FV_RELAYER_KEY).to.equal(EXISTING_RELAYER);
    expect(s.balances[RELAYER_PUB]).to.equal(500_000_000);
    expect(r.out).to.include(`Relayer: ${RELAYER_PUB}, Guthaben 0,5 SOL`);
    expectNoSecrets(w, r);

    const wrongCluster = makeWorld((s) => { s.vars.FV_CLUSTER = "mainnet"; });
    markChained(wrongCluster);
    const bad = await run(wrongCluster, ["relay"]);
    expect(bad.code).to.equal(1);
    expect(bad.out).to.match(/FV_CLUSTER auf Railway ist 'mainnet', erwartet devnet/);
    expect(writes(bad.calls)).to.deep.equal([]);
  });

  it("rotate-keys: token and seed through stdin, the new key registered before the switch, the old one revoked after the grace; FV_MASTER_KEY untouched; an interrupted run resumes, a finished one is followed by a new rotation", async () => {
    const w = makeWorld();
    markDeployed(w);
    const before = snapshot(w);
    const dry = await run(w, ["rotate-keys", "--dry-run"]);
    expect(dry.code, dry.out).to.equal(0);
    expect(dry.out).to.match(/als Schlüssel 3 eintragen/).and.to.match(/dann sperren: Schlüssel 2\./).and.to.match(/FV_MASTER_KEY bleibt/);
    expect(writes(dry.calls)).to.deep.equal([]);
    expect(snapshot(w)).to.equal(before);
    const no = await run(w, ["rotate-keys"], { input: "n\n" });
    expect(no.code).to.equal(1);
    expect(writes(no.calls)).to.deep.equal([]);

    const r = await run(w, ["rotate-keys"], { input: "j\n" });
    expect(r.code, r.out).to.equal(0);
    expect(r.out.match(/\(j\/n\)/g)).to.have.length(1);
    const c = r.calls;
    const s = readState(w);
    const gen = s.generated[0];
    const add = at(c, new RegExp(`^npx tsx scripts/server-key\\.ts add ${gen.pubHex} 3$`));
    const token = at(c, /^railway variable set FV_ADMIN_TOKEN --stdin --service verify --skip-deploys$/);
    const seed = at(c, /^railway variable set FV_SERVER_ED25519_SEED --stdin --service verify --skip-deploys$/);
    const keyId = at(c, /^railway variable set FV_SERVER_KEY_ID=3 --service verify$/);
    const revoke = at(c, /^npx tsx scripts\/server-key\.ts revoke 2$/);
    expect(add).to.be.greaterThan(-1).and.lessThan(token);
    expect(token).to.be.lessThan(seed);
    expect(seed).to.be.lessThan(keyId);
    expect(keyId).to.be.lessThan(revoke);
    expect(c.filter((x) => /FV_MASTER_KEY/.test(x))).to.deep.equal([]);
    expect(s.vars.FV_MASTER_KEY).to.equal(SECRETS.FV_MASTER_KEY);
    expect(s.vars.FV_SERVER_ED25519_SEED).to.equal(gen.seedHex);
    expect(s.vars.FV_ADMIN_TOKEN).to.match(/^[A-Za-z0-9_-]{40,}$/).and.not.to.equal(SECRETS.FV_ADMIN_TOKEN);
    expect(s.verifier.keyId).to.equal(3);
    expect(s.verifier.pubkeyHex).to.equal(gen.pubHex);
    expect(s.registry.keys.find((k: any) => k.id === 2).to).to.be.greaterThan(0);
    expect(s.registry.keys.find((k: any) => k.id === 3).to).to.equal(0);
    expect(fs.existsSync(gen.dir)).to.equal(false);
    expect(r.out).to.match(/FV_MASTER_KEY bleibt, wie er ist/).and.to.match(/Signierschlüssel 3 \([0-9a-f]{64}\) ist der einzige gültige; gesperrt: Schlüssel 2/);
    expectNoSecrets(w, r);

    const stateFile = path.join(w.home, "flaconvault-rollout/rotate-keys.state");
    expect(fs.readFileSync(stateFile, "utf8")).to.match(/^phase=done$/m).and.to.match(/^new_id=3$/m).and.to.match(/^done_at=\d{4}-\d\d-\d\dT/m);

    // Months later, another leak: the documented command rotates again (key 4 replaces key 3), behind the same question.
    const tokenBefore = s.vars.FV_ADMIN_TOKEN;
    const plan = await run(w, ["rotate-keys", "--dry-run"]);
    expect(plan.code, plan.out).to.equal(0);
    expect(plan.out).to.match(/Der letzte Schlüsseltausch ist abgeschlossen \(am \d{4}-\d\d-\d\dT[^)]*, Schlüssel 3\)\. Dieser Lauf macht einen neuen\./)
      .and.to.match(/als Schlüssel 4 eintragen/).and.to.match(/Danach sind 4 von 8 Schlüsselplätzen der Registry belegt/)
      .and.to.match(/dann sperren: Schlüssel 3\./).and.not.to.match(/Schon erledigt/);
    expect(writes(plan.calls)).to.deep.equal([]);
    const refused = await run(w, ["rotate-keys"], { input: "n\n" });
    expect(refused.code).to.equal(1);
    expect(writes(refused.calls)).to.deep.equal([]);
    const again = await run(w, ["rotate-keys"], { input: "j\n" });
    expect(again.code, again.out).to.equal(0);
    expect(again.out.match(/\(j\/n\)/g)).to.have.length(1);
    const s2 = readState(w);
    const gen2 = s2.generated[1];
    expect(writes(again.calls)).to.deep.equal(["solana-keygen new --no-bip39-passphrase --silent --force -o " + path.join(gen2.dir, "server.json"),
      `npx tsx scripts/server-key.ts add ${gen2.pubHex} 4`, "railway variable set FV_ADMIN_TOKEN --stdin --service verify --skip-deploys",
      "railway variable set FV_SERVER_ED25519_SEED --stdin --service verify --skip-deploys", "railway variable set FV_SERVER_KEY_ID=4 --service verify",
      "npx tsx scripts/server-key.ts revoke 3"]);
    expect(s2.verifier.keyId).to.equal(4);
    expect(s2.vars.FV_SERVER_ED25519_SEED).to.equal(gen2.seedHex);
    expect(s2.vars.FV_ADMIN_TOKEN).to.match(/^[A-Za-z0-9_-]{40,}$/).and.not.to.equal(tokenBefore);
    expect(s2.vars.FV_MASTER_KEY).to.equal(SECRETS.FV_MASTER_KEY);
    expect(s2.registry.keys.find((k: any) => k.id === 3).to).to.be.greaterThan(0);
    expect(s2.registry.keys.find((k: any) => k.id === 4).to).to.equal(0);
    expect(fs.readFileSync(stateFile, "utf8")).to.match(/^phase=done$/m).and.to.match(/^new_id=4$/m).and.to.match(/^old_id=3$/m);
    expectNoSecrets(w, again);

    // stopped after the switch, before the revocation: the re-run only revokes, after the grace
    const half = makeWorld();
    markDeployed(half);
    editState(half, (st) => {
      st.registry.keys.push({ id: 3, pub: "cd".repeat(32), from: 0, to: 0 });
      st.seedPubs["e1".repeat(32)] = "cd".repeat(32);
      st.vars.FV_SERVER_ED25519_SEED = "e1".repeat(32);
      st.vars.FV_SERVER_KEY_ID = "3";
      Object.assign(st.verifier, { keyId: 3, pubkeyHex: "cd".repeat(32) });
    });
    fs.mkdirSync(path.join(half.home, "flaconvault-rollout"), { recursive: true });
    fs.writeFileSync(path.join(half.home, "flaconvault-rollout/rotate-keys.state"), `phase=switching\nnew_id=3\nnew_pub=${"cd".repeat(32)}\nold_id=2\n`);
    const resumed = await run(half, ["rotate-keys"], { input: "j\n" });
    expect(resumed.code, resumed.out).to.equal(0);
    expect(resumed.out).to.match(/Der neue Schlüssel 3 läuft schon\. Noch zu sperren \(nach der Wartezeit\): Schlüssel 2/);
    expect(writes(resumed.calls)).to.deep.equal(["npx tsx scripts/server-key.ts revoke 2"]);
  });

  it("rotate-keys: a run that stops after its last revocation landed is recorded as finished by the next run, and status agrees", async () => {
    // the revoke of key 2 lands, but the client gives up waiting for the confirmation
    const w = makeWorld((s) => { s.failOnce["revoke-lands:2"] = 1; });
    markDeployed(w);
    const stopped = await run(w, ["rotate-keys"], { input: "j\n" });
    expect(stopped.code).to.equal(1);
    expect(stopped.out).to.match(/Schlüssel 2 ließ sich nicht sperren/).and.to.match(/not confirmed in 30\.00 seconds/);
    const stateFile = path.join(w.home, "flaconvault-rollout/rotate-keys.state");
    expect(fs.readFileSync(stateFile, "utf8")).to.match(/^phase=switched$/m).and.not.to.match(/done_at/);
    expect(readState(w).registry.keys.find((k: any) => k.id === 2).to).to.be.greaterThan(0);   // revoked on chain
    const before = await run(w, ["status"]);
    expect(before.out).to.match(/Schlüsseltausch: begonnen, nicht abgeschlossen \(zsh scripts\/p1-rollout\.sh rotate-keys schließt ihn ab\)/);

    // --dry-run reports it and records nothing
    const dryState = fs.readFileSync(stateFile, "utf8");
    const dry = await run(w, ["rotate-keys", "--dry-run"]);
    expect(dry.code, dry.out).to.equal(0);
    expect(dry.out).to.match(/Schon erledigt: Schlüssel 3 ist der einzige gültige/);
    expect(fs.readFileSync(stateFile, "utf8")).to.equal(dryState);

    const r = await run(w, ["rotate-keys"], { input: "j\n" });
    expect(r.code, r.out).to.equal(0);
    expect(r.out).to.match(/Schon erledigt: Schlüssel 3 ist der einzige gültige, das Admin-Token wurde dabei erneuert\./)
      .and.to.match(/Ein neuer Schlüsseltausch \(etwa nach einem Leck\): diesen Schritt nochmal starten\./)
      .and.not.to.match(/seit -/).and.not.to.match(/\(j\/n\)/);
    expect(writes(r.calls)).to.deep.equal([]);
    expect(fs.readFileSync(stateFile, "utf8")).to.match(/^phase=done$/m).and.to.match(/^new_id=3$/m).and.to.match(/^old_id=2$/m)
      .and.to.match(/^switched_at=\d+$/m).and.to.match(/^done_at=\d{4}-\d\d-\d\dT[\d:]+Z$/m);
    const after = await run(w, ["status"]);
    expect(after.out).to.match(/Schlüsseltausch: zuletzt abgeschlossen am \d{4}-\d\d-\d\dT[\d:]+Z \(Schlüssel 3\)/);
    expectNoSecrets(w, r);
  });

  it("status is read-only", async () => {
    const w = makeWorld((s) => { s.vars.FV_RELAYER_KEY = EXISTING_RELAYER; s.balances[RELAYER_PUB] = 250_000_000; });
    await chained(w);
    const before = snapshot(w);
    const r = await run(w, ["status"]);
    expect(r.code, r.out).to.equal(0);
    expect(r.out).to.match(/Stand [0-9a-f]{7} \(gleich diesem Stand\)/).and.to.match(/escrow: 6\.000 Bytes auf der Chain, Upgrade-Recht: diese Wallet, gleich dem lokalen Build/)
      .and.to.match(/flacon: 20\.096 Bytes/).and.to.match(/HolderConfig: vorhanden, cluster_tag 2/).and.to.match(/Pässe mit Holding: 7 von 7/)
      .and.to.include(`Relayer ${RELAYER_PUB}: 0,25 SOL`).and.to.match(/FV_RELAY_ENABLED aus, FV_RELAYER_KEY vorhanden/).and.to.match(/^Relay: aus$/m);
    expect(writes(r.calls)).to.deep.equal([]);
    expect(count(r.calls, /^anchor build/)).to.equal(0);
    expect(snapshot(w)).to.equal(before);
    expectNoSecrets(w, r);
  });

  it("a long TMPDIR (a sandbox's) does not break npx tsx: it gets a short private dir, removed afterwards", async () => {
    const w = makeWorld();
    markChained(w);
    const long = path.join(w.dir, "a-temp-dir-name-long-enough-for-the-tsx-socket-path-to-pass-104-bytes");
    fs.mkdirSync(long);
    expect(long.length).to.be.greaterThan(80);
    const npxDirs = () => fs.readdirSync("/tmp").filter((x) => x.startsWith("fv-npx."));
    const before = npxDirs();
    const r = await run(w, ["status"], { env: { TMPDIR: long } });
    expect(r.code, r.out).to.equal(0);
    expect(r.out).to.match(/HolderConfig: vorhanden, cluster_tag 2/).and.to.match(/Pässe mit Holding: 7 von 7/).and.not.to.match(/nicht lesbar/);
    expect(fs.readdirSync(long)).to.deep.equal([]);
    expect(npxDirs()).to.deep.equal(before);
  });

  it("FV_ROLLOUT_LOCAL=1 (rehearsal) calls no Railway, Vercel or gh and keeps its records apart from devnet's", async () => {
    const w = makeWorld();
    git(w.repo, "checkout", "-q", "-b", "feature/public-record");
    editState(w, (s) => { Object.assign(s.verifier, { build: w.sha, p1: true }); });
    const env = { FV_ROLLOUT_LOCAL: "1" };
    const d = await run(w, ["deploy"], { env });
    expect(d.code, d.out).to.equal(0);
    const c = await run(w, ["chain"], { env, input: "j\n" });
    expect(c.code, c.out).to.equal(0);
    expect(c.out).to.match(/Jetzt auf localnet ausführen\?/);
    expect(c.calls).to.include("npx tsx scripts/holder-config.ts init localnet");
    const rot = await run(w, ["rotate-keys"], { env });
    expect(rot.code).to.equal(1);
    expect(rot.out).to.match(/lokal \(FV_ROLLOUT_LOCAL=1\) geht er nur mit einem Ersatz \(FV_ROLLOUT_RAILWAY\)/);
    const st = await run(w, ["status"], { env });
    expect(st.code, st.out).to.equal(0);
    expect(st.out).to.match(/Relayer: lokal nicht verwaltet \(kein FV_ROLLOUT_RAILWAY\)/);
    for (const r of [d, c, rot, st]) expect(r.calls.filter((x) => /^(railway|railway-standin|vercel|gh) /.test(x))).to.deep.equal([]);
    // the rehearsal's deploy marker, backups and logs are in their own folder, marked localnet; devnet's does not exist
    const local = path.join(w.home, LOCAL_STATE);
    expect(fs.readFileSync(path.join(local, "cluster"), "utf8").trim()).to.equal("localnet");
    expect(fs.existsSync(path.join(local, "deployed", w.sha))).to.equal(true);
    expect(fs.readdirSync(local).filter((x) => x.endsWith(`-${w.sha.slice(0, 7)}`))).to.have.length(1);
    expect(fs.existsSync(path.join(w.home, "flaconvault-rollout"))).to.equal(false);

    // devnet's chain step does not take the rehearsal's deploy marker for its own
    const real = await run(w, ["chain"], { input: "j\n" });
    expect(real.code).to.equal(1);
    expect(real.out).to.match(/Die Web-App von [0-9a-f]{7} wurde noch nicht mit diesem Skript veröffentlicht/);
    expect(writes(real.calls)).to.deep.equal([]);
    // and one folder named for both is refused by whichever cluster did not write it first
    const shared = await run(w, ["chain", "--dry-run"], { env: { FV_ROLLOUT_STATE_DIR: local } });
    expect(shared.code).to.equal(1);
    expect(shared.out).to.match(/Der Ordner .* gehört zu localnet, nicht zu devnet\./);
    expect(shared.calls).to.deep.equal([]);
  });

  it("FV_ROLLOUT_LOCAL=1 refuses an RPC, verifier or web address that is not on this machine, before any call", async () => {
    const w = makeWorld();
    const cases: Array<[string, Record<string, string>]> = [
      ["FV_ROLLOUT_RPC", { FV_ROLLOUT_RPC: "https://api.devnet.solana.com" }],
      ["FV_ROLLOUT_RPC", { FV_ROLLOUT_RPC: "https://devnet.example.test/?api-key=fake-rpc-key-NEVER-PRINT" }],
      ["FV_ROLLOUT_RPC", { FV_ROLLOUT_RPC: "http://127.0.0.1.devnet.example.test:8899/" }],
      ["FV_ROLLOUT_VERIFY_URL", { FV_ROLLOUT_VERIFY_URL: "https://verify.flaconvault.com" }],
      ["FV_ROLLOUT_WEB_URL", { FV_ROLLOUT_WEB_URL: "https://app.flaconvault.com" }],
    ];
    const before = snapshot(w);
    for (const [name, env] of cases) {
      for (const step of ["deploy", "chain", "relay", "rotate-keys", "status"]) {
        const r = await run(w, [step], { env: { FV_ROLLOUT_LOCAL: "1", ...env } });
        expect(r.code, `${step} ${name}: ${r.out}`).to.equal(1);
        expect(r.out).to.include(`STOPP: Die Probe (FV_ROLLOUT_LOCAL=1) läuft nur gegen diesen Mac, aber ${name} zeigt woanders hin.`);
        expect(r.out).not.to.match(/devnet\.solana\.com|example\.test|flaconvault\.com|fake-rpc-key/);
        expect(r.calls).to.deep.equal([]);
      }
    }
    expect(snapshot(w)).to.equal(before);
    // the same addresses without FV_ROLLOUT_LOCAL are devnet's own run (a local RPC stays allowed there: tests, rehearsals)
    const dry = await run(w, ["deploy", "--dry-run"], { env: { FV_ROLLOUT_RPC: "https://api.devnet.solana.com" } });
    expect(dry.code, dry.out).to.equal(0);
  });

  it("FV_ROLLOUT_LOCAL=1 with a Railway stand-in runs relay and rotate-keys on the devnet code path, never the real CLI", async () => {
    const w = makeWorld((s) => { s.holderConfig = { clusterTag: 3 }; s.holdings = s.passports; });
    git(w.repo, "checkout", "-q", "-b", "feature/public-record");
    editState(w, (s) => { s.vars.FV_BUILD_SHA = w.sha; Object.assign(s.verifier, { build: w.sha, p1: true }); });
    const env = { FV_ROLLOUT_LOCAL: "1", FV_ROLLOUT_RAILWAY: standin(w) };

    // a stand-in must name itself as one: the plain CLI (here the fake on PATH) is refused before any write
    for (const bad of [path.join(w.bin, "railway"), "railway", path.join(w.dir, "missing")]) {
      const r = await run(w, ["relay"], { env: { ...env, FV_ROLLOUT_RAILWAY: bad } });
      expect(r.code, bad).to.equal(1);
      expect(r.out, bad).to.match(/FV_ROLLOUT_RAILWAY (ist kein Probe-Ersatz|muss der volle Pfad)/);
      expect(writes(r.calls), bad).to.deep.equal([]);
    }

    const dry = await run(w, ["relay", "--dry-run"], { env });
    expect(dry.code, dry.out).to.equal(0);
    expect(dry.out).to.match(/1\. Neuen Relayer-Schlüssel erzeugen/).and.to.match(/FV_CLUSTER=localnet FV_RELAY_ENABLED=true/);
    expect(writes(dry.calls)).to.deep.equal([]);
    const r = await run(w, ["relay"], { env });
    expect(r.code, r.out).to.equal(0);
    const s = readState(w);
    const [gen] = s.generated;
    expect(writes(r.calls)).to.deep.equal([`solana-keygen new --no-bip39-passphrase --silent --force -o ${path.join(gen.dir, "relayer.json")}`,
      "railway-standin variable set FV_RELAYER_KEY --stdin --service verify --skip-deploys",
      `solana transfer ${gen.pub} 0.500000000 --allow-unfunded-recipient --url ${RPC} --keypair ${path.join(w.home, ".config/solana/id.json")}`,
      "railway-standin variable set FV_CLUSTER=localnet --service verify --skip-deploys",
      "railway-standin variable set FV_RELAY_ENABLED=true --service verify"]);
    expect(s.vars.FV_RELAYER_KEY).to.equal(gen.json);
    expect(s.balances[gen.pub]).to.equal(500_000_000);
    expect(r.out).to.match(/Das Relay ist an/).and.to.include(`Relayer: ${gen.pub}, Guthaben 0,5 SOL`);
    expect(fs.existsSync(path.join(w.home, LOCAL_STATE, "relay/signatures.log"))).to.equal(true);
    expectNoSecrets(w, r);

    const rot = await run(w, ["rotate-keys"], { env, input: "j\n" });
    expect(rot.code, rot.out).to.equal(0);
    const s2 = readState(w);
    expect(s2.verifier.keyId).to.equal(3);
    expect(count(rot.calls, /^railway-standin variable set FV_(ADMIN_TOKEN|SERVER_ED25519_SEED) --stdin /)).to.equal(2);
    expect(rot.calls).to.include("npx tsx scripts/server-key.ts revoke 2");
    expect(fs.existsSync(path.join(w.home, LOCAL_STATE, "rotate-keys.state"))).to.equal(true);
    const st = await run(w, ["status"], { env });
    expect(st.out).to.match(/Railway: FV_RELAY_ENABLED an, FV_RELAYER_KEY vorhanden, FV_CLUSTER localnet, FV_SERVER_KEY_ID 3/);
    for (const x of [r, rot, st]) expect(x.calls.filter((c) => /^(railway|vercel|gh) /.test(c))).to.deep.equal([]);
    expectNoSecrets(w, rot);
  });

  it("no fake secret appears in any output, on any command line or in the rollout folders' logs and markers", () => {
    let checked = 0;
    let files = 0;
    const textFiles = (d: string): string[] => !fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => e.isDirectory() ? textFiles(path.join(d, e.name)) : e.name.endsWith(".so") ? [] : [path.join(d, e.name)]);
    for (const w of worlds) {
      for (const out of w.outputs) { expectNoSecrets(w, { code: 0, out, calls: callsOf(w) }); checked++; }
      for (const f of [...textFiles(path.join(w.home, "flaconvault-rollout")), ...textFiles(path.join(w.home, LOCAL_STATE))]) {
        const text = fs.readFileSync(f, "utf8");
        for (const secret of secretsOf(w)) expect(text.includes(secret), `a secret (${secret.slice(0, 6)}…) is in ${f}`).to.equal(false);
        files++;
      }
    }
    expect(checked).to.be.greaterThan(50);
    expect(files).to.be.greaterThan(20);
  });

  it("follows the documented commands, and the docs send the owner to it", () => {
    const script = fs.readFileSync(SCRIPT_SRC, "utf8");
    const deploy = fs.readFileSync(path.join(ROOT, "docs/deploy.md"), "utf8");
    const devnet = fs.readFileSync(path.join(ROOT, "docs/devnet.md"), "utf8");
    for (const cmd of ['git archive "$SHA" | tar -x -C "$D"', 'cp -R .vercel "$D/"', 'vercel --cwd "$D" --prod --yes',
      'railway variable set FV_BUILD_SHA="$SHA" --service verify --skip-deploys', "railway up --service verify --detach --ci",
      "--simulator false --wait-for-build --timeout"]) {
      expect(script, `script: ${cmd}`).to.include(cmd);
      expect(deploy, `deploy.md: ${cmd}`).to.include(cmd);
    }
    expect(script).to.match(/EXTEND_HEADROOM=4096/);
    expect(devnet).to.include("$((NEW - OLD + 4096))");
    for (const cmd of ["scripts/holder-config.ts init", "scripts/init-holdings.ts --dry-run", "scripts/server-key.ts add", "scripts/server-key.ts revoke"]) {
      expect(script, `script: ${cmd}`).to.include(cmd.replace(" --dry-run", ""));
      expect(devnet, `devnet.md: ${cmd}`).to.include(cmd);
    }
    const steps = [...script.matchAll(/^ {2}([a-z-]+)\) step_/gm)].map((m) => m[1]);
    expect(steps).to.deep.equal(["deploy", "chain", "relay", "rotate-keys", "status"]);
    for (const step of steps) expect(devnet + deploy, `docs name step ${step}`).to.include(`zsh scripts/p1-rollout.sh ${step}`);
    expect(deploy).to.include("zsh scripts/p1-rollout.sh deploy");
  });
});
