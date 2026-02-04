// src/core/file.ts
//
// Forge File Module (Node adapters)
// ---------------------------------
// This module implements the File.* API (read/write/append/delete/etc.)
// as pure functions over injected Node adapters (fs/path).
//
// It is designed to be used by run.ts (runtime) to create builtins:
//   const File = createFileModule({ fs, path, cwd: process.cwd() })
//
// Exports:
//   - createFileModule(env): ForgeFileModule
//   - resolveUserPath()
//   - parseCsvSimple()
//   - safeJsonParse()
//
// Notes:
// - All functions are async and UTF-8 for text.
// - JSON read/write are provided as helpers.
// - CSV is deliberately simple (comma split, no quotes escaping).
//   You can replace it with a real CSV parser later.

import type * as NodeFs from "fs";
import type * as NodePath from "path";

export type ForgeFileInfo = {
  size: number;
  created: string; // ISO string
  modified: string; // ISO string
};

export type ForgeFileModule = {
  read: (p: string) => Promise<string>;
  write: (p: string, data: string) => Promise<void>;
  append: (p: string, data: string) => Promise<void>;
  delete: (p: string) => Promise<void>;
  exists: (p: string) => Promise<boolean>;
  info: (p: string) => Promise<ForgeFileInfo>;
  copy: (src: string, dst: string) => Promise<void>;
  move: (src: string, dst: string) => Promise<void>;

  dir: {
    create: (p: string) => Promise<void>;
    list: (p: string) => Promise<string[]>;
  };

  // Convenience helpers (match your examples: File.read.json / File.write.json)
  read_json: (p: string) => Promise<any>;
  write_json: (p: string, obj: any) => Promise<void>;

  // Optional simple CSV
  read_csv: (p: string) => Promise<string[][]>;
};

export type FileEnv = {
  fs: typeof import("fs");
  path: typeof import("path");
  cwd: string;
  // Expand ~ to home if provided
  homeDir?: string;
};

export function createFileModule(env: FileEnv): ForgeFileModule {
  const fs = env.fs;
  const path = env.path;
  const cwd = env.cwd;

  return {
    read: async (p: string) => {
      const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
      return await fs.promises.readFile(full, "utf8");
    },

    write: async (p: string, data: string) => {
      const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
      await ensureDir(fs, path.dirname(full));
      await fs.promises.writeFile(full, String(data ?? ""), "utf8");
    },

    append: async (p: string, data: string) => {
      const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
      await ensureDir(fs, path.dirname(full));
      await fs.promises.appendFile(full, String(data ?? ""), "utf8");
    },

    delete: async (p: string) => {
      const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
      await fs.promises.rm(full, { force: true });
    },

    exists: async (p: string) => {
      const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
      try {
        await fs.promises.access(full, fs.constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },

    info: async (p: string) => {
      const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
      const st = await fs.promises.stat(full);
      const info: ForgeFileInfo = {
        size: st.size,
        created: st.birthtime.toISOString(),
        modified: st.mtime.toISOString(),
      };
      return info;
    },

    copy: async (src: string, dst: string) => {
      const s = resolveUserPath(src, { cwd, path, homeDir: env.homeDir });
      const d = resolveUserPath(dst, { cwd, path, homeDir: env.homeDir });
      await ensureDir(fs, path.dirname(d));
      await fs.promises.copyFile(s, d);
    },

    move: async (src: string, dst: string) => {
      const s = resolveUserPath(src, { cwd, path, homeDir: env.homeDir });
      const d = resolveUserPath(dst, { cwd, path, homeDir: env.homeDir });
      await ensureDir(fs, path.dirname(d));
      await fs.promises.rename(s, d);
    },

    dir: {
      create: async (p: string) => {
        const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
        await ensureDir(fs, full);
      },
      list: async (p: string) => {
        const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
        return await fs.promises.readdir(full);
      },
    },

    read_json: async (p: string) => {
      const content = await fs.promises.readFile(
        resolveUserPath(p, { cwd, path, homeDir: env.homeDir }),
        "utf8"
      );
      const parsed = safeJsonParse(content);
      return parsed;
    },

    write_json: async (p: string, obj: any) => {
      const txt = JSON.stringify(obj, null, 2);
      const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
      await ensureDir(fs, path.dirname(full));
      await fs.promises.writeFile(full, txt, "utf8");
    },

    read_csv: async (p: string) => {
      const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
      const txt = await fs.promises.readFile(full, "utf8");
      return parseCsvSimple(txt);
    },
  };
}

/* =========================================================
   Path resolution
   ========================================================= */

export function resolveUserPath(
  userPath: string,
  env: { cwd: string; path: typeof import("path"); homeDir?: string }
): string {
  const p = String(userPath ?? "").trim();
  if (!p) return env.cwd;

  // Expand ~ (Unix-like)
  if (p.startsWith("~")) {
    const home = env.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? env.cwd;
    return env.path.resolve(home, p.slice(1));
  }

  // Absolute stays absolute
  if (env.path.isAbsolute(p)) return p;

  // Relative from cwd
  return env.path.resolve(env.cwd, p);
}

/* =========================================================
   JSON
   ========================================================= */

export function safeJsonParse(text: string): any {
  try {
    return JSON.parse(String(text ?? ""));
  } catch (e: any) {
    throw new Error(`Invalid JSON: ${String(e?.message ?? e)}`);
  }
}

/* =========================================================
   CSV (simple)
   ========================================================= */

export function parseCsvSimple(text: string): string[][] {
  // Deliberately simple parser:
  // - split lines
  // - split commas
  // - trim cells
  // - ignores quotes/escapes
  return String(text ?? "")
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => line.split(",").map((c) => c.trim()));
}

/* =========================================================
   FS helpers
   ========================================================= */

export async function ensureDir(fs: typeof import("fs"), dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}
