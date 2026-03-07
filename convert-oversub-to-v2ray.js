#!/usr/bin/env bun
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  bun run convert-oversub-to-v2ray.js <oversub_url> [--out-links v2ray_links.txt] [--out-b64 v2ray_subscription.b64] [--schemes vless,vmess,trojan,ss] [--print]",
    "",
    "Example:",
    '  bun run convert-oversub-to-v2ray.js \"https://oversub.cloud/dyeq_TGT4uteL3L2\"',
  ].join("\n");
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function getArgValue(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function withBase64Padding(b64) {
  const mod = b64.length % 4;
  if (mod === 0) return b64;
  return b64 + "=".repeat(4 - mod);
}

function extractDataPanelBase64(html) {
  // RemnaWave/OverSecure panels embed a base64 JSON blob in the root div.
  const m = html.match(/data-panel="([^"]+)"/);
  if (!m) throw new Error('Could not find `data-panel="..."` in HTML.');
  return m[1];
}

function normalizeSchemes(input) {
  const raw = (input ?? "vless,vmess,trojan,ss")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length === 0) return new Set(["vless", "vmess", "trojan", "ss"]);
  return new Set(raw.map((s) => s.toLowerCase()));
}

function getPositionalArgs(argv) {
  // Avoid treating flag values (like `--out-links foo.txt`) as positionals.
  const flagsWithValues = new Set(["--out-links", "--out-b64", "--schemes"]);
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      if (flagsWithValues.has(a)) i++; // skip its value (validated later via getArgValue)
      continue;
    }
    positional.push(a);
  }

  return positional;
}

async function main() {
  const argv = process.argv.slice(2);

  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    console.log(usage());
    process.exitCode = 0;
    return;
  }

  const positional = getPositionalArgs(argv);
  const url = positional[0];
  if (!url) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const outLinks = getArgValue(argv, "--out-links") ?? "v2ray_links.txt";
  const outB64 = getArgValue(argv, "--out-b64") ?? "v2ray_subscription.b64";
  const schemes = normalizeSchemes(getArgValue(argv, "--schemes"));
  const shouldPrint = hasFlag(argv, "--print");

  const res = await globalThis.fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const panelB64 = extractDataPanelBase64(html);
  const panelJsonText = Buffer.from(
    withBase64Padding(panelB64),
    "base64",
  ).toString("utf8");

  let panel;
  try {
    panel = JSON.parse(panelJsonText);
  } catch {
    throw new Error("Decoded data-panel is not valid JSON (page format may have changed).");
  }

  const linksRaw = panel?.response?.links;
  if (!Array.isArray(linksRaw)) {
    throw new Error("Decoded panel JSON did not contain `response.links` array.");
  }

  const links = linksRaw
    .filter((x) => typeof x === "string")
    .filter((s) => {
      const scheme = s.split(":")[0]?.toLowerCase();
      return scheme && schemes.has(scheme);
    });

  if (links.length === 0) {
    throw new Error("No links matched requested schemes.");
  }

  const plain = links.join("\n");
  const b64 = Buffer.from(plain, "utf8").toString("base64");

  await writeFile(outLinks, plain + "\n", "utf8");
  await writeFile(outB64, b64 + "\n", "ascii");

  console.log(`Wrote ${links.length} links to: ${outLinks}`);
  console.log(`Wrote base64 subscription to: ${outB64}`);
  if (shouldPrint) console.log(b64);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
});
