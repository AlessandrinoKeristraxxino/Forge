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

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as readline from "readline/promises";

import type { Program } from "../core/ast";
import type { Diagnostic } from "../diagnostics/errors";
import { error as mkError, mergeDiagnostics, dedupeDiagnostics, sortDiagnostics } from "../diagnostics/errors";
import { analyzeText, type ForgeLanguageOptions } from "../language/forge.language";

/* =========================================================
   Public types
   ========================================================= */

export type RunOptions = {
  filename?: string; // for diagnostics / relative paths
  cwd?: string; // default: process.cwd()

  // Analysis tuning (optional)
  analysis?: ForgeLanguageOptions;

  // IO host (if not provided, a default Node host is used)
  io?: ForgeIO;

  // Runtime safety / limits
  maxSteps?: number; // prevent infinite loops (if your evaluator supports it)
  timeoutMs?: number; // if you implement cancellation later

  // Override builtins (modules/functions)
  builtins?: Partial<ForgeBuiltins>;

  // If true, skip execution when there are warnings only (default false).
  stopOnWarnings?: boolean;
};

export type RunResult = {
  ok: boolean;
  exitCode: number;

  stdout: string;
  stderr: string;

  // Diagnostics from analysis stage (and runtime stage, if available)
  diagnostics: Diagnostic[];

  // Execution value (if your evaluator returns a value)
  value?: unknown;

  // Debug timings
  timings?: {
    analysisMs: number;
    execMs: number;
    totalMs: number;
  };
};

export type ForgeIO = {
  print: (text: string) => void;
  error: (text: string) => void;

  // interactive input
  readLine: (prompt?: string) => Promise<string>;

  // optional: progress / status hooks
  onFpsChanged?: (fps: number) => void;
};

export type ForgeRuntimeHost = {
  io: ForgeIO;
  cwd: string;
  filename?: string;

  // Adapters (testable)
  fs: typeof fs;
  os: typeof os;
  crypto: typeof crypto;
  exec: (cmd: string, options?: { cwd?: string }) => Promise<string>;

  // Web fetch adapter
  fetch: typeof fetch;

  // Time adapter
  sleep: (ms: number) => Promise<void>;
};

export type ForgeBuiltins = {
  // root functions
  console: {
    text: {
      var: (value: any) => void;
    };
  };

  inp: ((prompt?: string) => Promise<string>) & {
    var: (prompt?: string) => Promise<string>;
  };

  chekBoolean: (value: any) => boolean;

  // Modules (namespaces)
  Time: {
    wait: (duration: string | number) => Promise<void>;
    set: {
      fps: (fps: number) => void;
    };
  };

  Sys: {
    exec: (cmd: string) => Promise<string>;
    exec_async: (cmd: string) => Promise<void>;
    process: {
      id: number;
      kill: (pid: number) => void;
    };
    cpu: {
      cores: number;
      usage: number; // best effort
      model: string;
    };
    os: {
      name: string;
      version: string;
      arch: string;
      platform: string;
    };
    chek: {
      // You used Sys.chek.ram.GB and Sys.chek.ram.comp in your spec
      ram: {
        GB: number;
        comp: string;
        compFn: (name: string) => string;
      };
      comp: (name: string) => string;
    };
  };

  File: {
    read: (p: string) => Promise<string>;
    write: (p: string, data: string) => Promise<void>;
    append: (p: string, data: string) => Promise<void>;
    delete: (p: string) => Promise<void>;
    exists: (p: string) => Promise<boolean>;
    info: (p: string) => Promise<{ size: number; created: string; modified: string }>;
    copy: (src: string, dst: string) => Promise<void>;
    move: (src: string, dst: string) => Promise<void>;

    dir: {
      create: (p: string) => Promise<void>;
      list: (p: string) => Promise<string[]>;
    };

    read_json: (p: string) => Promise<any>;
    write_json: (p: string, obj: any) => Promise<void>;

    // Optional: CSV helpers (very simple)
    read_csv: (p: string) => Promise<string[][]>;
  };

  Net: {
    get: (url: string, options?: { headers?: Record<string, string> }) => Promise<{ status: number; body: any }>;
    post: (url: string, body: any, options?: { headers?: Record<string, string> }) => Promise<{ status: number; body: any }>;
    download: (url: string, outPath: string) => Promise<void>;
    isOnline: () => Promise<boolean>;
    ping: (host: string) => Promise<{ latency: number }>;
  };

  Crypto: {
    hash: {
      md5: (text: string) => string;
      sha256: (text: string) => string;
    };
    base64: {
      encode: (text: string) => string;
      decode: (text: string) => string;
    };
    generate: {
      key: (bits: number) => string;
      uuid: () => string;
    };
    aes: {
      encrypt: (plain: string, keyHex: string) => string;
      decrypt: (cipherB64: string, keyHex: string) => string;
    };
    random: (min: number, max: number) => number;
  };

  Terminal: {
    progress: {
      bar: (percent: number, opts?: { width?: number; char?: string }) => void;
    };
    banner: (text: string, opts?: { font?: "small" | "big" }) => void;
    table: {
      styled: (rows: string[][], opts?: { style?: "grid" | "plain" }) => void;
    };
    tree: (obj: any) => void;
    spinner: {
      custom: (frames: string[], opts?: { ms?: number; ticks?: number }) => Promise<void>;
    };
    form: (schema: any[]) => Promise<Record<string, any>>;
  };
};

