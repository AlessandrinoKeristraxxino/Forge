"use strict";
// src/core/terminal.ui.ts
//
// Forge Terminal UI Runtime (interactive + printing)
// --------------------------------------------------
// This module bridges the pure renderers (terminal.ts) with real I/O.
// It is used by run.ts (or evaluator runtime) to implement `Terminal.*` builtins.
//
// Split rationale:
// - terminal.ts = pure string renderers (test friendly)
// - terminal.ui.ts = interaction and printing (host/IO dependent)
//
// Exports:
//   - createTerminalModule(io, hostSleep): ForgeTerminalModule
//
// Notes:
// - This is intentionally minimal (ASCII only).
// - If you later add ANSI colors, cursor control, and better forms,
//   do it here without touching evaluator/semantic.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTerminalModule = createTerminalModule;
const terminal_1 = require("../runner/terminal");
function createTerminalModule(args) {
    const io = args.io;
    const debugEnabled = isDebugEnabled();
    const print = (text, color) => {
        io.print(colorize(text, color));
    };
    const warn = (text) => io.error(`[Forge warning] ${text}`);
    const debug = (text) => {
        if (debugEnabled)
            io.print(colorize(`[Forge debug] ${text}`, "gray"));
    };
    return {
        progress: {
            bar: (percent, opts) => {
                const safePercent = Math.max(0, Math.min(100, Number(percent)));
                const text = (0, terminal_1.renderProgressBar)(percent, {
                    width: opts?.width,
                    char: opts?.char,
                });
                debug(`progress.bar percent=${safePercent}`);
                print(text, opts?.color ?? pickProgressColor(safePercent));
            },
        },
        spinner: {
            custom: async (frames, opts) => {
                const ms = clampInt(opts?.ms ?? 80, 10, 2000);
                const ticks = clampInt(opts?.ticks ?? 20, 1, 10_000);
                const safeFrames = Array.isArray(frames) && frames.length > 0 ? frames : ["-", "\\", "|", "/"];
                if (!Array.isArray(frames) || frames.length === 0)
                    warn("Spinner frames missing; using default frames.");
                debug(`spinner.custom ticks=${ticks} ms=${ms}`);
                let i = 0;
                for (const frame of (0, terminal_1.spinnerFrames)(safeFrames, { ticks })) {
                    // Minimal spinner: just prints each frame on its own line.
                    // For "real" spinner you want carriage returns / cursor control.
                    const spinColor = opts?.color ?? PRETTY_PALETTE[i % PRETTY_PALETTE.length];
                    print(String(frame), spinColor);
                    i++;
                    await args.sleep(ms);
                }
            },
        },
        table: {
            styled: (rows, opts) => {
                if (!Array.isArray(rows) || rows.length === 0) {
                    warn("table.styled received no rows.");
                    return;
                }
                const text = (0, terminal_1.renderTable)(rows, { style: opts?.style ?? "grid" });
                debug(`table.styled rows=${rows.length} style=${opts?.style ?? "grid"}`);
                if (!text)
                    return;
                if (opts?.color) {
                    print(text, opts.color);
                    return;
                }
                io.print(colorizeByLine(text, ["bright_cyan", "bright_blue", "gray"]));
            },
        },
        banner: (text, opts) => {
            const b = (0, terminal_1.renderBanner)(String(text ?? ""), { font: opts?.font ?? "small" });
            debug(`banner font=${opts?.font ?? "small"}`);
            if (opts?.color) {
                print(b, opts.color);
                return;
            }
            io.print(rainbowText(b, ["bright_magenta", "bright_cyan", "bright_yellow", "bright_blue"]));
        },
        tree: (obj, opts) => {
            const t = (0, terminal_1.renderTree)(obj, { maxDepth: opts?.maxDepth ?? 10 });
            debug(`tree maxDepth=${opts?.maxDepth ?? 10}`);
            if (t)
                print(t, "green");
        },
        form: async (schema) => {
            const out = {};
            for (const field of schema ?? []) {
                try {
                    if (field.type === "select") {
                        if (!field.options.length) {
                            warn(`Form field '${field.name}' has no options.`);
                            out[field.name] = null;
                            continue;
                        }
                        print(field.label, "cyan");
                        field.options.forEach((o, i) => print(`  [${i + 1}] ${o}`, "gray"));
                        const raw = await io.readLine("> ");
                        const idx = Number(raw);
                        const safeIdx = Number.isFinite(idx) ? idx : 1;
                        const chosen = field.options[Math.max(0, Math.min(field.options.length - 1, safeIdx - 1))];
                        out[field.name] = chosen;
                        continue;
                    }
                    if (field.type === "number") {
                        const raw = await io.readLine(field.label);
                        const value = Number(raw);
                        if (!Number.isFinite(value)) {
                            warn(`Form field '${field.name}' expected a number.`);
                            out[field.name] = null;
                        }
                        else {
                            out[field.name] = value;
                        }
                        continue;
                    }
                    // password/text: we don't hide input in basic IO
                    const raw = await io.readLine(field.label);
                    out[field.name] = raw;
                }
                catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    io.error(`[Forge error] Failed to read form field '${field.name}': ${message}`);
                    out[field.name] = null;
                }
            }
            return out;
        },
    };
}
const PRETTY_PALETTE = [
    "bright_cyan",
    "bright_magenta",
    "bright_blue",
    "bright_yellow",
    "bright_green",
];
function isDebugEnabled() {
    const raw = String(process.env.FORGE_DEBUG_TERMINAL ?? "").toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
}
function colorize(text, color) {
    if (!color)
        return text;
    const code = color === "red" ? "31" :
        color === "green" ? "32" :
            color === "yellow" ? "33" :
                color === "blue" ? "34" :
                    color === "magenta" ? "35" :
                        color === "cyan" ? "36" :
                            color === "bright_red" ? "91" :
                                color === "bright_green" ? "92" :
                                    color === "bright_yellow" ? "93" :
                                        color === "bright_blue" ? "94" :
                                            color === "bright_magenta" ? "95" :
                                                color === "bright_cyan" ? "96" :
                                                    "90";
    return `\x1b[${code}m${text}\x1b[0m`;
}
function pickProgressColor(percent) {
    if (percent < 25)
        return "bright_red";
    if (percent < 50)
        return "bright_yellow";
    if (percent < 75)
        return "bright_cyan";
    return "bright_green";
}
function colorizeByLine(text, palette) {
    const lines = text.split(/\r?\n/);
    return lines
        .map((line, idx) => colorize(line, palette[idx % palette.length]))
        .join("\n");
}
function rainbowText(text, palette) {
    let out = "";
    let i = 0;
    for (const ch of text) {
        if (ch === "\n" || ch === "\r" || ch === " ") {
            out += ch;
            continue;
        }
        out += colorize(ch, palette[i % palette.length]);
        i++;
    }
    return out;
}
function clampInt(n, lo, hi) {
    const x = Math.floor(Number(n));
    if (!Number.isFinite(x))
        return lo;
    return Math.max(lo, Math.min(hi, x));
}
//# sourceMappingURL=terminal-ui.js.map