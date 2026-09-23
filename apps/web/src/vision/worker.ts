/// <reference lib="webworker" />
// Classic worker (importScripts) — OpenCV.js is served from /vendor/opencv.js, not bundled.
import { readCard, renderCard, renderScene, tiltedQuad, type CardReading, type FrameLike, type HeatFieldsConfig } from "@flaconvault/vision";

declare const self: DedicatedWorkerGlobalScope & { cv?: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cvPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadCv(): Promise<any> {
  if (!cvPromise) {
    cvPromise = new Promise((resolve, reject) => {
      try {
        self.importScripts("/vendor/opencv.js");
        Promise.resolve(self.cv).then(resolve, reject);
      } catch (e) { reject(e); }
    });
  }
  return cvPromise;
}

export interface SynthRequest { heatLevels: number[]; humidityTriggered: boolean; tilt: number; rot: number; tint: [number, number, number]; brightness: number; blurSigma: number; noiseSigma: number; width: number; height: number; cardPx: number; seed: number }
export type WorkerRequest =
  | { id: number; type: "ping" }
  | { id: number; type: "read"; frame: FrameLike; cfg: HeatFieldsConfig; preview?: boolean; debug?: boolean }
  | { id: number; type: "synth"; cfg: HeatFieldsConfig; req: SynthRequest };
export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    const t0 = performance.now();
    const cv = await loadCv();
    const loadMs = performance.now() - t0;
    if (msg.type === "ping") {
      self.postMessage({ id: msg.id, ok: true, result: { loadMs, hasAruco: typeof cv.aruco_ArucoDetector === "function" } } satisfies WorkerResponse);
    } else if (msg.type === "read") {
      const r: CardReading = readCard(cv, msg.frame, msg.cfg, { preview: msg.preview, debug: msg.debug });
      const transfer = r.warped ? [r.warped.data.buffer] : [];
      self.postMessage({ id: msg.id, ok: true, result: r } satisfies WorkerResponse, transfer as Transferable[]);
    } else if (msg.type === "synth") {
      const q = msg.req;
      const card = renderCard(cv, msg.cfg, { heatLevels: q.heatLevels, humidityTriggered: q.humidityTriggered });
      const frame = renderScene(cv, card, { width: q.width, height: q.height, quad: tiltedQuad(q.width, q.height, q.cardPx, q.tilt, q.rot), tint: q.tint, brightness: q.brightness, blurSigma: q.blurSigma, noiseSigma: q.noiseSigma, seed: q.seed });
      card.delete();
      self.postMessage({ id: msg.id, ok: true, result: frame } satisfies WorkerResponse, [frame.data.buffer as ArrayBuffer]);
    }
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: e instanceof Error ? `${e.message}` : String(e) } satisfies WorkerResponse);
  }
};
