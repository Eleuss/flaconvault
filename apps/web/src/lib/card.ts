import QRCode from "qrcode";

/** Rev C card SVG for a given serial: same geometry, QR modules and serial text replaced. */
export async function cardSvgForSerial(template: string, serial: string): Promise<string> {
  const qr = QRCode.create(serial, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;                       // 21 for a short serial (version 1); larger versions still fit the 5.055 mm box
  const box = 5.055, origin = { x: 11.522, y: 25.622 };
  const pitch = box / n;
  const rects: string[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.modules.get(r, c)) continue;
    rects.push(`<rect x="${(origin.x + c * pitch).toFixed(3)}" y="${(origin.y + r * pitch).toFixed(3)}" width="${pitch.toFixed(3)}" height="${pitch.toFixed(3)}" fill="#000"/>`);
  }
  // strip the template's QR modules (0.241 mm rects) and insert ours before the serial text
  let out = template.replace(/<rect x="[\d.]+" y="[\d.]+" width="0\.241" height="0\.241" fill="#000"\/>\n?/g, "");
  out = out.replace(/<text x="18\.5" y="26\.4"/, `${rects.join("\n")}\n<text x="18.5" y="26.4"`);
  out = out.replace(/SN-2026-000001/g, serial);
  out = out.replace(/<metadata>[\s\S]*?<\/metadata>/, "");
  return out;
}
