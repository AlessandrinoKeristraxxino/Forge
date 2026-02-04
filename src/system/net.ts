// src/core/net.ts
//
// Forge Net Module (HTTP + download + online + ping)
// --------------------------------------------------
// This module implements the Net.* API using an injected fetch adapter.
// It is meant to be used by run.ts runtime host.
//
// Features:
// - Net.get(url, headers?)
// - Net.post(url, body, headers?)
// - Net.download(url, outPath)
// - Net.isOnline (boolean check)
// - Net.ping(host)
//
// Notes:
// - In Node 18+, global fetch exists. In older Node, you'd polyfill.
// - "ping" is approximated via a HEAD request timing. Real ICMP ping is not portable
//   without extra permissions/binaries, so we keep it safe and consistent.
//
// Exports:
//   - createNetModule(env): ForgeNetModule
//   - readResponseBody(res): any
//   - normalizeHeaders()

import type * as NodeFs from "fs";
import type * as NodePath from "path";

export type NetResponse = {
  status: number;
  body: any;
  headers?: Record<string, string>;
};

export type ForgeNetModule = {
  get: (url: string, headers?: Record<string, string>) => Promise<NetResponse>;
  post: (url: string, body: any, headers?: Record<string, string>) => Promise<NetResponse>;
  download: (url: string, outPath: string) => Promise<void>;
  isOnline: () => Promise<boolean>;
  ping: (host: string) => Promise<{ latency: number }>;
};

export type NetEnv = {
  fetch: typeof fetch;
  fs: typeof import("fs");
  path: typeof import("path");
  cwd: string;

  // Optional: default headers, user agent, etc.
  defaultHeaders?: Record<string, string>;
};

export function createNetModule(env: NetEnv): ForgeNetModule {
  const fetch = env.fetch;
  const fs = env.fs;
  const path = env.path;

  const defaultHeaders = normalizeHeaders(env.defaultHeaders ?? {});

  return {
    get: async (url: string, headers?: Record<string, string>) => {
      const h = { ...defaultHeaders, ...normalizeHeaders(headers ?? {}) };

      const res = await fetch(String(url), {
        method: "GET",
        headers: h,
      } as any);

      const body = await readResponseBody(res);
      return {
        status: res.status,
        body,
        headers: headersToRecord(res.headers),
      };
    },

    post: async (url: string, body: any, headers?: Record<string, string>) => {
      const isString = typeof body === "string";
      const payload = isString ? body : JSON.stringify(body);

      const h = {
        ...defaultHeaders,
        "content-type": isString ? "text/plain; charset=utf-8" : "application/json",
        ...normalizeHeaders(headers ?? {}),
      };

      const res = await fetch(String(url), {
        method: "POST",
        headers: h,
        body: payload,
      } as any);

      const out = await readResponseBody(res);
      return {
        status: res.status,
        body: out,
        headers: headersToRecord(res.headers),
      };
    },

    download: async (url: string, outPath: string) => {
      const res = await fetch(String(url), { method: "GET" } as any);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);

      const buf = Buffer.from(await res.arrayBuffer());

      const full = resolveUserPath(outPath, env.cwd, path);
      await ensureDir(fs, path.dirname(full));
      await fs.promises.writeFile(full, buf);
    },

    isOnline: async () => {
      // Safe online check: do a HEAD to a stable domain.
      // If the environment blocks network, it'll return false.
      try {
        const res = await fetch("https://example.com", { method: "HEAD" } as any);
        return res.ok;
      } catch {
        return false;
      }
    },

    ping: async (host: string) => {
      // Approximated ping via HEAD request.
      const url = normalizeHostToUrl(host);

      const t0 = nowMs();
      try {
        await fetch(url, { method: "HEAD" } as any);
      } catch {
        // ignore failures; still return elapsed time
      }
      const t1 = nowMs();

      return { latency: Math.max(0, Math.round(t1 - t0)) };
    },
  };
}

/* =========================================================
   Helpers
   ========================================================= */

export async function readResponseBody(res: Response): Promise<any> {
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();

  if (ct.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      // fallback to text if invalid json
      return await res.text();
    }
  }

  if (ct.startsWith("text/") || ct.includes("charset=")) {
    return await res.text();
  }

  // Try binary as base64 so Forge can carry it as text if needed.
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  } catch {
    return await res.text();
  }
}

export function normalizeHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const key = String(k).trim();
    if (!key) continue;
    out[key] = String(v ?? "");
  }
  return out;
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    h.forEach((v, k) => {
      out[k] = v;
    });
  } catch {
    // ignore
  }
  return out;
}

function nowMs(): number {
  const perf = (globalThis as any).performance;
  if (perf && typeof perf.now === "function") return perf.now();
  return Date.now();
}

function normalizeHostToUrl(host: string): string {
  const s = String(host ?? "").trim();
  if (!s) return "https://example.com";

  if (s.startsWith("http://") || s.startsWith("https://")) return s;

  // If it's like "google.com", use https by default
  return `https://${s}`;
}

function resolveUserPath(p: string, cwd: string, path: typeof import("path")): string {
  const s = String(p ?? "").trim();
  if (!s) return cwd;
  if (path.isAbsolute(s)) return s;
  if (s.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? cwd;
    return path.resolve(home, s.slice(1));
  }
  return path.resolve(cwd, s);
}

async function ensureDir(fs: typeof import("fs"), dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}
