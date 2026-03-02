import * as vscode from "vscode";
import * as fs from "fs";

let tourPanel: vscode.WebviewPanel | undefined;

export function showTourPanel(extensionUri: vscode.Uri): void {
  if (tourPanel) { tourPanel.reveal(vscode.ViewColumn.One); return; }
  tourPanel = vscode.window.createWebviewPanel(
    "modiqo.tour", "dex · How it works", vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")] }
  );
  const htmlPath = vscode.Uri.joinPath(extensionUri, "media", "tour.html").fsPath;
  tourPanel.webview.html = fs.readFileSync(htmlPath, "utf8");
  tourPanel.onDidDispose(() => { tourPanel = undefined; });
}
