import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DEV_SIMULATOR } from "@/lib/config";
import { DevConsole } from "@/components/dev-console";
export const metadata: Metadata = { title: "Simulator" };
export const dynamic = "force-dynamic";
export default function DevPage() {
  if (!DEV_SIMULATOR) notFound();
  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow">Simulatorkonsole · nur FV_DEV_SIMULATOR</p>
      <h1 className="mt-3 font-serif text-4xl">Virtuelle Siegel</h1>
      <p className="mt-2 max-w-xl text-sm text-muted">Bis die Hardware da ist: Tags anlegen, Taps auslösen, Antenne „reißen“. Jeder Tap erzeugt eine echte SUN-URL mit gültigem CMAC und hochgezähltem Zähler, die der Server wie einen Hardware-Tap behandelt.</p>
      <DevConsole />
    </div>
  );
}
