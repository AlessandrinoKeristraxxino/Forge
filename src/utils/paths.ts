// src/core/paths.ts
//
// Forge Paths Helpers
// -------------------
// Centralizes path utilities used across runtime modules (File/Net/Config/Runner).
//
// Why?
// - Prevents each module from re-implementing "~" expansion, cwd resolution, etc.
// - Keeps behavior consistent across features (runner, config loader, file module)
//
// Exports:
//   - resolveUserPath()
//   - tryResolveWorkspaceRoot()
//   - normalizeSlashes()
//   - isProbablyUri()
//   - toPosixPath()
//   - toNativePath()
//
// Notes:
// - This is Node-focused (extension host / CLI).
// - Workspace root resolution is best-effort and does not depend on VS Code APIs.

import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export type ResolvePathEnv = {
  cwd: string;
  homeDir?: string;
};

/**
 * Resolve user-provided path into an absolute filesystem path.
 * Supports:
 * - relative paths (resolved from cwd)
 * - absolute paths
 * - "~" home expansion
 */
export function resolveUserPath(userPath: string, env: ResolvePathEnv): string {
  const p = String(userPath ?? "").trim();
  if (!p) return env.cwd;

  // Home expansion
  if (p.startsWith("~")) {
    const home = env.homeDir ?? os.homedir();
    return path.resolve(home, p.slice(1));
  }

  // Already absolute
  if (path.isAbsolute(p)) return p;

  // Relative
  return path.resolve(env.cwd, p);
}

/**
 * Try to find a workspace/project root by walking upwards from `startPath`
 * until we find a marker (package.json, .git, forge.config.json).
 *
 * Returns null if not found.
 */
export async function tryResolveWorkspaceRoot(startPath: string): Promise<string | null> {
  let current = startPath;

  // If startPath is a file, start from its directory
  try {
    const st = await fs.promises.stat(current);
    if (st.isFile()) current = path.dirname(current);
  } catch {
    // ignore
  }

  // Walk up to filesystem root
  while (true) {
    const markers = ["forge.config.json", "package.json", ".git"];
    for (const m of markers) {
      const candidate = path.join(current, m);
      if (await exists(candidate)) return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/**
 * Normalize slashes to "/" (useful for matching and storage).
 */
export function normalizeSlashes(p: string): string {
  return String(p ?? "").replace(/\\/g, "/");
}

/**
 * Very small heuristic: looks like "file://", "http://", "https://".
 */
export function isProbablyUri(s: string): boolean {
  const t = String(s ?? "").trim().toLowerCase();
  return t.startsWith("file://") || t.startsWith("http://") || t.startsWith("https://");
}

/**
 * Convert a native path to posix-style (forward slashes).
 */
export function toPosixPath(nativePath: string): string {
  return normalizeSlashes(nativePath);
}

/**
 * Convert a posix-style path to the current platform native path.
 */
export function toNativePath(posixPath: string): string {
  const p = String(posixPath ?? "");
  if (path.sep === "/") return p;
  return p.replace(/\//g, "\\");
}

/* =========================================================
   Internal
   ========================================================= */

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
