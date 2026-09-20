import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      // `as: "*.js"` is required so Turbopack treats the loader output as a
      // JavaScript module. See `vgpu docs cat nextjs.md`.
      "*.wgsl": {
        loaders: ["@vgpu/wgsl/loader-webpack"],
        as: "*.js",
      },
    },
  },
};

export default nextConfig;
