import type { Metadata } from "next";
import { CertifyConsole } from "@/components/certify-console";
export const metadata: Metadata = { title: "Certification" };
export const dynamic = "force-dynamic";
export default function CertifyPage() {
  return <CertifyConsole />;
}
