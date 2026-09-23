import type { Metadata } from "next";
import { VisionLab } from "@/components/vision-lab";
export const metadata: Metadata = { title: "Indikatorlesung" };
export default function VisionPage() {
  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow">Kamera · Abschnitt 9 · Kalibrierung</p>
      <h1 className="mt-3 font-serif text-4xl">Indikatorlesung</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        ArUco-Marker → Homographie auf 660 × 340 px → Weißabgleich je Gruppe über Grau- und Weißfeld → ΔE zu „Ausgang“ und „Ausgelöst“.
        Testbild ohne Hardware, Foto der gedruckten Karte oder Live-Kamera. Die ROIs kommen aus <code className="mono">docs/heat_fields.json</code> — am Liefertag Datei ändern, nicht Code.
      </p>
      <VisionLab />
    </div>
  );
}
