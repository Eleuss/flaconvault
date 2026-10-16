"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, RotateCcw, Skull, Sparkles, Zap } from "lucide-react";
import { PUBLIC_VERIFY_URL } from "@/lib/config";
import type { PassportListItem } from "@/lib/api";
import { demoMode, setDemoMode } from "@/lib/demo";
import { passportHref } from "@/lib/format";
import { Lamp } from "./badges";

/**
 * Demo mode switch for this browser: /dev?demo=1 on, /dev?demo=0 off (lib/demo.ts). On localhost demo mode is
 * always on. The query parameter is applied once and then removed from the address bar.
 */
export function DemoSwitch() {
  const [on, setOn] = useState<boolean | null>(null);
  const [local, setLocal] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("demo");
    if (q === "1" || q === "0") {
      setDemoMode(q === "1");
      window.history.replaceState(null, "", window.location.pathname);
    }
    setLocal(/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname));
    setOn(demoMode());
  }, []);
  if (on === null) return null;
  if (local) return <p className="mt-6 text-sm text-muted">Demo mode is always on for localhost.</p>;
  return (
    <div className="card mt-6 p-4 text-sm">
      <p className="font-medium">Demo mode {on ? "on" : "off"} in this browser</p>
      <p className="mt-1 text-muted">
        Demo mode shows the dev wallets (keys in plain text in this browser, signing without a prompt), the burner wallet,
        airdrop buttons, test images and virtual taps. Never use these wallets for anything of value.
      </p>
      {/* full page loads: the wallet list is built once per page load */}
      <a href={on ? "/dev?demo=0" : "/dev?demo=1"} className="btn-outline btn-sm mt-3">{on ? "Switch demo mode off" : "Switch demo mode on"}</a>
    </div>
  );
}

