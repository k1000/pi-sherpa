import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryScope = "project" | "research" | "transcendental";
export type MemoryConfidence = "low" | "medium" | "high";
export type MemoryStatus = "active" | "needs-review" | "archived";

export type MemoryChunk = {
  id: string;
  artifactId: string;
  scope: MemoryScope;
  project?: string;
  area?: string;
  chunkIndex: number;
  text: string;
  sectionPath?: string;
  embedding?: number[];
  sourcePath?: string;
};

export type MemoryArtifact = {
  id: string;
  scope: MemoryScope;
  project?: string;
  area?: string;
  category?: string;
  type: string;
  title: string;
  summary?: string;
  text?: string;
  sourcePath?: string;
  sourceHash?: string;
  confidence?: MemoryConfidence;
  status?: MemoryStatus;
  tags?: string[];
  aliases?: string[];
  routes?: string[];
  keywords?: string[];
  embedding?: number[];
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryRelation = {
  from: string;
  relation: string;
  to: string;
  /** Persistent edge strength used as a practical SAGE-style propagation weight. */
  weight?: number;
  confidence?: MemoryConfidence;
  source?: string;
  createdAt?: string;
};

export type MemoryQuery = {
  text: string;
  scope?: MemoryScope;
  project?: string;
  area?: string;
  types?: string[];
  tags?: string[];
  embedding?: number[];
  limit?: number;
};

export type EvidenceChainStep = {
  from: string;
  relation: string;
  to: string;
  summary?: string;
};

export type MemoryResult = {
  artifact: MemoryArtifact;
  score: number;
  reason: string;
  evidenceChain?: EvidenceChainStep[];
};

export type RetrievalFeedback = {
  query: string;
  selectedIds: string[];
  usedIds?: string[];
  unusedIds?: string[];
  missing?: string[];
  outcome?: "helpful" | "partial" | "unhelpful";
  notes?: string;
  createdAt?: string;
};

export type RetrievalFeedbackRecord = RetrievalFeedback & { id?: string };

export interface MemoryStore {
  writeArtifact(input: MemoryArtifact): Promise<void>;
  writeChunk?(input: MemoryChunk): Promise<void>;
  writeRelation(input: MemoryRelation): Promise<void>;
  search(query: MemoryQuery): Promise<MemoryResult[]>;
  retrieveEvidenceChain(id: string, options?: { depth?: number; limit?: number }): Promise<EvidenceChainStep[]>;
  recordFeedback(input: RetrievalFeedback): Promise<void>;
}

export class NullMemoryStore implements MemoryStore {
  async writeArtifact(_input: MemoryArtifact): Promise<void> {}
  async writeChunk(_input: MemoryChunk): Promise<void> {}
  async writeRelation(_input: MemoryRelation): Promise<void> {}
  async search(_query: MemoryQuery): Promise<MemoryResult[]> { return []; }
  async retrieveEvidenceChain(_id: string, _options?: { depth?: number; limit?: number }): Promise<EvidenceChainStep[]> { return []; }
  async recordFeedback(_input: RetrievalFeedback): Promise<void> {}
}

export class DualMemoryStore implements MemoryStore {
  private readonly primary: MemoryStore;
  private readonly secondary?: MemoryStore;

  constructor(primary: MemoryStore, secondary?: MemoryStore) {
    this.primary = primary;
    this.secondary = secondary;
  }

  async writeArtifact(input: MemoryArtifact): Promise<void> {
    await this.primary.writeArtifact(input);
    if (this.secondary) await this.secondary.writeArtifact(input).catch(() => undefined);
  }

  async writeChunk(input: MemoryChunk): Promise<void> {
    if (this.primary.writeChunk) await this.primary.writeChunk(input);
    if (this.secondary?.writeChunk) await this.secondary.writeChunk(input).catch(() => undefined);
  }

  async writeRelation(input: MemoryRelation): Promise<void> {
    await this.primary.writeRelation(input);
    if (this.secondary) await this.secondary.writeRelation(input).catch(() => undefined);
  }

  async search(query: MemoryQuery): Promise<MemoryResult[]> {
    const primaryResults = await this.primary.search(query);
    if (primaryResults.length || !this.secondary) return primaryResults;
    return this.secondary.search(query).catch(() => []);
  }

  async retrieveEvidenceChain(id: string, options?: { depth?: number; limit?: number }): Promise<EvidenceChainStep[]> {
    const primaryChain = await this.primary.retrieveEvidenceChain(id, options);
    if (primaryChain.length || !this.secondary) return primaryChain;
    return this.secondary.retrieveEvidenceChain(id, options).catch(() => []);
  }

  async recordFeedback(input: RetrievalFeedback): Promise<void> {
    await this.primary.recordFeedback(input);
    if (this.secondary) await this.secondary.recordFeedback(input).catch(() => undefined);
  }
}

export type MemoryApiStoreConfig = {
  enabled: boolean;
  url: string;
  namespace: string;
  database: string;
  /** Use the Inquirer HTTP memory API. */
  mode?: "memory-api";
  token?: string;
  tokenEnv?: string;
  userEnv?: string;
  passEnv?: string;
};

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function apiBearerToken(config: MemoryApiStoreConfig): string | undefined {
  return config.token
    || (config.tokenEnv ? process.env[config.tokenEnv] : undefined)
    || process.env.SHERPA_MEMORY_API_TOKEN
    || process.env.MEMORY_API_TOKEN
    // inquirer/scripts/run-dev.sh defaults the local dev service to this token.
    || (isLocalUrl(config.url) ? "dev-token" : undefined);
}

function cloudflareAccessCookie(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    const dir = join(homedir(), ".cloudflared");
    if (!existsSync(dir)) return undefined;
    const tokenFile = readdirSync(dir).find((name) => name.startsWith(`${host}-`) && name.endsWith("-token"));
    if (!tokenFile) return undefined;
    const token = readFileSync(join(dir, tokenFile), "utf8").trim();
    return token ? `CF_Authorization=${token}` : undefined;
  } catch {
    return undefined;
  }
}

