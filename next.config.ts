import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  logging: {
    incomingRequests: true,
    fetches: {
      fullUrl: true,
      hmrRefreshes: true,
    }
  },
  serverExternalPackages: ["duckdb", "duckdb-async"],
  experimental: {
    authInterrupts: true
  }
};


export default nextConfig;
