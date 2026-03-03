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
import { showAdapterWizardPanel } from "./panels/adapterWizardPanel";
import { showTracePanel } from "./panels/tracePanel";
import { showCommandsPanel } from "./panels/commandsPanel";
import { showStatsPanel } from "./panels/statsPanel";
import { showPlanPanel } from "./panels/planPanel";
import { RegistryTreeProvider } from "./views/registryTree";
import {
  showRegistryDetailPanel,
  showRegistryOverviewPanel,
} from "./panels/registryPanel";
import { ExploreTreeProvider } from "./views/exploreTree";
import { VaultTreeProvider } from "./views/vaultTree";
import { CatalogViewProvider } from "./views/catalogView";
import { showCatalogDetailPanel } from "./panels/catalogDetailPanel";
import { InfoTreeProvider } from "./views/infoTree";
import { SetupTreeProvider } from "./views/setupTree";
import { showExploreResultsPanel } from "./panels/explorePanel";
import { showReferencePanel } from "./panels/referencePanel";
import { showSetupWizardPanel, showInstallPanel, showRegistryLoginPanel } from "./panels/setupWizardPanel";
import { showVaultPullPanel } from "./panels/vaultPullPanel";
import { showTourPanel } from "./panels/tourPanel";
import type { RegistryAdapter, RegistrySkill } from "./client/dexClient";
import { WorkspaceTreeItem } from "./views/workspaceTree";

