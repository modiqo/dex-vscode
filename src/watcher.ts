import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

export interface WatcherCallbacks {
  onAdaptersChanged: () => void;
  onTokensChanged: () => void;
  onFlowsChanged: () => void;
  onWorkspacesChanged: () => void;
}

/**
 * Watch ~/.dex subdirectories for filesystem changes.
 *
 * Uses Node.js fs.watch (recursive) instead of vscode.workspace.createFileSystemWatcher
 * because VS Code's watcher is unreliable for paths outside the workspace when changes
 * are made by external CLI processes.
 */
export function createDexWatcher(
  callbacks: WatcherCallbacks
): vscode.Disposable[] {
  const dexHome = path.join(os.homedir(), ".dex");
  const disposables: vscode.Disposable[] = [];

  // Debounce to avoid multiple rapid-fire callbacks for a single CLI operation
  const debounce = (fn: () => void, ms = 300) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  };

  const onAdapters = debounce(callbacks.onAdaptersChanged);
  const onTokens = debounce(callbacks.onTokensChanged);
  const onFlows = debounce(callbacks.onFlowsChanged);
  const onWorkspaces = debounce(callbacks.onWorkspacesChanged);

  const watches: fs.FSWatcher[] = [];

  const watchDir = (dir: string, onChange: () => void) => {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const w = fs.watch(dir, { recursive: true }, () => onChange());
      watches.push(w);
    } catch {
      // Directory may not exist yet on a fresh install — ignore
    }
  };

  watchDir(path.join(dexHome, "adapters"), onAdapters);
  watchDir(path.join(dexHome, "flows"), onFlows);
  watchDir(path.join(dexHome, "workspaces"), onWorkspaces);

  // tokens is a file, watch its parent directory
  const tokensDir = path.join(dexHome, "config");
  watchDir(tokensDir, onTokens);

  disposables.push({
    dispose: () => watches.forEach((w) => w.close()),
  });

  return disposables;
}
