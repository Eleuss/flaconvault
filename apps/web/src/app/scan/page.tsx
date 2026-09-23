import type { Metadata } from "next";
import { Suspense } from "react";
import { ScanFlow } from "@/components/scan-flow";
export const metadata: Metadata = { title: "Scan" };
export const dynamic = "force-dynamic";
export default function ScanPage() {
  return <Suspense fallback={null}><ScanFlow /></Suspense>;
}
