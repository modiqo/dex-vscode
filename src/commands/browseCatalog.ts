import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";
import { showCatalogDetailPanel } from "../panels/catalogDetailPanel";

export function registerBrowseCatalog(
  client: DexClient,
  extensionUri: vscode.Uri,
  onAdapterCreated?: () => void
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "modiqo.browseCatalog",
    async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search the adapter catalog (635 APIs)",
        placeHolder: "e.g. stripe, email, calendar, crm, ai ...",
      });

      if (query === undefined || query.trim().length === 0) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Searching catalog for "${query}"...`,
          cancellable: false,
        },
        async () => {
          try {
            const raw = await client.catalogSearch(query.trim());
            const results = parseCatalogResults(raw);

            if (results.length === 0) {
              vscode.window.showInformationMessage(
                `No adapters found for "${query}".`
              );
              return;
            }

            const picked = await vscode.window.showQuickPick(
              results.map((r) => ({
                label: r.id,
                description: r.category,
                detail: r.provider,
              })),
              {
                placeHolder: `${results.length} result(s) — select to view details`,
              }
            );

            if (!picked) {
              return;
            }

            await showCatalogDetailPanel(
              extensionUri,
              client,
              picked.label,
              onAdapterCreated,
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Catalog search failed: ${msg}`);
          }
        }
      );
    }
  );
}

// ── Types ─────────────────────────────────────────────────────────

export interface CatalogResult {
  id: string;
  category: string;
  provider: string;
}

// ── Parsers (exported for reuse by catalogView and catalogDetailPanel) ──

export function parseCatalogResults(text: string): CatalogResult[] {
  const results: CatalogResult[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("Catalog") ||
      trimmed.startsWith("ID") ||
      trimmed.startsWith("\u2500") ||
      trimmed.startsWith("Use:") ||
      trimmed.startsWith("Create:")
    ) {
      continue;
    }
    const parts = trimmed.split(/\s{2,}/);
    if (parts.length >= 3) {
      results.push({ id: parts[0], category: parts[1], provider: parts[2] });
    } else if (parts.length === 2) {
      results.push({ id: parts[0], category: parts[1], provider: "" });
    }
  }
  return results;
}

export function parseCatalogInfo(text: string): Record<string, string> {
  const info: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Catalog:")) {
      continue;
    }
    if (trimmed.startsWith("Create adapter:") || trimmed.startsWith("With defaults:")) {
      continue;
    }
    const match = trimmed.match(/^([^:]+):\s+(.+)$/);
    if (match) {
      info[match[1].trim()] = match[2].trim();
    }
  }
  return info;
}
