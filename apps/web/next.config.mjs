/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@flaconvault/proof", "@flaconvault/vision"],
  experimental: { esmExternals: true },
};
export default nextConfig;
