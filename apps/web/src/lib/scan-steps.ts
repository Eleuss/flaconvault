/** The steps of the scan page (components/scan-flow.tsx) and the rules that depend only on the step. */
export type ScanStep = "session" | "tap" | "preview" | "camera" | "read" | "verify" | "tx" | "done" | "dead";

/**
 * The 90 s session window covers tap → photo → server signature. Once the server has signed ("tx"), the signed scan
 * stays anchorable: the countdown stops and expiry no longer hides or blocks the anchor step.
 */
export const timedStep = (step: ScanStep): boolean => step !== "tx" && step !== "done" && step !== "dead";

/** The camera runs only while the camera step is shown and the session has not expired (S17). */
export const cameraOn = (step: ScanStep, expired: boolean): boolean => step === "camera" && !expired;
