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
import { InfoTreeProvider } from "./views/infoTree";
import { SetupTreeProvider } from "./views/setupTree";
import { showExploreResultsPanel } from "./panels/explorePanel";
import { showReferencePanel } from "./panels/referencePanel";
import { showSetupWizardPanel } from "./panels/setupWizardPanel";
import type { RegistryAdapter, RegistrySkill } from "./client/dexClient";

export function activate(context: vscode.ExtensionContext): void {
  const client = new DexClient();

  // Helper to set dexReady context and reveal/hide views
  async function updateDexReadyContext(): Promise<void> {
    const ready = await client.isSetupComplete();
    await vscode.commands.executeCommand("setContext", "modiqo.dexReady", ready);
    setupTree.setStatus(ready ? "complete" : (await client.isAvailable()) ? "needs-setup" : "not-installed");
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

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("modiqo-setup", setupTree),
    vscode.window.registerTreeDataProvider("modiqo-info", infoTree),
    vscode.window.registerTreeDataProvider("modiqo-adapters", adapterTree),
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
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Installing dex",
          cancellable: true,
        },
        async (progress, cancellation) => {
          const { spawn: spawnShell } = await import("child_process");
          const child = spawnShell("bash", ["-c",
            "curl -fsSL https://raw.githubusercontent.com/modiqo/dex-releases/main/install.sh | DEX_YES=1 bash"
          ], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
          });

          cancellation.onCancellationRequested(() => { child.kill(); });

          const steps = [
            "Downloading installer...",
            "Installing dex binary...",
            "Installing deno runtime...",
            "Installing TypeScript SDK...",
          ];
          let stepIdx = 0;

          progress.report({ message: steps[0] });

          const advance = (text: string) => {
            if (text.includes("deno") && stepIdx < 2) {
              stepIdx = 2;
              progress.report({ message: steps[2], increment: 25 });
            } else if (text.includes("sdk") || text.includes("SDK") || text.includes("typescript")) {
              stepIdx = 3;
              progress.report({ message: steps[3], increment: 25 });
            } else if ((text.includes("install") || text.includes("download")) && stepIdx < 1) {
              stepIdx = 1;
              progress.report({ message: steps[1], increment: 25 });
            }
          };

          child.stdout?.on("data", (data: Buffer) => advance(data.toString().toLowerCase()));
          child.stderr?.on("data", (data: Buffer) => advance(data.toString().toLowerCase()));

          const exitCode = await new Promise<number | null>((resolve) => {
            child.on("close", resolve);
            child.on("error", () => resolve(1));
          });

          if (exitCode === 0) {
            // Force status to needs-setup immediately (don't wait for async detection)
            setupTree.setStatus("needs-setup");
            await updateDexReadyContext();
            vscode.window.showInformationMessage(
              "dex installed successfully! Click Begin Setup to configure.",
            );
          } else if (!cancellation.isCancellationRequested) {
            vscode.window.showErrorMessage(
              "dex installation failed. Try running manually: curl -fsSL https://raw.githubusercontent.com/modiqo/dex-releases/main/install.sh | DEX_YES=1 bash",
            );
          }
        },
      );
    }),
    vscode.commands.registerCommand("modiqo.openSetupWizard", () => {
      showSetupWizardPanel(context.extensionUri, client, {
        onAdaptersInstalled: () => {
          // Progressively reveal adapters, flows, and workspaces in sidebar
          vscode.commands.executeCommand("setContext", "modiqo.dexReady", true);
          adapterTree.refresh();
          flowTree.refresh();
          workspaceTree.refresh();
          statusBar.refresh();
        },
        onTokensConfigured: () => {
          // Refresh vault and adapters when tokens change
          vaultTree.refresh();
          adapterTree.refresh();
          statusBar.refresh();
        },
        onComplete: () => {
          vscode.commands.executeCommand("setContext", "modiqo.dexReady", true);
          setupTree.setStatus("complete");
          adapterTree.refresh();
          flowTree.refresh();
          workspaceTree.refresh();
          registryTree.refresh();
          vaultTree.refresh();
          exploreTree.refresh();
          statusBar.refresh();
          vscode.window.showInformationMessage("dex setup complete!");
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
    vscode.commands.registerCommand("modiqo.showTrace", (ws) => {
      showTracePanel(context.extensionUri, ws);
    }),
    vscode.commands.registerCommand("modiqo.showCommands", (ws) => {
      showCommandsPanel(context.extensionUri, ws);
    }),
    vscode.commands.registerCommand("modiqo.showStats", (ws) => {
      showStatsPanel(context.extensionUri, ws);
    }),
    vscode.commands.registerCommand("modiqo.showPlan", (ws) => {
      showPlanPanel(context.extensionUri, ws);
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
      const passphrase = await vscode.window.showInputBox({
        prompt: "Enter vault passphrase",
        placeHolder: "Passphrase for encrypted vault",
        password: true,
      });
      if (!passphrase) { return; }

      const success = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Pulling vault...",
          cancellable: false,
        },
        () => client.vaultPull(passphrase),
      );

      if (success) {
        vaultTree.refresh();
        vscode.window.showInformationMessage("Vault pulled successfully.");
      } else {
        vscode.window.showErrorMessage("Vault pull failed. Check passphrase and try again.");
      }
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
