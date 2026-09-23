import type { Metadata } from "next";
import { ScanFlow } from "@/components/scan-flow";
export const metadata: Metadata = { title: "Scan" };
export const dynamic = "force-dynamic";
export default function ScanPage() {
  return <ScanFlow />;
}
