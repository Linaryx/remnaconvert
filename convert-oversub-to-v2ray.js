#!/usr/bin/env bun
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  bun run convert-oversub-to-v2ray.js <subscription_url> [--out-links v2ray_links.txt] [--out-b64 v2ray_subscription.b64] [--schemes vless,vmess,trojan,ss] [--user-agent Happ/1.0] [--hwid <uuid>] [--header Name=Value] [--print]",
    "",
    "Examples:",
    '  bun run convert-oversub-to-v2ray.js "https://example.com/sub/replace_me"',
    '  bun run convert-oversub-to-v2ray.js "https://example.com/sub/replace_me" --user-agent "Happ/1.0" --hwid "00000000-0000-0000-0000-000000000000"',
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

function getAllArgValues(argv, name) {
  const values = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    values.push(value);
    i++;
  }

  return values;
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

function splitLinks(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function decodeDirectSubscription(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (/(^|\n)\s*(vless|vmess|trojan|ss):\/\//i.test(trimmed)) {
    return splitLinks(trimmed);
  }

  const normalized = trimmed
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;

  let decoded;
  try {
    decoded = Buffer.from(withBase64Padding(normalized), "base64").toString(
      "utf8",
    );
  } catch {
    return null;
  }

  if (!/(^|\n)\s*(vless|vmess|trojan|ss):\/\//i.test(decoded)) {
    return null;
  }

  return splitLinks(decoded);
}

const ARROW_CHARS = /[\u2B07\u2B06\u27A1\u2B05\u2191\u2193\u2192\u2190]/;

function isArrowLink(link) {
  const hash = link.indexOf("#");
  let fragment = hash !== -1 ? link.slice(hash + 1) : "";
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // keep raw on decode failure
  }
  return ARROW_CHARS.test(fragment);
}

function appendParam(params, key, value) {
  if (value === undefined || value === null || value === "") return;
  params.set(key, String(value));
}

function extractProxyOutbound(config) {
  if (!Array.isArray(config?.outbounds)) return null;

  return (
    config.outbounds.find((outbound) => outbound?.tag === "proxy") ??
    config.outbounds.find((outbound) =>
      ["vless", "vmess", "trojan", "ss"].includes(
        outbound?.protocol?.toLowerCase?.(),
      ),
    ) ??
    null
  );
}

function vlessOutboundToLink(outbound, remarks) {
  const vnext = outbound?.settings?.vnext?.[0];
  const user = vnext?.users?.[0];
  if (!vnext?.address || !vnext?.port || !user?.id) return null;

  const params = new URLSearchParams();
  appendParam(params, "encryption", user.encryption ?? "none");
  appendParam(params, "flow", user.flow);

  const stream = outbound?.streamSettings ?? {};
  appendParam(params, "type", stream.network ?? "tcp");
  appendParam(params, "security", stream.security);

  if (stream.security === "reality") {
    appendParam(params, "sni", stream.realitySettings?.serverName);
    appendParam(params, "pbk", stream.realitySettings?.publicKey);
    appendParam(params, "sid", stream.realitySettings?.shortId);
    appendParam(params, "spx", stream.realitySettings?.spiderX);
    appendParam(params, "fp", stream.realitySettings?.fingerprint);
  }

  if (stream.network === "ws") {
    appendParam(params, "path", stream.wsSettings?.path);
    appendParam(params, "host", stream.wsSettings?.headers?.Host);
  }

  if (stream.network === "grpc") {
    appendParam(params, "serviceName", stream.grpcSettings?.serviceName);
    appendParam(params, "authority", stream.grpcSettings?.authority);
  }

  if (stream.network === "xhttp") {
    appendParam(params, "path", stream.xhttpSettings?.path);
    appendParam(params, "host", stream.xhttpSettings?.host);
    appendParam(params, "mode", stream.xhttpSettings?.mode);
  }

  if (stream.network === "tcp") {
    appendParam(params, "headerType", stream.tcpSettings?.header?.type);
  }

  const label = encodeURIComponent(remarks || vnext.address);
  return `vless://${user.id}@${vnext.address}:${vnext.port}?${params.toString()}#${label}`;
}

function extractLinksFromJsonConfigs(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }

  const configs = Array.isArray(parsed) ? parsed : [parsed];
  const links = configs
    .map((config) => {
      const outbound = extractProxyOutbound(config);
      if (!outbound) return null;

      const protocol = outbound?.protocol?.toLowerCase?.();
      if (protocol === "vless") {
        return vlessOutboundToLink(outbound, config?.remarks);
      }

      return null;
    })
    .filter((link) => typeof link === "string");

  return links.length > 0 ? links : null;
}

function extractLinksFromResponse(bodyText) {
  const directLinks = decodeDirectSubscription(bodyText);
  if (directLinks) return directLinks;

  const configLinks = extractLinksFromJsonConfigs(bodyText);
  if (configLinks) return configLinks;

  const panelB64 = extractDataPanelBase64(bodyText);
  const panelJsonText = Buffer.from(
    withBase64Padding(panelB64),
    "base64",
  ).toString("utf8");

  let panel;
  try {
    panel = JSON.parse(panelJsonText);
  } catch {
    throw new Error(
      "Decoded data-panel is not valid JSON (page format may have changed).",
    );
  }

  const linksRaw = panel?.response?.links;
  if (!Array.isArray(linksRaw)) {
    throw new Error(
      "Decoded panel JSON did not contain `response.links` array.",
    );
  }

  return linksRaw.filter((x) => typeof x === "string");
}

function normalizeSchemes(input) {
  const raw = (input ?? "vless,vmess,trojan,ss")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length === 0) return new Set(["vless", "vmess", "trojan", "ss"]);
  return new Set(raw.map((s) => s.toLowerCase()));
}

function buildRequestHeaders(argv) {
  const headers = {
    accept: "*/*",
  };

  const userAgent = getArgValue(argv, "--user-agent");
  if (userAgent) headers["user-agent"] = userAgent;

  const hwid = getArgValue(argv, "--hwid");
  if (hwid) headers["x-hwid"] = hwid;

  for (const raw of getAllArgValues(argv, "--header")) {
    const separator = raw.includes("=") ? "=" : raw.includes(":") ? ":" : null;
    if (!separator) {
      throw new Error(`Invalid header format: ${raw}. Use Name=Value.`);
    }

    const idx = raw.indexOf(separator);
    const name = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!name) {
      throw new Error(`Invalid header name in: ${raw}`);
    }
    headers[name] = value;
  }

  return headers;
}

function getPositionalArgs(argv) {
  // Avoid treating flag values as positionals.
  const flagsWithValues = new Set([
    "--out-links",
    "--out-b64",
    "--schemes",
    "--user-agent",
    "--hwid",
    "--header",
  ]);
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      if (flagsWithValues.has(a)) i++;
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
  const headers = buildRequestHeaders(argv);

  const res = await globalThis.fetch(url, {
    headers,
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  const bodyText = await res.text();
  const links = extractLinksFromResponse(bodyText)
    .filter((s) => !isArrowLink(s))
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
