// src/core/configuration.ts
//
// Forge Project / File Configuration Resolver
// -------------------------------------------
// This module reads "Forge config" from the filesystem and provides a single
// normalized config object used by the extension and tooling.
//
// For an MVP VS Code extension, this gives you:
// - project root detection
// - forge.config.json discovery
// - default language options
// - module gating defaults (AllInOne on/off)
// - include/exclude file globs
// - diagnostics toggles and lint toggles
//
// You can expand this later into a full build system.
//
// IMPORTANT: This file is Node-side (VS Code extension host), so it's fine to use fs/path.
//
// Exports:
//   - ForgeConfig (type)
//   - loadForgeConfig(filePath, workspaceRoot?): Promise<ResolvedForgeConfig>
//   - findForgeProjectRoot(startDir): Promise<string | null>

import * as fs from "fs";
import * as path from "path";

export type ForgeConfig = {
  // Name shown in logs / status
  name?: string;

  // If true, treat "AllInOne" as enabled unless disabled in source.
  // If false, require explicit `able` directives.
  defaultAllInOne?: boolean;

  // Default modules considered enabled when AllInOne is disabled (project policy).
  // Example: ["Math","Time"]
  defaultModules?: string[];

  // If true, allow "bare templates" more aggressively (inp(Hello >> )).
  // This is a parser heuristic. Real language design should prefer quotes,
  // but this helps match your examples.
  allowBareTemplates?: boolean;

  // Diagnostics options
  diagnostics?: {
    enabled?: boolean;
    // If true, semantic module gating errors become warnings.
    softModuleGating?: boolean;
    // If true, unknown member access is warning instead of error.
    relaxedMemberAccess?: boolean;
  };

  // Lint options
  lint?: {
    enabled?: boolean;
    preferLetOverVar?: boolean;
    preferQuotedPrompts?: boolean;
  };

  // File selection
  files?: {
    // Which file extensions are treated as Forge source
    extensions?: string[]; // default: [".forge"]
    // glob-ish patterns (simple) to include
    include?: string[]; // default: ["**/*.forge"]
    // glob-ish patterns (simple) to exclude
    exclude?: string[]; // default: ["**/node_modules/**", "**/dist/**", "**/out/**"]
  };
};

export type ResolvedForgeConfig = Required<ForgeConfig> & {
  projectRoot: string | null;
  configPath: string | null;
};

const DEFAULT_CONFIG: Required<ForgeConfig> = {
  name: "Forge Project",
  defaultAllInOne: true,
  defaultModules: [],
  allowBareTemplates: true,
  diagnostics: {
    enabled: true,
    softModuleGating: false,
    relaxedMemberAccess: true,
  },
  lint: {
    enabled: true,
    preferLetOverVar: true,
    preferQuotedPrompts: true,
  },
  files: {
    extensions: [".forge"],
    include: ["**/*.forge"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/out/**", "**/.git/**"],
  },
};

/* =========================================================
   Public API
   ========================================================= */

export async function loadForgeConfig(
  filePath: string,
  workspaceRoot?: string
): Promise<ResolvedForgeConfig> {
  const startDir = fs.existsSync(filePath) && fs.lstatSync(filePath).isDirectory()
    ? filePath
    : path.dirname(filePath);

  const projectRoot = (await findForgeProjectRoot(startDir)) ?? (workspaceRoot ?? null);
  const configPath = projectRoot ? await findConfigFile(projectRoot) : null;

  const userConfig = configPath ? safeReadJson<ForgeConfig>(configPath) : null;
  const merged = deepMerge(DEFAULT_CONFIG, userConfig ?? {});

  // Normalize arrays / booleans
  const resolved: ResolvedForgeConfig = {
    ...merged,
    projectRoot,
    configPath,
    defaultModules: uniqueStrings(merged.defaultModules ?? []),
    files: {
      extensions: uniqueStrings((merged.files.extensions ?? []).map(normalizeExt)),
      include: uniqueStrings(merged.files.include ?? []),
      exclude: uniqueStrings(merged.files.exclude ?? []),
    },
    diagnostics: {
      enabled: !!merged.diagnostics.enabled,
      softModuleGating: !!merged.diagnostics.softModuleGating,
      relaxedMemberAccess: !!merged.diagnostics.relaxedMemberAccess,
    },
    lint: {
      enabled: !!merged.lint.enabled,
      preferLetOverVar: !!merged.lint.preferLetOverVar,
      preferQuotedPrompts: !!merged.lint.preferQuotedPrompts,
    },
  };

  return resolved;
}

export async function findForgeProjectRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);

  // Stop at filesystem root
  for (let i = 0; i < 60; i++) {
    if (await exists(path.join(dir, "forge.config.json"))) return dir;
    if (await exists(path.join(dir, ".forge"))) return dir; // marker folder
    if (await exists(path.join(dir, ".git"))) return dir; // Git root fallback
    if (await exists(path.join(dir, "package.json"))) {
      // if this is a monorepo, we still treat it as root unless a closer config exists
      // Keep searching upward for forge.config.json but can return this if nothing else is found
      // We'll keep going.
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/* =========================================================
   Config file discovery
   ========================================================= */

async function findConfigFile(projectRoot: string): Promise<string | null> {
  const p = path.join(projectRoot, "forge.config.json");
  return (await exists(p)) ? p : null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/* =========================================================
   JSON utilities
   ========================================================= */

function safeReadJson<T>(p: string): T | null {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/* =========================================================
   Deep merge (simple & safe for config)
   ========================================================= */

function isObject(x: any): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const out: any = Array.isArray(base) ? [...base] : { ...base };

  for (const [k, v] of Object.entries(override ?? {})) {
    if (v === undefined) continue;

    if (Array.isArray(v)) {
      out[k] = v.slice();
      continue;
    }

    if (isObject(v) && isObject(out[k])) {
      out[k] = deepMerge(out[k], v);
      continue;
    }

    out[k] = v;
  }

  return out as T;
}

/* =========================================================
   Normalization helpers
   ========================================================= */

function uniqueStrings(list: string[]): string[] {
  const set = new Set<string>();
  for (const s of list ?? []) {
    const t = String(s ?? "").trim();
    if (t) set.add(t);
  }
  return [...set.values()];
}

function normalizeExt(ext: string): string {
  const e = String(ext ?? "").trim();
  if (!e) return ".forge";
  return e.startsWith(".") ? e : `.${e}`;
}
