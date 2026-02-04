"use strict";
// src/core/sys.ts
//
// Forge Sys Module (Node adapters)
// --------------------------------
// This module implements the Sys.* API and system checks used in your Forge spec.
//
// Goals:
// - Provide predictable outputs for editor/runtime
// - Keep everything testable by injecting Node adapters
// - Avoid platform-specific native dependencies
//
// IMPORTANT:
// - Real CPU usage requires sampling; we provide a best-effort function.
// - RAM "company" is not reliably detectable cross-platform; we expose "unknown"
//   and offer normalization helper functions for comparisons.
//
// Exports:
//   - createSysModule(env): ForgeSysModule
//   - estimateCpuUsagePercent(): Promise<number>
//   - normalizeVendorString()
//
// This module is meant to be used by run.ts runtime host.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSysModule = createSysModule;
exports.estimateCpuUsagePercent = estimateCpuUsagePercent;
exports.normalizeVendorString = normalizeVendorString;
function createSysModule(env) {
    const os = env.os;
    const cp = env.child_process;
    return {
        exec: async (cmd) => execToString(cp, String(cmd ?? ""), env.cwd),
        exec_async: async (cmd) => {
            cp.exec(String(cmd ?? ""), { cwd: env.cwd });
        },
        process: {
            id: env.process.pid,
            kill: (pid) => {
                try {
                    env.process.kill(pid);
                }
                catch {
                    // ignore in MVP
                }
            },
        },
        cpu: {
            cores: os.cpus()?.length ?? 1,
            usage: async () => await estimateCpuUsagePercent(os),
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
                GB: ramGB(os),
                comp: "unknown",
                compFn: (name) => normalizeVendorString(name),
            },
            comp: (name) => normalizeVendorString(name),
        },
    };
}
/* =========================================================
   Exec helper
   ========================================================= */
async function execToString(child_process, cmd, cwd) {
    return await new Promise((resolve, reject) => {
        child_process.exec(cmd, { cwd }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(String(stderr ?? err.message)));
                return;
            }
            resolve(String(stdout ?? ""));
        });
    });
}
/* =========================================================
   RAM helper
   ========================================================= */
function ramGB(os) {
    // totalmem -> bytes
    const gb = os.totalmem() / 1024 / 1024 / 1024;
    // Use rounded value for stable comparisons in scripts
    return Math.max(1, Math.round(gb));
}
/* =========================================================
   CPU usage (best effort sampling)
   ========================================================= */
async function estimateCpuUsagePercent(os) {
    // We sample CPU times twice, compute delta busy/total.
    // This is a common technique and works cross-platform.
    //
    // Note: This measures *system* CPU usage, not per-process.
    const a = cpuTimesSnapshot(os);
    await sleep(150);
    const b = cpuTimesSnapshot(os);
    const deltaTotal = b.total - a.total;
    const deltaIdle = b.idle - a.idle;
    if (deltaTotal <= 0)
        return 0;
    const busy = deltaTotal - deltaIdle;
    const pct = (busy / deltaTotal) * 100;
    return clampNum(pct, 0, 100);
}
function cpuTimesSnapshot(os) {
    const cpus = os.cpus();
    let total = 0;
    let idle = 0;
    for (const c of cpus) {
        const t = c.times;
        const sum = t.user + t.nice + t.sys + t.idle + t.irq;
        total += sum;
        idle += t.idle;
    }
    return { total, idle };
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
/* =========================================================
   Vendor normalization (for comparisons)
   ========================================================= */
function normalizeVendorString(name) {
    // Normalize for comparisons:
    // - lowercase
    // - remove spaces and punctuation
    // - keep alphanumerics and hyphen
    const s = String(name ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
    return s;
}
/* =========================================================
   Utils
   ========================================================= */
function clampNum(n, lo, hi) {
    const x = Number(n);
    if (!Number.isFinite(x))
        return lo;
    return Math.max(lo, Math.min(hi, x));
}
//# sourceMappingURL=sys.js.map