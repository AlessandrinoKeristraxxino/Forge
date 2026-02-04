"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadForgeConfig = loadForgeConfig;
exports.findForgeProjectRoot = findForgeProjectRoot;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DEFAULT_CONFIG = {
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
async function loadForgeConfig(filePath, workspaceRoot) {
    const startDir = fs.existsSync(filePath) && fs.lstatSync(filePath).isDirectory()
        ? filePath
        : path.dirname(filePath);
    const projectRoot = (await findForgeProjectRoot(startDir)) ?? (workspaceRoot ?? null);
    const configPath = projectRoot ? await findConfigFile(projectRoot) : null;
    const userConfig = configPath ? safeReadJson(configPath) : null;
    const merged = deepMerge(DEFAULT_CONFIG, userConfig ?? {});
    // Normalize arrays / booleans
    const resolved = {
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
async function findForgeProjectRoot(startDir) {
    let dir = path.resolve(startDir);
    // Stop at filesystem root
    for (let i = 0; i < 60; i++) {
        if (await exists(path.join(dir, "forge.config.json")))
            return dir;
        if (await exists(path.join(dir, ".forge")))
            return dir; // marker folder
        if (await exists(path.join(dir, ".git")))
            return dir; // Git root fallback
        if (await exists(path.join(dir, "package.json"))) {
            // if this is a monorepo, we still treat it as root unless a closer config exists
            // Keep searching upward for forge.config.json but can return this if nothing else is found
            // We'll keep going.
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
/* =========================================================
   Config file discovery
   ========================================================= */
async function findConfigFile(projectRoot) {
    const p = path.join(projectRoot, "forge.config.json");
    return (await exists(p)) ? p : null;
}
async function exists(p) {
    try {
        await fs.promises.access(p, fs.constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
/* =========================================================
   JSON utilities
   ========================================================= */
function safeReadJson(p) {
    try {
        const raw = fs.readFileSync(p, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/* =========================================================
   Deep merge (simple & safe for config)
   ========================================================= */
function isObject(x) {
    return !!x && typeof x === "object" && !Array.isArray(x);
}
function deepMerge(base, override) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(override ?? {})) {
        if (v === undefined)
            continue;
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
    return out;
}
/* =========================================================
   Normalization helpers
   ========================================================= */
function uniqueStrings(list) {
    const set = new Set();
    for (const s of list ?? []) {
        const t = String(s ?? "").trim();
        if (t)
            set.add(t);
    }
    return [...set.values()];
}
function normalizeExt(ext) {
    const e = String(ext ?? "").trim();
    if (!e)
        return ".forge";
    return e.startsWith(".") ? e : `.${e}`;
}
//# sourceMappingURL=configuration.js.map