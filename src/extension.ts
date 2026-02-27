import * as vscode from "vscode";
import { DexClient } from "./client/dexClient";
import { AdapterTreeProvider } from "./views/adapterTree";
import { FlowTreeProvider } from "./views/flowTree";
import { WorkspaceTreeProvider } from "./views/workspaceTree";
import { DexStatusBar } from "./statusBar";
import { createDexWatcher } from "./watcher";
import { registerConfigureToken } from "./commands/configureToken";
import { registerVerifyAdapter } from "./commands/verifyAdapter";
import { registerRunFlow } from "./commands/runFlow";
import { registerBrowseCatalog } from "./commands/browseCatalog";
import { showTracePanel } from "./panels/tracePanel";
import { showCommandsPanel } from "./panels/commandsPanel";
import { RegistryTreeProvider } from "./views/registryTree";
import {
  showRegistryDetailPanel,
  showRegistryOverviewPanel,
} from "./panels/registryPanel";
import { ExploreTreeProvider } from "./views/exploreTree";
import { showExploreResultsPanel } from "./panels/explorePanel";
import type { RegistryAdapter, RegistrySkill } from "./client/dexClient";

export function activate(context: vscode.ExtensionContext): void {
  const client = new DexClient();

  // Tree views
  const adapterTree = new AdapterTreeProvider(client);
  adapterTree.setExtensionUri(context.extensionUri);
  const flowTree = new FlowTreeProvider(client);
  flowTree.setExtensionUri(context.extensionUri);
  const workspaceTree = new WorkspaceTreeProvider(client);
  workspaceTree.setExtensionUri(context.extensionUri);
  const registryTree = new RegistryTreeProvider(client);
  registryTree.setExtensionUri(context.extensionUri);
  const exploreTree = new ExploreTreeProvider(client);
  exploreTree.setExtensionUri(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("modiqo-adapters", adapterTree),
    vscode.window.registerTreeDataProvider("modiqo-flows", flowTree),
    vscode.window.registerTreeDataProvider("modiqo-workspaces", workspaceTree),
    vscode.window.registerTreeDataProvider("modiqo-registry", registryTree),
    vscode.window.registerTreeDataProvider("modiqo-explore", exploreTree)
  );

  // Status bar
  const statusBar = new DexStatusBar(client);
  context.subscriptions.push({ dispose: () => statusBar.dispose() });
  statusBar.refresh();

  // File watcher on ~/.dex
  const watcherDisposables = createDexWatcher({
    onAdaptersChanged: () => {
      adapterTree.refresh();
      statusBar.refresh();
    },
    onTokensChanged: () => {
      adapterTree.refresh();
      statusBar.refresh();
    },
    onFlowsChanged: () => {
      flowTree.refresh();
    },
    onWorkspacesChanged: () => {
      workspaceTree.refresh();
    },
  });
  context.subscriptions.push(...watcherDisposables);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("modiqo.refreshAdapters", () => {
      adapterTree.refresh();
      statusBar.refresh();
    }),
    vscode.commands.registerCommand("modiqo.refreshFlows", () => {
      flowTree.refresh();
    }),
    vscode.commands.registerCommand("modiqo.refreshWorkspaces", () => {
      workspaceTree.refresh();
    }),
    vscode.commands.registerCommand("modiqo.showTrace", (ws) => {
      showTracePanel(context.extensionUri, ws);
    }),
    vscode.commands.registerCommand("modiqo.showCommands", (ws) => {
      showCommandsPanel(context.extensionUri, ws);
    }),
    vscode.commands.registerCommand("modiqo.refreshRegistry", () => {
      registryTree.refresh();
    }),
    vscode.commands.registerCommand("modiqo.registryLogin", async () => {
      const provider = await vscode.window.showQuickPick(
        [
          { label: "Google", description: "Login with Google account" },
          { label: "GitHub", description: "Login with GitHub account" },
        ],
        { placeHolder: "Select login provider" }
      );
      if (!provider) { return; }

      const providerArg = provider.label.toLowerCase();

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Logging in with ${provider.label}...`,
          cancellable: true,
        },
        async (_progress, cancellation) => {
          // Launch login in background (opens browser)
          const child = client.execStream(["login", "--provider", providerArg]);

          // Poll whoami every 2s to detect successful auth
          const maxAttempts = 60; // 2 minutes max
          for (let i = 0; i < maxAttempts; i++) {
            if (cancellation.isCancellationRequested) {
              child.kill();
              return;
            }

            await new Promise((r) => setTimeout(r, 2000));

            try {
              const whoami = await client.registryWhoami();
              if (whoami.status === "valid") {
                child.kill();
                registryTree.refresh();
                vscode.window.showInformationMessage(
                  `Logged in as ${whoami.email}`
                );
                return;
              }
            } catch {
              // whoami failed, keep polling
            }
          }

          child.kill();
          vscode.window.showWarningMessage(
            "Login timed out. Try refreshing the Registry view."
          );
        }
      );
    }),
    vscode.commands.registerCommand(
      "modiqo.showRegistryDetail",
      async (item: unknown, kind: "adapter" | "skill") => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Loading registry data...",
            cancellable: false,
          },
          async (progress) => {
            let adapters = registryTree.cachedAdapters;
            let skills = registryTree.cachedSkills;

            if (!registryTree.dataLoaded) {
              progress.report({ message: "Fetching adapters and skills..." });
              [adapters, skills] = await Promise.all([
                client.registryAdapterList("bootstrap"),
                client.registrySkillList("bootstrap"),
              ]);
            }

            showRegistryDetailPanel(
              context.extensionUri,
              item as RegistryAdapter | RegistrySkill,
              kind,
              adapters,
              skills
            );
          }
        );
      }
    ),
    vscode.commands.registerCommand("modiqo.showRegistryOverview", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Loading registry overview...",
          cancellable: false,
        },
        async (progress) => {
          let adapters = registryTree.cachedAdapters;
          let skills = registryTree.cachedSkills;

          if (!registryTree.dataLoaded) {
            progress.report({ message: "Fetching adapters and skills..." });
            [adapters, skills] = await Promise.all([
              client.registryAdapterList("bootstrap"),
              client.registrySkillList("bootstrap"),
            ]);
          }

          showRegistryOverviewPanel(context.extensionUri, adapters, skills);
        }
      );
    }),
    vscode.commands.registerCommand("modiqo.refreshExplore", () => {
      exploreTree.refresh();
    }),
    vscode.commands.registerCommand("modiqo.exploreSearch", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search for adapters and skills by intent",
        placeHolder: "e.g., send an email, list github issues, schedule a meeting",
      });
      if (!query) { return; }
      exploreTree.search(query);
    }),
    vscode.commands.registerCommand("modiqo.showExploreResults", async () => {
      if (!exploreTree.cachedResult) {
        // Trigger a search first
        const query = await vscode.window.showInputBox({
          prompt: "Search for adapters and skills by intent",
          placeHolder: "e.g., send an email, list github issues, schedule a meeting",
        });
        if (!query) { return; }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Exploring...",
            cancellable: false,
          },
          async () => {
            await exploreTree.search(query);
          }
        );
      }

      if (exploreTree.cachedResult) {
        showExploreResultsPanel(context.extensionUri, exploreTree.cachedResult);
      }
    }),
    registerConfigureToken(client),
    registerVerifyAdapter(client),
    registerRunFlow(client),
    registerBrowseCatalog(client, context.extensionUri)
  );

  // Refresh config when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("modiqo.executablePath")) {
        client.refreshConfig();
        adapterTree.refresh();
        flowTree.refresh();
        workspaceTree.refresh();
        statusBar.refresh();
      }
    })
  );
}

export function deactivate(): void {
  // cleanup handled by disposables
}
