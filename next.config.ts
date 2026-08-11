import type { NextConfig } from "next";

/**
 * Everything under `src/` imports with explicit `.js` specifiers, because it
 * also runs outside Next -- the worker is plain Node ESM. The bundler has to
 * be told that a `.js` specifier in this project means the `.ts` file next to
 * it, or every server module the pages import fails to resolve.
 *
 * Only webpack honours this option today (Turbopack ignores it and fails to
 * resolve the same imports), which is why the build and dev scripts pass
 * `--webpack`. Dropping the flag means either waiting for Turbopack to support
 * extension aliasing or dropping the `.js` specifiers across `src/` -- and the
 * worker needs them.
 */
const nextConfig: NextConfig = {
  experimental: {
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
    },
  },
};

export default nextConfig;
