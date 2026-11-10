import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // ListFunctions is GET /2015-03-31/functions/ with the slash: answer it instead of redirecting
  skipTrailingSlashRedirect: true,
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
