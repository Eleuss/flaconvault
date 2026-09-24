import type { Metadata } from "next";
import { MarketList } from "@/components/market-list";
export const metadata: Metadata = { title: "Markt" };
export const dynamic = "force-dynamic";
export default function MarketPage() { return <MarketList />; }
