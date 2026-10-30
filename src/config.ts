import { realpathSync, statSync } from "node:fs";

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  const integer = (name: string, fallback: number, max: number) => {
    if (env[name] === undefined) return fallback;
    const value = env[name]!.trim();
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
      throw new Error(`Invalid ${name}: expected an integer between 1 and ${max}`);
    }
    return Number(value);
  };
  const baseName = env.VIKUNJA_BASE_URL !== undefined ? "VIKUNJA_BASE_URL" : "VIKUNJA_API_URL";
  const rawUrl = env[baseName]?.trim() ?? "http://vikunja:3456";
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error(`Invalid ${baseName}: expected an absolute HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid ${baseName}: use HTTP(S) without credentials, query or fragment`);
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = basePath.endsWith("/api/v1") ? basePath : `${basePath}/api/v1`;
  const port = integer("PORT", 9090, 65535);
  const list = (name: string, fallback: string[]) => {
    if (env[name] === undefined) return fallback;
    const items = env[name]!.split(",").map(s => s.trim());
    if (items.some(s => !s)) throw new Error(`Invalid ${name}: expected a nonempty comma-separated allowlist`);
    return items;
  };
  const allowedHosts = list("VIKUNJA_MCP_ALLOWED_HOSTS", [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]).map(host => {
    let parsed: URL;
    try { parsed = new URL(`http://${host}`); } catch { throw new Error("Invalid VIKUNJA_MCP_ALLOWED_HOSTS"); }
    if (!/^[a-z\d.[\]:-]+$/i.test(host) || parsed.host.toLowerCase() !== host.toLowerCase() || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error("Invalid VIKUNJA_MCP_ALLOWED_HOSTS: use host names with optional ports");
    }
    return host.toLowerCase();
  });
  const allowedOrigins = list("VIKUNJA_MCP_ALLOWED_ORIGINS", allowedHosts.map(host => `http://${host}`)).map(origin => {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error("Invalid VIKUNJA_MCP_ALLOWED_ORIGINS"); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error("Invalid VIKUNJA_MCP_ALLOWED_ORIGINS: use exact HTTP(S) origins without paths");
    }
    return origin;
  });
  let uploadDirectory: string | undefined;
  if (env.VIKUNJA_UPLOAD_DIRECTORY !== undefined) {
    try {
      uploadDirectory = realpathSync(required("VIKUNJA_UPLOAD_DIRECTORY"));
      if (!statSync(uploadDirectory).isDirectory()) throw new Error();
    } catch { throw new Error("Invalid VIKUNJA_UPLOAD_DIRECTORY: expected an existing import directory"); }
  }
  if (env.VIKUNJA_USER_ID !== undefined) integer("VIKUNJA_USER_ID", 0, Number.MAX_SAFE_INTEGER);
  if (env.VIKUNJA_MCP_VALIDATE_ONLY !== undefined && !["0", "1"].includes(env.VIKUNJA_MCP_VALIDATE_ONLY)) {
    throw new Error("Invalid VIKUNJA_MCP_VALIDATE_ONLY: expected 0 or 1");
  }
  if (env.VIKUNJA_REQUIRE_ATOMIC_UPDATES !== undefined && !["0", "1"].includes(env.VIKUNJA_REQUIRE_ATOMIC_UPDATES)) {
    throw new Error("Invalid VIKUNJA_REQUIRE_ATOMIC_UPDATES: expected 0 or 1");
  }
  if (env.HOST !== undefined && !env.HOST.trim()) throw new Error("Invalid HOST");
  return {
    baseApiUrl: url.toString().replace(/\/$/, ""),
    token: required("VIKUNJA_TOKEN"), apiKey: required("VIKUNJA_MCP_API_KEY"),
    timeoutMs: integer("VIKUNJA_TIMEOUT_MS", 10_000, 300_000), port,
    host: env.HOST?.trim() ?? "127.0.0.1", allowedHosts, allowedOrigins,
    uploadDirectory, maxUploadBytes: integer("VIKUNJA_MAX_UPLOAD_BYTES", 524_288, 52_428_800),
    maxConcurrentRequests: integer("VIKUNJA_MCP_MAX_CONCURRENT_REQUESTS", 32, 1024),
    requireAtomicUpdates: env.VIKUNJA_REQUIRE_ATOMIC_UPDATES !== "0",
  };
}

export type Config = ReturnType<typeof loadConfig>;
