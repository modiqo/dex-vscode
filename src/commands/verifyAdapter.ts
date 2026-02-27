import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";
import { AdapterTreeItem } from "../views/adapterTree";

export function registerVerifyAdapter(
  client: DexClient
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "modiqo.verifyAdapter",
    async (item?: AdapterTreeItem) => {
      if (!item) {
        vscode.window.showWarningMessage(
          "Select an adapter from the sidebar to verify."
        );
        return;
      }

      const adapterId = item.adapter.id;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Verifying ${adapterId}...`,
          cancellable: false,
        },
        async () => {
          const ok = await client.verifyAdapter(adapterId);
          if (ok) {
            vscode.window.showInformationMessage(
              `${adapterId}: connection verified.`
            );
          } else {
            vscode.window.showWarningMessage(
              `${adapterId}: verification failed. Check token configuration.`
            );
          }
        }
      );
    }
  );
}
