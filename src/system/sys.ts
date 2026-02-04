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

import type * as NodeOs from "os";
import type * as NodeChildProcess from "child_process";
import type * as NodeProcess from "process";

export type ForgeSysModule = {
  exec: (cmd: string) => Promise<string>;
  exec_async: (cmd: string) => Promise<void>;

  process: {
    id: number;
    kill: (pid: number) => void;
  };

  cpu: {
    cores: number;
    usage: () => Promise<number>; // percent 0..100 (best effort)
    model: string;
  };

  os: {
    name: string;
    version: string;
    arch: string;
    platform: string;
  };

  chek: {
    ram: {
      GB: number;
      comp: string;
      compFn: (name: string) => string;
    };
    comp: (name: string) => string;
  };
};

export type SysEnv = {
  os: typeof import("os");
  child_process: typeof import("child_process");
  process: NodeJS.Process;

  cwd: string;
};

export function createSysModule(env: SysEnv): ForgeSysModule {
  const os = env.os;
  const cp = env.child_process;

  return {
    exec: async (cmd: string) => execToString(cp, String(cmd ?? ""), env.cwd),
    exec_async: async (cmd: string) => {
      cp.exec(String(cmd ?? ""), { cwd: env.cwd });
    },

    process: {
      id: env.process.pid,
      kill: (pid: number) => {
        try {
          env.process.kill(pid);
        } catch {
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
        compFn: (name: string) => normalizeVendorString(name),
      },
      comp: (name: string) => normalizeVendorString(name),
    },
  };
}

/* =========================================================
   Exec helper
   ========================================================= */

async function execToString(
  child_process: typeof import("child_process"),
  cmd: string,
  cwd: string
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
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

function ramGB(os: typeof import("os")): number {
  // totalmem -> bytes
  const gb = os.totalmem() / 1024 / 1024 / 1024;
  // Use rounded value for stable comparisons in scripts
  return Math.max(1, Math.round(gb));
}

/* =========================================================
   CPU usage (best effort sampling)
   ========================================================= */

export async function estimateCpuUsagePercent(os: typeof import("os")): Promise<number> {
  // We sample CPU times twice, compute delta busy/total.
  // This is a common technique and works cross-platform.
  //
  // Note: This measures *system* CPU usage, not per-process.
  const a = cpuTimesSnapshot(os);
  await sleep(150);
  const b = cpuTimesSnapshot(os);

  const deltaTotal = b.total - a.total;
  const deltaIdle = b.idle - a.idle;

  if (deltaTotal <= 0) return 0;

  const busy = deltaTotal - deltaIdle;
  const pct = (busy / deltaTotal) * 100;

  return clampNum(pct, 0, 100);
}

function cpuTimesSnapshot(os: typeof import("os")): { total: number; idle: number } {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/* =========================================================
   Vendor normalization (for comparisons)
   ========================================================= */

export function normalizeVendorString(name: string): string {
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

function clampNum(n: number, lo: number, hi: number): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}
