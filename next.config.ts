import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Hosts allowed to use dev-server resources (e.g. hot reload) when the app is
  // opened from another device on the LAN. Set ALLOWED_ORIGINS in .env.local.
  allowedDevOrigins: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/:\d+$/, ""))
    .filter(Boolean),
  async headers() {
    return [
      {
        // Explicitly set MIME type for WASM files if the host is misconfigured.
        source: "/ffmpeg/:path*.wasm",
        headers: [{ key: "Content-Type", value: "application/wasm" }],
      },
    ];
  },
  webpack(config) {
    // @ffmpeg/ffmpeg's worker uses /* @vite-ignore */ on a dynamic import so
    // Vite doesn't try to bundle the runtime URL. Webpack needs its own
    // equivalent comment. This loader swaps the two so webpack leaves the
    // import alone and the browser resolves ffmpeg-core.js at runtime.
    config.module.rules.push({
      test: /node_modules[\\/]@ffmpeg[\\/]ffmpeg[\\/]dist[\\/]esm[\\/]worker\.js$/,
      use: [
        {
          loader: path.resolve(__dirname, "src/loaders/ffmpeg-worker-patch.cjs"),
        },
      ],
    });
    return config;
  },
};

export default nextConfig;
