"use strict";
// src/core/run.ts
//
// Forge Runner (Node / Extension Host)
// -----------------------------------
// This module runs Forge source code end-to-end:
//
// 1) analyzeText()  -> lex + parse + semantic + lint diagnostics
// 2) evaluator      -> executes the AST with a runtime host (IO + builtins)
//
// It is designed so you can use it from:
// - a VS Code command ("Forge: Run File")
// - unit tests (capture stdout/stderr)
// - a CLI later
//
// Key idea: the runtime is injected (IO + system adapters), so your evaluator stays pure.
//
// Exports:
//   - runForgeSource(source, options): Promise<RunResult>
//   - createDefaultRuntimeHost(options): ForgeRuntimeHost
//
// Notes:
// - This file uses Node APIs (fs/os/crypto/child_process/fetch). It should run in the VS Code extension host.
// - If your evaluator exports different function names, this runner autodetects them.
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
exports.runForgeSource = runForgeSource;
exports.createDefaultRuntimeHost = createDefaultRuntimeHost;
exports.createDefaultNodeIO = createDefaultNodeIO;
exports.createDefaultBuiltins = createDefaultBuiltins;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const childProcess = __importStar(require("child_process"));
const crypto = __importStar(require("crypto"));
const readline = __importStar(require("readline/promises"));
const errors_1 = require("../diagnostics/errors");
const forge_language_1 = require("../language/forge.language");
/* =========================================================
   Runner: analyze + execute
   ========================================================= */
async function runForgeSource(source, options = {}) {
    const started = nowMs();
    const stdoutBuf = [];
    const stderrBuf = [];
    // If the user didn't provide IO, we create a default Node IO that ALSO captures output.
    // In VS Code, you'd usually pass a custom IO that prints to an OutputChannel/Terminal.
    const io = options.io ?? createDefaultNodeIO({
        captureStdout: (s) => stdoutBuf.push(s),
        captureStderr: (s) => stderrBuf.push(s),
    });
    const host = createDefaultRuntimeHost({
        io,
        cwd: options.cwd ?? process.cwd(),
        filename: options.filename,
    });
    // --- ANALYSIS ---
    const a0 = nowMs();
    const analysis = (0, forge_language_1.analyzeText)(source, options.analysis ?? {});
    const analysisMs = nowMs() - a0;
    const analysisDiags = (0, errors_1.sortDiagnostics)((0, errors_1.dedupeDiagnostics)(analysis.diagnostics ?? []));
    const hasErrors = analysisDiags.some((d) => d.severity === "error");
    const hasWarnings = analysisDiags.some((d) => d.severity === "warning");
    if (hasErrors || (options.stopOnWarnings && hasWarnings)) {
        return {
            ok: false,
            exitCode: 1,
            stdout: stdoutBuf.join(""),
            stderr: stderrBuf.join(""),
            diagnostics: analysisDiags,
            timings: {
                analysisMs,
                execMs: 0,
                totalMs: nowMs() - started,
            },
        };
    }
    if (!analysis.program) {
        const diag = (0, errors_1.error)("RUN_NO_AST", "Cannot execute: the program AST is missing (parser failed).", {
            start: { offset: 0, line: 0, column: 0 },
            end: { offset: Math.min(1, source.length), line: 0, column: Math.min(1, source.length) },
        }, "parser");
        return {
            ok: false,
            exitCode: 1,
            stdout: stdoutBuf.join(""),
            stderr: stderrBuf.join(""),
            diagnostics: (0, errors_1.sortDiagnostics)((0, errors_1.mergeDiagnostics)(analysisDiags, [diag])),
            timings: {
                analysisMs,
                execMs: 0,
                totalMs: nowMs() - started,
            },
        };
    }
    // --- EXECUTION ---
    const e0 = nowMs();
    const builtins = createDefaultBuiltins(host, options.builtins);
    try {
        const value = await executeProgram(analysis.program, source, host, builtins, {
            maxSteps: options.maxSteps,
        });
        const execMs = nowMs() - e0;
        return {
            ok: true,
            exitCode: 0,
            stdout: stdoutBuf.join(""),
            stderr: stderrBuf.join(""),
            diagnostics: analysisDiags,
            value,
            timings: {
                analysisMs,
                execMs,
                totalMs: nowMs() - started,
            },
        };
    }
    catch (err) {
        const execMs = nowMs() - e0;
        // Convert runtime error into a diagnostic at "unknown" location.
        // If your evaluator throws with range info, you can map it here.
        const diag = (0, errors_1.error)("RUN_RUNTIME_ERROR", `Runtime error: ${String(err?.message ?? err)}`, {
            start: { offset: 0, line: 0, column: 0 },
            end: { offset: Math.min(1, source.length), line: 0, column: Math.min(1, source.length) },
        }, "semantic", "Check the stack trace / printed logs for details.");
        io.error(`${String(err?.stack ?? err)}\n`);
        return {
            ok: false,
            exitCode: 1,
            stdout: stdoutBuf.join(""),
            stderr: stderrBuf.join(""),
            diagnostics: (0, errors_1.sortDiagnostics)((0, errors_1.mergeDiagnostics)(analysisDiags, [diag])),
            timings: {
                analysisMs,
                execMs,
                totalMs: nowMs() - started,
            },
        };
    }
}
/* =========================================================
   Runtime host
   ========================================================= */