export function activate(context: vscode.ExtensionContext): void {
  const client = new DexClient();

  // Helper to set dexReady context and reveal/hide views
  async function updateDexReadyContext(): Promise<void> {
    const available = await client.isAvailable();
    if (!available) {
      await vscode.commands.executeCommand("setContext", "modiqo.dexReady", false);
      await vscode.commands.executeCommand("setContext", "modiqo.setupStep", 0);
      setupTree.setStatus("not-installed");
      return;
    }
    const step = await client.wizardCheckpoint();
    const ready = step === 6;
    await vscode.commands.executeCommand("setContext", "modiqo.dexReady", ready);
    await vscode.commands.executeCommand("setContext", "modiqo.setupStep", step);
    setupTree.setStatus(ready ? "complete" : "needs-setup");
  }

  // Tree views
  const setupTree = new SetupTreeProvider(client);
  const infoTree = new InfoTreeProvider(client);
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
  const vaultTree = new VaultTreeProvider(client);
  const catalogView = new CatalogViewProvider(client, context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("modiqo-setup", setupTree),
    vscode.window.registerTreeDataProvider("modiqo-info", infoTree),
    vscode.window.registerTreeDataProvider("modiqo-adapters", adapterTree),
    vscode.window.registerWebviewViewProvider("modiqo-catalog", catalogView),
    vscode.window.registerTreeDataProvider("modiqo-flows", flowTree),
    vscode.window.registerTreeDataProvider("modiqo-workspaces", workspaceTree),
    vscode.window.registerTreeDataProvider("modiqo-registry", registryTree),
    vscode.window.registerTreeDataProvider("modiqo-vault", vaultTree),
    vscode.window.registerTreeDataProvider("modiqo-explore", exploreTree)
  );

  // Check initial dex state
  updateDexReadyContext();

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
      vaultTree.refresh();
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

  // Setup commands
  context.subscriptions.push(
    vscode.commands.registerCommand("modiqo.installDex", async () => {
      const panel = showInstallPanel(context.extensionUri, async () => {
        // "Begin Setup" clicked after install completes
        setupTree.setStatus("needs-setup");
        await updateDexReadyContext();
        // Open the setup wizard automatically
        vscode.commands.executeCommand("modiqo.openSetupWizard");
      });

      const { spawn: spawnShell } = await import("child_process");
      const child = spawnShell("bash", ["-c",
        "curl -fsSL https://raw.githubusercontent.com/modiqo/dex-releases/main/install.sh | DEX_YES=1 bash"
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      let currentStep = "download";

      const advance = (text: string) => {
        const lower = text.toLowerCase();
        if (lower.includes("deno") && currentStep !== "deno" && currentStep !== "sdk") {
          currentStep = "deno";
          panel.webview.postMessage({ type: "install-step", step: "deno" });
        } else if ((lower.includes("sdk") || lower.includes("typescript")) && currentStep !== "sdk") {
          currentStep = "sdk";
          panel.webview.postMessage({ type: "install-step", step: "sdk" });
        } else if ((lower.includes("install") || lower.includes("binary")) && currentStep === "download") {
          currentStep = "binary";
          panel.webview.postMessage({ type: "install-step", step: "binary" });
        }
      };

      child.stdout?.on("data", (data: Buffer) => advance(data.toString()));
      child.stderr?.on("data", (data: Buffer) => advance(data.toString()));

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("close", resolve);
        child.on("error", () => resolve(1));
      });

      if (exitCode === 0) {
        panel.webview.postMessage({ type: "install-done" });
      } else {
        panel.webview.postMessage({
          type: "install-error",
          step: currentStep,
          message: "Installation failed",
        });
      }
    }),
    vscode.commands.registerCommand("modiqo.openSetupWizard", () => {
      showSetupWizardPanel(context.extensionUri, client, {
        onAdaptersInstalled: () => {
          updateDexReadyContext();
          adapterTree.refresh();
          flowTree.refresh();
          workspaceTree.refresh();
          statusBar.refresh();
        },
        onTokensConfigured: () => {
          updateDexReadyContext();
          vaultTree.refresh();
          adapterTree.refresh();
          statusBar.refresh();
        },
        onComplete: () => {
          setupTree.setStatus("complete");
          adapterTree.refresh();
          flowTree.refresh();
          workspaceTree.refresh();
          registryTree.refresh();
          vaultTree.refresh();
          exploreTree.refresh();
          statusBar.refresh();
          // Focus the workspaces tree to draw attention away from setup
          vscode.commands.executeCommand("modiqo-workspaces.focus");
        },
      });
    }),
  );

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
    vscode.commands.registerCommand("modiqo.showTrace", (arg) => {
      showTracePanel(context.extensionUri, arg instanceof WorkspaceTreeItem ? arg.ws : arg);
    }),
    vscode.commands.registerCommand("modiqo.showCommands", (arg) => {
      showCommandsPanel(context.extensionUri, arg instanceof WorkspaceTreeItem ? arg.ws : arg);
    }),
    vscode.commands.registerCommand("modiqo.showStats", (arg) => {
      showStatsPanel(context.extensionUri, arg instanceof WorkspaceTreeItem ? arg.ws : arg);
    }),
    vscode.commands.registerCommand("modiqo.showPlan", (arg) => {
      showPlanPanel(context.extensionUri, arg instanceof WorkspaceTreeItem ? arg.ws : arg);
    }),
    vscode.commands.registerCommand("modiqo.showTour", () => {
      showTourPanel(context.extensionUri);
    }),
    vscode.commands.registerCommand("modiqo.refreshRegistry", () => {
      registryTree.refresh();
    }),
    vscode.commands.registerCommand("modiqo.registryLogin", () => {
      showRegistryLoginPanel(client, () => {
        registryTree.refresh();
      });
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
              progress.report({ message: "Fetching adapters and flows..." });
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
            progress.report({ message: "Fetching adapters and flows..." });
            [adapters, skills] = await Promise.all([
              client.registryAdapterList("bootstrap"),
              client.registrySkillList("bootstrap"),
            ]);
          }

          showRegistryOverviewPanel(context.extensionUri, adapters, skills);
        }
      );
    }),
    vscode.commands.registerCommand("modiqo.refreshVault", () => {
      vaultTree.refresh();
    }),
    vscode.commands.registerCommand("modiqo.vaultPull", async () => {
      showVaultPullPanel(client, () => {
        vaultTree.refresh();
      });
    }),
    vscode.commands.registerCommand("modiqo.refreshExplore", () => {
      exploreTree.refresh();
    }),
    vscode.commands.registerCommand("modiqo.exploreSearch", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search for adapters and flows by intent",
        placeHolder: "e.g., send an email, list github issues, schedule a meeting",
      });
      if (!query) { return; }
      exploreTree.search(query);
    }),
    vscode.commands.registerCommand("modiqo.showExploreResults", async () => {
      if (!exploreTree.cachedResult) {
        // Trigger a search first
        const query = await vscode.window.showInputBox({
          prompt: "Search for adapters and flows by intent",
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
    vscode.commands.registerCommand("modiqo.refreshCatalog", () => {
      catalogView.refresh();
    }),
    vscode.commands.registerCommand("modiqo.catalogDetail", async (adapterId: string) => {
      await showCatalogDetailPanel(context.extensionUri, client, adapterId, () => {
        adapterTree.refresh();
        statusBar.refresh();
      });
    }),
    registerConfigureToken(client),
    registerVerifyAdapter(client),
    registerRunFlow(client),
    registerBrowseCatalog(client, context.extensionUri, () => {
      adapterTree.refresh();
      statusBar.refresh();
    }),
    vscode.commands.registerCommand(
      "modiqo.createAdapter",
      (adapterId: string, catalogInfo: Record<string, string>) => {
        showAdapterWizardPanel(
          context.extensionUri,
          client,
          adapterId,
          catalogInfo,
          () => {
            adapterTree.refresh();
            statusBar.refresh();
          }
        );
      }
    ),
    vscode.commands.registerCommand("modiqo.showReference", (args: string[]) => {
      showReferencePanel(client, args);
    })
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
