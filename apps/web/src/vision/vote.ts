/**
 * Combining the five captured frames into the one reading that is signed. Each indicator is decided by a majority of
 * ALL captured frames (3 of 5): a frame where the card was not found, or (frame mode) where the heat label did not
 * anchor the strip, does not vote. Without a majority the indicator is UNREADABLE, never the single most "confident"
 * frame — confidences saturate near 1.0, so that pick would be noise (one specular highlight could decide it).
 */
import { Indicator } from "@flaconvault/proof";
import type { CardReading } from "@flaconvault/vision";

/** true when this frame takes part in the vote. */
export function frameCounts(r: CardReading): boolean {
  if (!r.found) return false;
  return r.quality?.mode !== "frame" || (r.quality.anchors ?? []).includes("heat-label");
}

/** The value at least `quorum` voters agree on, else UNREADABLE. */
export function majority(values: number[], quorum: number): number {
  const tally = new Map<number, number>();
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
  let winner: number = Indicator.UNREADABLE;
  tally.forEach((n, v) => { if (n >= quorum) winner = v; });
  return winner;
}

const decided = (code: number) => code === Indicator.INTACT || code === Indicator.TRIGGERED;

/**
 * One reading from several frames. `total` is the number of frames captured (the quorum is a majority of it).
 * heatLevels are only sent for a decided heat indicator (INTACT/TRIGGERED), with the decisive 40 °C field equal to
 * it; otherwise all six are 0, so an unreadable strip never draws a "triggered" field on the passport.
 */
export function combineReadings(readings: CardReading[], total = readings.length): CardReading | null {
  if (readings.length === 0) return null;
  const voters = readings.filter(frameCounts);
  if (voters.length === 0) {
    const notFound = readings.find((r) => !r.found);
    return notFound ?? { ...readings[0], found: false, reason: "The heat label was not recognized in any frame" };
  }
  const quorum = Math.floor(Math.max(total, voters.length) / 2) + 1;
  const heat = majority(voters.map((r) => r.heat), quorum);
  const humidity = majority(voters.map((r) => r.humidity), quorum);
  const uv = majority(voters.map((r) => r.uv), quorum);

  let heatLevels = [0, 0, 0, 0, 0, 0];
  if (decided(heat)) {
    const agree = voters.filter((r) => r.heat === heat);
    heatLevels = heatLevels.map((_, i) => (agree.filter((r) => r.heatLevels[i] === 1).length * 2 > agree.length ? 1 : 0));
    heatLevels[4] = heat === Indicator.TRIGGERED ? 1 : 0;
  }
  const share = (pick: (r: CardReading) => number, value: number, conf: (r: CardReading) => number) => {
    const agree = voters.filter((r) => pick(r) === value);
    return agree.length ? (agree.reduce((a, r) => a + conf(r), 0) / agree.length) * (agree.length / Math.max(total, voters.length)) : 0;
  };
  // the frame shown/kept as the representative one: agrees on heat, most confident among those
  const pool = voters.filter((r) => r.heat === heat);
  const rep = (pool.length ? pool : voters).reduce((a, b) => (b.confidence.heat + b.confidence.humidity > a.confidence.heat + a.confidence.humidity ? b : a));
  return {
    ...rep,
    reason: undefined,
    heat, humidity, uv, heatLevels,
    confidence: {
      heat: decided(heat) ? share((r) => r.heat, heat, (r) => r.confidence.heat) : 0,
      humidity: decided(humidity) ? share((r) => r.humidity, humidity, (r) => r.confidence.humidity) : 0,
    },
  };
}
