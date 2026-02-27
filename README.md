# modiqo

VSCode extension for [dex](https://github.com/modiqo/dex) — Execution Context Engineering.

Provides a sidebar explorer, flow runner, workspace dashboard, and registry browser that surface everything happening inside `~/.dex`.

## Features

### Adapters

Tree view of all installed adapters with expandable detail sections:

- **Info** — tools count, spec type, usage stats, token status
- **Logs** — request history from `requests.jsonl` with status icons, duration, and relative timestamps. Hover for full request/response details in a markdown table.
- **Policies** — rate limits, timeouts, retry, circuit breaker, and logging configuration parsed from `policies.json`

Right-click context menu:

- **Configure Token** — set a token value for adapters missing credentials
- **Verify Connection** — run proof-of-life flow to test the adapter
- **Browse Catalog** — search 635+ API adapters, view specification details, and get install commands

### Flows

Tree view of all flows discovered from `~/.dex/flows/`. Grouped by org when multiple orgs exist. Click any flow to open it in the editor.

Right-click to **Run Flow** — executes via `dex deno run --allow-all` in the integrated terminal.

### Workspaces

Tree view of active workspaces from `~/.dex/dex/workspaces/`. Each workspace expands to show:

- **Trace** — opens a Gantt timeline panel showing request durations, token usage, and success rates. Bars are color-coded (green = success, red = error) with opacity encoding token intensity. Hover for detailed tooltips.
- **Commands** — opens a split-panel view with command timeline on the left and request/response JSON (syntax-highlighted) on the right. Supports `HttpRequest`, `SetVariable`, and `QueryRead` command types.
- **Response files** (`@1.json`, `@2.json`, ...) — click to open directly in the editor.

### Registry

Connects to the modiqo registry with automatic authentication handling:

- **Auth check** — runs `dex registry whoami --verbose` to detect valid/expired tokens
- **Login** — if expired, click to pick Google or GitHub OAuth. Browser opens automatically; the view polls for completion and refreshes when authenticated.
- **Adapters** — lists all adapters in the bootstrap community with fingerprints. Click for a detail panel showing specification, bound skills, and install command.
- **Skills** — lists all skills with their adapter bindings. Click for a detail panel showing adapter fingerprint cross-references.
- **Overview** (graph icon in title bar) — Skill-Adapter Fingerprint Map. A heatmap grid where rows are skills, columns are adapters, and active cells show fingerprint bindings on hover.

Loading states show animated spinners during auth check and data fetch. Adapters and skills load in parallel.

### Status Bar

Shows adapter health at a glance: `dex: 8/10 adapters` with warning icon when tokens are missing.

### File Watcher

Monitors `~/.dex` for changes and auto-refreshes the relevant tree views when adapters, tokens, flows, or workspaces change on disk.

## Requirements

- [dex](https://github.com/modiqo/dex) CLI installed and on PATH (or configure `modiqo.executablePath`)
- VSCode 1.85.0+

## Install

### From VSIX (local)

```sh
# Build the extension
cd dex-vscode
npm install
npm run compile
npx @vscode/vsce package

# Install
code --install-extension modiqo-0.1.0.vsix
```

Or within VSCode: `Cmd+Shift+P` > `Extensions: Install from VSIX...` > select the `.vsix` file.

### From source (development)

```sh
git clone https://github.com/modiqo/dex-vscode.git
cd dex-vscode
npm install
npm run compile
```

Press `F5` to launch the Extension Development Host.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `modiqo.executablePath` | `dex`    | Path to the dex binary. Set this if dex is not on your PATH. |

## Commands

All commands are accessible via `Cmd+Shift+P` with the `modiqo:` prefix:

| Command                          | Description                              |
|----------------------------------|------------------------------------------|
| `modiqo: Refresh Adapters`       | Reload adapter list                      |
| `modiqo: Configure Token`        | Set a token for an adapter               |
| `modiqo: Verify Connection`      | Run proof-of-life for an adapter         |
| `modiqo: Browse Adapter Catalog` | Search and explore available adapters    |
| `modiqo: Run Flow`               | Execute a flow in the terminal           |
| `modiqo: Refresh Flows`          | Reload flow list                         |
| `modiqo: Refresh Workspaces`     | Reload workspace list                    |
| `modiqo: Show Trace Timeline`    | Open Gantt timeline for a workspace      |
| `modiqo: Show Commands`          | Open command request/response viewer     |
| `modiqo: Refresh Registry`       | Reload registry data                     |
| `modiqo: Registry Login`         | Authenticate with Google or GitHub       |
| `modiqo: Show Registry Overview` | Open skill-adapter fingerprint map       |

## Project Structure

```text
src/
  extension.ts              Main activation and command wiring
  statusBar.ts              Status bar item
  watcher.ts                FileSystemWatcher on ~/.dex
  client/
    dexClient.ts            CLI wrapper (execJson, execText, execStream)
  views/
    adapterTree.ts          Adapter TreeDataProvider (info, logs, policies)
    flowTree.ts             Flow TreeDataProvider
    workspaceTree.ts        Workspace TreeDataProvider
    registryTree.ts         Registry TreeDataProvider (auth, adapters, skills)
  commands/
    browseCatalog.ts        Catalog search and detail panel
    configureToken.ts       Token configuration
    runFlow.ts              Flow execution
    verifyAdapter.ts        Adapter verification
  panels/
    tracePanel.ts           Gantt timeline WebviewPanel
    commandsPanel.ts        Command request/response WebviewPanel
    registryPanel.ts        Registry detail and overview WebviewPanels
media/
  dex-icon.svg              Activity bar icon
  light/                    Light theme tree icons
  dark/                     Dark theme tree icons
```

## Build

```sh
npm run compile          # Development build with sourcemaps
npm run watch            # Watch mode for development
npm run vscode:prepublish  # Production build (minified)
npx @vscode/vsce package   # Package as .vsix
```

Type checking:

```sh
npx tsc --noEmit
```

## License

Business Source License 1.1 — same as [dex](https://github.com/modiqo/dex). See [LICENSE](LICENSE) for details.
