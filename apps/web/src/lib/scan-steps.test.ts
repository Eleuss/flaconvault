import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraOn, timedStep, type ScanStep } from "./scan-steps";

const ALL: ScanStep[] = ["session", "tap", "preview", "camera", "read", "verify", "tx", "done", "dead"];

test("the camera runs only on the camera step of a running session (S17)", () => {
  for (const step of ALL) {
    assert.equal(cameraOn(step, false), step === "camera", step);
    assert.equal(cameraOn(step, true), false, `${step}, expired`);
  }
});

test("the session countdown stops once the server has signed", () => {
  assert.deepEqual(ALL.filter((s) => !timedStep(s)), ["tx", "done", "dead"]);
});