function createDefaultRuntimeHost(args) {
    return {
        io: args.io,
        cwd: args.cwd,
        filename: args.filename,
        fs,
        os,
        crypto,
        exec: async (cmd, options) => {
            const cwd = options?.cwd ?? args.cwd;
            return await execToString(cmd, { cwd });
        },
        fetch: globalThis.fetch.bind(globalThis),
        sleep: (ms) => new Promise((resolve) => {
            setTimeout(resolve, Math.max(0, ms));
        }),
    };
}
/* =========================================================
   Default IO (Node)
   ========================================================= */
function createDefaultNodeIO(args) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const capOut = args?.captureStdout ?? (() => { });
    const capErr = args?.captureStderr ?? (() => { });
    return {
        print: (text) => {
            const s = ensureEndsWithNewline(text);
            capOut(s);
            process.stdout.write(s);
        },
        error: (text) => {
            const s = ensureEndsWithNewline(text);
            capErr(s);
            process.stderr.write(s);
        },
        readLine: async (prompt) => {
            const p = prompt ?? "";
            if (p) {
                // print prompt without forcing newline
                capOut(p);
                process.stdout.write(p);
            }
            const line = await rl.question("");
            // keep a newline like typical terminals
            capOut("\n");
            return line;
        },
        onFpsChanged: (_fps) => {
            /* optional hook */
        },
    };
}
/* =========================================================
   Builtins (Forge standard library)
   ========================================================= */
