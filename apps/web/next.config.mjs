/** @type {import('next').NextConfig} */
const nextConfig = {
  // local production builds: NEXT_DIST_DIR=.next-build npx next build (never clobbers a running dev server); Vercel uses .next
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@flaconvault/proof", "@flaconvault/vision"],
  experimental: { esmExternals: true },
};
export default nextConfig;
