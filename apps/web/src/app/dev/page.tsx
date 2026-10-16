import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DEV_SIMULATOR } from "@/lib/config";
import { DemoSwitch, DevConsole } from "@/components/dev-console";
export const metadata: Metadata = { title: "Simulator", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export default function DevPage() {
  if (!DEV_SIMULATOR) notFound();
  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow">Simulator console · FV_DEV_SIMULATOR only</p>
      <h1 className="mt-3 font-serif text-4xl">Virtual seals</h1>
      <p className="mt-2 max-w-xl text-sm text-muted">For development without hardware: create tags, trigger taps, “tear” the antenna. Every tap generates a real SUN URL with a valid CMAC and an incremented counter, which a verifier with its simulator on treats like a hardware tap.</p>
      <DemoSwitch />
      <DevConsole />
    </div>
  );
}