function createDefaultBuiltins(host, overrides) {
    const io = host.io;
    // ---- console.text.var ----
    const consoleObj = {
        text: {
            var: (value) => {
                io.print(stringifyForge(value));
            },
        },
    };
    // ---- inp / inp.var ----
    const inpFn = (async (prompt) => {
        const p = prompt ?? "";
        // Forge allows template-ish strings; by runtime we just accept a string
        return await io.readLine(p);
    });
    inpFn.var = async (prompt) => inpFn(prompt);
    // ---- chekBoolean ----
    const chekBoolean = (value) => typeof value === "boolean";
    // ---- Time ----
    let currentFps = 30;
    const Time = {
        wait: async (duration) => {
            const ms = typeof duration === "number" ? duration : parseDurationMs(String(duration));
            await host.sleep(ms);
        },
        set: {
            fps: (fps) => {
                const f = Math.max(1, Math.min(240, Math.floor(fps)));
                currentFps = f;
                io.onFpsChanged?.(f);
            },
        },
    };
    // ---- Sys ----
    const Sys = {
        exec: async (cmd) => host.exec(cmd, { cwd: host.cwd }),
        exec_async: async (cmd) => {
            // Fire-and-forget
            childProcess.exec(cmd, { cwd: host.cwd });
        },
        process: {
            id: process.pid,
            kill: (pid) => {
                try {
                    process.kill(pid);
                }
                catch (e) {
                    // ignore in MVP
                }
            },
        },
        cpu: {
            cores: os.cpus()?.length ?? 1,
            usage: estimateCpuUsagePercent(),
            model: os.cpus()?.[0]?.model ?? "unknown",
        },
        os: {
            name: os.type(),
            version: os.release(),
            arch: os.arch(),
            platform: os.platform(),
        },
        chek: {
            ram: {
                GB: Math.max(1, Math.round(os.totalmem() / 1024 / 1024 / 1024)),
                comp: "unknown",
                compFn: (name) => String(name),
            },
            comp: (name) => String(name),
        },
    };
    // ---- File ----
    const File = {
        read: async (p) => {
            const full = resolveUserPath(p, host.cwd);
            return await host.fs.promises.readFile(full, "utf8");
        },
        write: async (p, data) => {
            const full = resolveUserPath(p, host.cwd);
            await ensureDir(path.dirname(full));
            await host.fs.promises.writeFile(full, data, "utf8");
        },
        append: async (p, data) => {
            const full = resolveUserPath(p, host.cwd);
            await ensureDir(path.dirname(full));
            await host.fs.promises.appendFile(full, data, "utf8");
        },
        delete: async (p) => {
            const full = resolveUserPath(p, host.cwd);
            await host.fs.promises.rm(full, { force: true });
        },
        exists: async (p) => {
            const full = resolveUserPath(p, host.cwd);
            try {
                await host.fs.promises.access(full, host.fs.constants.F_OK);
                return true;
            }
            catch {
                return false;
            }
        },
        info: async (p) => {
            const full = resolveUserPath(p, host.cwd);
            const st = await host.fs.promises.stat(full);
            return {
                size: st.size,
                created: st.birthtime.toISOString(),
                modified: st.mtime.toISOString(),
            };
        },
        copy: async (src, dst) => {
            const s = resolveUserPath(src, host.cwd);
            const d = resolveUserPath(dst, host.cwd);
            await ensureDir(path.dirname(d));
            await host.fs.promises.copyFile(s, d);
        },
        move: async (src, dst) => {
            const s = resolveUserPath(src, host.cwd);
            const d = resolveUserPath(dst, host.cwd);
            await ensureDir(path.dirname(d));
            await host.fs.promises.rename(s, d);
        },
        dir: {
            create: async (p) => {
                const full = resolveUserPath(p, host.cwd);
                await ensureDir(full);
            },
            list: async (p) => {
                const full = resolveUserPath(p, host.cwd);
                return await host.fs.promises.readdir(full);
            },
        },
        read_json: async (p) => {
            const txt = await File.read(p);
            return JSON.parse(txt);
        },
        write_json: async (p, obj) => {
            const txt = JSON.stringify(obj, null, 2);
            await File.write(p, txt);
        },
        read_csv: async (p) => {
            const txt = await File.read(p);
            return txt
                .split(/\r?\n/g)
                .filter((l) => l.trim().length > 0)
                .map((line) => line.split(",").map((x) => x.trim()));
        },
    };
    // ---- Net ----
    const Net = {
        get: async (url, options) => {
            const res = await host.fetch(url, {
                method: "GET",
                headers: options?.headers,
            });
            const contentType = res.headers.get("content-type") ?? "";
            const body = contentType.includes("application/json") ? await res.json() : await res.text();
            return { status: res.status, body };
        },
        post: async (url, body, options) => {
            const headers = {
                "content-type": "application/json",
                ...(options?.headers ?? {}),
            };
            const res = await host.fetch(url, {
                method: "POST",
                headers,
                body: typeof body === "string" ? body : JSON.stringify(body),
            });
            const contentType = res.headers.get("content-type") ?? "";
            const out = contentType.includes("application/json") ? await res.json() : await res.text();
            return { status: res.status, body: out };
        },
        download: async (url, outPath) => {
            const res = await host.fetch(url);
            if (!res.ok)
                throw new Error(`Download failed (${res.status})`);
            const buf = Buffer.from(await res.arrayBuffer());
            const full = resolveUserPath(outPath, host.cwd);
            await ensureDir(path.dirname(full));
            await host.fs.promises.writeFile(full, buf);
        },
        isOnline: async () => {
            try {
                const res = await host.fetch("https://example.com", { method: "HEAD" });
                return res.ok;
            }
            catch {
                return false;
            }
        },
        ping: async (hostName) => {
            // Very rough approximation: measure a DNS resolve + tcp-ish via fetch HEAD.
            const url = hostName.startsWith("http") ? hostName : `https://${hostName}`;
            const t0 = nowMs();
            try {
                await host.fetch(url, { method: "HEAD" });
            }
            catch {
                // ignore
            }
            const t1 = nowMs();
            return { latency: Math.max(0, Math.round(t1 - t0)) };
        },
    };
    // ---- Crypto ----
    const Crypto = {
        hash: {
            md5: (text) => crypto.createHash("md5").update(text, "utf8").digest("hex"),
            sha256: (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex"),
        },
        base64: {
            encode: (text) => Buffer.from(text, "utf8").toString("base64"),
            decode: (text) => Buffer.from(text, "base64").toString("utf8"),
        },
        generate: {
            key: (bits) => crypto.randomBytes(Math.max(16, Math.floor(bits / 8))).toString("hex"),
            uuid: () => crypto.randomUUID(),
        },
        aes: {
            encrypt: (plain, keyHex) => {
                // AES-256-GCM (best practice), key must be 32 bytes (64 hex chars)
                const key = normalizeAesKey(keyHex);
                const iv = crypto.randomBytes(12);
                const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
                const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
                const tag = cipher.getAuthTag();
                // iv | tag | ciphertext
                return Buffer.concat([iv, tag, enc]).toString("base64");
            },
            decrypt: (cipherB64, keyHex) => {
                const key = normalizeAesKey(keyHex);
                const raw = Buffer.from(cipherB64, "base64");
                const iv = raw.subarray(0, 12);
                const tag = raw.subarray(12, 28);
                const enc = raw.subarray(28);
                const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
                decipher.setAuthTag(tag);
                const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
                return dec.toString("utf8");
            },
        },
        random: (min, max) => {
            const a = Math.floor(min);
            const b = Math.floor(max);
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            return lo + crypto.randomInt(hi - lo + 1);
        },
    };
    // ---- Terminal ----
    const Terminal = {
        progress: {
            bar: (percent, opts) => {
                const width = Math.max(10, Math.min(120, Math.floor(opts?.width ?? 40)));
                const ch = (opts?.char ?? "█").slice(0, 1);
                const p = Math.max(0, Math.min(100, percent));
                const filled = Math.round((p / 100) * width);
                const bar = ch.repeat(filled) + " ".repeat(Math.max(0, width - filled));
                io.print(`[${bar}] ${p.toFixed(0)}%`);
            },
        },
        banner: (text, opts) => {
            const font = opts?.font ?? "small";
            if (font === "big") {
                io.print("========================================");
                io.print(`  ${text}`);
                io.print("========================================");
            }
            else {
                io.print(`=== ${text} ===`);
            }
        },
        table: {
            styled: (rows, opts) => {
                const style = opts?.style ?? "grid";
                if (!rows.length)
                    return;
                const colCount = Math.max(...rows.map((r) => r.length));
                const widths = new Array(colCount).fill(0).map((_, i) => {
                    return Math.max(...rows.map((r) => (r[i] ?? "").length));
                });
                const line = (left, mid, right) => left +
                    widths.map((w) => "─".repeat(w + 2)).join(mid) +
                    right;
                const formatRow = (r) => "│" +
                    widths
                        .map((w, i) => {
                        const cell = (r[i] ?? "").toString();
                        return " " + cell.padEnd(w, " ") + " ";
                    })
                        .join("│") +
                    "│";
                if (style === "plain") {
                    for (const r of rows)
                        io.print(r.join("  "));
                    return;
                }
                io.print(line("┌", "┬", "┐"));
                io.print(formatRow(rows[0]));
                io.print(line("├", "┼", "┤"));
                for (const r of rows.slice(1))
                    io.print(formatRow(r));
                io.print(line("└", "┴", "┘"));
            },
        },
        tree: (obj) => {
            const lines = [];
            renderTree(obj, "", true, lines);
            io.print(lines.join("\n"));
        },
        spinner: {
            custom: async (frames, opts) => {
                const ms = Math.max(10, Math.floor(opts?.ms ?? 80));
                const ticks = Math.max(1, Math.floor(opts?.ticks ?? 20));
                const f = frames.length ? frames : ["-", "\\", "|", "/"];
                for (let i = 0; i < ticks; i++) {
                    const frame = f[i % f.length];
                    io.print(frame);
                    await host.sleep(ms);
                }
            },
        },
        form: async (schema) => {
            // Very simple interactive form.
            const out = {};
            for (const field of schema ?? []) {
                const type = String(field?.type ?? "text");
                const name = String(field?.name ?? "field");
                const label = String(field?.label ?? `${name}: `);
                if (type === "password") {
                    // No hidden input in basic terminal; treat as normal.
                    out[name] = await io.readLine(label);
                }
                else if (type === "number") {
                    const v = await io.readLine(label);
                    out[name] = Number(v);
                }
                else if (type === "select") {
                    const options = Array.isArray(field?.options) ? field.options : [];
                    io.print(`${label}`);
                    options.forEach((o, i) => io.print(`  [${i + 1}] ${String(o)}`));
                    const idx = Number(await io.readLine("> "));
                    out[name] = options[Math.max(0, Math.min(options.length - 1, idx - 1))];
                }
                else {
                    out[name] = await io.readLine(label);
                }
            }
            return out;
        },
    };
    const builtins = {
        console: consoleObj,
        inp: inpFn,
        chekBoolean,
        Time,
        Sys,
        File,
        Net,
        Crypto,
        Terminal,
    };
    // Apply overrides (shallow merge; you can replace entire modules/functions)
    return deepMergeBuiltins(builtins, overrides ?? {});
}
/* =========================================================
   Execution adapter (autodetect evaluator exports)
   ========================================================= */
async function executeProgram(program, source, host, builtins, limits) {
    // We import evaluator as a namespace to avoid hard-coding exported names.
    // This prevents compile issues if you rename the function later.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Evaluator = await Promise.resolve().then(() => require("../core/evaluator"));
    // Most likely candidates:
    // - evaluateProgram(program, runtime)
    // - evaluate(program, runtime)
    // - run(program, runtime)
    // - Evaluator class with .run()
    const runtime = {
        host,
        builtins,
        limits: limits ?? {},
        source,
    };
    if (typeof Evaluator.evaluateProgram === "function") {
        return await Evaluator.evaluateProgram(program, runtime);
    }
    if (typeof Evaluator.evaluate === "function") {
        return await Evaluator.evaluate(program, runtime);
    }
    if (typeof Evaluator.run === "function") {
        return await Evaluator.run(program, runtime);
    }
    if (typeof Evaluator.Evaluator === "function") {
        const ev = new Evaluator.Evaluator(runtime);
        if (typeof ev.run === "function")
            return await ev.run(program);
    }
    // Fallback MVP executor so the language remains usable while evaluator is evolving.
    host.io.error("[Forge warning] No evaluator export found. Falling back to MVP runtime (let/var/const + console.text.var).\n");
    return executeProgramMvp(program, builtins);
}
async function executeProgramMvp(program, builtins) {
    const stores = {
        l: new Map(),
        v: new Map(),
        c: new Map(),
    };
    const evalExpr = async (expr) => {
        if (!expr)
            return null;
        switch (expr.kind) {
            case "StringLiteral":
            case "NumberLiteral":
            case "BooleanLiteral":
                return expr.value;
            case "NullLiteral":
                return null;
            case "TemplateString": {
                const parts = Array.isArray(expr.parts) ? expr.parts : [];
                let out = "";
                for (const p of parts) {
                    if (p?.kind === "TemplateTextPart")
                        out += String(p.value ?? "");
                    else if (p?.kind === "TemplateExprPart")
                        out += String(await evalExpr(p.expression));
                }
                return out;
            }
            case "Identifier": {
                const name = String(expr.name ?? "");
                if (stores.l.has(name))
                    return stores.l.get(name);
                if (stores.v.has(name))
                    return stores.v.get(name);
                if (stores.c.has(name))
                    return stores.c.get(name);
                return null;
            }
            case "NamespacedIdentifier": {
                const ns = String(expr.namespace ?? "");
                const name = String(expr.name?.name ?? expr.name?.value ?? "");
                if (ns === "l")
                    return stores.l.get(name);
                if (ns === "v")
                    return stores.v.get(name);
                if (ns === "c")
                    return stores.c.get(name);
                return null;
            }
            default:
                return null;
        }
    };
    for (const st of program.body ?? []) {
        if (!st)
            continue;
        if (st.kind === "VarDeclaration") {
            const declKind = String(st.declKind ?? "let");
            const name = String(st.name?.name ?? st.name?.value ?? "");
            const val = await evalExpr(st.initializer);
            if (!name)
                continue;
            if (declKind === "let")
                stores.l.set(name, val);
            else if (declKind === "var")
                stores.v.set(name, val);
            else
                stores.c.set(name, val);
            continue;
        }
        if (st.kind === "ExpressionStatement") {
            const expr = st.expression;
            if (expr?.kind === "CallExpression" &&
                expr?.callee?.kind === "MemberExpression" &&
                expr.callee?.object?.kind === "MemberExpression" &&
                expr.callee.object?.object?.kind === "Identifier" &&
                expr.callee.object?.object?.name === "console" &&
                expr.callee.object?.property?.name === "text" &&
                expr.callee?.property?.name === "var") {
                const args = Array.isArray(expr.args) ? expr.args : [];
                const firstArg = args[0];
                const first = firstArg?.kind === "NamedArgument" || firstArg?.kind === "PositionalArgument"
                    ? firstArg.value
                    : firstArg;
                const v = await evalExpr(first);
                builtins.console.text.var(v);
            }
        }
    }
    return null;
}
/* =========================================================
   Helpers
   ========================================================= */
function nowMs() {
    const perf = globalThis.performance;
    if (perf && typeof perf.now === "function")
        return perf.now();
    return Date.now();
}
function ensureEndsWithNewline(text) {
    if (text.endsWith("\n"))
        return text;
    return text + "\n";
}
function stringifyForge(value) {
    if (value === null || value === undefined)
        return "null";
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
function parseDurationMs(input) {
    // Supports:
    // - "1s", "0.5s"
    // - "120ms"
    // - "2m", "1h"
    // - raw number string treated as ms
    const s = input.trim();
    const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h)?$/i);
    if (!m) {
        // fallback: try number
        const n = Number(s);
        return Number.isFinite(n) ? Math.max(0, n) : 0;
    }
    const n = Number(m[1]);
    const unit = (m[2] ?? "ms").toLowerCase();
    const mult = unit === "ms" ? 1 :
        unit === "s" ? 1000 :
            unit === "m" ? 60_000 :
                unit === "h" ? 3_600_000 :
                    1;
    return Math.max(0, Math.round(n * mult));
}
async function execToString(cmd, opts) {
    return await new Promise((resolve, reject) => {
        childProcess.exec(cmd, { cwd: opts.cwd }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr?.toString() || err.message));
                return;
            }
            resolve(stdout?.toString() ?? "");
        });
    });
}
function resolveUserPath(p, cwd) {
    const s = String(p ?? "").trim();
    if (!s)
        return cwd;
    // Expand ~
    if (s.startsWith("~")) {
        const home = os.homedir();
        return path.resolve(home, s.slice(1));
    }
    // Absolute stays absolute
    if (path.isAbsolute(s))
        return s;
    // Otherwise relative to cwd
    return path.resolve(cwd, s);
}
async function ensureDir(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
}
function normalizeAesKey(keyHex) {
    // Need 32 bytes for AES-256-GCM.
    // If shorter, hash it; if longer, slice.
    const raw = Buffer.from(String(keyHex ?? ""), "hex");
    if (raw.length === 32)
        return raw;
    if (raw.length > 32)
        return raw.subarray(0, 32);
    return crypto.createHash("sha256").update(raw).digest(); // 32 bytes
}
function estimateCpuUsagePercent() {
    // Best-effort: return 0..100. Real CPU usage needs sampling.
    // We'll just return 0 for now to avoid lying.
    return 0;
}
function renderTree(node, prefix, isLast, out) {
    const pointer = isLast ? "└─ " : "├─ ";
    const nextPrefix = prefix + (isLast ? "   " : "│  ");
    if (Array.isArray(node)) {
        out.push(prefix + pointer + "[ ]");
        node.forEach((child, i) => renderTree(child, nextPrefix, i === node.length - 1, out));
        return;
    }
    if (node && typeof node === "object") {
        out.push(prefix + pointer + "{ }");
        const keys = Object.keys(node);
        keys.forEach((k, i) => {
            const last = i === keys.length - 1;
            const v = node[k];
            if (v && typeof v === "object") {
                out.push(nextPrefix + (last ? "└─ " : "├─ ") + k);
                renderTree(v, nextPrefix + (last ? "   " : "│  "), true, out);
            }
            else {
                out.push(nextPrefix + (last ? "└─ " : "├─ ") + `${k}: ${String(v)}`);
            }
        });
        return;
    }
    out.push(prefix + pointer + String(node));
}
function deepMergeBuiltins(base, patch) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(patch ?? {})) {
        if (v === undefined)
            continue;
        if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") {
            out[k] = deepMergeBuiltins(out[k], v);
            continue;
        }
        out[k] = v;
    }
    return out;
}
//# sourceMappingURL=run.js.map