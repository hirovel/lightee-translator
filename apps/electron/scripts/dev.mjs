import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = resolve(appRoot, "node_modules/vite/bin/vite.js");
const electronBin = resolve(
  appRoot,
  process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/electron/dist/electron",
);

function openPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : port));
    });
  });
}

async function findPort(start) {
  for (let port = start; port < start + 20; port += 1) {
    try {
      return await openPort(port);
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("No open Vite port found");
}

function waitFor(url, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(url);
        if (response.ok || response.status === 404) {
          resolve();
          return;
        }
      } catch {
        // Vite is still starting.
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  });
}

const port = await findPort(5173);
const url = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port)], {
  cwd: appRoot,
  stdio: "inherit",
  env: process.env,
});

let electron;
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  if (electron && !electron.killed) electron.kill();
  if (!vite.killed) vite.kill();
  process.exit(code);
};

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
vite.once("exit", (code) => {
  if (!stopping) stop(code ?? 1);
});

await waitFor(`${url}/`);
electron = spawn(electronBin, ["."], {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    LIGHTEE_DEV_SERVER_URL: url,
  },
});
electron.once("exit", (code) => stop(code ?? 0));
