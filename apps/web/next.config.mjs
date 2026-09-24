/** @type {import('next').NextConfig} */
const nextConfig = {
  // production builds go to .next-build so `next build` never clobbers a running `next dev` (.next)
  distDir: process.env.NEXT_DIST_DIR ?? (process.env.NODE_ENV === "production" ? ".next-build" : ".next"),
  transpilePackages: ["@flaconvault/proof", "@flaconvault/vision"],
  experimental: { esmExternals: true },
};
export default nextConfig;
