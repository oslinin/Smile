import type { NextConfig } from "next";

// On GitHub Pages the app is served from a project subpath
// (oslinin.github.io/Smile), so /_next/ assets must be prefixed with /Smile or
// they 404. The Pages workflow sets NEXT_PUBLIC_BASE_PATH=/Smile; local dev
// leaves it unset so the app stays at the domain root.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // Static export only for the GitHub Pages deployment (which sets
  // NEXT_PUBLIC_BASE_PATH). A regular server build is required locally so the
  // copilot's POST route handler (/api/copilot) can exist — static export
  // supports GET-only route handlers.
  output: basePath ? "export" : undefined,
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
