# Forge Language Support (VS Code Extension)

Forge Language Support adds syntax highlighting, diagnostics, and a runner for `.forge` files.

## Features

- Syntax highlighting (TextMate grammar)
- Diagnostics (lexer/parser/semantic + lint pipeline)
- Command: `Forge: Run File`
- Configurable runner and diagnostics behavior

## Requirements

- Node.js 20+ recommended
- VS Code 1.85+

## Quick Start (Development)

```bash
npm install
npm run compile
```

Then:

1. Open this folder in VS Code.
2. Press `F5` to start an Extension Development Host.
3. Create a `.forge` file.
4. Run `Forge: Run File` from the Command Palette.

## Example

```forge
disable 'AllInOne';
able 'Math', 'Time', 'Sys';

let dog = 'Fuffy';
console.text.var(l.dog);
```

## Commands

- `forge.runFile` -> **Forge: Run File**
- `forge.toggleDiagnostics` -> **Forge: Toggle Diagnostics**

## Extension Settings

- `forge.diagnostics.enabled`
- `forge.runner.outputChannel`
- `forge.runner.autoSaveBeforeRun`
- `forge.system.allowSysExec`

## Scripts

- `npm run compile` - Compile TypeScript
- `npm run watch` - Compile in watch mode
- `npm run lint` - Lint source
- `npm run check` - Compile + lint
- `npm run package` - Build `.vsix`

## Publishing

This repo is prepared for GitHub + CI. Before publishing to Marketplace, confirm:

1. `publisher` in `package.json` matches your actual publisher id.
2. `repository`, `bugs`, and `homepage` URLs are correct.
3. You can package successfully:

```bash
npm run compile
npm run package
```

## Open Collaboration

This repository is intentionally open and free to access.

Contributions are welcome and appreciated: if you want to fix bugs, improve code quality, refine docs, or extend features, please open a PR.

I actively appreciate community help in correcting, modifying, and improving this project.

See `CONTRIBUTING.md` for contribution flow and guidelines.

## License

MIT - see `LICENSE`.
