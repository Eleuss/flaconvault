"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ArrowRight, Camera, Loader2, Nfc, RefreshCw, ShieldOff, Zap } from "lucide-react";
import { Indicator, Role, Tier, NONCE_TTL_S } from "@flaconvault/proof";
import type { CardReading, FrameLike, HeatFieldsConfig } from "@flaconvault/vision";
import { VisionClient, frameFromSource } from "@/vision/client";
import { combineReadings } from "@/vision/vote";
import { api, attesterMismatch, parseTagUrl, sha256Hex, signedAttester, verifyBody, type Preview, type Session, type SimTag, type TagParams, type VerifyResult } from "@/lib/verify-api";
import { adoptDeadline, scanSession, scanUrlFor, secondsLeft, sessionClock, tapHandoff, type SessionClock } from "@/lib/handoff";
import { buildRecordScanTx, flaconProgram, programId } from "@/lib/flacon";
import { creatingSignature, scanProofAttester, sendAsV0 } from "@/lib/send-tx";
import { ApiError, friendly } from "@/lib/errors";
import { PROGRAM_ID } from "@/lib/config";
import { demoMode } from "@/lib/demo";
import { effectiveVerdict, gradeLetter, gradeSentence, indicatorText, passportHref, short, txUrl, verdictText } from "@/lib/format";
import { GradeMark, Lamp, Pill } from "./badges";
import { WalletButton } from "./wallet-button";
import { isIOS, noInjectedWallet, resumeRef, resumeUrl, walletBrowseLinks } from "@/lib/wallet-links";
import { WalletReadyState } from "@solana/wallet-adapter-base";

type Step = "session" | "tap" | "preview" | "camera" | "read" | "verify" | "tx" | "done" | "dead";
/** `tapId` + `tapToken`: a tap /t already verified (adopted via ?adopt=&k=); the token proves this browser saw that tap. */
interface Tag extends TagParams { source: "nfc" | "simulator"; serial?: string | null; tapId?: number; tapToken?: string }
/** The session's local deadline; `limitedBy: "tap"` when an adopted tap's 180 s server window ends first. */
type Clock = SessionClock & { limitedBy: "session" | "tap" };
const platform = () => (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent) ? "ANDROID_WEB" : typeof navigator !== "undefined" && /iPhone|iPad/i.test(navigator.userAgent) ? "IOS_WEB" : "DESKTOP_WEB");
const nonceCode = (nonce: string) => nonce.replace(/^0x/, "").slice(0, 6).toUpperCase();

