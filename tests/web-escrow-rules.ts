/**
 * Unit tests for the web app's pure escrow/market rules (apps/web/src/lib/escrow-rules.ts): price parsing, serial
 * validation, encoded paths and the action matrix that mirrors programs/escrow/src/rules.rs. No validator needed:
 *   NODE_OPTIONS=--no-experimental-strip-types npx ts-mocha -p ./tsconfig.json tests/web-escrow-rules.ts
 * (also runs as part of `anchor test`).
 */
import { expect } from "chai";
import {
  MAX_DISPUTE_AFTER_S,
  MIN_DISPUTE_AFTER_S,
  OrderState as S,
  availableActions,
  coreAssetUri,
  effectiveWindow,
  formatUsdc,
  isValidSerial,
  marketPassportPath,
  normalizeSerial,
  orderPath,
  parsePriceUsdc,
  passportPath,
  receiptDeadline,
  shipDeadline,
  type OrderLike,
} from "../apps/web/src/lib/escrow-rules";

const DAY = 86400;
const order = (state: number, extra: Partial<OrderLike> = {}): OrderLike => ({ state, reservedAt: 1_000, shippedAt: 0, disputeAfterS: 7 * DAY, assetDeposited: false, ...extra });
const viewer = (v: Partial<{ isSeller: boolean; isBuyer: boolean; isAdmin: boolean; sealDead: boolean }> = {}) => ({ isSeller: false, isBuyer: false, isAdmin: false, sealDead: false, ...v });

describe("web escrow rules", () => {
  it("parsePriceUsdc: positive decimals with at most 6 places, in base units", () => {
    expect(parsePriceUsdc("480")).to.equal(BigInt(480_000_000));
    expect(parsePriceUsdc(" 480.5 ")).to.equal(BigInt(480_500_000));
    expect(parsePriceUsdc("0.000001")).to.equal(BigInt(1));
    expect(parsePriceUsdc("12.345678")).to.equal(BigInt(12_345_678));
    for (const bad of ["-5", "0", "0.0", "480,50", "abc", "", "1e3", "1.2345678", ".5", "5.", "+5", "Infinity", "0x10"]) {
      expect(parsePriceUsdc(bad), bad).to.equal(null);
    }
    expect(formatUsdc(BigInt(480_500_000))).to.equal("480.5");
    expect(formatUsdc(BigInt(480_000_000))).to.equal("480");
    expect(formatUsdc(BigInt(1))).to.equal("0.000001");
  });

  it("serials: trimmed, 3–64 chars, no spaces / slashes / query characters", () => {
    expect(normalizeSerial("  SN-2026-000004 ")).to.equal("SN-2026-000004");
    for (const ok of ["SN-2026-000004", "abc", "A.b_c-1", "x".repeat(64)]) expect(isValidSerial(ok), ok).to.be.true;
    for (const bad of ["SN-2026-000004 ", "SN/1", "SN#1", "SN?1", "ab", "-abc", ".abc", "x".repeat(65), "SN 1", "", "Ünïcode"]) {
      expect(isValidSerial(bad), bad).to.be.false;
    }
  });

  it("paths encode their dynamic part", () => {
    expect(passportPath("SN-1")).to.equal("/p/SN-1");
    expect(passportPath("a/b?c")).to.equal("/p/a%2Fb%3Fc");
    expect(coreAssetUri("https://verify.example/", "SN 1/x")).to.equal("https://verify.example/api/passport/SN%201%2Fx/metadata.json");
    expect(marketPassportPath("a#b")).to.equal("/market/a%23b");
    expect(orderPath("8vxGxW1gTEST")).to.equal("/market/o/8vxGxW1gTEST");
  });

  it("windows are clamped like the program (1 h ..= 60 days)", () => {
    expect(effectiveWindow(1)).to.equal(MIN_DISPUTE_AFTER_S);
    expect(effectiveWindow(10 ** 12)).to.equal(MAX_DISPUTE_AFTER_S);
    expect(shipDeadline(order(S.RESERVED))).to.equal(1_000 + 7 * DAY);
    expect(receiptDeadline(order(S.SHIPPED, { shippedAt: 5_000 }))).to.equal(5_000 + 7 * DAY);
  });

  it("listing: the buyer reserves, the seller can withdraw", () => {
    expect(availableActions(order(S.LISTED), viewer(), 0)).to.deep.equal(["reserve"]);
    expect(availableActions(order(S.LISTED), viewer({ isSeller: true }), 0)).to.deep.equal(["cancel"]);
  });

  it("seller never ships: the buyer's refund appears only after reserved_at + window", () => {
    const o = order(S.RESERVED);
    expect(availableActions(o, viewer({ isBuyer: true }), 1_000 + 7 * DAY)).to.deep.equal([]);
    expect(availableActions(o, viewer({ isBuyer: true }), 1_000 + 7 * DAY + 1)).to.deep.equal(["refundNotShipped"]);
    expect(availableActions(order(S.PRESHIP_SCANNED), viewer({ isBuyer: true }), 1_000 + 7 * DAY + 1)).to.deep.equal(["refundNotShipped"]);
    expect(availableActions(o, viewer({ isSeller: true }), 0)).to.deep.equal(["preShip"]);
    expect(availableActions(order(S.PRESHIP_SCANNED), viewer({ isSeller: true }), 0)).to.deep.equal(["ship"]);
  });

  it("buyer never scans: after shipped_at + window anyone may pay the seller; the buyer gets no refund", () => {
    const o = order(S.SHIPPED, { shippedAt: 10_000 });
    expect(availableActions(o, viewer({ isBuyer: true }), 10_000 + 7 * DAY)).to.deep.equal(["receipt"]);
    const late = 10_000 + 7 * DAY + 1;
    expect(availableActions(o, viewer({ isBuyer: true }), late)).to.deep.equal(["receipt", "releaseAfterTimeout"]);
    expect(availableActions(o, viewer(), late)).to.deep.equal(["releaseAfterTimeout"]);
  });

  it("mismatch: only the admin resolves; matched receipt: release, never a refund", () => {
    expect(availableActions(order(S.MISMATCH), viewer({ isBuyer: true, sealDead: true }), 10 ** 10)).to.deep.equal([]);
    expect(availableActions(order(S.MISMATCH), viewer({ isAdmin: true }), 0)).to.deep.equal(["resolve"]);
    expect(availableActions(order(S.RECEIPT_SCANNED), viewer({ isBuyer: true, sealDead: true, isAdmin: true }), 0)).to.deep.equal(["release"]);
  });

  it("dead seal / admin refunds while funded and before a matched receipt; seller closes terminal orders", () => {
    for (const s of [S.RESERVED, S.PRESHIP_SCANNED, S.SHIPPED]) {
      expect(availableActions(order(s), viewer({ isBuyer: true, sealDead: true }), 0)).to.include("disputeSealDead");
      expect(availableActions(order(s), viewer({ isAdmin: true }), 0)).to.include("adminRefund");
    }
    for (const s of [S.RELEASED, S.DISPUTE, S.CANCELLED]) {
      expect(availableActions(order(s), viewer({ isSeller: true }), 0)).to.deep.equal(["close"]);
      expect(availableActions(order(s), viewer({ isBuyer: true, isAdmin: true }), 0)).to.deep.equal([]);
    }
  });
});