function envFirst(...names: Array<string | undefined>): string | undefined {
  for (const name of names) {
    if (!name) continue;
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

type ApiObject = Record<string, unknown>;

function firstDefined(input: ApiObject, ...keys: string[]): unknown {
  for (const key of keys) if (input[key] !== undefined && input[key] !== null) return input[key];
  return undefined;
}

function apiString(input: ApiObject, fallback: string, ...keys: string[]): string {
  return String(firstDefined(input, ...keys) ?? fallback);
}

function apiStringArray(input: ApiObject, key: string): string[] | undefined {
  const value = input[key];
  return Array.isArray(value) ? value.map(String) : undefined;
}

function mapApiEvidenceStep(step: ApiObject): EvidenceChainStep {
  return {
    from: apiString(step, "", "from", "fromId", "from_id"),
    relation: apiString(step, "related", "relation", "type"),
    to: apiString(step, "", "to", "toId", "to_id"),
    summary: firstDefined(step, "summary") as string | undefined,
  };
}

function mapApiArtifact(input: ApiObject): MemoryArtifact {
  const id = apiString(input, "", "id", "memory_id", "memoryId");
  const embedding = input.embedding;
  return {
    id,
    scope: apiString(input, "project", "scope") as MemoryArtifact["scope"],
    project: firstDefined(input, "project") as string | undefined,
    area: firstDefined(input, "area") as string | undefined,
    category: firstDefined(input, "category") as string | undefined,
    type: apiString(input, "evidence", "type") as MemoryArtifact["type"],
    title: apiString(input, id || "Memory artifact", "title"),
    summary: firstDefined(input, "summary") as string | undefined,
    text: firstDefined(input, "text") as string | undefined,
    sourcePath: firstDefined(input, "sourcePath", "source_path") as string | undefined,
    sourceHash: firstDefined(input, "sourceHash", "source_hash") as string | undefined,
    confidence: firstDefined(input, "confidence") as number | undefined,
    status: firstDefined(input, "status") as string | undefined,
    tags: apiStringArray(input, "tags"),
    aliases: apiStringArray(input, "aliases"),
    routes: apiStringArray(input, "routes"),
    keywords: apiStringArray(input, "keywords"),
    embedding: Array.isArray(embedding) ? embedding.map(Number) : undefined,
    createdAt: firstDefined(input, "createdAt", "created_at") as string | undefined,
    updatedAt: firstDefined(input, "updatedAt", "updated_at") as string | undefined,
  };
}

function mapApiSearchResult(item: any): MemoryResult {
  const artifact = mapApiArtifact((item.artifact ?? item) as ApiObject);
  const chunks = Array.isArray(item.chunks) ? item.chunks : [];
  const firstChunk = chunks.find((chunk: any) => typeof chunk?.text === "string");
  return {
    artifact: {
      ...artifact,
      text: artifact.text ?? firstChunk?.text,
      sourcePath: artifact.sourcePath ?? firstChunk?.sourcePath ?? firstChunk?.source_path,
    },
    score: Number(item.score ?? item.rank ?? 0),
    reason: String(item.reason ?? item.diagnostics?.reason ?? "memory API match"),
    evidenceChain: Array.isArray(item.evidenceChain) ? item.evidenceChain.map(mapApiEvidenceStep) : undefined,
  };
}

export class MemoryApiStore implements MemoryStore {
  private readonly config: MemoryApiStoreConfig;

  constructor(config: MemoryApiStoreConfig) {
    this.config = config;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
    const token = apiBearerToken(this.config);
    if (token) headers.Authorization = `Bearer ${token}`;
    const cfCookie = cloudflareAccessCookie(this.config.url);
    if (cfCookie) headers.Cookie = cfCookie;
    if (!token) {
      const user = envFirst("SHERPA_MEMORY_API_USERNAME", this.config.userEnv, "USERNAME", "AUTH_USERNAME");
      const pass = envFirst("SHERPA_MEMORY_API_PASSWORD", this.config.passEnv, "PASSWORD", "AUTH_PASSWORD");
      if (user && pass) headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    }
    return headers;
  }

  private async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const timeoutMs = method === "GET" ? 5000 : 10000;
    const response = await fetch(`${this.config.url.replace(/\/$/, "")}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Memory API ${response.status}: ${await response.text()}`);
    return await response.json() as T;
  }

  async writeArtifact(input: MemoryArtifact): Promise<void> {
    const sourceText = input.text?.trim();
    if (sourceText) {
      await this.request("POST", "/api/v1/memory/ingest", {
        artifact: input,
        sourceText,
        options: {
          chunk: true,
          embed: true,
          extractJsonLd: false,
          disambiguate: false,
          linkMentions: false,
          semanticGraph: false,
          applyGraphPatches: false,
        },
      });
      return;
    }
    await this.request("PUT", `/api/v1/memory/artifacts/${encodeURIComponent(input.id)}`, input);
  }

  async writeChunk(input: MemoryChunk): Promise<void> {
    await this.request("PUT", `/api/v1/memory/chunks/${encodeURIComponent(input.id)}`, input);
  }

  async writeRelation(input: MemoryRelation): Promise<void> {
    await this.request("POST", "/api/v1/memory/relations", input);
  }

  async search(query: MemoryQuery): Promise<MemoryResult[]> {
    const payload = await this.request<any[]>("POST", "/api/v1/memory/search", {
      ...query,
      types: query.types ?? [],
      tags: query.tags ?? [],
      includeChunks: true,
      includeEvidence: true,
    });
    if (!Array.isArray(payload)) throw new Error("Memory API returned non-list search payload");
    return payload.map(mapApiSearchResult);
  }

  async retrieveEvidenceChain(id: string, options?: { depth?: number; limit?: number }): Promise<EvidenceChainStep[]> {
    const params = new URLSearchParams({
      depth: String(Math.max(1, Math.min(5, Math.floor(options?.depth ?? 2)))),
      limit: String(Math.max(1, Math.min(100, Math.floor(options?.limit ?? 20)))),
    });
    const payload = await this.request<any[]>("GET", `/api/v1/memory/artifacts/${encodeURIComponent(id)}/evidence-chain?${params.toString()}`);
    if (!Array.isArray(payload)) throw new Error("Memory API returned non-list evidence chain payload");
    return payload.map(mapApiEvidenceStep);
  }

  async recordFeedback(input: RetrievalFeedback): Promise<void> {
    await this.request("POST", "/api/v1/memory/retrieval-feedback", {
      query: input.query,
      selectedIds: input.selectedIds,
      usedIds: input.usedIds ?? [],
      unusedIds: input.unusedIds ?? [],
      missing: input.missing ?? [],
      outcome: input.outcome,
      notes: input.notes,
      createdAt: input.createdAt,
    });
  }

  async recentFeedback(limit = 50): Promise<RetrievalFeedbackRecord[]> {
    const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(200, Math.floor(limit)))) });
    const payload = await this.request<any[]>("GET", `/api/v1/memory/retrieval-feedback?${params.toString()}`);
    if (!Array.isArray(payload)) throw new Error("Memory API returned non-list retrieval feedback payload");
    return payload.map((item) => ({
      id: item.id,
      query: item.query ?? "",
      selectedIds: Array.isArray(item.selectedIds) ? item.selectedIds : [],
      usedIds: Array.isArray(item.usedIds) ? item.usedIds : [],
      unusedIds: Array.isArray(item.unusedIds) ? item.unusedIds : [],
      missing: Array.isArray(item.missing) ? item.missing : [],
      outcome: item.outcome,
      notes: item.notes,
      createdAt: item.createdAt,
    }));
  }
}
