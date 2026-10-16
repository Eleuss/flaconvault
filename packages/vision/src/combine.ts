import { Indicator } from "@flaconvault/proof";
import { isDecided, notFoundReading } from "./pipeline.ts";
import type { CardReading } from "./types.ts";

/** The value that more than half of the votes agree on, else UNREADABLE (a tie or a split never decides). */
function majority(votes: number[]): number {
  const counts = new Map<number, number>();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const [v, n] of counts) if (n * 2 > votes.length) return v;
  return Indicator.UNREADABLE;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Combine the readings of several frames of the same card into one. Per indicator (heat, humidity, UV) the verdict is
 * the one that a strict majority of the frames with a found card agree on, else UNREADABLE, so a tie is UNREADABLE.
 * A single frame with a specular highlight therefore cannot flip a triggered field to INTACT, and frames that disagree
 * are never settled by picking the "most confident" one (classifier confidences saturate near 1).
 *
 * - heatLevels: per-field majority over the frames that agree on a decided heat verdict (a tie keeps the
 *   representative frame's level); all zero unless heat is INTACT or TRIGGERED, so heatLevels[decisive] equals heat.
 * - confidence: share of agreeing frames × their mean confidence.
 * - Everything else (fields, quality, homography, preview) comes from a representative frame: the one that agrees
 *   with the most combined verdicts (heat first), then the most confident one.
 * - No frame with a card: the first reading is returned (its reason says why); no readings at all: not found.
 */
export function combineReadings(readings: CardReading[]): CardReading {
  const ms = readings.reduce((a, r) => a + r.ms, 0);
  const found = readings.filter((r) => r.found);
  const noVotes = { frames: readings.length, found: 0, heat: 0, humidity: 0, uv: 0 };
  if (readings.length === 0) return { ...notFoundReading("No frames to read"), votes: noVotes };
  if (found.length === 0) return { ...readings[0], ms, votes: noVotes };

  const heat = majority(found.map((r) => r.heat));
  const humidity = majority(found.map((r) => r.humidity));
  const uv = majority(found.map((r) => r.uv));
  const agreeHeat = found.filter((r) => r.heat === heat);
  const agreeHum = found.filter((r) => r.humidity === humidity);
  const agreeUv = found.filter((r) => r.uv === uv);

  const score = (r: CardReading) => (r.heat === heat ? 4 : 0) + (r.humidity === humidity ? 2 : 0) + (r.uv === uv ? 1 : 0);
  const conf = (r: CardReading) => r.confidence.heat + r.confidence.humidity;
  const rep = found.reduce((best, r) => (score(r) > score(best) || (score(r) === score(best) && conf(r) > conf(best)) ? r : best));

  let heatLevels = [0, 0, 0, 0, 0, 0];
  if (isDecided(heat)) {
    const lead = agreeHeat.includes(rep) ? rep : agreeHeat[0];
    heatLevels = lead.heatLevels.map((own, i) => {
      const ones = agreeHeat.filter((r) => r.heatLevels[i] === 1).length;
      return ones * 2 > agreeHeat.length ? 1 : ones * 2 < agreeHeat.length ? 0 : own;
    });
  }
  // no strict majority for an indicator → it came out UNREADABLE because the frames disagree
  const split = ([["heat", agreeHeat], ["humidity", agreeHum], ["UV", agreeUv]] as const).filter(([, a]) => a.length * 2 <= found.length).map(([n]) => n);
  return {
    ...rep,
    reason: split.length ? `Frames disagree on ${split.join(", ")}: retake the photos` : rep.reason,
    heat, humidity, uv, heatLevels,
    confidence: {
      heat: (agreeHeat.length / found.length) * mean(agreeHeat.map((r) => r.confidence.heat)),
      humidity: (agreeHum.length / found.length) * mean(agreeHum.map((r) => r.confidence.humidity)),
    },
    ms,
    votes: { frames: readings.length, found: found.length, heat: agreeHeat.length, humidity: agreeHum.length, uv: agreeUv.length },
  };
}
