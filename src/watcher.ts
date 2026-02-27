import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";

export interface WatcherCallbacks {
  onAdaptersChanged: () => void;
  onTokensChanged: () => void;
  onFlowsChanged: () => void;
  onWorkspacesChanged: () => void;
}

/**
 * Watch ~/.dex for filesystem changes and trigger refresh callbacks.
 */
export function createDexWatcher(
  callbacks: WatcherCallbacks
): vscode.Disposable[] {
  const dexHome = path.join(os.homedir(), ".dex");
  const disposables: vscode.Disposable[] = [];

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(dexHome), "**/*")
  );

  const handleChange = (uri: vscode.Uri) => {
    const p = uri.fsPath;
    if (p.includes("/adapters/")) {
      callbacks.onAdaptersChanged();
    }
    if (p.includes("/tokens")) {
      callbacks.onTokensChanged();
    }
    if (p.includes("/flows/")) {
      callbacks.onFlowsChanged();
    }
    if (p.includes("/workspaces/")) {
      callbacks.onWorkspacesChanged();
    }
  };

  watcher.onDidChange(handleChange);
  watcher.onDidCreate(handleChange);
  watcher.onDidDelete(handleChange);

  disposables.push(watcher);
  return disposables;
}
