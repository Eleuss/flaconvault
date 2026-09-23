/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@flaconvault/proof"],
  experimental: { esmExternals: true },
};
export default nextConfig;
