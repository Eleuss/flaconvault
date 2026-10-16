import { HEAT_DECISIVE_INDEX, Indicator } from "@flaconvault/proof";
import { isDecided, notFoundReading } from "./pipeline.ts";
import type { CardReading } from "./types.ts";

/**
 * true when this frame takes part in the vote: the card was found and, in frame mode, the blue heat label anchored
 * it (without the label the card's orientation and registration are unknown, so the frame abstains).
 */
export function frameCounts(r: CardReading): boolean {
  if (!r.found) return false;
  return r.quality?.mode !== "frame" || (r.quality.anchors ?? []).includes("heat-label");
}

/**
 * The value that at least `quorum` of the votes agree on, else UNREADABLE. An indicator that every vote reports as
 * MISSING (not fitted on this card, e.g. UV in marker mode) stays MISSING whatever the quorum: it was not read, which
 * is not the same as "unreadable, inspection recommended".
 */
export function majority(votes: number[], quorum: number): number {
  if (votes.length > 0 && votes.every((v) => v === Indicator.MISSING)) return Indicator.MISSING;
  const counts = new Map<number, number>();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const [v, n] of counts) if (n >= Math.max(1, quorum)) return v;
  return Indicator.UNREADABLE;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const joinList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * Combine the readings of several frames of the same card into the one reading that is signed. `total` is the number
 * of frames captured (default: the readings given); each indicator needs a majority of ALL of them, e.g. 3 of 5.
 * Frames without a card, and frame-mode frames whose heat label was not found, do not vote but still count towards
 * the quorum, so one good frame among four misses never decides alone. Without a quorum an indicator is UNREADABLE,
 * never the single most "confident" frame: classifier confidences saturate near 1, so that pick would be noise (one
 * specular highlight could decide it).
 *
 * - heatLevels: per-field strict majority over the voters that agree on a decided heat verdict (a tie gives 0), with
 *   the decisive 40 °C field equal to the verdict; all zero unless heat is INTACT or TRIGGERED.
 * - confidence: for a decided indicator, the agreeing voters' mean confidence × their share of the frames; else 0.
 * - Everything else (fields, quality, homography, preview) comes from a representative voter: the one that agrees
 *   with the most combined verdicts (heat first), then the most confident one.
 * - No voter: a not-found reading (every indicator MISSING) whose reason says why; no readings at all: not found.
 */
export function combineReadings(readings: CardReading[], total = readings.length): CardReading {
  const ms = sum(readings.map((r) => r.ms));
  const frames = Math.max(total, readings.length);
  const voters = readings.filter(frameCounts);
  const noVotes = { frames, found: 0, heat: 0, humidity: 0, uv: 0 };
  if (readings.length === 0) return { ...notFoundReading("No frames to read"), votes: noVotes };
  if (voters.length === 0) {
    const seen = readings.find((r) => r.found); // a card, but never anchored on its heat label
    const base = seen ?? readings[0];
    const empty = notFoundReading("", ms);
    return {
      ...base, found: false,
      reason: seen ? "The heat label was not recognized in any frame: hold the card flat and fully in view, avoid glare" : base.reason ?? "Card not detected",
      heat: empty.heat, humidity: empty.humidity, uv: empty.uv, heatLevels: empty.heatLevels, confidence: empty.confidence, ms, votes: noVotes,
    };
  }

  const quorum = Math.floor(frames / 2) + 1;
  const heat = majority(voters.map((r) => r.heat), quorum);
  const humidity = majority(voters.map((r) => r.humidity), quorum);
  const uv = majority(voters.map((r) => r.uv), quorum);
  const agreeHeat = voters.filter((r) => r.heat === heat);
  const agreeHum = voters.filter((r) => r.humidity === humidity);
  const agreeUv = voters.filter((r) => r.uv === uv);

  const score = (r: CardReading) => (r.heat === heat ? 4 : 0) + (r.humidity === humidity ? 2 : 0) + (r.uv === uv ? 1 : 0);
  const conf = (r: CardReading) => r.confidence.heat + r.confidence.humidity;
  const rep = voters.reduce((best, r) => (score(r) > score(best) || (score(r) === score(best) && conf(r) > conf(best)) ? r : best));

  let heatLevels = [0, 0, 0, 0, 0, 0];
  if (isDecided(heat)) {
    heatLevels = heatLevels.map((_, i) => (agreeHeat.filter((r) => r.heatLevels[i] === 1).length * 2 > agreeHeat.length ? 1 : 0));
    heatLevels[HEAT_DECISIVE_INDEX] = heat === Indicator.TRIGGERED ? 1 : 0;
  }
  const share = (agree: CardReading[], pick: (r: CardReading) => number) => mean(agree.map(pick)) * (agree.length / frames);

  // UNREADABLE without an UNREADABLE quorum although some voter read it: the frames disagree, or too few voted
  const undecided = ([["heat", heat, agreeHeat, (r: CardReading) => r.heat], ["humidity", humidity, agreeHum, (r: CardReading) => r.humidity], ["UV", uv, agreeUv, (r: CardReading) => r.uv]] as const)
    .filter(([, v, agree, pick]) => v === Indicator.UNREADABLE && agree.length < quorum && voters.some((r) => pick(r) !== Indicator.UNREADABLE))
    .map(([name]) => name);
  const reason = !undecided.length ? rep.reason
    : voters.length < quorum ? `Only ${voters.length} of ${frames} frames could be read: hold the card steady and fully in view, then retake the photos`
    : `Frames disagree on ${joinList([...undecided])} (${voters.length} of ${frames} frames counted): retake the photos`;
  return {
    ...rep,
    reason,
    heat, humidity, uv, heatLevels,
    confidence: {
      heat: isDecided(heat) ? share(agreeHeat, (r) => r.confidence.heat) : 0,
      humidity: isDecided(humidity) ? share(agreeHum, (r) => r.confidence.humidity) : 0,
    },
    ms,
    votes: { frames, found: voters.length, heat: agreeHeat.length, humidity: agreeHum.length, uv: agreeUv.length },
  };
}
