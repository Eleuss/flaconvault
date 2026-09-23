"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ArrowRight, Camera, Loader2, Nfc, RefreshCw, ShieldOff, Zap } from "lucide-react";
import { Grade, Indicator, Role, Tier, NONCE_TTL_S } from "@flaconvault/proof";
import type { CardReading, FrameLike, HeatFieldsConfig } from "@flaconvault/vision";
import { VisionClient, frameFromSource } from "@/vision/client";
import { api, parseTagUrl, sha256Hex, type Preview, type Session, type SimTag } from "@/lib/verify-api";
import { buildRecordScanTx, flaconProgram, type VerifyResponse } from "@/lib/flacon";
import { DEV_SIMULATOR, PROGRAM_ID } from "@/lib/config";
import { gradeLetter, gradeSentence, indicatorText, txUrl, verdictText } from "@/lib/format";
import { GradeMark, Lamp, Pill } from "./badges";
import { WalletButton } from "./wallet-button";

type Step = "session" | "tap" | "preview" | "camera" | "read" | "verify" | "tx" | "done" | "dead";
interface Tag { uid: string; ctr: string; cmac: string; source: "nfc" | "simulator"; serial?: string | null }
const platform = () => (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent) ? "ANDROID_WEB" : typeof navigator !== "undefined" && /iPhone|iPad/i.test(navigator.userAgent) ? "IOS_WEB" : "DESKTOP_WEB");
const nonceCode = (nonce: string) => nonce.replace(/^0x/, "").slice(0, 6).toUpperCase();

