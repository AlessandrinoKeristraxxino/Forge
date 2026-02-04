// src/core/index.ts
//
// Forge Core Barrel Export
// ------------------------
// One import point for the VS Code extension layer.
//
// Example usage (in extension.ts):
//   import { tokenize, parseSource, analyzeProgram } from "./core";
//
// This file re-exports the public API of your language core.

export * from "./errors";
export * from "./lint";
