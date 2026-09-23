import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FlaconVault", short_name: "FlaconVault", description: "Siegel prüfen, Pass lesen, Scan bezeugen.",
    start_url: "/", display: "standalone", background_color: "#fbfbf9", theme_color: "#fbfbf9",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
