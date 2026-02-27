import * as vscode from "vscode";
import { DexClient } from "../client/dexClient";
import { AdapterTreeItem } from "../views/adapterTree";

export function registerConfigureToken(
  client: DexClient
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "modiqo.configureToken",
    async (item?: AdapterTreeItem) => {
      const adapterId = item?.adapter.id;
      const envVar = item?.adapter.token_env;

      if (!envVar) {
        const input = await vscode.window.showInputBox({
          prompt: "Environment variable name for the token",
          placeHolder: "GITHUB_TOKEN",
        });
        if (!input) {
          return;
        }
        const value = await vscode.window.showInputBox({
          prompt: `Enter value for ${input}`,
          password: true,
        });
        if (value !== undefined) {
          const ok = await client.tokenSet(input, value);
          if (ok) {
            vscode.window.showInformationMessage(`Token ${input} configured.`);
          } else {
            vscode.window.showErrorMessage(`Failed to set token ${input}.`);
          }
        }
        return;
      }

      const value = await vscode.window.showInputBox({
        prompt: `Enter token for ${adapterId} (${envVar})`,
        password: true,
      });

      if (value !== undefined) {
        const ok = await client.tokenSet(envVar, value);
        if (ok) {
          vscode.window.showInformationMessage(
            `Token for ${adapterId} configured.`
          );
        } else {
          vscode.window.showErrorMessage(
            `Failed to set token for ${adapterId}.`
          );
        }
      }
    }
  );
}
