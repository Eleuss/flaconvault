import { NextResponse } from "next/server";

/** Solana Actions response headers (CORS for Blink clients, devnet chain id). */
export const ACTIONS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "Content-Type": "application/json",
  "X-Action-Version": "2.4",
  "X-Blockchain-Ids": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};
export const actionJson = (body: unknown, status = 200) => new NextResponse(JSON.stringify(body), { status, headers: ACTIONS_HEADERS });
