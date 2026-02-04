"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderProgressBar = renderProgressBar;
exports.renderBanner = renderBanner;
exports.renderTable = renderTable;
exports.renderTree = renderTree;
exports.spinnerFrames = spinnerFrames;
exports.buildFormPrompts = buildFormPrompts;
function renderProgressBar(percent, opts = {}) {
    const width = clampInt(opts.width ?? 40, 10, 120);
    const ch = (opts.char ?? "█").slice(0, 1) || "█";
    const empty = (opts.emptyChar ?? " ").slice(0, 1) || " ";
    const showPercent = opts.showPercent ?? true;
    const p = clampNum(percent, 0, 100);
    const filled = Math.round((p / 100) * width);
    const bar = ch.repeat(filled) + empty.repeat(Math.max(0, width - filled));
    if (!showPercent)
        return `[${bar}]`;
    return `[${bar}] ${p.toFixed(0)}%`;
}
function renderBanner(text, opts = {}) {
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
function center(s, width, pad) {
    if (s.length >= width)
        return s.slice(0, width);
    const total = width - s.length;
    const left = Math.floor(total / 2);
    const right = total - left;
    return pad.repeat(left) + s + pad.repeat(right);
}
function renderTable(rows, opts = {}) {
    const style = opts.style ?? "grid";
    if (!rows || rows.length === 0)
        return "";
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
    const formatRow = (r) => "│" +
        widths
            .map((w, i) => {
            const cell = (r[i] ?? "").slice(0, w);
            return " " + cell.padEnd(w, " ") + " ";
        })
            .join("│") +
        "│";
    const out = [];
    out.push(top);
    out.push(formatRow(normalized[0]));
    out.push(mid);
    for (const r of normalized.slice(1))
        out.push(formatRow(r));
    out.push(bot);
    // Clamp final output width (best effort)
    return out.map((ln) => (ln.length > maxWidth ? ln.slice(0, maxWidth) : ln)).join("\n");
}
function line(left, mid, right, widths) {
    return left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
}
function renderTree(obj, opts = {}) {
    const maxDepth = clampInt(opts.maxDepth ?? 10, 1, 50);
    const maxChildren = clampInt(opts.maxChildren ?? 200, 10, 10_000);
    const out = [];
    walkTree(obj, "", true, out, 0, maxDepth, maxChildren);
    return out.join("\n");
}
function walkTree(node, prefix, isLast, out, depth, maxDepth, maxChildren) {
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
        if (node.length > limit)
            out.push(nextPrefix + "└─ …");
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
            }
            else {
                out.push(nextPrefix + (last ? "└─ " : "├─ ") + `${k}: ${String(v)}`);
            }
        }
        if (keys.length > limit)
            out.push(nextPrefix + "└─ …");
        return;
    }
    out.push(prefix + pointer + String(node));
}
function* spinnerFrames(frames, opts = {}) {
    const f = frames.length ? frames : ["-", "\\", "|", "/"];
    const ticks = clampInt(opts.ticks ?? 30, 1, 10_000);
    for (let i = 0; i < ticks; i++) {
        yield f[i % f.length];
    }
}
function buildFormPrompts(schema) {
    const out = [];
    for (const f of schema ?? []) {
        if (f.type === "select") {
            out.push(`${f.label}`);
            f.options.forEach((o, i) => out.push(`  [${i + 1}] ${o}`));
            out.push("> ");
        }
        else {
            out.push(`${f.label}`);
        }
    }
    return out;
}
/* =========================================================
   Util
   ========================================================= */
function clampInt(n, lo, hi) {
    const x = Math.floor(Number(n));
    if (!Number.isFinite(x))
        return lo;
    return Math.max(lo, Math.min(hi, x));
}
function clampNum(n, lo, hi) {
    const x = Number(n);
    if (!Number.isFinite(x))
        return lo;
    return Math.max(lo, Math.min(hi, x));
}
//# sourceMappingURL=terminal.js.map