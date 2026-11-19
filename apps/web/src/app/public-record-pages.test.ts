import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { EventType } from "@flaconvault/proof";
import type { Passport } from "@/lib/api";
import { eventLine } from "@/lib/format";
import { DRAWER_TEXT, DRAWER_TITLE, PUBLIC_RECORD_LINK, SAVE_BUTTON, SCAN_BY_LABEL } from "@/lib/public-record";
import { verifyBody } from "@/lib/verify-api";
import PassportPage from "./p/[serial]/page";
import PrivacyPage from "./privacy/page";
import TagLanding from "./t/page";
import { LiveCheck } from "@/components/live-check";
import { TestPhaseNotice } from "@/components/public-record";
import { TapRecord } from "@/components/tap-record";
import { Timeline } from "@/components/timeline";

/** Every element of a rendered tree (plain function components are not expanded). */
function all(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) { node.forEach((n) => all(n, out)); return out; }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  out.push(el);
  all(el.props.children as ReactNode, out);
  return out;
}
const strings = (el: ReactElement<Record<string, unknown>>): string[] => {
  const c = el.props.children as ReactNode;
  return (Array.isArray(c) ? c : [c]).filter((x): x is string => typeof x === "string");
};
/** The verifier answers every request with `body` (JSON, 200). */
function verifierAnswers(t: TestContext, body: unknown): void {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

const tapView = (o: Record<string, unknown> = {}) => ({
  tapId: 31, ts: 1_790_000_000, verdict: "VALID", counter: 9, serial: "SN-2026-000001", serialHash: "0x" + "11".repeat(32),
  uidHash: "0x" + "22".repeat(32), sealKind: 1, sealDead: false, uid: null, message: "Seal genuine · tap 9", ...o,
});

test("/t shows the tap's public record under the verdict (TAP pending, polled by the client)", async (t) => {
  const record = { state: "pending", purpose: "TAP", eventId: 77, dueAt: 1_790_000_185, txSig: null, reason: null, cluster: "DEVNET" };
  verifierAnswers(t, tapView({ record }));
  const page = await TagLanding({ searchParams: Promise.resolve({ tap: "31", k: "tok" }) });
  const rec = all(page).filter((el) => el.type === TapRecord);
  assert.equal(rec.length, 1);
  assert.deepEqual(rec[0].props.initial, record);
  assert.equal(rec[0].props.tapId, 31);
  assert.equal(rec[0].props.serial, "SN-2026-000001");
  assert.equal(typeof rec[0].props.serverNow, "number");
});

test("/t without a record (an older verifier, or nothing queued) shows no record line", async (t) => {
  verifierAnswers(t, tapView());
  assert.equal(all(await TagLanding({ searchParams: Promise.resolve({ tap: "31" }) })).filter((el) => el.type === TapRecord).length, 0);
  verifierAnswers(t, tapView({ record: { state: "replaced", purpose: "TAP", eventId: 1 } }));
  assert.equal(all(await TagLanding({ searchParams: Promise.resolve({ tap: "31" }) })).filter((el) => el.type === TapRecord).length, 0);
});

const passport: Passport = {
  serial: "SN-2026-000001", serialHash: "0x" + "11".repeat(32), brand: "Maison", name: "No. 1", batch: "B1",
  asset: null, issuer: null, issuerLabel: null, grade: 0, void: false, createdAt: 1_790_000_000,
  seals: [], sealStatus: "INTACT", stats: { scanCount: 1, attesterCount: 0, certifiedCount: 0, counter: 9, onChainScanCount: 1 },
  latest: null,
  events: [{ id: 77, type: EventType.SCAN, ts: 1_790_000_200, actor: null, actorLabel: null, txSig: "Sig77", status: "confirmed", sealUidHash: null,
    payload: { tier: 0, counter: 9, anchor: "relay", purpose: "TAP" }, arBundle: null, arMedia: null, gradeAfter: null, location: null, scanBy: "VISITOR", purpose: "TAP" }],
};

test("/p: the test-phase notice under the header, the history, and the closed drawer with the on-chain block and live check", async (t) => {
  verifierAnswers(t, passport);
  const tree = all(await PassportPage({ params: Promise.resolve({ serial: "SN-2026-000001" }) }));
  assert.equal(tree.filter((el) => el.type === TestPhaseNotice).length, 1);
  assert.equal(tree.filter((el) => el.type === Timeline).length, 1);
  const drawer = tree.filter((el) => el.type === "details");
  assert.equal(drawer.length, 1);
  assert.notEqual(drawer[0].props.open, true, "closed by default");
  const inside = all(drawer[0].props.children as ReactNode);
  assert.ok(inside.some((el) => el.type === "summary" && strings(el).includes(DRAWER_TITLE)));
  assert.ok(inside.some((el) => el.type === "p" && strings(el).includes(DRAWER_TEXT)));
  assert.ok(inside.some((el) => el.type === "p" && strings(el).includes("On-chain")));
  // "Check live on-chain" lives only in the drawer now
  assert.equal(inside.filter((el) => el.type === LiveCheck).length, 1);
  assert.equal(tree.filter((el) => el.type === LiveCheck).length, 1);
});

// ---- /privacy: what a scan without a wallet stores, and where ---------------------------------------------------

/** The text of a rendered tree in reading order (function components are not expanded: their children are read). */
const words = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(words).join("");
  return isValidElement(node) ? words((node.props as { children?: ReactNode }).children) : "";
};
/** The sections of /privacy in page order: the page's only components with a `title`. */
const privacySections = (): Array<{ title: string; text: string }> =>
  all(PrivacyPage()).filter((el) => typeof el.type === "function" && typeof el.props.title === "string")
    .map((el) => ({ title: el.props.title as string, text: words(el.props.children as ReactNode) }));
