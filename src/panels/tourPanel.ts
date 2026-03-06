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
  let html = fs.readFileSync(htmlPath, "utf8");

  // Inject lottie-web script URI for webview security
  const lottieUri = tourPanel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "vendor", "lottie-light.min.js")
  );
  html = html.replace("{{LOTTIE_URI}}", lottieUri.toString());

  // Inject webview CSP source for script tags
  const cspSource = tourPanel.webview.cspSource;
  html = html.replace("{{CSP_SOURCE}}", cspSource);

  tourPanel.webview.html = html;
  tourPanel.onDidDispose(() => { tourPanel = undefined; });
}
