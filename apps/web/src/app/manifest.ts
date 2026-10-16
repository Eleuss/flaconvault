import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FlaconVault", short_name: "FlaconVault", description: "Check perfume seals, read bottle passports, witness scans.",
    start_url: "/", display: "standalone", background_color: "#fbfbf9", theme_color: "#fbfbf9",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