const privacySection = (title: string): string => {
  const s = privacySections().find((x) => x.title === title);
  assert.ok(s, `/privacy has no section "${title}"`);
  return s.text;
};
const WALLET_FREE = "Scan without a wallet: the public record";
/** A source file of the verifier (apps/verify/fv): /privacy states what that code does. */
const verifierSource = (file: string): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../verify/fv", file), "utf8");

test("/privacy opens with the scan without a wallet: who signs and pays, what is on Solana, what stays with FlaconVault", () => {
  assert.equal(privacySections()[0].title, WALLET_FREE, "the first section, so a reader finds it at once");
  const text = privacySection(WALLET_FREE);
  const says = (re: RegExp, what: string) => assert.match(text, re, `/privacy no longer says ${what}`);
  // a tap and "Save to the public record": the verifier signs, the relayer sends and pays (spec P1 goal, §9.5)
  assert.ok(text.includes(`a scan saved with “${SAVE_BUTTON}”`), "the button is named as the scan page names it");
  says(/A seal tap \(opening the seal's link\)/, "that a seal tap alone is saved");
  says(/no wallet, no account and no signature from you/, "that the visitor needs no wallet and signs nothing");
  says(/Our verification server signs the entry; our relayer[^.]* sends it to Solana and pays for it\./, "who signs, sends and pays");
  says(/within about 3 minutes, unless a scan of the same tap takes its place/, "when a tap is saved");
  // the FVSCAN2 fields (spec §3.1) and the relayer as the only wallet (§9.7)
  says(/On Solana, public and permanent: a hash of the serial number and of the chip UID, the chip counter, the purpose \(tap or check\)/, "what the transaction holds");
  says(/a hash of the signed public record, a random one-time code, the time, and our server key and signature/, "what the transaction holds");
  says(/for a check also the indicator readings \(heat, humidity, light\), the fill level and a hash of the photos/, "what a check adds");
  says(/The only wallet address in the transaction is our relayer's; the field for who scanned stays empty\./, "that no wallet of the visitor is on Solana");
  // the v2 bundle (§4.3): public, with the country
  says(/In the signed public record[^:]*\(Solana holds only its hash\): also the serial number, the seal \(box or neck\) and the country/, "what the signed public record adds");
  // SQLite only (§9.8, fv/views.py public_payload)
  says(/Only on the verification server: the place you typed, your device type, the card photos themselves, and a note or wallet address if one is sent along/, "what stays on the verification server");
  says(/not in the transaction, not in the signed public record and not shown on the passport page/, "that this detail is not public");
  // D14
  says(/Not on Arweave: at present these scans and their photos are not uploaded to the archive\./, "that these scans are not archived");
  // the passport history (components/timeline.tsx, lib/format.ts eventLine)
  assert.ok(text.includes(`the label “${SCAN_BY_LABEL.VISITOR}”`), "the history label as the passport page shows it");
  assert.ok(text.includes(`the link “${PUBLIC_RECORD_LINK}” to the transaction`), "the history link as the passport page shows it");
  says(/a tap is listed as “Sighting”/, "how a tap is listed");
  assert.equal(eventLine(passport.events[0]).title, "Sighting", "a recorded TAP is still listed under this title");
  // storage duration: only what the verifier does. Nothing deletes these rows, so no deletion is promised
  says(/What is on Solana cannot be changed or deleted by anyone, including us\./, "that Solana is permanent");
  says(/What stays on the verification server is stored without automatic deletion at present\./, "how long the server keeps it");
  assert.doesNotMatch(text, /(is|are|will be) deleted (after|within)|deleted automatically/, "no deletion period is promised");
});

test("/privacy states the relayer's visitor limits (drift guard over apps/verify/fv/relayer.py, spec D16)", () => {
  const relayer = verifierSource("relayer.py");
  const constant = (name: string): number => {
    const m = new RegExp(`^${name} = (\\d+)\\b`, "m").exec(relayer);
    assert.ok(m, `fv/relayer.py no longer defines ${name}`);
    return Number(m[1]);
  };
  const taps = constant("VISITOR_TAPS_PER_SEAL_24H"), checks = constant("VISITOR_CHECKS_PER_SEAL_24H"), hours = constant("CAP_WINDOW_S") / 3600;
  const limits = `per seal, at most ${taps} ${taps === 1 ? "tap" : "taps"} and ${checks} ${checks === 1 ? "check" : "checks"} within ${hours} hours are sent to Solana`;
  const text = privacySection(WALLET_FREE);
  assert.ok(text.includes(limits), `/privacy must say "${limits}" (the constants of fv/relayer.py)`);
  // over the limit or not sent: kept off chain, still in the history (fv/relayer.py settle_event)
  assert.match(text, /An entry beyond that, or one that could not be sent, is kept by FlaconVault only: on the verification server, and listed on the passport page without that link\./);
});

test("/privacy: scans without a wallet are not on Arweave while the verifier's archiving queue skips them (D14)", () => {
  const arweave = privacySection("Public and permanent: Arweave archive");
  assert.match(arweave, /the record \(the signed scan bundle\) of each confirmed scan anchored with a wallet and its photos of the card are uploaded to Arweave/);
  assert.match(arweave, /Scans saved without a wallet are not uploaded to Arweave at present\./);
  // drift guard: once the archive mirrors relay scans (planned after P1), both sections of /privacy have to say so
  const queue = /\ndef arweave_queue\([\s\S]*?(?=\n\ndef )/.exec(verifierSource("db.py"))?.[0] ?? "";
  assert.match(queue, /'\$\.anchor'\), ''\) != 'relay'|_NOT_RELAY/, "fv/db.py arweave_queue no longer skips relay scans: update /privacy");
});

test("/privacy: the server keeps a scan without a wallet, photos leave the browser on either button, a tap is an entry", () => {
  const server = privacySection("Verification server (Railway)");
  assert.match(server, /It stores, without automatic deletion at present:/);
  assert.match(server, /Scans without a wallet: the scan record as above \(its place and device type stay here and are not public\), the signed public record and the message we signed for Solana, and its status/);
  assert.ok(privacySection("In your browser").includes(`leave it only when you press “${SAVE_BUTTON}” or “Get signature”.`));
  assert.match(privacySection("Your choices"), /A seal tap is itself saved to the public record, as described under “Scan without a wallet”\./);
  // "(the scan page sends neither)": no wallet address and no note go along with a public-record scan
  assert.ok(privacySection(WALLET_FREE).includes("a note or wallet address if one is sent along (the scan page sends neither)"));
  const body = verifyBody({
    tag: { uid: "04AABBCCDDEEFF", ctr: "00000A", cmac: "0011223344556677", source: "nfc" }, nonce: "0x" + "ab".repeat(32), role: 0, tier: 1,
    reading: null, fill: 90, serial: "SN-1", country: "DE", city: "Wickede", attester: "WalletA", platform: "IOS_WEB", anchor: "relay",
  });
  assert.equal(body.attester, null);
  assert.equal("note" in body, false);
  assert.deepEqual(body.location, { country: "DE", city: "Wickede" });   // the place goes to the verifier, which keeps it to itself
});

test("/privacy keeps to the wording rules (Dev-Briefing §16, spec §10.2)", () => {
  const page = [words(PrivacyPage()), ...privacySections().map((s) => s.title)].join(" ");
  assert.doesNotMatch(page, /\b(guaranteed?|trustless|NFTs?|tokeni[sz]ed|damaged|destroyed|ruined|counterfeit-proof|forgery-proof)\b/i);
});