function StepHeader({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div>
      <p className="eyebrow">Schritt {n} von 9</p>
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
  const [left, setLeft] = useState(NONCE_TTL_S);
  const [tag, setTag] = useState<Tag | null>(null);
  const [simTags, setSimTags] = useState<SimTag[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [frames, setFrames] = useState<{ img: FrameLike[]; blobs: Blob[]; mediaHash: string } | null>(null);
  const [reading, setReading] = useState<CardReading | null>(null);
  const [fill, setFill] = useState(92);
  const [role, setRole] = useState<number>(Role.OWNER);
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("DE");
  const [verify, setVerify] = useState<VerifyResponse | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nfcState, setNfcState] = useState<string>("");
  const [deadSerial, setDeadSerial] = useState("");
  const cfg = useRef<HeatFieldsConfig | null>(null);
  const vision = useRef<VisionClient | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const tier = frames ? Tier.SELF_MEDIA : Tier.SELF;

  // ---- 1. session -------------------------------------------------------
  const startSession = useCallback(async () => {
    setError(null); setTag(null); setPreview(null); setFrames(null); setReading(null); setVerify(null); setTxSig(null);
    try {
      const s = await api.session();
      setSession(s); setLeft(s.ttl ?? NONCE_TTL_S); setStep("tap");
      if (DEV_SIMULATOR) api.simTags().then(setSimTags).catch(() => setSimTags([]));
    } catch (e) { setError(`Server nicht erreichbar: ${(e as Error).message}`); }
  }, []);
  useEffect(() => {
    vision.current = new VisionClient();
    fetch("/heat_fields.json").then((r) => r.json()).then((c) => { cfg.current = c; });
    return () => { vision.current?.terminate(); stream.current?.getTracks().forEach((t) => t.stop()); };
  }, []);
  useEffect(() => {
    if (!session || step === "done" || step === "dead") return;
    const id = setInterval(() => setLeft(Math.max(0, Math.round(session.expiresAt - Date.now() / 1000))), 500);
    return () => clearInterval(id);
  }, [session, step]);
  const expired = session != null && left <= 0 && step !== "done" && step !== "dead";

  // ---- 2. tap -----------------------------------------------------------
  const onTag = useCallback(async (t: Tag) => {
    setTag(t); setBusy("preview");
    try {
      const p = await api.preview(t.uid, t.ctr, t.cmac);
      setPreview(p);
      setStep(p.verdict === "NO_RESPONSE" ? "dead" : "preview");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }, []);
  const simTap = async (t: SimTag) => {
    setBusy(`tap-${t.uid}`);
    try {
      const r = await api.simTap(t.uid);
      if (!r.responds || !r.url) { setTag({ uid: t.uid, ctr: "", cmac: "", source: "simulator", serial: t.serial }); setDeadSerial(t.serial ?? ""); setStep("dead"); return; }
      const parsed = parseTagUrl(r.url);
      if (!parsed) throw new Error("Simulator-URL unlesbar");
      await onTag({ ...parsed, source: "simulator", serial: t.serial });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const startNfc = async () => {
    const w = window as unknown as { NDEFReader?: new () => { scan: () => Promise<void>; onreading: ((ev: { message: { records: Array<{ recordType: string; data?: DataView; encoding?: string }> } }) => void) | null; onreadingerror: (() => void) | null } };
    if (!w.NDEFReader) { setNfcState("WebNFC nur in Android Chrome. iPhone: Siegel antippen öffnet /t."); return; }
    try {
      const reader = new w.NDEFReader();
      await reader.scan();
      setNfcState("Bereit — Siegel ans Handy halten …");
      reader.onreadingerror = () => setNfcState("Lesefehler — nochmal antippen");
      reader.onreading = (ev) => {
        for (const rec of ev.message.records) {
          if (rec.recordType === "url" && rec.data) {
            const url = new TextDecoder().decode(rec.data);
            const parsed = parseTagUrl(url);
            if (parsed) { setNfcState(`Gelesen: …${parsed.uid.slice(-4)} · Zähler ${parseInt(parsed.ctr, 16)}`); onTag({ ...parsed, source: "nfc" }); return; }
          }
        }
        setNfcState("Kein FlaconVault-Siegel (keine SUN-URL)");
      };
    } catch (e) { setNfcState(`NFC: ${(e as Error).message}`); }
  };

  // ---- 4. camera --------------------------------------------------------
  const startCam = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      stream.current = s;
      if (video.current) { video.current.srcObject = s; await video.current.play(); }
    } catch (e) { setError(`Kamera: ${(e as Error).message}`); }
  };
  const stopCam = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  useEffect(() => { if (step === "camera") startCam(); else stopCam(); return stopCam; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [step]);

  const captureFrames = async () => {
    if (!video.current || !session) return;
    setBusy("capture");
    try {
      const imgs: FrameLike[] = [], blobs: Blob[] = [];
      for (let i = 0; i < 5; i++) {
        const f = frameFromSource(video.current, 1600);
        imgs.push(f);
        const c = document.createElement("canvas"); c.width = f.width; c.height = f.height;
        const ctx = c.getContext("2d")!;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
        // the nonce code is burned into the frame as well, so the photo carries the session
        ctx.font = `bold ${Math.round(f.height / 18)}px sans-serif`; ctx.fillStyle = "rgba(166,101,27,0.95)"; ctx.fillText(nonceCode(session.nonce), 24, Math.round(f.height / 14));
        blobs.push(await new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.9)));
        await new Promise((r) => setTimeout(r, 300));
      }
      const mediaHash = await sha256Hex(await Promise.all(blobs.map((b) => b.arrayBuffer())));
      setFrames({ img: imgs, blobs, mediaHash });
      setStep("read");
      // 5. indicator reading on the captured frames
      setBusy("read");
      let best: CardReading | null = null;
      for (const f of imgs) {
        const r = await vision.current!.read({ data: new Uint8ClampedArray(f.data), width: f.width, height: f.height }, cfg.current!, {});
        if (r.found && (!best || r.confidence.heat + r.confidence.humidity > best.confidence.heat + best.confidence.humidity)) best = r;
        if (!best && !r.found) best = r;
      }
      setReading(best);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const skipCamera = () => { setFrames(null); setReading(null); setStep("read"); };

  // ---- 6–7. bundle + signature -----------------------------------------
  const requestSignature = async () => {
    if (!tag || !session) return;
    setBusy("verify"); setError(null);
    try {
      let mediaHash: string | undefined;
      if (frames) {
        const m = await api.media(frames.blobs);
        if (m.sha256.toLowerCase() !== frames.mediaHash.toLowerCase()) throw new Error("Medien-Hash weicht vom Server ab");
        mediaHash = m.sha256;
      }
      const r = reading && reading.found ? reading : null;
      const body = {
        uid: tag.uid, ctr: tag.ctr, cmac: tag.cmac, nonce: session.nonce, role, tier,
        indicators: { heat: r ? r.heat : Indicator.MISSING, humidity: r ? r.humidity : Indicator.MISSING, uv: Indicator.MISSING },
        heatLevels: r ? r.heatLevels : [0, 0, 0, 0, 0, 0], fill, mediaHash,
        serial: preview?.serial ?? undefined, location: { country: country || null, city: city || null },
        attester: wallet.publicKey?.toBase58() ?? null, platform: tag.source === "simulator" ? "SIMULATOR" : platform(),
      };
      const v = await api.verify(body);
      setVerify(v);
      setStep(v.verdict === "VALID" ? "tx" : "verify");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  // ---- 8. transaction ---------------------------------------------------
  const sendTx = async () => {
    if (!verify || !anchorWallet || !wallet.publicKey) return;
    setBusy("tx"); setError(null);
    try {
      const program = flaconProgram(connection, anchorWallet);
      const { tx } = await buildRecordScanTx(program, wallet.publicKey, verify, { tier, role });
      const sig = await wallet.sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      setTxSig(sig);
      await api.events({ eventId: verify.eventId, txSig: sig, serial: verify.serial, type: 2 });
      setStep("done");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const airdropBurner = async () => {
    if (!wallet.publicKey) return;
    setBusy("airdrop");
    try { const s = await connection.requestAirdrop(wallet.publicKey, 1e9); await connection.confirmTransaction(s, "confirmed"); }
    catch (e) { setError(`Airdrop: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  // ---- dead seal --------------------------------------------------------
  const reportDead = async () => {
    setBusy("dead");
    try {
      const serial = preview?.serial ?? tag?.serial ?? deadSerial;
      if (!serial) throw new Error("Seriennummer des Passes angeben");
      await api.events({ serial, type: 9, actor: wallet.publicKey?.toBase58() ?? null, payload: { source: tag?.source ?? "manual", uid: tag?.uid ?? null, note: "Siegel antwortet nicht" } });
      setDeadSerial(serial);
      setStep("done");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const heatTxt = reading?.found ? indicatorText("heat", reading.heat) : null;
  const humTxt = reading?.found ? indicatorText("humidity", reading.humidity) : null;
  const previewVerdict = preview ? verdictText(preview.verdict, preview.counter) : null;
  const finalGrade = verify?.grade ?? null;
  const stepNo = useMemo(() => ({ session: 1, tap: 2, preview: 3, camera: 4, read: 5, verify: 7, tx: 8, done: 9, dead: 3 })[step], [step]);

  return (
    <div className="page-in container-page py-10">
      {/* countdown */}
      {session && step !== "done" && (
        <div className="mb-6 flex items-center justify-between text-xs text-muted">
          <span>Sitzung <span className="mono text-ink">{nonceCode(session.nonce)}</span></span>
          <span className={`tabular ${left <= 15 ? "text-bad" : ""}`}>{expired ? "abgelaufen" : `${left} s`}</span>
        </div>
      )}
      {expired && (
        <div className="card mb-6 p-4 text-sm">
          <p className="font-medium">Sitzung abgelaufen</p>
          <p className="mt-1 text-muted">Tap bis Transaktion müssen innerhalb von 90 Sekunden liegen. Bitte neu starten.</p>
          <button onClick={startSession} className="btn btn-sm mt-3"><RefreshCw className="h-3.5 w-3.5" aria-hidden /> Neu starten</button>
        </div>
      )}
      {error && <p className="mb-6 rounded-xl border border-bad/40 px-4 py-3 text-sm text-bad">{error}</p>}

      {step === "session" && (
        <div>
          <StepHeader n={1} title="Scan bezeugen" hint="Tap, Foto der Karte, Serversignatur, Transaktion. Alles in einer Sitzung von 90 Sekunden; der Sitzungscode wird ins Foto eingeblendet." />
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button onClick={startSession} className="btn">Sitzung starten <ArrowRight className="h-4 w-4" aria-hidden /></button>
            <WalletButton />
          </div>
          {!PROGRAM_ID && <p className="mt-4 text-xs text-muted">Hinweis: keine Programm-ID gesetzt — die Transaktion (Schritt 8) ist deaktiviert.</p>}
        </div>
      )}

      {step === "tap" && !expired && (
        <div>
          <StepHeader n={2} title="Siegel antippen" hint="Der Chip liefert eine URL mit UID, Zähler und Prüfsumme. Nur der Server kann die Prüfsumme prüfen." />
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div className="card p-4">
              <p className="flex items-center gap-2 text-sm font-medium"><Nfc className="h-4 w-4 text-amber" aria-hidden /> WebNFC (Android Chrome)</p>
              <button onClick={startNfc} className="btn-outline btn-sm mt-3">NFC-Lesen starten</button>
              <p className="mt-2 text-xs text-muted">{nfcState || "iPhone: Siegel antippen öffnet die Tag-Landing /t — das reicht für Tier 0."}</p>
            </div>
            {DEV_SIMULATOR && (
              <div className="card p-4">
                <p className="flex items-center gap-2 text-sm font-medium"><Zap className="h-4 w-4 text-amber" aria-hidden /> Virtuellen Tap einspielen</p>
                <ul className="mt-3 divide-y divide-line">
                  {simTags.map((t) => (
                    <li key={t.uid} className="flex items-center gap-3 py-2 text-sm">
                      <Lamp tone={t.alive ? "ok" : "bad"} />
                      <span className="mono">{t.uid}</span>
                      <span className="flex-1 truncate text-muted">{t.serial ?? "nicht registriert"} · Zähler {t.counter}</span>
                      <button onClick={() => simTap(t)} disabled={busy !== null} className="btn btn-sm">{busy === `tap-${t.uid}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : "Tap"}</button>
                    </li>
                  ))}
                  {simTags.length === 0 && <li className="py-2 text-xs text-muted">Keine virtuellen Tags — im <Link href="/dev" className="link">Simulator</Link> anlegen.</li>}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {step === "preview" && preview && previewVerdict && !expired && (
        <div>
          <StepHeader n={3} title="Verdict-Vorschau" />
          <div className="mt-6 flex items-center gap-3">
            <Lamp tone={previewVerdict.tone} className="h-3.5 w-3.5" />
            <p className={`font-serif text-3xl ${previewVerdict.tone === "ok" ? "text-ok" : previewVerdict.tone === "bad" ? "text-bad" : "text-warn"}`}>{previewVerdict.title}</p>
          </div>
          <p className="mt-2 max-w-lg text-sm text-muted">{previewVerdict.hint}</p>
          {preview.serial && <p className="mt-2 text-sm text-muted">Pass <span className="mono text-ink">{preview.serial}</span> · {preview.sealKind === 0 ? "Packungssiegel" : "Halssiegel"}</p>}
          <div className="mt-6 flex flex-wrap gap-3">
            {preview.verdict === "VALID" && <button onClick={() => setStep("camera")} className="btn"><Camera className="h-4 w-4" aria-hidden /> Weiter zur Kamera</button>}
            {preview.verdict === "VALID" && <button onClick={skipCamera} className="btn-outline">Ohne Foto (Tier 1)</button>}
            {preview.verdict !== "VALID" && <button onClick={startSession} className="btn-outline">Neu starten</button>}
          </div>
        </div>
      )}

      {step === "camera" && !expired && (
        <div>
          <StepHeader n={4} title="Karte fotografieren" hint="Die Fahne mit Marker und Indikatoren in den Rahmen. Fünf Bilder, der Sitzungscode wird eingeblendet und mitfotografiert. Kein Galerie-Upload." />
          <div className="relative mt-6 overflow-hidden rounded-2xl border border-line bg-line">
            <video ref={video} playsInline muted className="block w-full" />
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute left-[10%] top-[18%] h-[64%] w-[80%] rounded-lg border-2 border-amber/80" />
              <div className="absolute left-3 top-3 rounded-md bg-amber px-2 py-1 font-mono text-lg font-bold text-white">{session ? nonceCode(session.nonce) : ""}</div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <button onClick={captureFrames} disabled={busy !== null} className="btn">{busy === "capture" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Camera className="h-4 w-4" aria-hidden />} 5 Bilder aufnehmen</button>
            <button onClick={skipCamera} className="btn-outline">Ohne Foto (Tier 1)</button>
          </div>
        </div>
      )}

      {step === "read" && !expired && (
        <div>
          <StepHeader n={5} title="Indikatoren" hint={frames ? "Gelesen aus den Aufnahmen: Marker → Entzerrung → Weißabgleich → ΔE." : "Ohne Foto: Indikatoren gelten als nicht gelesen (MISSING), Tier 1."} />
          {busy === "read" && <p className="mt-6 flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Karte wird gelesen …</p>}
          {reading && !reading.found && (
            <div className="card mt-6 p-4 text-sm"><p className="font-medium">Karte nicht erkannt</p><p className="mt-1 text-muted">{reading.reason}. Nochmal fotografieren oder ohne Lesung fortfahren (Indikatoren MISSING).</p></div>
          )}
          {reading?.found && heatTxt && humTxt && (
            <div className="mt-6 flex flex-wrap gap-2">
              <Pill tone={heatTxt.tone}>{heatTxt.label}: {heatTxt.detail}</Pill>
              <Pill tone={humTxt.tone}>{humTxt.label}: {humTxt.detail}</Pill>
              <Pill tone="none">Licht: nicht bestückt (Rev D)</Pill>
              {(reading.heat === Indicator.UNREADABLE || reading.humidity === Indicator.UNREADABLE) && <Pill tone="none">Prüfung empfohlen</Pill>}
            </div>
          )}
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="card block p-4 text-sm">
              <span className="font-medium">Füllstand {fill} %</span>
              <input type="range" min={0} max={100} value={fill} onChange={(e) => setFill(+e.target.value)} className="mt-2 w-full" />
              <span className="text-xs text-muted">Demo: Slider. Später aus der Kamera.</span>
            </label>
            <div className="card p-4 text-sm">
              <label className="block">Rolle
                <select value={role} onChange={(e) => setRole(+e.target.value)} className="ml-2 rounded-full border border-line bg-surface px-2 py-0.5 text-sm">
                  <option value={Role.OWNER}>Besitzer</option><option value={Role.SELLER}>Verkäufer</option><option value={Role.BUYER}>Käufer</option>
                </select>
              </label>
              <div className="mt-2 flex gap-2">
                <input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} placeholder="DE" className="w-14 rounded-full border border-line bg-surface px-2 py-0.5 text-sm" aria-label="Land" />
                <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Ort (grob, freiwillig)" className="flex-1 rounded-full border border-line bg-surface px-3 py-0.5 text-sm" aria-label="Ort" />
              </div>
              <p className="mt-1 text-xs text-muted">Ort bleibt off-chain. Kein GPS.</p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <button onClick={requestSignature} disabled={busy !== null} className="btn">{busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Signatur holen <ArrowRight className="h-4 w-4" aria-hidden /></button>
            {frames && <button onClick={() => setStep("camera")} className="btn-outline">Nochmal fotografieren</button>}
          </div>
        </div>
      )}

      {step === "verify" && verify && (
        <div>
          <StepHeader n={7} title={verdictText(verify.verdict, verify.counter).title} hint={verdictText(verify.verdict, verify.counter).hint} />
          <button onClick={startSession} className="btn-outline mt-6">Neu starten</button>
        </div>
      )}

      {step === "tx" && verify && !expired && (
        <div>
          <StepHeader n={8} title="Signiert — jetzt verankern" hint={`Server-Verdict ${verify.verdict} · Zähler ${verify.counter} · Grade ${gradeLetter(verify.grade)} vorab. Die Transaktion enthält die Ed25519-Prüfung der Serversignatur und record_scan.`} />
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {!wallet.connected ? <WalletButton /> : (
              <>
                <button onClick={sendTx} disabled={busy !== null || !PROGRAM_ID} className="btn">{busy === "tx" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Mit {wallet.wallet?.adapter.name} signieren und senden</button>
                {DEV_SIMULATOR && <button onClick={airdropBurner} disabled={busy !== null} className="btn-outline btn-sm">1 SOL Airdrop (Test)</button>}
              </>
            )}
          </div>
          <p className="mono mt-4 break-all text-xs text-muted">msg {verify.msgHex.slice(0, 32)}… · sig {verify.serverSig?.slice(0, 24)}… · key #{verify.keyId}</p>
        </div>
      )}

      {step === "done" && (
        <div>
          <StepHeader n={9} title={txSig ? "Scan verankert" : "Siegel antwortet nicht — gemeldet"} />
          <div className="mt-6 flex items-center gap-5">
            <GradeMark grade={txSig ? finalGrade : Grade.VOID} />
            <div className="text-sm text-muted">
              {txSig && verify && (
                <>
                  <p className="text-ink">Grade {gradeLetter(finalGrade)} · Zähler {verify.counter}</p>
                  {gradeSentence(finalGrade ?? 0) && <p className="mt-1">{gradeSentence(finalGrade ?? 0)}</p>}
                  <a href={txUrl(txSig)} target="_blank" rel="noreferrer" className="link mt-1 block">Transaktion im Explorer</a>
                </>
              )}
              {!txSig && <p>Grade-Vorschau VOID · Event SEAL_DEAD gemeldet. Ohne gültigen Scan keine Freigabe.</p>}
            </div>
          </div>
          {reading?.found && heatTxt && humTxt && (
            <div className="mt-6 flex flex-wrap gap-2"><Pill tone={heatTxt.tone}>{heatTxt.label}: {heatTxt.detail}</Pill><Pill tone={humTxt.tone}>{humTxt.label}: {humTxt.detail}</Pill></div>
          )}
          <div className="mt-8 flex flex-wrap gap-3">
            {(verify?.serial ?? deadSerial) && <Link href={`/p/${verify?.serial ?? deadSerial}`} className="btn">Pass ansehen <ArrowRight className="h-4 w-4" aria-hidden /></Link>}
            <button onClick={startSession} className="btn-outline">Neuer Scan</button>
          </div>
        </div>
      )}

      {step === "dead" && (
        <div>
          <StepHeader n={3} title="Kein Siegel gefunden" hint="Siegel beschädigt, entfernt oder nicht in Reichweite. Ein Foto der Stelle dokumentiert es; der Pass bekommt Event SEAL_DEAD und Grade-Vorschau VOID." />
          <div className="mt-6 flex items-center gap-3 text-bad"><ShieldOff className="h-5 w-5" aria-hidden /><span className="font-serif text-2xl">Siegel antwortet nicht</span></div>
          {!(preview?.serial ?? tag?.serial) && (
            <label className="mt-4 block text-sm">Pass-Seriennummer <input value={deadSerial} onChange={(e) => setDeadSerial(e.target.value)} placeholder="SN-2026-000001" className="ml-2 rounded-full border border-line bg-surface px-3 py-0.5 font-mono text-sm" /></label>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <button onClick={reportDead} disabled={busy !== null} className="btn">{busy === "dead" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Melden (SEAL_DEAD)</button>
            <button onClick={startSession} className="btn-outline">Abbrechen</button>
          </div>
        </div>
      )}
      <p className="mt-10 text-xs text-muted">Schritt {stepNo} · Tier {tier} · Wallet {wallet.publicKey ? `${wallet.publicKey.toBase58().slice(0, 4)}…` : "nicht verbunden"}</p>
    </div>
  );
}