function StepHeader({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div>
      <p className="eyebrow">Step {n} of 7</p>
      <h1 className="mt-2 font-serif text-3xl sm:text-4xl">{title}</h1>
      {hint && <p className="mt-2 max-w-lg text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function ScanFlow() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();
  const [step, setStep] = useState<Step>("session");
  const [session, setSession] = useState<Session | null>(null);
  const [clock, setClock] = useState<Clock | null>(null);
  const [left, setLeft] = useState(NONCE_TTL_S);
  const [tag, setTag] = useState<Tag | null>(null);
  const [simTags, setSimTags] = useState<SimTag[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [frames, setFrames] = useState<{ img: FrameLike[]; blobs: Blob[]; mediaHash: string } | null>(null);
  const [reading, setReading] = useState<CardReading | null>(null);
  const [fill, setFill] = useState(92);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const qRole = Number(params.get("role")), qTier = Number(params.get("tier")), qSite = Number(params.get("site"));
  const certified = qTier === Tier.CERTIFIED || qTier === Tier.BIRTH;
  // Vault/Partner roles only exist in the certified flow (the role select offers them only there)
  const defaultRole = Number.isInteger(qRole) && qRole >= 0 && qRole <= 4 && (certified || qRole <= Role.BUYER) ? qRole : Role.OWNER;
  const [role, setRole] = useState<number>(defaultRole);
  const siteId = certified && Number.isInteger(qSite) && qSite > 0 ? qSite : 0;
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nfcState, setNfcState] = useState<string>("");
  const [deadSerial, setDeadSerial] = useState("");
  const [camReady, setCamReady] = useState(false);
  const cfg = useRef<HeatFieldsConfig | null>(null);
  const vision = useRef<VisionClient | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const nfcAbort = useRef<AbortController | null>(null);
  /** synchronous guard: a second press on Capture must not start a parallel run before `busy` re-renders */
  const capturing = useRef(false);
  /** the photos uploaded for this session (one upload per set of frames; the verifier caps files per nonce) */
  const uploaded = useRef<{ mediaHash: string; sha256: string } | null>(null);
  // demo tools (virtual taps, test images, airdrop) — read after hydration, see lib/demo.ts
  const [demo, setDemo] = useState(false);
  useEffect(() => setDemo(demoMode()), []);
  // the virtual-tap card only makes sense when the verifier runs its simulator (off in production)
  const [serverSim, setServerSim] = useState(false);
  useEffect(() => { if (demo) api.health().then((h) => setServerSim(!!h.simulator)).catch(() => setServerSim(false)); }, [demo]);
  useEffect(() => { if (demo && serverSim && step === "tap") api.simTags().then(setSimTags).catch(() => setSimTags([])); }, [demo, serverSim, step]);
  const deadNonceSpent = useRef<string | null>(null);
  const [tierOverride, setTierOverride] = useState<number | null>(null);
  const tier = tierOverride ?? (certified ? qTier : frames ? Tier.SELF_MEDIA : Tier.SELF);
  const scanUrl = scanUrlFor(params);

  /**
   * Takes a fresh session from the server: local deadline + clock offset. `share` publishes it to /t in other tabs
   * (localStorage) so a tap is handed over instead of consumed — only while this page waits for a tap.
   */
  const adoptSession = useCallback((s: Session, deadlineOverride?: { deadline: number; limitedBy: "session" | "tap" }, share = true) => {
    const base = sessionClock(s);
    const c: Clock = { ...base, deadline: deadlineOverride?.deadline ?? base.deadline, limitedBy: deadlineOverride?.limitedBy ?? "session" };
    if (share) scanSession.set({ nonce: s.nonce, expiresAt: s.expiresAt, ttl: s.ttl, issuedAt: s.issuedAt, deadline: c.deadline, offset: c.offset, scanUrl });
    setSession(s); setClock(c); setLeft(secondsLeft(c.deadline));
    uploaded.current = null;
    return c;
  }, [scanUrl]);

  // ---- 1. session -------------------------------------------------------
  const startSession = useCallback(async () => {
    setError(null); setTag(null); setPreview(null); setFrames(null); setReading(null); setVerify(null); setTxSig(null);
    // a resumed scan (?resume=) may have set tier and role: a new scan starts from the page's own defaults again
    setTierOverride(null); setRole(defaultRole); setNfcState(""); setDeadSerial("");
    try {
      const s = await api.session();
      adoptSession(s);
      setStep("tap");
    } catch (e) { setError(friendly(e)); }
  }, [defaultRole, adoptSession]);
  useEffect(() => {
    vision.current = new VisionClient();
    fetch("/heat_fields.json").then((r) => r.json()).then((c) => { cfg.current = c; }).catch(() => { /* the read step reports a missing config */ });
    return () => { vision.current?.terminate(); stream.current?.getTracks().forEach((t) => t.stop()); nfcAbort.current?.abort(); };
  }, []);
  // The 90 s window covers tap → photo → server signature. Once the server has signed ("tx"), the signed scan stays
  // anchorable: the countdown stops and expiry no longer hides or blocks the anchor step.
  const timed = step !== "tx" && step !== "done" && step !== "dead";
  useEffect(() => {
    if (!clock || !timed) return;
    const tick = () => setLeft(secondsLeft(clock.deadline));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [clock, timed]);
  const expired = session != null && clock != null && left <= 0 && timed;
  useEffect(() => { if (!timed || expired) scanSession.clear(); }, [timed, expired]);
  // WebNFC: release the reader whenever the tap step is left (or the session runs out)
  useEffect(() => { if (step !== "tap" || expired) { nfcAbort.current?.abort(); nfcAbort.current = null; } }, [step, expired]);

  // ---- 2. tap -----------------------------------------------------------
  const onTag = useCallback(async (t: Tag) => {
    setTag(t); setBusy("preview");
    try {
      const p = await api.preview(t);
      const verdict = effectiveVerdict(p);
      setPreview({ ...p, verdict });
      setStep(verdict === "NO_RESPONSE" ? "dead" : "preview");
    } catch (e) { setError(friendly(e)); }
    finally { setBusy(null); }
  }, []);
  // Resume: Safari (iPhone) loads the sticker link into THIS tab, so the page restarts. A session that is still
  // running in localStorage is picked up again, and the pending tap handoff then advances it.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || step !== "session") return;
    resumed.current = true;
    if (params.has("resume") || params.has("adopt")) return; // those flows bring their own state
    // only the tab that started the session takes it up again (a second /scan tab on the same nonce would fail)
    const s = scanSession.active();
    if (!s || !scanSession.ownedHere(s)) return;
    setSession({ nonce: s.nonce, expiresAt: s.expiresAt, ttl: s.ttl ?? NONCE_TTL_S, issuedAt: s.issuedAt });
    setClock({ deadline: s.deadline, offset: s.offset, limitedBy: "session" });
    setLeft(secondsLeft(s.deadline));
    setNfcState("Session resumed");
    setStep("tap");
  }, [step, params]);
  // Resume at the anchor step inside a wallet app's browser (iPhone): ?resume=<eventId>.<token> (see lib/wallet-links.ts)
  const resumedTx = useRef(false);
  useEffect(() => {
    if (resumedTx.current) return;
    const r = params.get("resume");
    if (!r) return;
    resumedTx.current = true;
    const ref = resumeRef.decode(r);
    if (!ref) { setError("This resume link is invalid. Start a new scan."); return; }
    (async () => {
      setBusy("resume");
      try {
        const v = await api.resume(ref.eventId, ref.token);
        const signed = signedAttester(v);
        setVerify(v);
        setRole(signed.role ?? defaultRole);
        // the server's record of the scan decides tier and role; the link's own parameters only as a fallback
        setTierOverride(signed.tier ?? (params.get("tier") != null && Number.isInteger(qTier) ? qTier : null));
        setStep(v.verdict === "VALID" ? "tx" : "verify");
      } catch (e) { setError(friendly(e)); }
      finally { setBusy(null); }
    })();
  }, [params, defaultRole, qTier]);
  // Adopt a tap that already landed on /t (phone background NFC read): one tap, then straight on to the card photo.
  const adopted = useRef(false);
  useEffect(() => {
    const id = params.get("adopt"), k = params.get("k");
    if (!id || adopted.current) return;
    adopted.current = true;
    (async () => {
      setError(null);
      try {
        const [s, t] = await Promise.all([api.session(), api.tap(id)]);
        // the server adopts a /t tap for 180 s after it happened: the countdown ends with whichever comes first
        const ad = adoptDeadline(t.ts, sessionClock(s));
        adoptSession(s, ad);
        const verdict = effectiveVerdict(t);
        const p: Preview = { verdict, counter: t.counter, serial: t.serial, serialHash: t.serialHash, uidHash: t.uidHash, sealKind: t.sealKind, sealDead: t.sealDead };
        if (secondsLeft(ad.deadline) <= 0) { setPreview({ ...p, verdict: "TAP_TOO_OLD" }); setStep("preview"); setNfcState("This tap is older than 3 minutes — please tap the seal again"); return; }
        setTag({ uid: t.uid ?? "", ctr: t.counter != null ? t.counter.toString(16).padStart(6, "0").toUpperCase() : "", cmac: "", source: "nfc", serial: t.serial ?? undefined, tapId: t.tapId, tapToken: k ?? undefined });
        setPreview(p);
        setNfcState("Tap handed over");
        setStep(verdict === "NO_RESPONSE" ? "dead" : "preview");
      } catch (e) { setError(`Tap could not be handed over: ${friendly(e)}`); }
    })();
  }, [params, adoptSession]);
  // adopt / k / resume are one-shot: drop them from the address bar once read (keeps tier, role, site)
  useEffect(() => {
    if (!params.has("adopt") && !params.has("k") && !params.has("resume")) return;
    const keep = new URLSearchParams();
    for (const key of ["tier", "role", "site"]) { const v = params.get(key); if (v != null) keep.set(key, v); }
    const q = keep.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }, [params, pathname, router]);
  // Tap handoff: a tap that opened /t (other tab, or this tab before the reload) is handed over through localStorage
  useEffect(() => {
    if (step !== "tap" || expired) return;
    let alive = true;
    const pick = async () => {
      const h = await tapHandoff.take();
      if (!h || !alive) return;
      setNfcState("Tap handed over from the browser");
      onTag({ uid: h.uid, ctr: h.ctr, cmac: h.cmac, piccData: h.piccData, enc: h.enc, source: "nfc" });
    };
    pick();
    const id = setInterval(pick, 1000);
    const onStorage = (e: StorageEvent) => { if (e.key === tapHandoff.key) pick(); };
    window.addEventListener("storage", onStorage);
    return () => { alive = false; clearInterval(id); window.removeEventListener("storage", onStorage); };
  }, [step, expired, onTag]);
  const simTap = async (t: SimTag) => {
    setBusy(`tap-${t.uid}`);
    try {
      const r = await api.simTap(t.uid);
      if (!r.responds || !r.url) { setTag({ uid: t.uid, ctr: "", cmac: "", source: "simulator", serial: t.serial }); setDeadSerial(t.serial ?? ""); setStep("dead"); return; }
      const parsed = parseTagUrl(r.url);
      if (!parsed) throw new Error("Simulator URL unreadable");
      await onTag({ ...parsed, source: "simulator", serial: t.serial });
    } catch (e) { setError(friendly(e)); }
    finally { setBusy(null); }
  };
  const startNfc = async () => {
    const w = window as unknown as { NDEFReader?: new () => { scan: (o?: { signal: AbortSignal }) => Promise<void>; onreading: ((ev: { message: { records: Array<{ recordType: string; data?: DataView; encoding?: string }> } }) => void) | null; onreadingerror: (() => void) | null } };
    if (!w.NDEFReader) { setNfcState("WebNFC only in Android Chrome. iPhone: tapping the seal opens /t."); return; }
    try {
      const reader = new w.NDEFReader();
      nfcAbort.current?.abort();
      const ctrl = new AbortController(); nfcAbort.current = ctrl;
      await reader.scan({ signal: ctrl.signal });
      setNfcState("Ready — hold the seal to the phone …");
      reader.onreadingerror = () => setNfcState("Read error — tap again");
      reader.onreading = (ev) => {
        const seen: string[] = [];
        for (const rec of ev.message.records) {
          if (!rec.data) { seen.push(rec.recordType); continue; }
          // Any record type: decode as text and look for the sticker link (url / absolute-url / text / mime / unknown).
          const text = new TextDecoder().decode(rec.data).replace(/\0/g, "");
          seen.push(`${rec.recordType}: ${text.slice(0, 60)}`);
          const candidates = [text, ...(text.match(/https?:\/\/[^\s"'<>]+/gi) ?? []), ...(/^[\w.-]+\.[a-z]{2,}\//i.test(text) ? [`https://${text}`] : [])];
          for (const c of candidates) {
            const parsed = parseTagUrl(c);
            if (parsed) { setNfcState(parsed.piccData ? "Read: encrypted tap" : `Read: …${parsed.uid.slice(-4)} · counter ${parseInt(parsed.ctr, 16)}`); onTag({ ...parsed, source: "nfc" }); ctrl.abort(); nfcAbort.current = null; return; }
          }
        }
        // Chrome's WebNFC hands some NTAG 424 DNA messages over as an empty record. Release the reader so the next tap goes
        // to Android, which opens the sticker link; /t then hands the tap over to this session.
        ctrl.abort(); nfcAbort.current = null;
        setNfcState(`Chrome could not read the chip (${seen.join(" | ") || "empty"}). NFC reader stopped — now simply hold the seal to the phone: Android opens the link, “Tap handed over”, then return to this tab.`);
      };
    } catch (e) { setNfcState(`NFC: ${friendly(e)}`); }
  };

  // ---- 4. camera --------------------------------------------------------
  const stopCam = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setCamReady(false); };
  // on only while the camera step is shown and the session runs; a stream that arrives after the step was left is stopped at once
  const camOn = step === "camera" && !expired;
  useEffect(() => {
    if (!camOn) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        if (video.current) { video.current.srcObject = s; await video.current.play(); }
      } catch (e) { if (!cancelled) setError(`Camera: ${friendly(e)}`); }
    })();
    return () => { cancelled = true; stopCam(); };
  }, [camOn]);

  /** Frames → JPEG blobs with the nonce code burned in → media hash → indicator reading (briefing §8 steps 4–5). */
  const processFrames = async (imgs: FrameLike[]) => {
    if (!session) return;
    if (!vision.current || !cfg.current) throw new Error("The card reader is not ready yet. Wait a moment and capture again.");
    const blobs: Blob[] = [];
    for (const f of imgs) {
      const c = document.createElement("canvas"); c.width = f.width; c.height = f.height;
      const ctx = c.getContext("2d")!;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
      // the nonce code is burned into the frame as well, so the photo carries the session
      ctx.font = `bold ${Math.round(f.height / 18)}px sans-serif`; ctx.fillStyle = "rgba(166,101,27,0.95)"; ctx.fillText(nonceCode(session.nonce), 24, Math.round(f.height / 14));
      blobs.push(await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode the photo"))), "image/jpeg", 0.9)));
    }
    const mediaHash = await sha256Hex(await Promise.all(blobs.map((b) => b.arrayBuffer())));
    setFrames({ img: imgs, blobs, mediaHash });
    setReading(null);
    setStep("read");
    setBusy("read");
    // every frame is read; the indicators are decided by a majority of the frames (vision/vote.ts)
    const readings: CardReading[] = [];
    for (const f of imgs) readings.push(await vision.current.read({ data: new Uint8ClampedArray(f.data), width: f.width, height: f.height }, cfg.current, {}));
    setReading(combineReadings(readings, imgs.length));
  };
  const runCapture = async (grab: () => Promise<FrameLike[]>) => {
    if (capturing.current) return;
    capturing.current = true;
    setBusy("capture"); setError(null);
    try { await processFrames(await grab()); }
    catch (e) { setError(friendly(e)); }
    finally { capturing.current = false; setBusy(null); }
  };
  const captureFrames = () => runCapture(async () => {
    const v = video.current;
    if (!v || !v.videoWidth) throw new Error("The camera is not ready yet.");
    const imgs: FrameLike[] = [];
    for (let i = 0; i < 5; i++) {
      imgs.push(frameFromSource(v, 1600));
      await new Promise((r) => setTimeout(r, 300));
    }
    return imgs;
  });
  /** Demo only: five synthetic card renders instead of camera frames (tests the whole tier-2 path without hardware). */
  const syntheticFrames = (triggered: boolean) => runCapture(async () => {
    if (!vision.current || !cfg.current) throw new Error("The card reader is not ready yet.");
    const imgs: FrameLike[] = [];
    for (let i = 0; i < 5; i++) {
      imgs.push(await vision.current.synth(cfg.current, {
        heatLevels: triggered ? [1, 1, 1, 1, 1, 0] : [1, 0, 0, 0, 0, 0], humidityTriggered: false,
        tilt: 0.05 + i * 0.01, rot: -4 + i * 2, tint: [1.04, 1.0, 0.9], brightness: -15, blurSigma: 0.8, noiseSigma: 4,
        width: 1280, height: 720, cardPx: 800, seed: 40 + i,
      }));
    }
    return imgs;
  });
  const skipCamera = () => { setFrames(null); setReading(null); setStep("read"); };

  // ---- 6–7. bundle + signature -----------------------------------------
  const requestSignature = async () => {
    if (!tag || !session) return;
    setBusy("verify"); setError(null);
    try {
      let mediaHash: string | undefined;
      if (frames) {
        // one upload per set of frames: retrying "Get signature" reuses it (the verifier caps the files per session)
        let up = uploaded.current;
        if (!up || up.mediaHash !== frames.mediaHash) {
          const m = await api.media(frames.blobs, session.nonce);
          if (m.sha256.toLowerCase() !== frames.mediaHash.toLowerCase()) throw new Error("Media hash differs from the server");
          up = { mediaHash: frames.mediaHash, sha256: m.sha256 };
          uploaded.current = up;
        }
        mediaHash = up.sha256;
      }
      const v = await api.verify(verifyBody({
        tag, nonce: session.nonce, role, tier, reading: reading && reading.found ? reading : null, fill, mediaHash,
        serial: preview?.serial, country, city, attester: wallet.publicKey?.toBase58() ?? null, platform: platform(),
      }));
      setVerify(v);
      setStep(v.verdict === "VALID" ? "tx" : "verify");
    } catch (e) { setError(friendly(e)); }
    finally { setBusy(null); }
  };

  // ---- anchor step: transaction -----------------------------------------
  const signed = signedAttester(verify);
  const txTier = signed.tier ?? tier, txRole = signed.role ?? role;
  const sendTx = async () => {
    if (!verify || !anchorWallet || !wallet.publicKey) return;
    setError(null);
    // the server signed this scan for the wallet connected at "Get signature": anchoring with another one cannot be confirmed
    const other = attesterMismatch(verify, wallet.publicKey.toBase58());
    if (other) { setError(`This scan was signed for wallet ${short(other)}. Switch back to that wallet (header) to anchor it.`); return; }
    setBusy("tx");
    try {
      let sig = txSig; // set when the transaction landed but the server confirmation failed: only that is retried
      if (!sig) {
        const program = flaconProgram(connection, anchorWallet);
        const { tx, scanProof } = await buildRecordScanTx(program, wallet.publicKey, verify, { tier: txTier, role: txRole, siteId });
        // Already anchored (the wallet sent it but the answer never reached this page)? Only a real ScanProof counts —
        // owned by the flacon program and attested by this wallet; a SOL transfer to the address is not an anchor.
        const info = await connection.getAccountInfo(scanProof, "confirmed");
        const anchoredBy = scanProofAttester(info ? { owner: info.owner, data: info.data } : null, programId());
        if (anchoredBy && !anchoredBy.equals(wallet.publicKey)) throw new Error(`This scan is already anchored by another wallet (${short(anchoredBy.toBase58())}). It cannot be anchored twice.`);
        if (anchoredBy) {
          sig = await creatingSignature(connection, scanProof, { programId: programId(), instruction: "record_scan", signer: wallet.publicKey });
          if (!sig) throw new Error("This scan is anchored on chain, but its transaction was not found yet. Try again in a moment.");
        } else {
          sig = await sendAsV0(wallet, connection, tx);
        }
        setTxSig(sig);
      }
      await api.events({ eventId: verify.eventId, txSig: sig, actor: wallet.publicKey.toBase58(), serial: verify.serial, type: 2 });
      setStep("done");
    } catch (e) {
      // the server saw it fail on chain, or the signature does not belong to this scan: look again / send again next time
      if (e instanceof ApiError && (e.code === "tx_failed" || e.code === "tx_mismatch")) setTxSig(null);
      setError(friendly(e));
    }
    finally { setBusy(null); }
  };
  const airdrop = async () => {
    if (!wallet.publicKey) return;
    setBusy("airdrop");
    try { const s = await connection.requestAirdrop(wallet.publicKey, 1e9); await connection.confirmTransaction(s, "confirmed"); }
    catch (e) { setError(`Airdrop: ${friendly(e)}`); }
    finally { setBusy(null); }
  };

  // ---- dead seal --------------------------------------------------------
  /** SEAL_DEAD without a transaction: recorded as an unverified report (needs an unused session nonce); a partner confirms it on chain. */
  const reportDead = async () => {
    setBusy("dead"); setError(null);
    try {
      const serial = (preview?.serial ?? tag?.serial ?? deadSerial).trim();
      if (!serial) throw new Error("Enter the passport serial number");
      let s = session;
      if (!s || !clock || s.nonce === deadNonceSpent.current || secondsLeft(clock.deadline) <= 2) { s = await api.session(); adoptSession(s, undefined, false); }
      deadNonceSpent.current = s.nonce; // a failed attempt may still have used it: the next attempt takes a fresh session
      // no chip UID in the report (it would become public); the seal is identified by its hash when the tap gave one
      await api.events({ serial, type: 9, nonce: s.nonce, actor: wallet.publicKey?.toBase58() ?? null, sealUidHash: preview?.uidHash ?? undefined, payload: { source: tag?.source ?? "manual", note: "Seal not responding" } });
      setDeadSerial(serial);
      setStep("done");
    } catch (e) { setError(friendly(e)); }
    finally { setBusy(null); }
  };

  const heatTxt = reading?.found ? indicatorText("heat", reading.heat) : null;
  const humTxt = reading?.found ? indicatorText("humidity", reading.humidity) : null;
  const previewVerdict = preview
    ? preview.verdict === "TAP_TOO_OLD"
      ? { title: "Tap too old", tone: "warn" as const, hint: "The seal was tapped more than 3 minutes ago. Tap it again to start the check." }
      : verdictText(preview.verdict, preview.counter)
    : null;
  const finalGrade = verify?.grade ?? null;
  const stepNo = useMemo(() => ({ session: 1, tap: 2, preview: 3, camera: 4, read: 5, verify: 6, tx: 6, done: 7, dead: 3 })[step], [step]);
  const doneSerial = verify?.serial ?? deadSerial;
  const resumeLinks = verify?.eventId && verify.resumeToken
    ? walletBrowseLinks(resumeUrl({ eventId: verify.eventId, token: verify.resumeToken, tier: txTier, role: txRole, siteId }))
    : null;

  return (
    <div className="page-in container-page py-10">
      {/* countdown */}
      {session && timed && (
        <div className="mb-6 flex items-center justify-between text-xs text-muted">
          <span>Session <span className="mono text-ink">{nonceCode(session.nonce)}</span></span>
          <span className={`tabular ${left <= 15 ? "text-bad" : ""}`}>{expired ? "expired" : `${left} s`}</span>
        </div>
      )}
      {expired && (
        <div className="card mb-6 p-4 text-sm">
          <p className="font-medium">{clock?.limitedBy === "tap" ? "Tap too old" : "Session expired"}</p>
          <p className="mt-1 text-muted">{clock?.limitedBy === "tap"
            ? "The server accepts a tap from the seal page for 3 minutes. Please restart and tap the seal again."
            : "Tap, photo and signature must happen within 90 seconds. Please restart."}</p>
          <button onClick={startSession} className="btn btn-sm mt-3"><RefreshCw className="h-3.5 w-3.5" aria-hidden /> Restart</button>
        </div>
      )}
      {error && <p className="mb-6 rounded-xl border border-bad/40 px-4 py-3 text-sm text-bad" role="alert">{error}</p>}

      {step === "session" && (
        <div>
          <StepHeader n={1} title="Witness a scan" hint="Tap, photo of the card, server signature, transaction. All in one 90-second session; the session code is overlaid on the photo." />
          {busy === "resume" ? (
            <p className="mt-6 flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the signed scan …</p>
          ) : (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button onClick={startSession} className="btn">Start session <ArrowRight className="h-4 w-4" aria-hidden /></button>
              <WalletButton />
            </div>
          )}
          {!PROGRAM_ID && <p className="mt-4 text-xs text-muted">Note: no program ID set — the anchor step is disabled.</p>}
        </div>
      )}

      {step === "tap" && !expired && (
        <div>
          <StepHeader n={2} title="Tap the seal" hint="The chip returns a URL with UID, counter and checksum. Only the server can verify the checksum." />
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div className="card p-4">
              <p className="flex items-center gap-2 text-sm font-medium"><Nfc className="h-4 w-4 text-amber" aria-hidden /> WebNFC (Android Chrome)</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={startNfc} className="btn-outline btn-sm">Start NFC reading</button>
                <button onClick={() => { nfcAbort.current?.abort(); setTag(null); setPreview(null); setStep("dead"); }} className="btn-outline btn-sm" title="Seal separated or removed — report as SEAL_DEAD"><ShieldOff className="h-3.5 w-3.5" aria-hidden /> Seal not responding</button>
              </div>
              <p className="mt-2 break-words text-xs text-muted">{nfcState || "Session running — simply hold the seal to the phone. The phone opens the seal link and the tap is handed over here; then return to this tab."}</p>
            </div>
            {demo && serverSim && (
              <div className="card p-4">
                <p className="flex items-center gap-2 text-sm font-medium"><Zap className="h-4 w-4 text-amber" aria-hidden /> Inject a virtual tap</p>
                <ul className="mt-3 divide-y divide-line">
                  {simTags.map((t) => (
                    <li key={t.uid} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                      <Lamp tone={t.alive ? "ok" : "bad"} />
                      <span className="mono">{t.uid}</span>
                      <span className="min-w-0 flex-1 truncate text-muted">{t.serial ?? "not registered"} · counter {t.counter}</span>
                      <button onClick={() => simTap(t)} disabled={busy !== null} className="btn btn-sm ml-auto">{busy === `tap-${t.uid}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : "Tap"}</button>
                    </li>
                  ))}
                  {simTags.length === 0 && <li className="py-2 text-xs text-muted">No virtual tags — create them in the <Link href="/dev" className="link">simulator</Link>.</li>}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {step === "preview" && preview && previewVerdict && !expired && (
        <div>
          <StepHeader n={3} title="Seal checked" />
          <div className="mt-6 flex items-center gap-3">
            <Lamp tone={previewVerdict.tone} className="h-3.5 w-3.5" />
            <p className={`font-serif text-3xl ${previewVerdict.tone === "ok" ? "text-ok" : previewVerdict.tone === "bad" ? "text-bad" : "text-warn"}`}>{previewVerdict.title}</p>
          </div>
          <p className="mt-2 max-w-lg text-sm text-muted">{previewVerdict.hint}</p>
          {preview.serial && <p className="mt-2 text-sm text-muted">Passport <span className="mono text-ink">{preview.serial}</span> · {preview.sealKind === 0 ? "Box seal" : "Neck seal"}</p>}
          <div className="mt-6 flex flex-wrap gap-3">
            {preview.verdict === "VALID" && <button onClick={() => setStep("camera")} className="btn"><Camera className="h-4 w-4" aria-hidden /> Continue to camera</button>}
            {preview.verdict === "VALID" && !certified && <button onClick={skipCamera} className="btn-outline">Without photo (tier 1)</button>}
            {preview.verdict !== "VALID" && <button onClick={startSession} className="btn-outline">Restart</button>}
          </div>
        </div>
      )}

      {step === "camera" && !expired && (
        <div>
          <StepHeader n={4} title="Photograph the card" hint="Place the card in its holder fully inside the frame. Five frames; the session code is overlaid. Keep faces and personal items out of the picture: the photos become part of the public scan record." />
          <div className="relative mt-6 overflow-hidden rounded-2xl border border-line bg-line">
            <video ref={video} playsInline muted className="block w-full" onPlaying={() => setCamReady(true)} onLoadedData={(e) => { if (e.currentTarget.videoWidth > 0) setCamReady(true); }} />
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute left-[10%] top-[18%] h-[64%] w-[80%] rounded-lg border-2 border-amber/80" />
              <div className="absolute left-3 top-3 rounded-md bg-amber px-2 py-1 font-mono text-lg font-bold text-white">{session ? nonceCode(session.nonce) : ""}</div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <button onClick={captureFrames} disabled={busy !== null || !camReady} className="btn">{busy === "capture" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Camera className="h-4 w-4" aria-hidden />} Capture 5 frames</button>
            {!certified && <button onClick={skipCamera} className="btn-outline">Without photo (tier 1)</button>}
            {demo && (
              <>
                <button onClick={() => syntheticFrames(false)} disabled={busy !== null} className="btn-outline btn-sm">Test image: intact</button>
                <button onClick={() => syntheticFrames(true)} disabled={busy !== null} className="btn-outline btn-sm">Test image: 40 °C triggered</button>
              </>
            )}
          </div>
          {!camReady && <p className="mt-2 text-xs text-muted">Waiting for the camera …</p>}
        </div>
      )}

      {step === "read" && !expired && (
        <div>
          <StepHeader n={5} title="Indicators" hint={frames ? "Read from the frames: card outline → rectification → white balance → colour distance; each indicator needs 3 of 5 frames to agree." : "Without photo: indicators count as not read (MISSING), tier 1."} />
          {busy === "read" && <p className="mt-6 flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading the card …</p>}
          {reading && !reading.found && (
            <div className="card mt-6 p-4 text-sm"><p className="font-medium">Card not recognized</p><p className="mt-1 text-muted">{reading.reason}. Photograph again or continue without a reading (indicators MISSING).</p></div>
          )}
          {reading?.found && heatTxt && humTxt && (
            <div className="mt-6 flex flex-wrap gap-2">
              <Pill tone={heatTxt.tone}>{heatTxt.label}: {heatTxt.detail}</Pill>
              <Pill tone={humTxt.tone}>{humTxt.label}: {humTxt.detail}</Pill>
              {reading.uv === Indicator.MISSING ? <Pill tone="none">Light: not fitted</Pill> : <Pill tone={indicatorText("uv", reading.uv).tone}>{indicatorText("uv", reading.uv).label}: {indicatorText("uv", reading.uv).detail}</Pill>}
              {(reading.heat === Indicator.UNREADABLE || reading.humidity === Indicator.UNREADABLE) && <Pill tone="none">Inspection recommended</Pill>}
            </div>
          )}
          {reading?.found && (reading.heat === Indicator.UNREADABLE || reading.humidity === Indicator.UNREADABLE) && (
            <p className="mt-2 text-xs text-muted">{reading.reason ?? "The card could not be read reliably"}{reading.votes ? ` · heat agreed in ${reading.votes.heat} of ${reading.votes.frames} frames` : ""}. Photograph again for a full reading.</p>
          )}
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="card block p-4 text-sm">
              <span className="font-medium">Fill level {fill} %</span>
              <input type="range" min={0} max={100} value={fill} onChange={(e) => setFill(+e.target.value)} className="mt-2 w-full" />
              <span className="text-xs text-muted">Demo: slider. Later from the camera.</span>
            </label>
            <div className="card p-4 text-sm">
              <label className="block">Role
                <select value={role} onChange={(e) => setRole(+e.target.value)} className="ml-2 rounded-full border border-line bg-surface px-2 py-0.5 text-sm">
                  <option value={Role.OWNER}>Owner</option><option value={Role.SELLER}>Seller</option><option value={Role.BUYER}>Buyer</option>
                  {certified && <><option value={Role.VAULT}>Vault</option><option value={Role.PARTNER}>Partner</option></>}
                </select>
                {certified && <span className="ml-2 text-xs text-muted">Tier {qTier} · Site {siteId}</span>}
              </label>
              <div className="mt-2 flex gap-2">
                <input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))} placeholder="DE" className="w-14 rounded-full border border-line bg-surface px-2 py-0.5 text-sm" aria-label="Country (optional)" />
                <input value={city} onChange={(e) => setCity(e.target.value.slice(0, 80))} placeholder="Place (rough, optional)" className="flex-1 rounded-full border border-line bg-surface px-3 py-0.5 text-sm" aria-label="Place (optional)" />
              </div>
              <p className="mt-1 text-xs text-muted">Optional. Country and place are not in the Solana transaction, but they are part of the public scan record and its permanent archive. No GPS. <Link href="/privacy" className="link">Privacy</Link></p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <button onClick={requestSignature} disabled={busy !== null} className="btn">{busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Get signature <ArrowRight className="h-4 w-4" aria-hidden /></button>
            {frames && <button onClick={() => setStep("camera")} disabled={busy !== null} className="btn-outline">Photograph again</button>}
          </div>
        </div>
      )}

      {step === "verify" && verify && (
        <div>
          <StepHeader n={6} title={verdictText(verify.verdict, verify.counter).title} hint={verdictText(verify.verdict, verify.counter).hint} />
          <button onClick={startSession} className="btn-outline mt-6">Restart</button>
        </div>
      )}

      {step === "tx" && verify && (
        <div>
          <StepHeader n={6} title="Server signed — now anchor it" hint={`Server verdict ${verify.verdict} · counter ${verify.counter} · Grade ${gradeLetter(verify.grade)} preliminary. The transaction contains the Ed25519 check of the server signature and record_scan.`} />
          {!wallet.connected && isIOS() && noInjectedWallet(wallet.wallets.map((w) => ({ name: w.adapter.name, installed: w.readyState === WalletReadyState.Installed }))) && (
            <div className="card mt-6 p-4 text-sm">
              <p className="font-medium">Sign with your wallet app</p>
              {resumeLinks ? (
                <>
                  <p className="mt-1 text-muted">Safari cannot connect a wallet. The scan continues in the wallet app, where you sign directly.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <a href={resumeLinks.phantom} className="btn btn-sm">Continue in Phantom</a>
                    <a href={resumeLinks.solflare} className="btn-outline btn-sm">Continue in Solflare</a>
                  </div>
                </>
              ) : <p className="mt-1 text-muted">Safari cannot connect a wallet, and this scan cannot be handed to the wallet app. Connect a wallet (WalletConnect) above.</p>}
            </div>
          )}
          {signed.pubkey && wallet.publicKey && signed.pubkey !== wallet.publicKey.toBase58() && (
            <p className="mt-6 text-sm text-warn">Signed for wallet {short(signed.pubkey)} — switch to that wallet in the header to anchor this scan.</p>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {!wallet.connected ? <WalletButton /> : (
              <>
                <button onClick={sendTx} disabled={busy !== null || !PROGRAM_ID} className="btn">{busy === "tx" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} {txSig ? "Retry confirmation with the server" : `Sign and send with ${wallet.wallet?.adapter.name ?? "wallet"}`}</button>
                {txSig && <a href={txUrl(txSig)} target="_blank" rel="noreferrer" className="link text-xs text-muted">Transaction landed · explorer</a>}
                {demo && <button onClick={airdrop} disabled={busy !== null} className="btn-outline btn-sm">1 SOL airdrop (test)</button>}
              </>
            )}
          </div>
          <p className="mono mt-4 break-all text-xs text-muted">msg {verify.msgHex.slice(0, 32)}… · sig {verify.serverSig?.slice(0, 24)}… · key #{verify.keyId}</p>
        </div>
      )}

      {step === "done" && (
        <div>
          <StepHeader n={7} title={txSig ? "Scan anchored" : "Seal not responding — report recorded"} />
          <div className="mt-6 flex items-center gap-5">
            {txSig ? <GradeMark grade={finalGrade} /> : <ShieldOff className="h-12 w-12 shrink-0 text-warn" aria-hidden />}
            <div className="text-sm text-muted">
              {txSig && verify && (
                <>
                  <p className="text-ink">Grade {gradeLetter(finalGrade)} · counter {verify.counter}</p>
                  {gradeSentence(finalGrade ?? 0) && <p className="mt-1">{gradeSentence(finalGrade ?? 0)}</p>}
                  <a href={txUrl(txSig)} target="_blank" rel="noreferrer" className="link mt-1 block">Transaction in explorer</a>
                </>
              )}
              {!txSig && <p>Your SEAL_DEAD report is recorded as unverified. A partner checks the seal and confirms it on chain; the report alone does not change the passport.</p>}
            </div>
          </div>
          {reading?.found && heatTxt && humTxt && (
            <div className="mt-6 flex flex-wrap gap-2"><Pill tone={heatTxt.tone}>{heatTxt.label}: {heatTxt.detail}</Pill><Pill tone={humTxt.tone}>{humTxt.label}: {humTxt.detail}</Pill></div>
          )}
          <div className="mt-8 flex flex-wrap gap-3">
            {doneSerial && <Link href={passportHref(doneSerial)} className="btn">View passport <ArrowRight className="h-4 w-4" aria-hidden /></Link>}
            <button onClick={startSession} className="btn-outline">New scan</button>
          </div>
        </div>
      )}

      {step === "dead" && (
        <div>
          {preview?.sealDead ? (
            <StepHeader n={3} title="Seal recorded as not responding" hint="This seal is already marked as not responding on chain, so the passport is void. There is nothing more to report." />
          ) : (
            <StepHeader n={3} title="No seal found" hint="Seal separated, removed or out of range. Your report is recorded as unverified; a partner checks the seal and confirms it on chain." />
          )}
          <div className="mt-6 flex items-center gap-3 text-bad"><ShieldOff className="h-5 w-5" aria-hidden /><span className="font-serif text-2xl">Seal not responding</span></div>
          {preview?.serial && <p className="mt-2 text-sm text-muted">Passport <Link href={passportHref(preview.serial)} className="link mono text-ink">{preview.serial}</Link></p>}
          {!preview?.sealDead && !(preview?.serial ?? tag?.serial) && (
            <label className="mt-4 block text-sm">Passport serial number <input value={deadSerial} onChange={(e) => setDeadSerial(e.target.value)} placeholder="SN-2026-000001" className="ml-2 rounded-full border border-line bg-surface px-3 py-0.5 font-mono text-sm" /></label>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            {!preview?.sealDead && <button onClick={reportDead} disabled={busy !== null} className="btn">{busy === "dead" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Report (SEAL_DEAD)</button>}
            <button onClick={startSession} className="btn-outline">{preview?.sealDead ? "New scan" : "Cancel"}</button>
          </div>
        </div>
      )}
      <p className="mt-10 text-xs text-muted">Step {stepNo} · Tier {step === "tx" || step === "done" ? txTier : tier} · Wallet {wallet.publicKey ? `${wallet.publicKey.toBase58().slice(0, 4)}…` : "not connected"}</p>
    </div>
  );
}