/* =========================================================
   Runner: analyze + execute
   ========================================================= */

export async function runForgeSource(source: string, options: RunOptions = {}): Promise<RunResult> {
  const started = nowMs();

  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];

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
  const analysis = analyzeText(source, options.analysis ?? {});
  const analysisMs = nowMs() - a0;

  const analysisDiags = sortDiagnostics(dedupeDiagnostics(analysis.diagnostics ?? []));

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
    const diag = mkError(
      "RUN_NO_AST",
      "Cannot execute: the program AST is missing (parser failed).",
      {
        start: { offset: 0, line: 0, column: 0 },
        end: { offset: Math.min(1, source.length), line: 0, column: Math.min(1, source.length) },
      },
      "parser"
    );

    return {
      ok: false,
      exitCode: 1,
      stdout: stdoutBuf.join(""),
      stderr: stderrBuf.join(""),
      diagnostics: sortDiagnostics(mergeDiagnostics(analysisDiags, [diag])),
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
  } catch (err: any) {
    const execMs = nowMs() - e0;

    // Convert runtime error into a diagnostic at "unknown" location.
    // If your evaluator throws with range info, you can map it here.
    const diag = mkError(
      "RUN_RUNTIME_ERROR",
      `Runtime error: ${String(err?.message ?? err)}`,
      {
        start: { offset: 0, line: 0, column: 0 },
        end: { offset: Math.min(1, source.length), line: 0, column: Math.min(1, source.length) },
      },
      "semantic",
      "Check the stack trace / printed logs for details."
    );

    io.error(`${String(err?.stack ?? err)}\n`);

    return {
      ok: false,
      exitCode: 1,
      stdout: stdoutBuf.join(""),
      stderr: stderrBuf.join(""),
      diagnostics: sortDiagnostics(mergeDiagnostics(analysisDiags, [diag])),
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

export function createDefaultRuntimeHost(args: { io: ForgeIO; cwd: string; filename?: string }): ForgeRuntimeHost {
  return {
    io: args.io,
    cwd: args.cwd,
    filename: args.filename,

    fs,
    os,
    crypto,

    exec: async (cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd ?? args.cwd;
      return await execToString(cmd, { cwd });
    },

    fetch: globalThis.fetch.bind(globalThis),

    sleep: (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
      }),
  };
}

/* =========================================================
   Default IO (Node)
   ========================================================= */

export function createDefaultNodeIO(args?: {
  captureStdout?: (s: string) => void;
  captureStderr?: (s: string) => void;
}): ForgeIO {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const capOut = args?.captureStdout ?? (() => {});
  const capErr = args?.captureStderr ?? (() => {});

  return {
    print: (text: string) => {
      const s = ensureEndsWithNewline(text);
      capOut(s);
      process.stdout.write(s);
    },
    error: (text: string) => {
      const s = ensureEndsWithNewline(text);
      capErr(s);
      process.stderr.write(s);
    },
    readLine: async (prompt?: string) => {
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

export function createDefaultBuiltins(host: ForgeRuntimeHost, overrides?: Partial<ForgeBuiltins>): ForgeBuiltins {
  const io = host.io;

  // ---- console.text.var ----
  const consoleObj = {
    text: {
      var: (value: any) => {
        io.print(stringifyForge(value));
      },
    },
  };

  // ---- inp / inp.var ----
  const inpFn = (async (prompt?: string) => {
    const p = prompt ?? "";
    // Forge allows template-ish strings; by runtime we just accept a string
    return await io.readLine(p);
  }) as ForgeBuiltins["inp"];
  inpFn.var = async (prompt?: string) => inpFn(prompt);

  // ---- chekBoolean ----
  const chekBoolean = (value: any) => typeof value === "boolean";

  // ---- Time ----
  let currentFps = 30;
  const Time = {
    wait: async (duration: string | number) => {
      const ms = typeof duration === "number" ? duration : parseDurationMs(String(duration));
      await host.sleep(ms);
    },
    set: {
      fps: (fps: number) => {
        const f = Math.max(1, Math.min(240, Math.floor(fps)));
        currentFps = f;
        io.onFpsChanged?.(f);
      },
    },
  };

  // ---- Sys ----
  const Sys = {
    exec: async (cmd: string) => host.exec(cmd, { cwd: host.cwd }),
    exec_async: async (cmd: string) => {
      // Fire-and-forget
      childProcess.exec(cmd, { cwd: host.cwd });
    },
    process: {
      id: process.pid,
      kill: (pid: number) => {
        try {
          process.kill(pid);
        } catch (e) {
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
        compFn: (name: string) => String(name),
      },
      comp: (name: string) => String(name),
    },
  };

  // ---- File ----
  const File = {
    read: async (p: string) => {
      const full = resolveUserPath(p, host.cwd);
      return await host.fs.promises.readFile(full, "utf8");
    },
    write: async (p: string, data: string) => {
      const full = resolveUserPath(p, host.cwd);
      await ensureDir(path.dirname(full));
      await host.fs.promises.writeFile(full, data, "utf8");
    },
    append: async (p: string, data: string) => {
      const full = resolveUserPath(p, host.cwd);
      await ensureDir(path.dirname(full));
      await host.fs.promises.appendFile(full, data, "utf8");
    },
    delete: async (p: string) => {
      const full = resolveUserPath(p, host.cwd);
      await host.fs.promises.rm(full, { force: true });
    },
    exists: async (p: string) => {
      const full = resolveUserPath(p, host.cwd);
      try {
        await host.fs.promises.access(full, host.fs.constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    info: async (p: string) => {
      const full = resolveUserPath(p, host.cwd);
      const st = await host.fs.promises.stat(full);
      return {
        size: st.size,
        created: st.birthtime.toISOString(),
        modified: st.mtime.toISOString(),
      };
    },
    copy: async (src: string, dst: string) => {
      const s = resolveUserPath(src, host.cwd);
      const d = resolveUserPath(dst, host.cwd);
      await ensureDir(path.dirname(d));
      await host.fs.promises.copyFile(s, d);
    },
    move: async (src: string, dst: string) => {
      const s = resolveUserPath(src, host.cwd);
      const d = resolveUserPath(dst, host.cwd);
      await ensureDir(path.dirname(d));
      await host.fs.promises.rename(s, d);
    },
    dir: {
      create: async (p: string) => {
        const full = resolveUserPath(p, host.cwd);
        await ensureDir(full);
      },
      list: async (p: string) => {
        const full = resolveUserPath(p, host.cwd);
        return await host.fs.promises.readdir(full);
      },
    },
    read_json: async (p: string) => {
      const txt = await File.read(p);
      return JSON.parse(txt);
    },
    write_json: async (p: string, obj: any) => {
      const txt = JSON.stringify(obj, null, 2);
      await File.write(p, txt);
    },
    read_csv: async (p: string) => {
      const txt = await File.read(p);
      return txt
        .split(/\r?\n/g)
        .filter((l) => l.trim().length > 0)
        .map((line) => line.split(",").map((x) => x.trim()));
    },
  };

  // ---- Net ----
  const Net = {
    get: async (url: string, options?: { headers?: Record<string, string> }) => {
      const res = await host.fetch(url, {
        method: "GET",
        headers: options?.headers,
      } as any);
      const contentType = res.headers.get("content-type") ?? "";
      const body = contentType.includes("application/json") ? await res.json() : await res.text();
      return { status: res.status, body };
    },
    post: async (url: string, body: any, options?: { headers?: Record<string, string> }) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(options?.headers ?? {}),
      };
      const res = await host.fetch(url, {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      } as any);
      const contentType = res.headers.get("content-type") ?? "";
      const out = contentType.includes("application/json") ? await res.json() : await res.text();
      return { status: res.status, body: out };
    },
    download: async (url: string, outPath: string) => {
      const res = await host.fetch(url);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      const full = resolveUserPath(outPath, host.cwd);
      await ensureDir(path.dirname(full));
      await host.fs.promises.writeFile(full, buf);
    },
    isOnline: async () => {
      try {
        const res = await host.fetch("https://example.com", { method: "HEAD" } as any);
        return res.ok;
      } catch {
        return false;
      }
    },
    ping: async (hostName: string) => {
      // Very rough approximation: measure a DNS resolve + tcp-ish via fetch HEAD.
      const url = hostName.startsWith("http") ? hostName : `https://${hostName}`;
      const t0 = nowMs();
      try {
        await host.fetch(url, { method: "HEAD" } as any);
      } catch {
        // ignore
      }
      const t1 = nowMs();
      return { latency: Math.max(0, Math.round(t1 - t0)) };
    },
  };

  // ---- Crypto ----
  const Crypto = {
    hash: {
      md5: (text: string) => crypto.createHash("md5").update(text, "utf8").digest("hex"),
      sha256: (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    },
    base64: {
      encode: (text: string) => Buffer.from(text, "utf8").toString("base64"),
      decode: (text: string) => Buffer.from(text, "base64").toString("utf8"),
    },
    generate: {
      key: (bits: number) => crypto.randomBytes(Math.max(16, Math.floor(bits / 8))).toString("hex"),
      uuid: () => crypto.randomUUID(),
    },
    aes: {
      encrypt: (plain: string, keyHex: string) => {
        // AES-256-GCM (best practice), key must be 32 bytes (64 hex chars)
        const key = normalizeAesKey(keyHex);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        // iv | tag | ciphertext
        return Buffer.concat([iv, tag, enc]).toString("base64");
      },
      decrypt: (cipherB64: string, keyHex: string) => {
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
    random: (min: number, max: number) => {
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
      bar: (percent: number, opts?: { width?: number; char?: string }) => {
        const width = Math.max(10, Math.min(120, Math.floor(opts?.width ?? 40)));
        const ch = (opts?.char ?? "█").slice(0, 1);
        const p = Math.max(0, Math.min(100, percent));
        const filled = Math.round((p / 100) * width);
        const bar = ch.repeat(filled) + " ".repeat(Math.max(0, width - filled));
        io.print(`[${bar}] ${p.toFixed(0)}%`);
      },
    },
    banner: (text: string, opts?: { font?: "small" | "big" }) => {
      const font = opts?.font ?? "small";
      if (font === "big") {
        io.print("========================================");
        io.print(`  ${text}`);
        io.print("========================================");
      } else {
        io.print(`=== ${text} ===`);
      }
    },
    table: {
      styled: (rows: string[][], opts?: { style?: "grid" | "plain" }) => {
        const style = opts?.style ?? "grid";
        if (!rows.length) return;

        const colCount = Math.max(...rows.map((r) => r.length));
        const widths = new Array(colCount).fill(0).map((_, i) => {
          return Math.max(...rows.map((r) => (r[i] ?? "").length));
        });

        const line = (left: string, mid: string, right: string) =>
          left +
          widths.map((w) => "─".repeat(w + 2)).join(mid) +
          right;

        const formatRow = (r: string[]) =>
          "│" +
          widths
            .map((w, i) => {
              const cell = (r[i] ?? "").toString();
              return " " + cell.padEnd(w, " ") + " ";
            })
            .join("│") +
          "│";

        if (style === "plain") {
          for (const r of rows) io.print(r.join("  "));
          return;
        }

        io.print(line("┌", "┬", "┐"));
        io.print(formatRow(rows[0]));
        io.print(line("├", "┼", "┤"));
        for (const r of rows.slice(1)) io.print(formatRow(r));
        io.print(line("└", "┴", "┘"));
      },
    },
    tree: (obj: any) => {
      const lines: string[] = [];
      renderTree(obj, "", true, lines);
      io.print(lines.join("\n"));
    },
    spinner: {
      custom: async (frames: string[], opts?: { ms?: number; ticks?: number }) => {
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
    form: async (schema: any[]) => {
      // Very simple interactive form.
      const out: Record<string, any> = {};
      for (const field of schema ?? []) {
        const type = String(field?.type ?? "text");
        const name = String(field?.name ?? "field");
        const label = String(field?.label ?? `${name}: `);
        if (type === "password") {
          // No hidden input in basic terminal; treat as normal.
          out[name] = await io.readLine(label);
        } else if (type === "number") {
          const v = await io.readLine(label);
          out[name] = Number(v);
        } else if (type === "select") {
          const options = Array.isArray(field?.options) ? field.options : [];
          io.print(`${label}`);
          options.forEach((o: any, i: number) => io.print(`  [${i + 1}] ${String(o)}`));
          const idx = Number(await io.readLine("> "));
          out[name] = options[Math.max(0, Math.min(options.length - 1, idx - 1))];
        } else {
          out[name] = await io.readLine(label);
        }
      }
      return out;
    },
  };

  const builtins: ForgeBuiltins = {
    console: consoleObj as any,
    inp: inpFn as any,
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

async function executeProgram(
  program: Program,
  source: string,
  host: ForgeRuntimeHost,
  builtins: ForgeBuiltins,
  limits?: { maxSteps?: number }
): Promise<unknown> {
  // We import evaluator as a namespace to avoid hard-coding exported names.
  // This prevents compile issues if you rename the function later.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Evaluator: any = await Promise.resolve().then(() => require("../core/evaluator"));

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
    if (typeof ev.run === "function") return await ev.run(program);
  }

  // Fallback MVP executor so the language remains usable while evaluator is evolving.
  host.io.error(
    "[Forge warning] No evaluator export found. Falling back to MVP runtime (let/var/const + console.text.var).\n"
  );
  return executeProgramMvp(program, builtins);
}

async function executeProgramMvp(program: Program, builtins: ForgeBuiltins): Promise<unknown> {
  const stores = {
    l: new Map<string, unknown>(),
    v: new Map<string, unknown>(),
    c: new Map<string, unknown>(),
  };

  const evalExpr = async (expr: any): Promise<unknown> => {
    if (!expr) return null;

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
          if (p?.kind === "TemplateTextPart") out += String(p.value ?? "");
          else if (p?.kind === "TemplateExprPart") out += String(await evalExpr(p.expression));
        }
        return out;
      }
      case "Identifier": {
        const name = String(expr.name ?? "");
        if (stores.l.has(name)) return stores.l.get(name);
        if (stores.v.has(name)) return stores.v.get(name);
        if (stores.c.has(name)) return stores.c.get(name);
        return null;
      }
      case "NamespacedIdentifier": {
        const ns = String(expr.namespace ?? "");
        const name = String(expr.name?.name ?? expr.name?.value ?? "");
        if (ns === "l") return stores.l.get(name);
        if (ns === "v") return stores.v.get(name);
        if (ns === "c") return stores.c.get(name);
        return null;
      }
      default:
        return null;
    }
  };

  for (const st of (program as any).body ?? []) {
    if (!st) continue;

    if (st.kind === "VarDeclaration") {
      const declKind = String(st.declKind ?? "let");
      const name = String(st.name?.name ?? st.name?.value ?? "");
      const val = await evalExpr(st.initializer);
      if (!name) continue;
      if (declKind === "let") stores.l.set(name, val);
      else if (declKind === "var") stores.v.set(name, val);
      else stores.c.set(name, val);
      continue;
    }

    if (st.kind === "ExpressionStatement") {
      const expr = st.expression;
      if (
        expr?.kind === "CallExpression" &&
        expr?.callee?.kind === "MemberExpression" &&
        expr.callee?.object?.kind === "MemberExpression" &&
        expr.callee.object?.object?.kind === "Identifier" &&
        expr.callee.object?.object?.name === "console" &&
        expr.callee.object?.property?.name === "text" &&
        expr.callee?.property?.name === "var"
      ) {
        const args = Array.isArray(expr.args) ? expr.args : [];
        const firstArg = args[0];
        const first =
          firstArg?.kind === "NamedArgument" || firstArg?.kind === "PositionalArgument"
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

function nowMs(): number {
  const perf = (globalThis as any).performance;
  if (perf && typeof perf.now === "function") return perf.now();
  return Date.now();
}

function ensureEndsWithNewline(text: string): string {
  if (text.endsWith("\n")) return text;
  return text + "\n";
}

function stringifyForge(value: any): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseDurationMs(input: string): number {
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
  const mult =
    unit === "ms" ? 1 :
    unit === "s" ? 1000 :
    unit === "m" ? 60_000 :
    unit === "h" ? 3_600_000 :
    1;
  return Math.max(0, Math.round(n * mult));
}

async function execToString(cmd: string, opts: { cwd: string }): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    childProcess.exec(cmd, { cwd: opts.cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.toString() || err.message));
        return;
      }
      resolve(stdout?.toString() ?? "");
    });
  });
}

function resolveUserPath(p: string, cwd: string): string {
  const s = String(p ?? "").trim();
  if (!s) return cwd;

  // Expand ~
  if (s.startsWith("~")) {
    const home = os.homedir();
    return path.resolve(home, s.slice(1));
  }

  // Absolute stays absolute
  if (path.isAbsolute(s)) return s;

  // Otherwise relative to cwd
  return path.resolve(cwd, s);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

function normalizeAesKey(keyHex: string): Buffer {
  // Need 32 bytes for AES-256-GCM.
  // If shorter, hash it; if longer, slice.
  const raw = Buffer.from(String(keyHex ?? ""), "hex");
  if (raw.length === 32) return raw;
  if (raw.length > 32) return raw.subarray(0, 32);
  return crypto.createHash("sha256").update(raw).digest(); // 32 bytes
}

function estimateCpuUsagePercent(): number {
  // Best-effort: return 0..100. Real CPU usage needs sampling.
  // We'll just return 0 for now to avoid lying.
  return 0;
}

function renderTree(node: any, prefix: string, isLast: boolean, out: string[]): void {
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
      } else {
        out.push(nextPrefix + (last ? "└─ " : "├─ ") + `${k}: ${String(v)}`);
      }
    });
    return;
  }

  out.push(prefix + pointer + String(node));
}

function deepMergeBuiltins<T extends Record<string, any>>(base: T, patch: Partial<T>): T {
  const out: any = Array.isArray(base) ? [...base] : { ...base };

  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined) continue;

    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") {
      out[k] = deepMergeBuiltins(out[k], v as any);
      continue;
    }

    out[k] = v;
  }

  return out as T;
}
