// src/core/terminal.ts
//
// Forge Terminal UI Helpers (render-only)
// --------------------------------------
// This module contains pure rendering helpers for "Terminal.*" APIs.
// It does NOT do real I/O. It returns strings.
// The runtime (run.ts) is responsible for printing these strings.
//
// Why split it?
// - You can reuse these in tests (snapshot output)
// - You can reuse these in web later
//
// Exports:
//   - renderProgressBar
//   - renderBanner
//   - renderTableGrid
//   - renderTree
//   - Spinner (async generator)
//   - buildFormPrompts (simple)
//
// NOTE: The fancy stuff (colors, cursor control) can be added later.
// For MVP, we keep it ASCII-safe.

export type ProgressBarOptions = {
  width?: number; // default 40
  char?: string; // default "█"
  emptyChar?: string; // default " "
  showPercent?: boolean; // default true
};

export function renderProgressBar(percent: number, opts: ProgressBarOptions = {}): string {
  const width = clampInt(opts.width ?? 40, 10, 120);
  const ch = (opts.char ?? "█").slice(0, 1) || "█";
  const empty = (opts.emptyChar ?? " ").slice(0, 1) || " ";
  const showPercent = opts.showPercent ?? true;

  const p = clampNum(percent, 0, 100);
  const filled = Math.round((p / 100) * width);
  const bar = ch.repeat(filled) + empty.repeat(Math.max(0, width - filled));

  if (!showPercent) return `[${bar}]`;
  return `[${bar}] ${p.toFixed(0)}%`;
}

/* =========================================================
   Banner
   ========================================================= */

export type BannerOptions = {
  font?: "small" | "big"; // default small
  width?: number; // used for "big"
};

export function renderBanner(text: string, opts: BannerOptions = {}): string {
  const font = opts.font ?? "small";
  const t = String(text ?? "");

  if (font === "big") {
    const w = clampInt(opts.width ?? Math.max(30, t.length + 8), 20, 140);
    const line = "=".repeat(w);
    const inner = center(` ${t} `, w, " ");
    return [line, inner, line].join("\n");
  }

  return `=== ${t} ===`;
}

function center(s: string, width: number, pad: string): string {
  if (s.length >= width) return s.slice(0, width);
  const total = width - s.length;
  const left = Math.floor(total / 2);
  const right = total - left;
  return pad.repeat(left) + s + pad.repeat(right);
}

/* =========================================================
   Table
   ========================================================= */

export type TableOptions = {
  style?: "grid" | "plain";
  maxWidth?: number; // clamp columns for safety
};

export function renderTable(rows: string[][], opts: TableOptions = {}): string {
  const style = opts.style ?? "grid";
  if (!rows || rows.length === 0) return "";

  const normalized = rows.map((r) => r.map((c) => String(c ?? "")));
  const colCount = Math.max(...normalized.map((r) => r.length));
  const maxWidth = clampInt(opts.maxWidth ?? 200, 40, 400);

  const widths = new Array(colCount).fill(0).map((_, i) => {
    const w = Math.max(...normalized.map((r) => (r[i] ?? "").length));
    return clampInt(w, 1, 80);
  });

  if (style === "plain") {
    return normalized.map((r) => r.join("  ")).join("\n");
  }

  // Grid style
  const top = line("┌", "┬", "┐", widths);
  const mid = line("├", "┼", "┤", widths);
  const bot = line("└", "┴", "┘", widths);

  const formatRow = (r: string[]) =>
    "│" +
    widths
      .map((w, i) => {
        const cell = (r[i] ?? "").slice(0, w);
        return " " + cell.padEnd(w, " ") + " ";
      })
      .join("│") +
    "│";

  const out: string[] = [];
  out.push(top);
  out.push(formatRow(normalized[0]));
  out.push(mid);
  for (const r of normalized.slice(1)) out.push(formatRow(r));
  out.push(bot);

  // Clamp final output width (best effort)
  return out.map((ln) => (ln.length > maxWidth ? ln.slice(0, maxWidth) : ln)).join("\n");
}

function line(left: string, mid: string, right: string, widths: number[]): string {
  return left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
}

/* =========================================================
   Tree view
   ========================================================= */

export type TreeOptions = {
  maxDepth?: number; // default 10
  maxChildren?: number; // default 200
};

export function renderTree(obj: any, opts: TreeOptions = {}): string {
  const maxDepth = clampInt(opts.maxDepth ?? 10, 1, 50);
  const maxChildren = clampInt(opts.maxChildren ?? 200, 10, 10_000);

  const out: string[] = [];
  walkTree(obj, "", true, out, 0, maxDepth, maxChildren);
  return out.join("\n");
}

function walkTree(
  node: any,
  prefix: string,
  isLast: boolean,
  out: string[],
  depth: number,
  maxDepth: number,
  maxChildren: number
): void {
  const pointer = isLast ? "└─ " : "├─ ";
  const nextPrefix = prefix + (isLast ? "   " : "│  ");

  if (depth >= maxDepth) {
    out.push(prefix + pointer + "…");
    return;
  }

  if (Array.isArray(node)) {
    out.push(prefix + pointer + `[${node.length}]`);
    const limit = Math.min(node.length, maxChildren);
    for (let i = 0; i < limit; i++) {
      walkTree(node[i], nextPrefix, i === limit - 1, out, depth + 1, maxDepth, maxChildren);
    }
    if (node.length > limit) out.push(nextPrefix + "└─ …");
    return;
  }

  if (node && typeof node === "object") {
    const keys = Object.keys(node);
    out.push(prefix + pointer + `{${keys.length}}`);
    const limit = Math.min(keys.length, maxChildren);
    for (let i = 0; i < limit; i++) {
      const k = keys[i];
      const last = i === limit - 1;
      const v = node[k];

      if (v && typeof v === "object") {
        out.push(nextPrefix + (last ? "└─ " : "├─ ") + k);
        walkTree(v, nextPrefix + (last ? "   " : "│  "), true, out, depth + 1, maxDepth, maxChildren);
      } else {
        out.push(nextPrefix + (last ? "└─ " : "├─ ") + `${k}: ${String(v)}`);
      }
    }
    if (keys.length > limit) out.push(nextPrefix + "└─ …");
    return;
  }

  out.push(prefix + pointer + String(node));
}

/* =========================================================
   Spinner (frames generator)
   ========================================================= */

export type SpinnerOptions = {
  ms?: number; // delay suggestion
  ticks?: number; // number of frames to emit
};

export function* spinnerFrames(frames: string[], opts: SpinnerOptions = {}): Generator<string> {
  const f = frames.length ? frames : ["-", "\\", "|", "/"];
  const ticks = clampInt(opts.ticks ?? 30, 1, 10_000);

  for (let i = 0; i < ticks; i++) {
    yield f[i % f.length];
  }
}

/* =========================================================
   Form prompts (render-only)
   ========================================================= */

export type FormField =
  | { type: "text"; name: string; label: string }
  | { type: "password"; name: string; label: string }
  | { type: "number"; name: string; label: string }
  | { type: "select"; name: string; label: string; options: string[] };

export function buildFormPrompts(schema: FormField[]): string[] {
  const out: string[] = [];
  for (const f of schema ?? []) {
    if (f.type === "select") {
      out.push(`${f.label}`);
      f.options.forEach((o, i) => out.push(`  [${i + 1}] ${o}`));
      out.push("> ");
    } else {
      out.push(`${f.label}`);
    }
  }
  return out;
}

/* =========================================================
   Util
   ========================================================= */

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function clampNum(n: number, lo: number, hi: number): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}
