// src/core/time.ts
//
// Forge Time Module (runtime + helpers)
// ------------------------------------
// Implements the Time.* API from your Forge spec:
//
//   Time.wait(1s)
//   Time.set.fps(20)
//
// Plus some extra helpers that are useful for the evaluator/runtime:
// - parseDurationMs()
// - formatDurationMs()
// - createFrameClock()  (optional for animations)
//
// This module is used by run.ts (runtime) to build builtins.
//
// Exports:
//   - createTimeModule(env): ForgeTimeModule
//   - parseDurationMs()
//   - formatDurationMs()
//   - createFrameClock()
//
// Notes:
// - Duration input accepts: "120ms", "1s", "0.5s", "2m", "1h"
// - Also accepts raw number as milliseconds.

export type ForgeTimeModule = {
  wait: (duration: string | number) => Promise<void>;
  set: {
    fps: (fps: number) => void;
  };

  // Exposed state (optional)
  get: {
    fps: () => number;
    frameMs: () => number;
  };
};

export type TimeEnv = {
  sleep: (ms: number) => Promise<void>;
  onFpsChanged?: (fps: number) => void;
  initialFps?: number;
};

export function createTimeModule(env: TimeEnv): ForgeTimeModule {
  let fps = clampInt(env.initialFps ?? 30, 1, 240);

  return {
    wait: async (duration: string | number) => {
      const ms = typeof duration === "number" ? duration : parseDurationMs(String(duration ?? ""));
      await env.sleep(Math.max(0, ms));
    },

    set: {
      fps: (next: number) => {
        fps = clampInt(next, 1, 240);
        env.onFpsChanged?.(fps);
      },
    },

    get: {
      fps: () => fps,
      frameMs: () => Math.round(1000 / fps),
    },
  };
}

/* =========================================================
   Duration parsing
   ========================================================= */

export function parseDurationMs(input: string): number {
  // Supports:
  // - "1s", "0.5s"
  // - "120ms"
  // - "2m"
  // - "1h"
  // - "500" -> treated as ms
  const s = String(input ?? "").trim();
  if (!s) return 0;

  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h)?$/i);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
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

export function formatDurationMs(ms: number): string {
  const n = Math.max(0, Math.round(Number(ms)));
  if (n < 1000) return `${n}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 2)}s`;
  if (n < 3_600_000) return `${(n / 60_000).toFixed(n % 60_000 === 0 ? 0 : 2)}m`;
  return `${(n / 3_600_000).toFixed(n % 3_600_000 === 0 ? 0 : 2)}h`;
}

/* =========================================================
   Frame clock (optional helper)
   ========================================================= */

export type FrameClock = {
  fps: number;
  frameMs: number;
  sleepFrame: () => Promise<void>;
  setFps: (fps: number) => void;
};

export function createFrameClock(env: { sleep: (ms: number) => Promise<void>; fps?: number }): FrameClock {
  let fps = clampInt(env.fps ?? 30, 1, 240);

  return {
    get fps() {
      return fps;
    },
    get frameMs() {
      return Math.round(1000 / fps);
    },
    sleepFrame: async () => {
      await env.sleep(Math.round(1000 / fps));
    },
    setFps: (next: number) => {
      fps = clampInt(next, 1, 240);
    },
  };
}

/* =========================================================
   Utils
   ========================================================= */

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}
