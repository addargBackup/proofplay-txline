/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@txline-kit/client", "@txline-kit/constants"],
  webpack: (config) => {
    config.externals = config.externals || [];
    // Keep node-only optional deps of web3.js out of the client bundle.
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, os: false, path: false };
    return config;
  },
};
export default nextConfig;
