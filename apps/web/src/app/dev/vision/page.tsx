import type { Metadata } from "next";
import { VisionLab } from "@/components/vision-lab";
export const metadata: Metadata = { title: "Indicator reading" };
export default function VisionPage() {
  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow">Camera · Section 9 · Calibration</p>
      <h1 className="mt-3 font-serif text-4xl">Indicator reading</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        ArUco markers → homography to 660 × 340 px → white balance per group via grey and white patches → ΔE against “Baseline” and “Triggered”.
        Test image without hardware, photo of the printed card or live camera. The ROIs come from <code className="mono">docs/heat_fields.json</code> — on delivery day change the file, not the code.
      </p>
      <VisionLab />
    </div>
  );
}
