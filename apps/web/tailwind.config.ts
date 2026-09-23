import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        line: "var(--line)",
        amber: "var(--amber)",
        forest: "var(--forest)",
        ok: "var(--ok)",
        warn: "var(--warn)",
        bad: "var(--bad)",
        none: "var(--none)",
      },
      fontFamily: {
        sans: ["var(--font-manrope)", "Manrope", "system-ui", "sans-serif"],
        serif: ["var(--font-instrument)", "Instrument Serif", "Georgia", "serif"],
        mono: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      maxWidth: { page: "1080px" },
      boxShadow: { soft: "0 1px 2px rgb(23 28 25 / 0.04), 0 12px 32px -12px rgb(23 28 25 / 0.16)" },
    },
  },
  plugins: [],
};
export default config;
