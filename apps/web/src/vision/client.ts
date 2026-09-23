import type { CardReading, FrameLike, HeatFieldsConfig } from "@flaconvault/vision";
import type { SynthRequest, WorkerRequest, WorkerResponse } from "./worker";

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** Promise wrapper around the vision worker. One worker per client; OpenCV loads lazily on first use (~13 MB). */
export class VisionClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url));
      this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        if (ev.data.ok) p.resolve(ev.data.result); else p.reject(new Error(ev.data.error));
      };
      this.worker.onerror = (e) => { this.pending.forEach((p) => p.reject(new Error(e.message))); this.pending.clear(); };
    }
    return this.worker;
  }
  private call<T>(msg: DistributiveOmit<WorkerRequest, "id">, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ensure().postMessage({ ...msg, id }, transfer);
    });
  }
  ping() { return this.call<{ loadMs: number; hasAruco: boolean }>({ type: "ping" }); }
  read(frame: FrameLike, cfg: HeatFieldsConfig, opts: { preview?: boolean; debug?: boolean } = {}) {
    return this.call<CardReading>({ type: "read", frame, cfg, ...opts }, [frame.data.buffer as ArrayBuffer]);
  }
  synth(cfg: HeatFieldsConfig, req: SynthRequest) { return this.call<FrameLike>({ type: "synth", cfg, req }); }
  terminate() { this.worker?.terminate(); this.worker = null; this.pending.clear(); }
}

/** Draw an ImageBitmap/video frame into an RGBA frame, downscaled so the long edge is ≤ maxEdge. */
export function frameFromSource(src: CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number }, maxEdge = 1600): FrameLike {
  const w = src.videoWidth ?? src.width ?? 0, h = src.videoHeight ?? src.height ?? 0;
  const k = Math.min(1, maxEdge / Math.max(w, h));
  const cw = Math.round(w * k), ch = Math.round(h * k);
  const canvas = document.createElement("canvas");
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, cw, ch);
  const img = ctx.getImageData(0, 0, cw, ch);
  return { data: img.data, width: cw, height: ch };
}
