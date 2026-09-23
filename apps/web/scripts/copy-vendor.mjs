// Copies OpenCV.js (13 MB, loaded by the vision worker via importScripts) and the heat-field calibration into public/.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cvPath = require.resolve("@techstark/opencv-js/dist/opencv.js");
mkdirSync(resolve(here, "../public/vendor"), { recursive: true });
copyFileSync(cvPath, resolve(here, "../public/vendor/opencv.js"));
copyFileSync(resolve(here, "../../../docs/heat_fields.json"), resolve(here, "../public/heat_fields.json"));
console.log("[copy-vendor] opencv.js + heat_fields.json → public/");
