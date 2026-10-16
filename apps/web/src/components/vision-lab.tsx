"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, FlaskConical, Loader2, Repeat, Upload } from "lucide-react";
import { Indicator, HEAT_FIELDS_C } from "@flaconvault/proof";
import { combineReadings, type CardReading, type FrameLike, type HeatFieldsConfig } from "@flaconvault/vision";
import { VisionClient, frameFromSource } from "@/vision/client";
import { indicatorText } from "@/lib/format";
import { Lamp, Pill } from "./badges";

const TINTS: Record<string, [number, number, number]> = { neutral: [1, 1, 1], warm: [1.06, 1.0, 0.82], cold: [0.9, 0.97, 1.08], yellow: [1.1, 1.02, 0.85] };
const toneOf = (code: number) => (code === Indicator.INTACT ? "ok" : code === Indicator.TRIGGERED ? "warn" : "none");

export function VisionLab() {
  const client = useRef<VisionClient | null>(null);
  const [cfg, setCfg] = useState<HeatFieldsConfig | null>(null);
  const [status, setStatus] = useState("Loading OpenCV …");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<CardReading | null>(null);
  const [series, setSeries] = useState<CardReading[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const inputCanvas = useRef<HTMLCanvasElement>(null);
  const warpCanvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [synth, setSynth] = useState({ decisive: true, lowFields: 1, humidity: false, tilt: 0.08, rot: -6, tint: "warm", brightness: -20, blur: 1.0, noise: 5, seed: 7 });

  useEffect(() => {
    const c = new VisionClient();
    client.current = c;
    fetch("/heat_fields.json").then((r) => r.json()).then(setCfg).catch((e) => setStatus(`heat_fields.json missing: ${e.message}`));
    c.ping().then((p) => setStatus(`OpenCV loaded in ${Math.round(p.loadMs)} ms · ArUco ${p.hasAruco ? "available" : "MISSING"}`)).catch((e) => setStatus(`OpenCV error: ${e.message}`));
    return () => { c.terminate(); stream.current?.getTracks().forEach((t) => t.stop()); };
  }, []);

  const drawFrame = (canvas: HTMLCanvasElement | null, f: FrameLike, maxW: number) => {
    if (!canvas) return;
    const k = Math.min(1, maxW / f.width);
    canvas.width = Math.round(f.width * k); canvas.height = Math.round(f.height * k);
    const tmp = document.createElement("canvas"); tmp.width = f.width; tmp.height = f.height;
    tmp.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
    canvas.getContext("2d")!.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  };

  const drawWarped = useCallback((r: CardReading) => {
    const canvas = warpCanvas.current;
    if (!canvas || !r.warped || !cfg) return;
    canvas.width = r.warped.width; canvas.height = r.warped.height;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(r.warped.data), r.warped.width, r.warped.height), 0, 0);
    const S = cfg.px_per_mm;
    ctx.lineWidth = 2; ctx.font = "11px sans-serif";
    // frame mode (the real card in its holder) reads its own layout (cfg.frame); marker mode the printed test card
    const frame = r.quality.mode === "frame" && cfg.frame ? cfg.frame : null;
    (frame ? frame.fields : cfg.fields).forEach((f, i) => {
      const fr = r.heatFields[i];
      ctx.strokeStyle = fr?.level === 1 ? "#b7791f" : "#2f7a4f";
      if (fr && fr.confidence < 0.85) ctx.strokeStyle = "#b3261e";
      ctx.strokeRect(f.roi_mm.x * S, f.roi_mm.y * S, f.roi_mm.w * S, f.roi_mm.h * S);
      ctx.fillStyle = ctx.strokeStyle; ctx.fillText(`${f.temp_c}°`, f.roi_mm.x * S, f.roi_mm.y * S - 3);
    });
    const hm = frame ? frame.humidity_mm : cfg.humidity_mm;
    ctx.strokeStyle = r.humidity === 1 ? "#b7791f" : r.humidity === 0 ? "#2f7a4f" : "#b3261e";
    ctx.beginPath(); ctx.arc(hm.cx * S, hm.cy * S, hm.roi_r * S, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#8a938c"; ctx.setLineDash([4, 3]);
    if (frame) {
      ctx.strokeRect(frame.uv_mm.x * S, frame.uv_mm.y * S, frame.uv_mm.w * S, frame.uv_mm.h * S);
      ctx.strokeRect(frame.white_ref_mm.x * S, frame.white_ref_mm.y * S, frame.white_ref_mm.w * S, frame.white_ref_mm.h * S);
      const b = frame.black_ref;
      ctx.beginPath(); ctx.arc(b.cx * S, b.cy * S, b.r0 * S, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(b.cx * S, b.cy * S, b.r1 * S, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.strokeRect(cfg.aruco.x * S, cfg.aruco.y * S, cfg.aruco.size * S, cfg.aruco.size * S);
      ctx.strokeRect(cfg.qr.x * S, cfg.qr.y * S, cfg.qr.size * S, cfg.qr.size * S);
    }
    ctx.setLineDash([]);
  }, [cfg]);

  const analyze = useCallback(async (frame: FrameLike) => {
    if (!client.current || !cfg) return null;
    setBusy(true);
    try {
      drawFrame(inputCanvas.current, frame, 640);
      const r = await client.current.read(frame, cfg, { preview: true, debug: true });
      setReading(r); drawWarped(r);
      return r;
    } catch (e) { setStatus(`Error: ${(e as Error).message}`); return null; }
    finally { setBusy(false); }
  }, [cfg, drawWarped]);

  const runSynth = async () => {
    if (!client.current || !cfg) return;
    setBusy(true);
    try {
      const heatLevels = [0, 0, 0, 0, 0, 0].map((_, i) => (i < synth.lowFields ? 1 : 0));
      if (synth.decisive) for (let i = 0; i <= 4; i++) heatLevels[i] = 1;
      const frame = await client.current.synth(cfg, {
        heatLevels, humidityTriggered: synth.humidity, tilt: synth.tilt, rot: synth.rot, tint: TINTS[synth.tint] ?? TINTS.neutral,
        brightness: synth.brightness, blurSigma: synth.blur, noiseSigma: synth.noise, width: 1280, height: 720, cardPx: 780, seed: synth.seed,
      });
      await analyze(frame);
    } finally { setBusy(false); }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const bmp = await createImageBitmap(file);
    await analyze(frameFromSource(bmp, 1600));
    bmp.close();
  };

  const startCam = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      stream.current = s;
      if (video.current) { video.current.srcObject = s; await video.current.play(); }
      setCamOn(true);
    } catch (e) { setStatus(`Camera: ${(e as Error).message}`); }
  };
  const stopCam = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setCamOn(false); };
  const capture = async () => { if (video.current) await analyze(frameFromSource(video.current, 1600)); };
  const runSeries = async () => {
    if (!video.current) return;
    const out: CardReading[] = [];
    setSeries([]);
    for (let i = 0; i < 10; i++) {
      const r = await analyze(frameFromSource(video.current, 1600));
      if (r) out.push(r);
      setSeries([...out]);
      await new Promise((res) => setTimeout(res, 350));
    }
  };

  const heat = reading ? indicatorText("heat", reading.heat) : null;
  const hum = reading ? indicatorText("humidity", reading.humidity) : null;
  // the series combined as the scan page combines its five frames (majority of all captures, same helper)
  const combined = series.length ? combineReadings(series) : null;

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[380px_1fr]">
      <div className="space-y-6">
        <p className="text-xs text-muted">{status}</p>

        <section className="card p-4">
          <p className="flex items-center gap-2 text-sm font-medium"><FlaskConical className="h-4 w-4 text-amber" aria-hidden /> Test image (no hardware)</p>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <label className="flex items-center gap-2"><input type="checkbox" checked={synth.decisive} onChange={(e) => setSynth({ ...synth, decisive: e.target.checked })} /> 40 °C triggered</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={synth.humidity} onChange={(e) => setSynth({ ...synth, humidity: e.target.checked })} /> Humidity pink</label>
            <label>lower fields black <input type="range" min={0} max={4} value={synth.lowFields} onChange={(e) => setSynth({ ...synth, lowFields: +e.target.value })} className="w-full" /></label>
            <label>Tilt {synth.tilt.toFixed(2)} <input type="range" min={0} max={0.2} step={0.01} value={synth.tilt} onChange={(e) => setSynth({ ...synth, tilt: +e.target.value })} className="w-full" /></label>
            <label>Rotation {synth.rot}° <input type="range" min={-25} max={25} value={synth.rot} onChange={(e) => setSynth({ ...synth, rot: +e.target.value })} className="w-full" /></label>
            <label>Brightness {synth.brightness} <input type="range" min={-80} max={40} value={synth.brightness} onChange={(e) => setSynth({ ...synth, brightness: +e.target.value })} className="w-full" /></label>
            <label>Blur {synth.blur} <input type="range" min={0} max={3} step={0.2} value={synth.blur} onChange={(e) => setSynth({ ...synth, blur: +e.target.value })} className="w-full" /></label>
            <label>Noise {synth.noise} <input type="range" min={0} max={16} value={synth.noise} onChange={(e) => setSynth({ ...synth, noise: +e.target.value })} className="w-full" /></label>
            <label className="col-span-2">Lighting
              <select value={synth.tint} onChange={(e) => setSynth({ ...synth, tint: e.target.value })} className="ml-2 rounded-full border border-line bg-surface px-2 py-0.5">
                {Object.keys(TINTS).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
          </div>
          <button onClick={runSynth} disabled={busy || !cfg} className="btn btn-sm mt-3">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <FlaskConical className="h-3.5 w-3.5" aria-hidden />} Generate and read test image</button>
        </section>

        <section className="card p-4">
          <p className="flex items-center gap-2 text-sm font-medium"><Upload className="h-4 w-4 text-amber" aria-hidden /> Photo of the card</p>
          <input type="file" accept="image/*" capture="environment" onChange={(e) => onFile(e.target.files?.[0])} className="mt-3 block w-full text-xs text-muted file:mr-3 file:rounded-full file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-xs file:text-ink" />
          <p className="mt-2 text-xs text-muted">Photograph the card in its holder, flat and from above. To test a trigger with a printed card (<code className="mono">docs/card/Einlegekarte_RevC.pdf</code>, 100 %), black out a field with a marker or colour the humidity dot pink.</p>
        </section>

        <section className="card p-4">
          <p className="flex items-center gap-2 text-sm font-medium"><Camera className="h-4 w-4 text-amber" aria-hidden /> Live camera</p>
          <video ref={video} playsInline muted className={`mt-3 w-full rounded-lg bg-line ${camOn ? "" : "hidden"}`} />
          <div className="mt-3 flex flex-wrap gap-2">
            {!camOn ? <button onClick={startCam} className="btn-outline btn-sm">Start camera</button> : (
              <>
                <button onClick={capture} disabled={busy} className="btn btn-sm">Capture</button>
                <button onClick={runSeries} disabled={busy} className="btn-outline btn-sm"><Repeat className="h-3.5 w-3.5" aria-hidden /> 10× series</button>
                <button onClick={stopCam} className="btn-outline btn-sm">Stop</button>
              </>
            )}
          </div>
          {combined?.votes && (
            <p className="mt-3 text-xs">
              <span className="font-medium">{`Combined: heat ${indicatorText("heat", combined.heat).detail ?? "not read"} (${combined.votes.heat} of ${combined.votes.frames} agree) · humidity ${indicatorText("humidity", combined.humidity).detail ?? "not read"} (${combined.votes.humidity} of ${combined.votes.frames})`}</span>
              <span className="block text-muted">{`${combined.votes.found} of ${combined.votes.frames} captures voted · per capture: heat ${series.map((r) => r.heat).join("")} · humidity ${series.map((r) => r.humidity).join("")}${combined.reason ? ` · ${combined.reason}` : ""}`}</span>
            </p>
          )}
        </section>
      </div>

      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div><p className="eyebrow">Input</p><canvas ref={inputCanvas} className="mt-2 w-full rounded-lg border border-line bg-line" /></div>
          <div><p className="eyebrow">Rectified card 660 × 340</p><canvas ref={warpCanvas} className="mt-2 w-full rounded-lg border border-line bg-line" /></div>
        </div>

        {reading && !reading.found && (
          <div className="card p-4"><p className="font-medium text-bad">Card not detected</p><p className="mt-1 text-sm text-muted">{reading.reason} · all indicators MISSING · {Math.round(reading.ms)} ms</p></div>
        )}
        {reading && reading.found && heat && hum && (
          <div className="card p-4">
            <div className="flex flex-wrap gap-2">
              <Pill tone={heat.tone}>{heat.label}: {heat.detail}</Pill>
              <Pill tone={hum.tone}>{hum.label}: {hum.detail}</Pill>
              <Pill tone="none">Light: {reading?.found && reading.uv !== 3 ? indicatorText("uv", reading.uv).detail : "not fitted"}</Pill>
            </div>
            {reading.reason && <p className="mt-2 text-xs text-muted">{reading.reason}</p>}
            <div className="mt-4 grid grid-cols-6 gap-2">
              {HEAT_FIELDS_C.map((c, i) => {
                const f = reading.heatFields[i];
                return (
                  <div key={c} className={`rounded-lg border px-2 py-2 text-center text-xs tabular ${i === 4 ? "border-amber" : "border-line"} ${f?.level === 1 ? "bg-ink text-bg" : "bg-surface text-muted"}`}>
                    <div>{c} °C</div>
                    <div className="mt-1 opacity-70">{f ? `${Math.round(f.confidence * 100)} %` : "–"}</div>
                  </div>
                );
              })}
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-4">
              <div><dt>heatLevels</dt><dd className="mono text-ink">[{reading.heatLevels.join(",")}]</dd></div>
              <div><dt>Confidence heat / humidity</dt><dd className="tabular text-ink">{reading.confidence.heat.toFixed(3)} / {reading.confidence.humidity.toFixed(3)}</dd></div>
              <div><dt>Marker / QR / anchors</dt><dd className="text-ink">{Math.round(reading.quality.markerPx)} px · {reading.quality.qrUsed ? "QR" : "no QR"} · {reading.quality.anchors.length}</dd></div>
              <div><dt>White balance L* grey/white</dt><dd className="tabular text-ink">{reading.quality.groups.heat.greyL.toFixed(0)}/{reading.quality.groups.heat.whiteL.toFixed(0)} · {reading.quality.groups.hum.greyL.toFixed(0)}/{reading.quality.groups.hum.whiteL.toFixed(0)}</dd></div>
              <div><dt>Humidity ΔE intact / triggered</dt><dd className="tabular text-ink">{reading.humidityField ? `${reading.humidityField.dIntact.toFixed(1)} / ${reading.humidityField.dTriggered.toFixed(1)}` : "–"}</dd></div>
              <div><dt>Duration</dt><dd className="tabular text-ink">{Math.round(reading.ms)} ms</dd></div>
              <div className="col-span-2"><dt>Anchors</dt><dd className="text-ink">{reading.quality.anchors.join(", ") || "–"}</dd></div>
            </dl>
            <div className="mt-3 flex items-center gap-3 text-xs">
              <Lamp tone={toneOf(reading.heat)} /><span>heat = heatLevels[4]</span>
              <button onClick={() => setShowDebug(!showDebug)} className="link text-muted">{showDebug ? "Hide debug" : "Show debug"}</button>
            </div>
            {showDebug && reading.debug && <pre className="mono mt-3 max-h-64 overflow-auto rounded-lg border border-line bg-bg p-3 text-[11px] text-muted">{reading.debug.join("\n")}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}
