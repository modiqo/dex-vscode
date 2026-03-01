import * as vscode from "vscode";
import { execFile, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execFileAsync = promisify(execFile);

export interface Adapter {
  id: string;
  name: string;
  group?: string;
  has_token: boolean;
  token_env?: string;
  verified?: boolean;
  tools?: number;
  spec_type?: string;
  usage?: string;
  success?: string;
}

export interface CatalogCategory {
  name: string;
  count: number;
  examples: string;
}

export interface FlowJson {
  name: string;
  path: string;
  description?: string;
  adapter?: string;
  flow_type?: string;
  status?: string;
}

export interface Flow {
  org: string;
  name: string;
  path: string;
  description?: string;
  adapter?: string;
}

export interface TokenInfo {
  env_var: string;
  adapter_id: string;
  configured: boolean;
}

export interface VaultToken {
  name: string;
  type: string;
  expires_in: string;
  refresh: string;
  created: string;
  description: string;
}

export interface RegistryWhoami {
  status: "valid" | "expired" | "error";
  email: string;
  tokenExpires: string;
  tokenIssued: string;
  registryUrl: string;
  connected: boolean;
}

export interface RegistryAdapter {
  name: string;
  fingerprint: string;
  visibility: string;
  description: string;
}

export interface RegistrySkill {
  name: string;
  description: string;
  adapters: string;
  visibility: string;
}

export interface ExploreToolMatch {
  adapter_id: string;
  tool: string;
  toolset: string;
  score: number;
  description: string;
  group: string;
}

export interface ExploreSkillMatch {
  name: string;
  description: string;
  matchPercent: string;
}

export interface FlowSearchMatch {
  name: string;
  description: string;
  matchPercent: number;
  flowType: "ATOMIC" | "COMPOSITE" | string;
  location: string;
  endpoints: string;
  adapter: string;
}

export interface ExploreResult {
  query: string;
  tools: ExploreToolMatch[];
  skills: ExploreSkillMatch[];
  flowSearchResults: FlowSearchMatch[];
}

export interface DexInfo {
  version: string;
  folder: string;
}

export interface DryRunToolset {
  name: string;
  tool_count: number;
  confidence: number;
  methods: Record<string, number>;
}

export interface DryRunSchemeAuth {
  type: string;
  header_name?: string;
  key_env?: string;
  token_env?: string;
  username_env?: string;
  password_env?: string;
  description?: string;
}

export interface DryRunAuth {
  type: string;
  header_name?: string;
  key_env?: string;
  token_env?: string;
  description?: string;
  /** Per-operation: map of scheme name → auth config */
  schemes?: Record<string, DryRunSchemeAuth>;
  /** Per-operation: default scheme for unannotated operations */
  default_scheme?: string | null;
  /** Per-operation: OpenAPI security scheme definitions */
  spec_security_schemes?: Record<string, {
    scheme_type: string;
    location?: string;
    name?: string;
    http_scheme?: string;
  }>;
}

export interface DryRunResult {
  adapter_id: string;
  spec_source: string;
  spec: {
    title: string;
    version: string;
    openapi_version: string;
    base_url: string;
    operation_count: number;
    spec_size_bytes: number;
  };
  toolsets: DryRunToolset[];
  detection_method: string;
  auth: DryRunAuth;
  summary: {
    total_toolsets: number;
    total_tools: number;
    get_operations: number;
    post_operations: number;
    put_operations: number;
    delete_operations: number;
  };
}

export interface SetupAdapterInfo {
  id: string;
  name: string;
  description: string;
  tools: number;
  installed: boolean;
}

export interface SetupTokenRequirement {
  env_var: string;
  adapters: string[];
  configured: boolean;
  is_oauth: boolean;
  url?: string;
}

export interface WireClient {
  id: string;
  name: string;
  description: string;
  installed: boolean;
}

export interface ProofResult {
  adapter: string;
  success: boolean;
  output?: string;
  error?: string;
}

export class DexClient {
  private dexPath: string;

  constructor() {
    const config = vscode.workspace.getConfiguration("modiqo");
    this.dexPath = config.get<string>("executablePath", "dex");
  }

  /** Reload dex path from settings */
  refreshConfig(): void {
    const config = vscode.workspace.getConfiguration("modiqo");
    this.dexPath = config.get<string>("executablePath", "dex");
  }

  /** Execute a dex command and parse JSON output (falls back to stderr if stdout empty) */
  async execJson<T>(args: string[]): Promise<T> {
    try {
      const { stdout, stderr } = await execFileAsync(this.dexPath, args, {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      });
      const out = stdout.trim();
      const text = out.length > 0 ? out : stderr.trim();
      return JSON.parse(text) as T;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`dex ${args.join(" ")} failed: ${msg}`);
    }
  }

  /** Execute a dex command, return stdout as string (falls back to stderr if stdout empty) */
  async execText(args: string[]): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync(this.dexPath, args, {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      });
      const out = stdout.trim();
      return out.length > 0 ? out : stderr.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`dex ${args.join(" ")} failed: ${msg}`);
    }
  }

  /** Execute with streaming output (for flow runs, long operations) */
  execStream(args: string[]): ChildProcess {
    return spawn(this.dexPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  /** Create adapter non-interactively via dex adapter new --yes.
   *  Returns a ChildProcess for streaming stdout/stderr progress.
   *  Optionally passes --config-json for auth, headers, toolset filter overrides. */
  adapterCreateStream(
    id: string,
    specUrl: string,
    options?: { baseUrl?: string; group?: string; configJson?: object }
  ): ChildProcess {
    const args = ["adapter", "new", id, specUrl, "--yes"];
    if (options?.baseUrl) {
      args.push("--base-url", options.baseUrl);
    }
    if (options?.group) {
      args.push("--group", options.group);
    }
    if (options?.configJson) {
      args.push("--config-json", JSON.stringify(options.configJson));
    }
    return this.execStream(args);
  }

  /** Run adapter dry-run to detect spec, toolsets, auth without creating.
   *  Returns structured JSON from `dex adapter new <id> <spec> --dry-run`.
   *  Uses extended timeout since large specs may take time to download/parse. */
  async adapterDryRun(
    id: string,
    specUrl: string,
    options?: { baseUrl?: string }
  ): Promise<DryRunResult> {
    const args = ["adapter", "new", id, specUrl, "--dry-run"];
    if (options?.baseUrl) {
      args.push("--base-url", options.baseUrl);
    }
    try {
      const { stdout, stderr } = await execFileAsync(this.dexPath, args, {
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      });
      const out = stdout.trim();
      const text = out.length > 0 ? out : stderr.trim();
      return JSON.parse(text) as DryRunResult;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`dry-run failed: ${msg}`);
    }
  }

  /** Execute silently, return success/failure */
  async execSilent(args: string[]): Promise<boolean> {
    try {
      await execFileAsync(this.dexPath, args, {
        timeout: 30000,
        env: { ...process.env },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Check if dex is properly installed (binary + deno runtime at ~/.dex/bin/deno) */
  async isAvailable(): Promise<boolean> {
    const homeDir = os.homedir();
    const denoPath = path.join(homeDir, ".dex", "bin", "deno");

    // The deno runtime is the key indicator of a proper dex install
    if (!fs.existsSync(denoPath)) {
      return false;
    }

    // Also verify the binary works
    return this.execSilent(["--version"]);
  }

  /** Get version and base folder from dex info */
  async dexInfo(): Promise<DexInfo> {
    try {
      const text = await this.execText(["info"]);
      let version = "";
      let folder = "";
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        const vMatch = trimmed.match(/^Version:\s+(.+)$/);
        if (vMatch) { version = vMatch[1]; }
        const pMatch = trimmed.match(/^Adapters:\s+(.+)$/);
        if (pMatch) {
          // Derive base folder: strip trailing /adapters
          folder = pMatch[1].replace(/\/adapters$/, "");
        }
      }
      return { version, folder };
    } catch {
      return { version: "", folder: "" };
    }
  }

  /** Get adapter list — parses text output until --output=json is added */
  async adapterList(): Promise<Adapter[]> {
    try {
      const text = await this.execText(["adapter", "list"]);
      return this.parseAdapterListText(text);
    } catch {
      return [];
    }
  }

  /** Get flow list */
  async flowList(): Promise<Flow[]> {
    try {
      const result = await this.execJson<{ total: number; flows: FlowJson[] }>(
        ["flow", "list", "--json"]
      );
      const rawFlows = result.flows ?? [];
      return rawFlows.map((f) => {
        // Derive org from path: ~/.dex/flows/<org>/<name>/main.ts
        const parts = f.path.split("/");
        const flowsIdx = parts.indexOf("flows");
        const org =
          flowsIdx >= 0 && flowsIdx + 1 < parts.length
            ? parts[flowsIdx + 1]
            : "unknown";
        return {
          org,
          name: f.name,
          path: f.path,
          description: f.description,
          adapter: f.adapter,
        };
      });
    } catch {
      return [];
    }
  }

  /** Get token list — parses text output until --output=json is added */
  async tokenList(): Promise<TokenInfo[]> {
    try {
      const text = await this.execText(["token", "list"]);
      return this.parseTokenListText(text);
    } catch {
      return [];
    }
  }

  /** Get vault tokens — parses the table output of `dex token list` */
  async vaultTokenList(): Promise<VaultToken[]> {
    try {
      const text = await this.execText(["token", "list"]);
      return this.parseVaultTokenTable(text);
    } catch {
      return [];
    }
  }

  /** Pull vault from registry with passphrase.
   *  Uses DEX_VAULT_PASSPHRASE env var for headless mode. */
  async vaultPull(passphrase: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.dexPath, ["vault", "pull"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, DEX_VAULT_PASSPHRASE: passphrase },
      });

      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));

      // Safety timeout
      setTimeout(() => {
        child.kill();
        resolve(false);
      }, 30000);
    });
  }

  /** Get adapter catalog categories */
  async catalogList(): Promise<CatalogCategory[]> {
    try {
      const text = await this.execText(["adapter", "catalog", "list"]);
      return this.parseCatalogListText(text);
    } catch {
      return [];
    }
  }

  /** Search adapter catalog */
  async catalogSearch(query: string): Promise<string> {
    return this.execText(["adapter", "catalog", "search", query]);
  }

  /** Get adapter catalog info */
  async catalogInfo(id: string): Promise<string> {
    return this.execText(["adapter", "catalog", "info", id]);
  }

  /** Verify an adapter connection by running its proof-of-life flow */
  async verifyAdapter(adapterId: string): Promise<boolean> {
    return this.execSilent([
      "deno",
      "run",
      "--allow-all",
      `bootstrap/${adapterId}`,
      "--output=summary",
    ]);
  }

  /** Set a token value */
  async tokenSet(envVar: string, value: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.dexPath, ["token", "set", envVar], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
      child.stdin.write(value);
      child.stdin.end();
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    });
  }

  /** Check registry authentication status */
  async registryWhoami(): Promise<RegistryWhoami> {
    try {
      const text = await this.execText(["registry", "whoami", "--verbose"]);
      return this.parseWhoamiText(text);
    } catch {
      return {
        status: "error",
        email: "",
        tokenExpires: "",
        tokenIssued: "",
        registryUrl: "",
        connected: false,
      };
    }
  }

  /** List registry adapters for a community */
  async registryAdapterList(community: string): Promise<RegistryAdapter[]> {
    try {
      const text = await this.execText([
        "registry", "adapter", "list", "--community", community,
      ]);
      return this.parseRegistryAdapterTable(text);
    } catch {
      return [];
    }
  }

  /** List registry skills for a community */
  async registrySkillList(community: string): Promise<RegistrySkill[]> {
    try {
      const text = await this.execText([
        "registry", "skill", "list", "--community", community,
      ]);
      return this.parseRegistrySkillTable(text);
    } catch {
      return [];
    }
  }

  /** Explore adapters and skills matching a query */
  async explore(query: string): Promise<ExploreResult> {
    const [toolsResult, skillsResult, flowSearchResults] = await Promise.all([
      this.exploreJson(query),
      this.exploreSkills(query),
      this.flowSearch(query),
    ]);
    return { query, tools: toolsResult, skills: skillsResult, flowSearchResults };
  }

  /** Search flows with natural language via dex flow search */
  async flowSearch(query: string): Promise<FlowSearchMatch[]> {
    try {
      const text = await this.execText(["flow", "search", query]);
      return this.parseFlowSearchOutput(text);
    } catch {
      return [];
    }
  }

  /** Run explore with --json for tool matches */
  private async exploreJson(query: string): Promise<ExploreToolMatch[]> {
    try {
      return await this.execJson<ExploreToolMatch[]>([
        "explore", query, "--json",
      ]);
    } catch {
      return [];
    }
  }

  /** Run explore text output and parse @@skills table */
  private async exploreSkills(query: string): Promise<ExploreSkillMatch[]> {
    try {
      const text = await this.execText(["explore", query]);
      return this.parseExploreSkillsTable(text);
    } catch {
      return [];
    }
  }

  /** Parse @@skills section from explore text output */
  private parseExploreSkillsTable(text: string): ExploreSkillMatch[] {
    const skills: ExploreSkillMatch[] = [];
    let inSkills = false;

    for (const line of text.split("\n")) {
      const trimmed = line.trim();

      if (trimmed.startsWith("@@skills")) {
        inSkills = true;
        continue;
      }
      if (inSkills && trimmed.startsWith("@@")) {
        break; // Hit next section
      }

      if (!inSkills || !line.includes("\u2502")) { continue; }

      const cells = line.split("\u2502").map((c) => c.trim());
      const filtered = cells.filter((_, i) => i > 0 && i < cells.length - 1);
      if (filtered.length < 3) { continue; }

      const [name, description, matchPercent] = filtered;
      if (name === "Name" || !name) { continue; }

      skills.push({ name, description, matchPercent });
    }

    return skills;
  }

  /** Parse dex flow search output (@@flows section with numbered entries) */
  private parseFlowSearchOutput(text: string): FlowSearchMatch[] {
    const flows: FlowSearchMatch[] = [];
    let inFlows = false;

    const lines = text.split("\n");
    let i = 0;
    while (i < lines.length) {
      const trimmed = lines[i].trim();

      if (trimmed.startsWith("@@flows")) {
        inFlows = true;
        i++;
        continue;
      }
      if (inFlows && trimmed.startsWith("@@")) {
        break; // Hit next section
      }

      if (!inFlows) { i++; continue; }

      // Match entry header: "1. [ATOMIC] flow-name (75% match)"
      const headerMatch = trimmed.match(
        /^\d+\.\s+\[(\w+)\]\s+(.+?)\s+\((\d+)%\s+match\)$/
      );
      if (!headerMatch) { i++; continue; }

      const flowType = headerMatch[1];
      const name = headerMatch[2];
      const matchPercent = parseInt(headerMatch[3], 10);

      // Collect indented lines following the header
      const details: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        // Continuation lines are indented (3+ spaces) and non-empty
        if (next.match(/^\s{3,}\S/)) {
          details.push(next.trim());
          i++;
        } else {
          break;
        }
      }

      // Parse detail lines
      let description = "";
      let location = "";
      let endpoints = "";
      let adapter = "";
      const descParts: string[] = [];

      for (const d of details) {
        if (d.startsWith("Location:")) {
          location = d.replace("Location:", "").trim();
        } else if (d.startsWith("Parameters:")) {
          // skip
        } else if (d.startsWith("Endpoints:")) {
          endpoints = d.replace("Endpoints:", "").trim();
          // Extract adapter from endpoints like "[OK] adapter/gmail"
          const adapterMatch = endpoints.match(/adapter\/(\S+)/);
          if (adapterMatch) { adapter = adapterMatch[1]; }
        } else if (d.startsWith("Use this if:")) {
          // skip
        } else {
          descParts.push(d);
        }
      }
      description = descParts.join(" ");

      flows.push({ name, description, matchPercent, flowType, location, endpoints, adapter });
    }

    return flows;
  }

  // ── Setup wizard methods ────────────────────────────────────────

  /** Install an adapter from registry (streaming output).
   *  Uses `dex registry adapter pull bootstrap/<id>` and auto-confirms. */
  installAdapterStream(adapterId: string): ChildProcess {
    const child = spawn(this.dexPath, ["registry", "adapter", "pull", `bootstrap/${adapterId}`], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    // Auto-confirm the [Y/n] prompt
    child.stdin?.write("y\n");
    child.stdin?.end();
    return child;
  }

  /** Pull associated skills/flows for an installed adapter.
   *  Uses `dex registry skill search <adapterId>` to get full (non-truncated) names,
   *  then pulls each matching skill. */
  async pullAssociatedSkills(adapterId: string): Promise<number> {
    // Search for skills associated with this adapter
    let searchOutput: string;
    try {
      searchOutput = await this.execText(["registry", "skill", "search", adapterId]);
    } catch {
      return 0;
    }

    // Parse full skill names from the search results table
    const skillNames: string[] = [];
    for (const line of searchOutput.split("\n")) {
      if (!line.includes("\u2502")) { continue; }
      const cells = line.split("\u2502").map((c) => c.trim());
      const filtered = cells.filter((_, i) => i > 0 && i < cells.length - 1);
      if (filtered.length < 2) { continue; }
      const name = filtered[0];
      if (name && name !== "Name" && !name.includes("─")) {
        // Deduplicate
        if (!skillNames.includes(name)) {
          skillNames.push(name);
        }
      }
    }

    let count = 0;
    for (const name of skillNames) {
      try {
        const child = spawn(this.dexPath, ["registry", "skill", "pull", `bootstrap/${name}`], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });
        child.stdin?.write("y\n");
        child.stdin?.end();
        const code = await new Promise<number | null>((resolve) => {
          child.on("close", resolve);
          child.on("error", () => resolve(1));
        });
        if (code === 0) { count++; }
      } catch {
        // Skip failures silently
      }
    }
    return count;
  }

  /** Run OAuth setup for Google (opens browser for consent) */
  oauthSetupGoogle(scopes: string[]): ChildProcess {
    const args = ["oauth", "setup", "google", "--scopes", scopes.join(",")];
    return spawn(this.dexPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  /** Wire a skill to an AI client via `dex install skill --provider <name> --agents` */
  async wireClient(clientName: string): Promise<boolean> {
    // Map extension wire IDs to dex provider names
    const providerMap: Record<string, string> = {
      "dex-skill-claude-code": "claude",
      "dex-skill-cursor": "cursor",
      "dex-skill-codex": "codex",
      "dex-agents-md": "agents-md",
    };
    const provider = providerMap[clientName] || clientName;
    return this.execSilent(["install", "skill", "--provider", provider, "--agents"]);
  }

  /** Get list of available skills for wiring */
  async availableSkills(): Promise<RegistrySkill[]> {
    return this.registrySkillList("bootstrap");
  }

  /** Get proof-of-life flow details for an adapter (mirrors Rust proof_flow_for) */
  private proofFlowFor(adapterId: string): { flowName: string; args: string[] } | null {
    const summary = "--output=summary";
    const now = new Date();
    switch (adapterId) {
      case "github":
        return { flowName: "search-github-repositories", args: ["trending", "any", "5", "stars", summary] };
      case "gmail":
        return { flowName: "retrieve-recent-emails", args: ["5", summary] };
      case "calendar": {
        const today = now.toISOString().replace(/T.*/, "T00:00:00Z");
        const dayAfterTomorrow = new Date(now.getTime() + 2 * 86400000).toISOString().replace(/T.*/, "T00:00:00Z");
        return { flowName: "check-calendar-meetings", args: [today, dayAfterTomorrow, summary] };
      }
      case "stripe": {
        const todayStr = now.toISOString().slice(0, 10);
        const monthStart = todayStr.slice(0, 8) + "01";
        return { flowName: "fetch-stripe-payables-receivables", args: [monthStart, todayStr, "receivables", summary] };
      }
      case "linear":
        return { flowName: "list-linear-issues", args: ["5", summary] };
      default:
        return null;
    }
  }

  /** Run proof-of-life flow for an adapter using deno directly */
  async runProofOfLife(adapterId: string): Promise<ProofResult> {
    const proof = this.proofFlowFor(adapterId);
    if (!proof) {
      return { adapter: adapterId, success: false, error: "No proof flow for this adapter" };
    }

    const homeDir = os.homedir();
    const flowPath = path.join(homeDir, ".dex", "flows", "bootstrap", proof.flowName, "main.ts");
    const denoPath = path.join(homeDir, ".dex", "bin", "deno");
    const cacheDir = path.join(homeDir, ".dex", "deno_cache");

    if (!fs.existsSync(flowPath)) {
      return { adapter: adapterId, success: false, error: `Flow not found: ${proof.flowName}` };
    }

    try {
      const { stdout, stderr } = await execFileAsync(denoPath, ["run", "--allow-all", flowPath, ...proof.args], {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, DENO_DIR: cacheDir },
      });
      // Strip ANSI escape codes from output
      // eslint-disable-next-line no-control-regex
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, "");
      const raw = stdout.trim() || stderr.trim();
      const output = stripAnsi(raw);
      return { adapter: adapterId, success: true, output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { adapter: adapterId, success: false, error: msg };
    }
  }

  /** Detect which tokens are needed by reading each adapter's manifest.json.
   *  Mirrors the Rust `probe_adapter_tokens` logic from setup/state.rs. */
  async detectTokenRequirements(): Promise<SetupTokenRequirement[]> {
    const adaptersDir = path.join(os.homedir(), ".dex", "adapters");
    const vaultTokens = await this.vaultTokenList();
    const configuredNames = new Set(vaultTokens.map((t) => t.name));

    // Also check via `dex token list` for configured tokens
    const tokenList = await this.tokenList();
    for (const t of tokenList) {
      if (t.configured) { configuredNames.add(t.env_var); }
    }

    // Read installed adapter dirs
    let adapterDirs: string[] = [];
    try {
      adapterDirs = fs.readdirSync(adaptersDir).filter((d) => {
        const stat = fs.statSync(path.join(adaptersDir, d));
        return stat.isDirectory();
      });
    } catch {
      return [];
    }

    // Read manifest.json from each adapter to get token_env
    const byEnv = new Map<string, string[]>();
    for (const adapterId of adapterDirs) {
      const manifestPath = path.join(adaptersDir, adapterId, "manifest.json");
      const envVar = this.readTokenEnvFromManifest(manifestPath);
      if (envVar) {
        const list = byEnv.get(envVar) || [];
        list.push(adapterId);
        byEnv.set(envVar, list);
      }
    }

    const reqs: SetupTokenRequirement[] = [];
    for (const [envVar, adapterIds] of byEnv) {
      reqs.push({
        env_var: envVar,
        adapters: adapterIds,
        configured: configuredNames.has(envVar),
        is_oauth: envVar === "GSUITE_TOKEN",
        url: DexClient.tokenUrlFor(envVar),
      });
    }
    return reqs;
  }

  /** Extract token env var from adapter manifest.json auth section.
   *  Supports simple auth (token_env/key_env) and per-operation auth (schemes). */
  private readTokenEnvFromManifest(manifestPath: string): string | undefined {
    try {
      const content = fs.readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(content);
      const auth = manifest?.auth;
      if (!auth) { return undefined; }

      // Simple auth: top-level token_env or key_env
      if (auth.token_env) { return auth.token_env; }
      if (auth.key_env) { return auth.key_env; }

      // Per-operation auth: schemes[default_scheme].token_env or .key_env
      const defaultScheme = auth.default_scheme;
      if (defaultScheme && auth.schemes?.[defaultScheme]) {
        const scheme = auth.schemes[defaultScheme];
        if (scheme.token_env) { return scheme.token_env; }
        if (scheme.key_env) { return scheme.key_env; }
      }
    } catch {
      // Manifest unreadable
    }
    return undefined;
  }

  /** Get URL where user can create/find their token. Mirrors Rust token_url_for(). */
  private static tokenUrlFor(envVar: string): string | undefined {
    const urls: Record<string, string> = {
      GITHUB_TOKEN: "https://github.com/settings/tokens/new",
      GEMINI_API_KEY: "https://aistudio.google.com/app/apikey",
      LINEAR_API: "https://linear.app/settings/api",
      ADAPTER_NOTION_TOKEN: "https://www.notion.so/my-integrations",
      CLOUDFLARE_API: "https://dash.cloudflare.com/profile/api-tokens",
      ELEVEN_LABS_API: "https://elevenlabs.io/app/settings/api-keys",
      MANUS_API: "https://app.manus.ai/settings/api",
      STRIPE_API: "https://dashboard.stripe.com/apikeys",
    };
    return urls[envVar];
  }

  /** Ensure baseline stdio MCP servers are configured in ~/.dex/config/mcp.json */
  async ensureStdioBaseline(): Promise<void> {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, ".dex", "config");
    const mcpPath = path.join(configDir, "mcp.json");

    // Only write if mcp.json doesn't exist or has no servers
    let needsWrite = true;
    try {
      const existing = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
      const servers = existing?.mcpServers;
      if (servers && Object.keys(servers).length > 0) {
        needsWrite = false;
      }
    } catch {
      // File doesn't exist or invalid JSON
    }

    if (needsWrite) {
      const mcpConfig = {
        mcpServers: {
          "playwright-headed": {
            command: "npx",
            args: ["-y", "@playwright/mcp@latest", "--browser", "chrome", "--no-sandbox"],
          },
          "playwright-nosandbox": {
            command: "npx",
            args: ["-y", "@playwright/mcp@latest", "--browser", "chrome", "--no-sandbox", "--headless"],
          },
          "chrome-devtools-headed": {
            command: "npx",
            args: ["chrome-devtools-mcp@latest", "--chromeArg=--no-sandbox", "--chromeArg=--disable-setuid-sandbox"],
          },
          "chrome-devtools-nosandbox": {
            command: "npx",
            args: ["chrome-devtools-mcp@latest", "--headless", "--chromeArg=--no-sandbox", "--chromeArg=--disable-setuid-sandbox"],
          },
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          },
        },
      };

      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    }
  }

  /** Start the stdio daemon (idempotent) */
  async startDaemon(): Promise<void> {
    try {
      await this.execSilent(["daemon", "start"]);
    } catch {
      // Daemon may already be running — that's fine
    }
  }

  /** Check if setup is complete (has adapters, tokens, and skills) */
  async isSetupComplete(): Promise<boolean> {
    try {
      const [adapters, tokens] = await Promise.all([
        this.adapterList(),
        this.tokenList(),
      ]);
      return adapters.length > 0 && tokens.some((t) => t.configured);
    } catch {
      return false;
    }
  }

  /** Parse @@section-based whoami output */
  private parseWhoamiText(text: string): RegistryWhoami {
    const result: RegistryWhoami = {
      status: "error",
      email: "",
      tokenExpires: "",
      tokenIssued: "",
      registryUrl: "",
      connected: false,
    };

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("ok: Authenticated as")) {
        result.email = trimmed.replace("ok: Authenticated as", "").trim();
        result.status = "valid";
      }
      if (trimmed.startsWith("token_status:")) {
        const val = trimmed.split(":").slice(1).join(":").trim();
        result.status = val === "valid" ? "valid" : "expired";
      }
      if (trimmed.startsWith("token_expires:")) {
        result.tokenExpires = trimmed.split(":").slice(1).join(":").trim();
      }
      if (trimmed.startsWith("token_issued:")) {
        result.tokenIssued = trimmed.split(":").slice(1).join(":").trim();
      }
      if (trimmed.startsWith("registry_url:")) {
        result.registryUrl = trimmed.split(":").slice(1).join(":").trim();
      }
      if (trimmed.startsWith("connected:")) {
        result.connected = trimmed.includes("yes");
      }
    }

    return result;
  }

  /** Parse registry adapter table (│-delimited: Name | Fingerprint | Visibility | Description) */
  private parseRegistryAdapterTable(text: string): RegistryAdapter[] {
    const adapters: RegistryAdapter[] = [];
    let currentAdapter: Partial<RegistryAdapter> | null = null;

    for (const line of text.split("\n")) {
      if (!line.includes("\u2502")) { continue; }

      const cells = line.split("\u2502").map((c) => c.trim());
      // Remove empty leading/trailing cells from box drawing
      const filtered = cells.filter((_, i) => i > 0 && i < cells.length - 1);
      if (filtered.length < 4) { continue; }

      const [name, fingerprint, visibility, description] = filtered;

      // Skip header row
      if (name === "Name") { continue; }

      if (name) {
        // New adapter row
        if (currentAdapter && currentAdapter.name) {
          adapters.push(currentAdapter as RegistryAdapter);
        }
        currentAdapter = { name, fingerprint, visibility, description };
      } else if (currentAdapter) {
        // Continuation row — append description
        currentAdapter.description =
          (currentAdapter.description || "") + " " + description;
      }
    }

    if (currentAdapter && currentAdapter.name) {
      adapters.push(currentAdapter as RegistryAdapter);
    }

    return adapters;
  }

  /** Parse registry skill table (│-delimited: Name | Description | Adapters | Visibility) */
  private parseRegistrySkillTable(text: string): RegistrySkill[] {
    const skills: RegistrySkill[] = [];
    let currentSkill: Partial<RegistrySkill> | null = null;

    for (const line of text.split("\n")) {
      if (!line.includes("\u2502")) { continue; }

      const cells = line.split("\u2502").map((c) => c.trim());
      const filtered = cells.filter((_, i) => i > 0 && i < cells.length - 1);
      if (filtered.length < 4) { continue; }

      const [name, description, adapters, visibility] = filtered;

      // Skip header row
      if (name === "Name") { continue; }

      if (name) {
        if (currentSkill && currentSkill.name) {
          skills.push(currentSkill as RegistrySkill);
        }
        currentSkill = { name, description, adapters, visibility };
      } else if (currentSkill) {
        currentSkill.description =
          (currentSkill.description || "") + " " + description;
      }
    }

    if (currentSkill && currentSkill.name) {
      skills.push(currentSkill as RegistrySkill);
    }

    return skills;
  }

  /** Parse adapter list table output into structured data.
   *  Table format: | ID | Name | Tools | Type | Usage | Success | Status |
   *  Group header rows like "gsuite (4 adapter...)" have no ID in columns.
   */
  private parseAdapterListText(text: string): Adapter[] {
    const adapters: Adapter[] = [];
    let currentGroup: string | undefined;

    for (const line of text.split("\n")) {
      // Skip box-drawing borders and empty lines
      if (!line.includes("\u2502")) {
        // Check for group header: "gsuite (4 adapter...)"
        const groupMatch = line.trim().match(/^(\w+)\s+\(\d+\s+adapter/);
        if (groupMatch) {
          currentGroup = groupMatch[1];
        }
        continue;
      }

      // Split table row by │
      const cells = line
        .split("\u2502")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length < 2) {
        continue;
      }

      const id = cells[0];
      const name = cells[1];

      // Skip header row
      if (id === "ID" || id === "Name") {
        continue;
      }

      // Skip group header rows (id contains "(" like "gsuite (4 adapter...)")
      if (id.includes("(") || id.includes("adapter")) {
        const gm = id.match(/^(\w+)/);
        if (gm) {
          currentGroup = gm[1];
        }
        continue;
      }

      // Must have a non-empty ID starting with a letter
      if (!id || !id.match(/^[a-z]/i)) {
        continue;
      }

      const tools = cells.length >= 3 ? parseInt(cells[2], 10) || 0 : 0;
      const specType = cells.length >= 4 ? cells[3] : "";
      const usage = cells.length >= 5 ? cells[4] : "";
      const success = cells.length >= 6 ? cells[5] : "";
      const status = cells.length >= 7 ? cells[6] : "";
      const hasToken = status.includes("\u2713") || status.includes("ready");

      adapters.push({
        id,
        name: name || id,
        group: currentGroup,
        has_token: hasToken,
        tools,
        spec_type: specType || undefined,
        usage: usage || undefined,
        success: success || undefined,
      });
    }

    return adapters;
  }

  /** Parse catalog list text output */
  private parseCatalogListText(text: string): CatalogCategory[] {
    const categories: CatalogCategory[] = [];
    for (const line of text.split("\n")) {
      // Format: "  HR / Platform           20 APIs   Workday: Asor, ..."
      const match = line
        .trim()
        .match(/^(.+?)\s+(\d+)\s+APIs?\s+(.+)$/);
      if (match) {
        categories.push({
          name: match[1].trim(),
          count: parseInt(match[2], 10),
          examples: match[3].trim(),
        });
      }
    }
    return categories;
  }

  /** Parse token list text output into structured data */
  private parseTokenListText(text: string): TokenInfo[] {
    const tokens: TokenInfo[] = [];
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("-") || trimmed.startsWith("=")) {
        continue;
      }

      // Best-effort parse: "GITHUB_TOKEN    github    ✓ configured"
      const match = trimmed.match(/^(\S+)\s+(\S+)\s+(.+)$/);
      if (match) {
        const [, envVar, adapterId, status] = match;
        tokens.push({
          env_var: envVar,
          adapter_id: adapterId,
          configured:
            status.includes("\u2713") || status.includes("configured"),
        });
      }
    }

    return tokens;
  }

  /** Parse `dex token list` table with │-delimited columns:
   *  Name | Type | Expires In | Refresh | Created | Description */
  private parseVaultTokenTable(text: string): VaultToken[] {
    const tokens: VaultToken[] = [];
    const lines = text.split("\n");

    for (const line of lines) {
      // Skip borders (┌─┬─┐, ├─┼─┤, └─┴─┘), headers, status/result sections
      if (
        !line.includes("│") ||
        line.includes("Name") && line.includes("Type") && line.includes("Expires")
      ) {
        continue;
      }

      const cells = line
        .split("│")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);

      if (cells.length < 2) {
        continue;
      }

      // A data row has a name in the first cell (non-empty, not a continuation line)
      const name = cells[0];
      if (!name || name.startsWith("(")) {
        // Continuation line like "(auto-refreshed)" — append to previous description
        if (tokens.length > 0 && cells.length >= 1) {
          const prev = tokens[tokens.length - 1];
          const extra = cells.join(" ").trim();
          if (extra) {
            prev.description = prev.description === "-"
              ? extra
              : `${prev.description} ${extra}`;
          }
        }
        continue;
      }

      tokens.push({
        name,
        type: cells[1] || "-",
        expires_in: cells[2] || "-",
        refresh: cells[3] || "-",
        created: cells[4] || "-",
        description: cells[5] || "-",
      });
    }

    return tokens;
  }
}
