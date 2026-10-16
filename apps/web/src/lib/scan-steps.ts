/** The steps of the scan page (components/scan-flow.tsx) and the rules that depend only on the step, tier and role. */
import { Role, Tier } from "@flaconvault/proof";
import { scanUsableForOrder } from "./escrow-rules";
import { short } from "./format";

export type ScanStep = "session" | "tap" | "preview" | "camera" | "read" | "verify" | "tx" | "done" | "dead";

/**
 * The 90 s session window covers tap → photo → server signature. Once the server has signed ("tx"), the signed scan
 * stays anchorable: the countdown stops and expiry no longer hides or blocks the anchor step.
 */
export const timedStep = (step: ScanStep): boolean => step !== "tx" && step !== "done" && step !== "dead";

/** The camera runs only while the camera step is shown and the session has not expired (S17). */
export const cameraOn = (step: ScanStep, expired: boolean): boolean => step === "camera" && !expired;

// ---- certified scans: the partner wallet ------------------------------------------------------------------------

/**
 * Tiers ≥ 3 (certified, birth) and the vault/partner roles are signed only for a wallet registered as a partner
 * (/api/verify answers 403 not_partner otherwise), and record_scan accepts them only from that partner.
 */
export const needsPartnerWallet = (tier: number, role: number): boolean =>
  tier >= Tier.CERTIFIED || role === Role.VAULT || role === Role.PARTNER;

/**
 * The roles the scan page offers. A certified tier only with the vault or partner role: the program refuses a tier
 * above 2 for owner, seller and buyer (TierNotAllowedForRole), and it would do so only after the server had signed.
 */
export const roleChoices = (certified: boolean): number[] =>
  certified ? [Role.VAULT, Role.PARTNER] : [Role.OWNER, Role.SELLER, Role.BUYER];

/** The role the page starts with: ?role= when the flow offers it, else partner (certified) or owner. */
export function initialRole(qRole: number, certified: boolean): number {
  return Number.isInteger(qRole) && roleChoices(certified).includes(qRole) ? qRole : certified ? Role.PARTNER : Role.OWNER;
}

/** What this browser offers for connecting a wallet. */
export interface WalletEnv {
  connected: boolean;
  /** iPhone / iPad (no Mobile Wallet Adapter, no wallet extension in Safari) */
  ios: boolean;
  /** a real wallet is injected into this browser (extension, or the wallet app's own browser) */
  injectedWallet: boolean;
  /** the site offers WalletConnect (NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set) */
  walletConnect: boolean;
}
export interface PartnerWalletGate {
  /** the wallet can be connected on this page (otherwise this browser cannot do the scan at all) */
  canConnect: boolean;
  title: string;
  text: string;
}

/**
 * Before a certified scan is signed: the server signs it for the wallet connected at "Get signature" (the attester)
 * and only that wallet can anchor it, so the partner wallet must be connected first. null when nothing is missing.
 * Safari on iPhone has no injected wallet: the partner connects through WalletConnect, which also survives the reload
 * that tapping the seal causes (one press on "Connect" restores the session). Without WalletConnect an iPhone cannot
 * do a certified scan, and the page says so instead of failing at "Get signature".
 */
export function partnerWalletGate(tier: number, role: number, env: WalletEnv): PartnerWalletGate | null {
  if (!needsPartnerWallet(tier, role) || env.connected) return null;
  const why = "A certified scan is signed for the partner wallet that is connected when you press “Get signature”, and only that wallet can anchor it.";
  if (env.ios && !env.injectedWallet) {
    return env.walletConnect
      ? {
        canConnect: true, title: "Connect the partner wallet first",
        text: `${why} Safari on iPhone has no wallet extension: press “Select Wallet”, choose WalletConnect and approve in your wallet app, then return to this tab. Tapping the seal reloads this page; if the wallet then shows “Connect”, press it once to resume the connection.`,
      }
      : {
        canConnect: false, title: "This browser cannot sign a certified scan",
        text: `${why} Safari on iPhone has no wallet extension and this site has no WalletConnect set up, so no partner wallet can be connected here. Use Android Chrome with the partner's wallet app, or ask the operator to enable WalletConnect.`,
      };
  }
  return { canConnect: true, title: "Connect the partner wallet first", text: `${why} Connect it here, best before you start: the session runs for 90 seconds from the tap.` };
}

/**
 * The anchor step on an iPhone without an injected wallet: how this scan can still be signed. `canResume` = a resume
 * link into the wallet app's browser exists; `signedFor` = the wallet the server signed the scan for (certified scans).
 */
export function iosSignHint(o: { walletConnect: boolean; canResume: boolean; signedFor: string | null }): string {
  const only = o.signedFor ? ` This scan is signed for wallet ${short(o.signedFor)}: only that wallet can anchor it.` : "";
  if (o.walletConnect && o.canResume) return `Connect your wallet below with WalletConnect and sign here, or continue in the wallet app's browser, where you sign directly.${only}`;
  if (o.walletConnect) return `Connect your wallet below with WalletConnect and sign here.${only}`;
  if (o.canResume) return `Safari has no wallet extension: the scan continues in the wallet app's browser, where you sign directly.${only}`;
  return "Safari has no wallet extension and this site has no WalletConnect set up, so this scan cannot be signed in this browser.";
}

// ---- escrow scans ----------------------------------------------------------------------------------------------

/**
 * A seller's shipping scan or a buyer's receipt scan only counts for an order when heat and humidity are both read
 * (scanUsableForOrder). Warns before the signature instead of after anchoring; null when the reading qualifies or the
 * role has nothing to do with an order.
 */
export function escrowScanWarning(role: number, reading: { found: boolean; heat: number; humidity: number } | null): string | null {
  if (role !== Role.SELLER && role !== Role.BUYER) return null;
  const usable = scanUsableForOrder(reading?.found ? reading : null);
  if (usable.ok) return null;
  const which = role === Role.SELLER ? "shipping scan" : "receipt scan";
  const next = reading ? "Photograph the card again." : "Restart and photograph the card.";
  return `This scan cannot be recorded as an order's ${which} (${usable.reason}): the escrow compares heat and humidity, so both must be read as intact or triggered. ${next}`;
}
