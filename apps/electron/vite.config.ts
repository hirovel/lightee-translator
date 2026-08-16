import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const appRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(appRoot, "../..");

export default defineConfig({
  base: "./",
  root: resolve(appRoot, "renderer"),
  server: {
    host: "127.0.0.1",
    strictPort: false,
    fs: {
      allow: [projectRoot],
    },
  },
  preview: {
    host: "127.0.0.1",
    strictPort: false,
  },
  build: {
    outDir: resolve(appRoot, "dist"),
    emptyOutDir: true,
    target: "es2022",
  },
});
