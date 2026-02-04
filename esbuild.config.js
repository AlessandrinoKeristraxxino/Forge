// esbuild.config.js
// Bundles the VS Code extension entrypoint (src/extension.ts) into out/extension.js
// Fast builds, clean output, and works well for packaging.
//
// Usage:
//   node esbuild.config.js
//   node esbuild.config.js --watch
//
// Optional in package.json scripts:
//   "build": "node esbuild.config.js",
//   "watch": "node esbuild.config.js --watch"

const esbuild = require("esbuild");
const path = require("path");

const isWatch = process.argv.includes("--watch");

const projectRoot = __dirname;

const entryFile = path.join(projectRoot, "src", "extension.ts");
const outFile = path.join(projectRoot, "out", "extension.js");

const buildOptions = {
  entryPoints: [entryFile],
  outfile: outFile,

  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",

  sourcemap: true,
  sourcesContent: true,

  // VS Code provides the 'vscode' module at runtime (must not be bundled)
  external: ["vscode"],

  // Keep names readable for stack traces
  keepNames: true,

  // Some extensions prefer no minify for easier debugging
  minify: false,

  // Define Node env
  define: {
    "process.env.NODE_ENV": JSON.stringify(isWatch ? "development" : "production")
  },

  logLevel: "info"
};

async function main() {
  try {
    if (isWatch) {
      const ctx = await esbuild.context(buildOptions);
      await ctx.watch();
      console.log("[esbuild] Watching for changes...");
    } else {
      await esbuild.build(buildOptions);
      console.log("[esbuild] Build completed.");
    }
  } catch (err) {
    console.error("[esbuild] Build failed:", err);
    process.exit(1);
  }
}

main();
