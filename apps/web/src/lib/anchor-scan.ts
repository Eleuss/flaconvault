/**
 * The anchor step of a scan ("Sign and send"): the decisions behind it, kept out of the component so they are tested.
 * scan-flow.tsx supplies the wallet, RPC and verifier calls; everything that decides what is sent, recovered, refused
 * or retried lives here.
 */
import type { PublicKey, Transaction } from "@solana/web3.js";
import { ApiError } from "./errors";
import { short } from "./format";
import { scanProofAttester, type CreatingTxExpectation } from "./send-tx";
import { attesterMismatch, signedAttester, type VerifyResult } from "./verify-api";

/** A refusal decided on this page, before or instead of a transaction; its message is shown as it is. */
export class AnchorRefused extends Error {
  constructor(message: string) { super(message); this.name = "AnchorRefused"; }
}

/** What to do with the ScanProof address of a signed scan. */
export type AnchorPlan = { kind: "send" } | { kind: "recover" } | { kind: "refuse"; message: string };

/**
 * Before record_scan: is this scan already anchored (the wallet sent it, but the answer never reached this page)?
 * Only a real ScanProof counts — owned by the flacon program, with its discriminator. A SOL transfer to the
 * predictable address is not an anchor ("send"). A ScanProof attested by this wallet is recovered by looking up the
 * transaction that created it ("recover"); one attested by another wallet can never be confirmed for this one.
 */
export function anchorPlan(info: { owner: PublicKey; data: Uint8Array } | null, wallet: PublicKey, programId: PublicKey): AnchorPlan {
  const by = scanProofAttester(info, programId);
  if (!by) return { kind: "send" };
  if (!by.equals(wallet)) return { kind: "refuse", message: `This scan is already anchored by another wallet (${short(by.toBase58())}). It cannot be anchored twice.` };
  return { kind: "recover" };
}

/**
 * After a failed confirmation: forget the landed signature when the server saw it fail on chain (tx_failed) or says
 * it does not belong to this scan (tx_mismatch), so the next press looks again / sends again instead of posting the
 * same signature forever. Any other failure (network, tx_not_visible …) keeps it: only the confirmation is retried.
 */
export const resetsTxSig = (e: unknown): boolean => e instanceof ApiError && (e.code === "tx_failed" || e.code === "tx_mismatch");

/**
 * A scan opened from a resume link that the server signed without a wallet (the normal iPhone Safari case) can be
 * anchored by any wallet, and the wallet that anchors it becomes its attester. Whoever holds the link — also someone
 * who forwarded their own scan — would get a scan of a bottle this wallet never saw onto its record, so the user
 * confirms first that the scan is their own.
 */
export const needsOwnScanConfirmation = (resumed: boolean, v: VerifyResult | null): boolean => resumed && signedAttester(v).pubkey == null;

export interface AnchorDeps {
  verify: VerifyResult;
  wallet: PublicKey;
  programId: PublicKey;
  /** a signature that landed earlier while its server confirmation failed: only the confirmation is retried */
  landedSig: string | null;
  /** opened from a resume link, and whether the user confirmed it is their own scan (needsOwnScanConfirmation) */
  resumed?: boolean;
  ownScanConfirmed?: boolean;
  build(): Promise<{ tx: Transaction; scanProof: PublicKey }>;
  accountInfo(account: PublicKey): Promise<{ owner: PublicKey; data: Uint8Array } | null>;
  findCreating(account: PublicKey, expect: CreatingTxExpectation): Promise<string | null>;
  send(tx: Transaction): Promise<string>;
  /** POST /api/events with the signature */
  confirm(sig: string): Promise<unknown>;
}
/** `landedSig`: the signature to keep for the next attempt (null = build and look again). */
export type AnchorOutcome = { ok: true; sig: string } | { ok: false; error: unknown; landedSig: string | null };

/** One press on "Sign and send" / "Retry confirmation with the server". */
export async function anchorScan(d: AnchorDeps): Promise<AnchorOutcome> {
  // the server signed this scan for the wallet connected at "Get signature": anchoring with another one cannot be confirmed
  const other = attesterMismatch(d.verify, d.wallet.toBase58());
  if (other) return { ok: false, error: new AnchorRefused(`This scan was signed for wallet ${short(other)}. Switch back to that wallet (header) to anchor it.`), landedSig: d.landedSig };
  if (needsOwnScanConfirmation(!!d.resumed, d.verify) && !d.ownScanConfirmed) {
    return { ok: false, error: new AnchorRefused("Confirm first that this is your own scan: anchor only a scan you made yourself."), landedSig: d.landedSig };
  }
  let sig = d.landedSig;
  try {
    if (!sig) {
      const { tx, scanProof } = await d.build();
      const plan = anchorPlan(await d.accountInfo(scanProof), d.wallet, d.programId);
      if (plan.kind === "refuse") throw new AnchorRefused(plan.message);
      if (plan.kind === "recover") {
        // the transaction that created it must be this wallet's record_scan (not a transfer that pre-funded the address)
        sig = await d.findCreating(scanProof, { programId: d.programId, instruction: "record_scan", signer: d.wallet });
        if (!sig) throw new AnchorRefused("This scan is anchored on chain, but its transaction was not found yet. Try again in a moment.");
      } else {
        sig = await d.send(tx);
      }
    }
    await d.confirm(sig);
    return { ok: true, sig };
  } catch (error) {
    return { ok: false, error, landedSig: resetsTxSig(error) ? null : sig };
  }
}