interface SimTag { uid: string; serial: string | null; kind: number | null; counter: number; alive: boolean; lastUrl?: string | null }
interface TapResult { responds: boolean; uid: string; ctr?: number; ctrHex?: string; cmac?: string; url: string | null; tapId?: number }
interface Health { ok: boolean; keyId: number; pubkeyHex: string; simulator: boolean; programId: string | null }

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${PUBLIC_VERIFY_URL}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export function DevConsole() {
  const [health, setHealth] = useState<Health | null | undefined>(undefined);
  const [tags, setTags] = useState<SimTag[]>([]);
  const [passports, setPassports] = useState<PassportListItem[]>([]);
  const [serial, setSerial] = useState<string>("");
  const [kind, setKind] = useState<number>(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ t: number; text: string; url?: string | null; tone: "ok" | "bad" | "none" }>>([]);
  const [error, setError] = useState<string | null>(null);

  const push = (text: string, tone: "ok" | "bad" | "none" = "none", url?: string | null) => setLog((l) => [{ t: Date.now(), text, url, tone }, ...l].slice(0, 30));

  const refresh = useCallback(async () => {
    let h: Health;
    try { h = await api<Health>("/health"); } catch (e) { setHealth(null); setError((e as Error).message); return; }
    setHealth(h);
    if (!h.simulator) return; // /api/dev/* only exists with FV_DEV_SIMULATOR=true
    try {
      const [t, p] = await Promise.all([api<SimTag[]>("/api/dev/tags"), api<PassportListItem[]>("/api/passports")]);
      setTags(t); setPassports(p); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try { await fn(); } catch (e) { push(`Error: ${(e as Error).message}`, "bad"); } finally { setBusy(null); await refresh(); }
  }
  const createTag = () => run("create", async () => {
    const t = await api<SimTag>("/api/dev/tag", { serial: serial || undefined, kind });
    push(`Tag ${t.uid} created${t.serial ? ` · seal on ${t.serial}` : " · unregistered"}`, "ok");
  });
  const tap = (uid: string) => run(`tap-${uid}`, async () => {
    const r = await api<TapResult>("/api/dev/tap", { uid });
    if (r.responds) push(`Tap ${uid} · counter ${r.ctr} · CMAC ${r.cmac}`, "ok", r.url);
    else push(`Tap ${uid} · seal not responding`, "bad", r.url);
  });
  const kill = (uid: string) => run(`kill-${uid}`, async () => { await api("/api/dev/kill", { uid }); push(`Antenna of ${uid} separated`, "bad"); });
  const revive = (uid: string) => run(`revive-${uid}`, async () => { await api("/api/dev/revive", { uid }); push(`${uid} responds again`, "ok"); });
  const reset = () => run("reset", async () => { await api("/api/dev/reset", {}); setLog([]); push("Database reset and re-seeded", "none"); });

  if (health === undefined) return <p className="mt-8 flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Connecting to {PUBLIC_VERIFY_URL} …</p>;
  if (health === null) return (
    <div className="card mt-8 p-5 text-sm">
      <p className="font-medium text-bad">Verification server unreachable</p>
      <p className="mt-1 text-muted">{PUBLIC_VERIFY_URL} — start it with <code className="mono">cd apps/verify && uv run uvicorn fv.main:app --port 8787</code>{error ? ` (${error})` : ""}</p>
      <button onClick={refresh} className="btn-outline btn-sm mt-3">Try again</button>
    </div>
  );
  if (!health.simulator) return (
    <div className="card mt-8 p-5 text-sm">
      <p className="font-medium">Simulator disabled on this server</p>
      <p className="mt-1 text-muted">The verification server at {PUBLIC_VERIFY_URL} is running with FV_DEV_SIMULATOR off, so it accepts only real seals. Virtual seals are available on a local verifier.</p>
    </div>
  );

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_380px]">
      <div>
        <div className="card p-4">
          <p className="text-sm font-medium">New virtual seal</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select value={serial} onChange={(e) => setSerial(e.target.value)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
              <option value="">— unregistered —</option>
              {passports.map((p) => <option key={p.serial} value={p.serial}>{p.serial} · {p.brand} {p.name}</option>)}
            </select>
            <select value={kind} onChange={(e) => setKind(Number(e.target.value))} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
              <option value={1}>Neck</option><option value={0}>Box</option>
            </select>
            <button onClick={createTag} disabled={busy !== null} className="btn btn-sm"><Plus className="h-3.5 w-3.5" aria-hidden /> Create</button>
          </div>
        </div>

        <ul className="mt-6 divide-y divide-line border-y border-line">
          {tags.map((t) => (
            <li key={t.uid} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <Lamp tone={t.alive ? "ok" : "bad"} />
              <span className="mono w-32">{t.uid}</span>
              <span className="min-w-0 flex-1 text-sm text-muted">
                {t.serial ? <Link href={passportHref(t.serial)} className="link text-ink">{t.serial}</Link> : "unregistered"}
                {t.kind != null && <> · {t.kind === 0 ? "Box" : "Neck"}</>} · counter <span className="tabular">{t.counter}</span>
              </span>
              <span className="flex gap-1.5">
                <button onClick={() => tap(t.uid)} disabled={busy !== null} className="btn btn-sm"><Zap className="h-3.5 w-3.5" aria-hidden /> Tap</button>
                {t.alive
                  ? <button onClick={() => kill(t.uid)} disabled={busy !== null} className="btn-outline btn-sm" title="Antenna tears = mechanical tamper"><Skull className="h-3.5 w-3.5" aria-hidden /> Kill</button>
                  : <button onClick={() => revive(t.uid)} disabled={busy !== null} className="btn-outline btn-sm"><Sparkles className="h-3.5 w-3.5" aria-hidden /> Revive</button>}
              </span>
            </li>
          ))}
          {tags.length === 0 && <li className="py-6 text-sm text-muted">No virtual tags yet.</li>}
        </ul>
        <div className="mt-4 flex items-center justify-between text-xs text-muted">
          <span>Server-Key #{health.keyId} · <span className="mono">{health.pubkeyHex.slice(0, 16)}…</span> · program {health.programId ? <span className="mono">{health.programId.slice(0, 8)}…</span> : "not set"}</span>
          <button onClick={reset} disabled={busy !== null} className="btn-outline btn-sm"><RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset + Seed</button>
        </div>
      </div>

      <aside>
        <p className="eyebrow">Recent taps</p>
        <ol className="mt-3 space-y-3">
          {log.length === 0 && <li className="text-sm text-muted">A tap creates a SUN URL here. “Open in /t” calls it the way a phone would.</li>}
          {log.map((l) => (
            <li key={l.t} className="card p-3 text-xs">
              <div className="flex items-center gap-2"><Lamp tone={l.tone} /><span className="break-all">{l.text}</span></div>
              {l.url && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <a href={l.url} className="btn btn-sm">Open in /t</a>
                  <span className="mono break-all text-muted">{l.url.replace(/^https?:\/\/[^/]+/, "")}</span>
                </div>
              )}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
