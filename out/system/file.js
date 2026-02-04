"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFileModule = createFileModule;
exports.resolveUserPath = resolveUserPath;
exports.safeJsonParse = safeJsonParse;
exports.parseCsvSimple = parseCsvSimple;
exports.ensureDir = ensureDir;
function createFileModule(env) {
    const fs = env.fs;
    const path = env.path;
    const cwd = env.cwd;
    return {
        read: async (p) => {
            const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
            return await fs.promises.readFile(full, "utf8");
        },
        write: async (p, data) => {
            const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
            await ensureDir(fs, path.dirname(full));
            await fs.promises.writeFile(full, String(data ?? ""), "utf8");
        },
        append: async (p, data) => {
            const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
            await ensureDir(fs, path.dirname(full));
            await fs.promises.appendFile(full, String(data ?? ""), "utf8");
        },
        delete: async (p) => {
            const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
            await fs.promises.rm(full, { force: true });
        },
        exists: async (p) => {
            const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
            try {
                await fs.promises.access(full, fs.constants.F_OK);
                return true;
            }
            catch {
                return false;
            }
        },
        info: async (p) => {
            const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
            const st = await fs.promises.stat(full);
            const info = {
                size: st.size,
                created: st.birthtime.toISOString(),
                modified: st.mtime.toISOString(),
            };
            return info;
        },
        copy: async (src, dst) => {
            const s = resolveUserPath(src, { cwd, path, homeDir: env.homeDir });
            const d = resolveUserPath(dst, { cwd, path, homeDir: env.homeDir });
            await ensureDir(fs, path.dirname(d));
            await fs.promises.copyFile(s, d);
        },
        move: async (src, dst) => {
            const s = resolveUserPath(src, { cwd, path, homeDir: env.homeDir });
            const d = resolveUserPath(dst, { cwd, path, homeDir: env.homeDir });
            await ensureDir(fs, path.dirname(d));
            await fs.promises.rename(s, d);
        },
        dir: {
            create: async (p) => {
                const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
                await ensureDir(fs, full);
            },
            list: async (p) => {
                const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
                return await fs.promises.readdir(full);
            },
        },
        read_json: async (p) => {
            const content = await fs.promises.readFile(resolveUserPath(p, { cwd, path, homeDir: env.homeDir }), "utf8");
            const parsed = safeJsonParse(content);
            return parsed;
        },
        write_json: async (p, obj) => {
            const txt = JSON.stringify(obj, null, 2);
            const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
            await ensureDir(fs, path.dirname(full));
            await fs.promises.writeFile(full, txt, "utf8");
        },
        read_csv: async (p) => {
            const full = resolveUserPath(p, { cwd, path, homeDir: env.homeDir });
            const txt = await fs.promises.readFile(full, "utf8");
            return parseCsvSimple(txt);
        },
    };
}
/* =========================================================
   Path resolution
   ========================================================= */
function resolveUserPath(userPath, env) {
    const p = String(userPath ?? "").trim();
    if (!p)
        return env.cwd;
    // Expand ~ (Unix-like)
    if (p.startsWith("~")) {
        const home = env.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? env.cwd;
        return env.path.resolve(home, p.slice(1));
    }
    // Absolute stays absolute
    if (env.path.isAbsolute(p))
        return p;
    // Relative from cwd
    return env.path.resolve(env.cwd, p);
}
/* =========================================================
   JSON
   ========================================================= */
function safeJsonParse(text) {
    try {
        return JSON.parse(String(text ?? ""));
    }
    catch (e) {
        throw new Error(`Invalid JSON: ${String(e?.message ?? e)}`);
    }
}
/* =========================================================
   CSV (simple)
   ========================================================= */
function parseCsvSimple(text) {
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
async function ensureDir(fs, dir) {
    await fs.promises.mkdir(dir, { recursive: true });
}
//# sourceMappingURL=file.js.map