import * as vscode from "vscode";
import { execFile, spawn, ChildProcess } from "child_process";
import { promisify } from "util";

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

  /** Execute a dex command and parse JSON output */
  async execJson<T>(args: string[]): Promise<T> {
    try {
      const { stdout } = await execFileAsync(this.dexPath, args, {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      });
      return JSON.parse(stdout.trim()) as T;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`dex ${args.join(" ")} failed: ${msg}`);
    }
  }

  /** Execute a dex command, return stdout as string */
  async execText(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.dexPath, args, {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      });
      return stdout.trim();
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

  /** Check if dex binary is available */
  async isAvailable(): Promise<boolean> {
    return this.execSilent(["--version"]);
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
}
