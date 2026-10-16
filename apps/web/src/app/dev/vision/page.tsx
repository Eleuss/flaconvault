import type { Metadata } from "next";
import { VisionLab } from "@/components/vision-lab";
export const metadata: Metadata = { title: "Indicator reading", robots: { index: false, follow: false } };
export default function VisionPage() {
  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow">Camera · Section 9 · Calibration</p>
      <h1 className="mt-3 font-serif text-4xl">Indicator reading</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Real card in its holder (frame mode): the holder window is the outline, the blue heat label anchors the strip, white
        balance against the card white and the black ring → ΔE against “Baseline” and “Triggered”. The printed test card
        (marker mode) uses ArUco markers and grey/white patches instead. Both are rectified to 660 × 340 px. Test image without
        hardware, photo of the card or live camera. The ROIs come from <code className="mono">docs/heat_fields.json</code>
        (frame mode: its <code className="mono">frame</code> section) — change the file, not the code.
      </p>
      <VisionLab />
    </div>
  );
}
