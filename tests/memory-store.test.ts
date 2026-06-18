/**
 * Sherpa memory-store abstraction tests.
 * Run with: tsx tests/memory-store.test.ts
 */

import { DualMemoryStore, MemoryApiStore, NullMemoryStore, type MemoryArtifact, type MemoryChunk, type MemoryQuery, type MemoryResult, type MemoryStore, type RetrievalFeedback } from "../lib/memory-store.ts";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }

class RecordingStore implements MemoryStore {
  artifacts: MemoryArtifact[] = [];
  chunks: MemoryChunk[] = [];
  feedback: RetrievalFeedback[] = [];
  private readonly results: MemoryResult[];
  private readonly failWrites: boolean;

  constructor(results: MemoryResult[] = [], failWrites = false) {
    this.results = results;
    this.failWrites = failWrites;
  }

  async writeArtifact(input: MemoryArtifact): Promise<void> {
    if (this.failWrites) throw new Error("write failed");
    this.artifacts.push(input);
  }

  async writeChunk(input: MemoryChunk): Promise<void> {
    if (this.failWrites) throw new Error("chunk write failed");
    this.chunks.push(input);
  }

  async writeRelation(): Promise<void> {}
  async search(_query: MemoryQuery): Promise<MemoryResult[]> { return this.results; }
  async retrieveEvidenceChain(): Promise<[]> { return []; }
  async recordFeedback(input: RetrievalFeedback): Promise<void> { this.feedback.push(input); }
}

test("NullMemoryStore is a safe no-op", async () => {
  const store = new NullMemoryStore();
  await store.writeArtifact({ id: "a", scope: "project", type: "evidence", title: "A" });
  assert((await store.search({ text: "anything" })).length === 0, "expected no results");
  assert((await store.retrieveEvidenceChain("a")).length === 0, "expected no chain");
});

test("DualMemoryStore writes primary and best-effort secondary", async () => {
  const primary = new RecordingStore();
  const secondary = new RecordingStore([], true);
  const store = new DualMemoryStore(primary, secondary);
  await store.writeArtifact({ id: "a", scope: "project", type: "evidence", title: "A" });
  assert(primary.artifacts.length === 1, "expected primary write");
});

test("DualMemoryStore writes chunks through the primary and best-effort secondary", async () => {
  const primary = new RecordingStore();
  const secondary = new RecordingStore([], true);
  const store = new DualMemoryStore(primary, secondary);
  await store.writeChunk({ id: "a.chunk.0", artifactId: "a", scope: "project", chunkIndex: 0, text: "semantic chunk", embedding: [0.1, 0.2] });
  assert(primary.chunks.length === 1, "expected primary chunk write");
  assert(primary.chunks[0]!.embedding?.length === 2, "expected chunk embedding to be preserved");
});

test("DualMemoryStore falls back to secondary search when primary is empty", async () => {
  const result: MemoryResult = { artifact: { id: "b", scope: "project", type: "claim", title: "B" }, score: 0.7, reason: "test" };
  const store = new DualMemoryStore(new RecordingStore([]), new RecordingStore([result]));
  const results = await store.search({ text: "B" });
  assert(results.length === 1 && results[0]!.artifact.id === "b", "expected secondary result");
});

test("MemoryApiStore calls the HTTP memory API and maps search results", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/ingest")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("/retrieval-feedback")) {
      return new Response(JSON.stringify([{ query: "cash", selectedIds: ["note:cash"], missing: ["note:wire"], createdAt: "2026-05-21T00:00:00Z" }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify([{
      artifact: { id: "note:cash", scope: "project", type: "note", title: "Cash", summary: "cash summary" },
      score: 0.91,
      reason: "vector",
      chunks: [{ id: "chunk:cash", text: "Cash details" }],
      evidenceChain: [{ from: "note:cash", relation: "mentions", to: "entity:cash" }],
    }]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const store = new MemoryApiStore({ enabled: true, url: "http://memory.test", namespace: "pi", database: "memory", token: "test-token" });
    await store.writeArtifact({ id: "note:new", scope: "project", type: "note", title: "New", text: "searchable text" });
    assert(calls[0]!.url === "http://memory.test/api/v1/memory/ingest", "expected text artifacts to use ingest endpoint");
    const ingestBody = JSON.parse(String(calls[0]!.init!.body));
    assert(ingestBody.sourceText === "searchable text", "expected sourceText for searchable ingest");
    assert(ingestBody.options.chunk === true && ingestBody.options.extractJsonLd === false, "expected bounded ingest options");
    const results = await store.search({ text: "cash", project: "demo", limit: 3 });
    assert(calls[1]!.url === "http://memory.test/api/v1/memory/search", "expected search endpoint");
    assert((calls[1]!.init!.headers as Record<string, string>).Authorization === "Bearer test-token", "expected bearer auth");
    assert(results[0]!.artifact.id === "note:cash", "expected artifact mapping");
    assert(results[0]!.artifact.text === "Cash details", "expected chunk text fallback");
    assert(results[0]!.evidenceChain?.[0]?.to === "entity:cash", "expected evidence mapping");
    const feedback = await store.recentFeedback(5);
    assert(calls[2]!.url === "http://memory.test/api/v1/memory/retrieval-feedback?limit=5", "expected feedback endpoint");
    assert(feedback[0]!.missing?.[0] === "note:wire", "expected feedback mapping");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const { name, fn } of tests) {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
