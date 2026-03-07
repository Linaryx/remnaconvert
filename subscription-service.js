#!/usr/bin/env bun
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_URL = process.env.SOURCE_URL;
const PORT = Number(process.env.PORT ?? 8080);
const UPDATE_INTERVAL_MINUTES = Number(process.env.UPDATE_INTERVAL_MINUTES ?? 30);
const SCHEMES = process.env.SCHEMES ?? "vless,vmess,trojan,ss";
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(__dirname, "public");
const LINKS_FILE = process.env.LINKS_FILE ?? "v2ray_links.txt";
const B64_FILE = process.env.B64_FILE ?? "v2ray_subscription.b64";

const linksPath = path.join(OUTPUT_DIR, LINKS_FILE);
const b64Path = path.join(OUTPUT_DIR, B64_FILE);

if (!SOURCE_URL) {
  console.error("Missing SOURCE_URL env var.");
  process.exit(2);
}

async function ensureOutputDir() {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

function runConverter() {
  const converterPath = path.join(__dirname, "convert-oversub-to-v2ray.js");
  const args = [
    process.execPath,
    converterPath,
    SOURCE_URL,
    "--out-links",
    linksPath,
    "--out-b64",
    b64Path,
    "--schemes",
    SCHEMES,
  ];

  const proc = Bun.spawn({
    cmd: args,
    stdout: "inherit",
    stderr: "inherit",
  });

  return proc.exited.then((code) => {
    if (code === 0) return;
    throw new Error(`converter exited with code ${code}`);
  });
}

async function hasGeneratedFiles() {
  try {
    await access(linksPath, constants.F_OK);
    await access(b64Path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

let lastUpdateOk = false;
let lastUpdateAt = null;
let lastError = null;

async function updateNow() {
  try {
    await runConverter();
    lastUpdateOk = true;
    lastUpdateAt = new Date().toISOString();
    lastError = null;
    console.log(`[update] success at ${lastUpdateAt}`);
  } catch (err) {
    lastUpdateOk = false;
    lastError = String(err?.message ?? err);
    console.error(`[update] failed: ${lastError}`);
  }
}

async function sendFile(filePath, contentType) {
  try {
    const body = await readFile(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

async function start() {
  await ensureOutputDir();

  if (!(await hasGeneratedFiles())) {
    console.log("[init] generated files are missing, running first update...");
  }
  await updateNow();

  const intervalMs = Math.max(1, UPDATE_INTERVAL_MINUTES) * 60 * 1000;
  setInterval(updateNow, intervalMs);

  const server = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    async fetch(req) {
      const pathname = new URL(req.url).pathname;

      if (pathname === "/" || pathname === "/healthz") {
        const payload = JSON.stringify(
          {
            ok: lastUpdateOk,
            lastUpdateAt,
            lastError,
            linksPath: `/${LINKS_FILE}`,
            subscriptionPath: `/${B64_FILE}`,
          },
          null,
          2,
        );
        return new Response(payload, {
          status: lastUpdateOk ? 200 : 503,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        });
      }

      if (pathname === `/${LINKS_FILE}`) {
        return sendFile(linksPath, "text/plain; charset=utf-8");
      }

      if (pathname === `/${B64_FILE}`) {
        return sendFile(b64Path, "text/plain; charset=utf-8");
      }

      return new Response("Not found\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
  });

  console.log(`[server] listening on :${server.port}`);
  console.log(`[server] links endpoint: /${LINKS_FILE}`);
  console.log(`[server] subscription endpoint: /${B64_FILE}`);
}

start().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
