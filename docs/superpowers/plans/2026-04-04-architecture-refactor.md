# Architecture Refactor & Security Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose `src/client.ts` (1,400 lines) into `RpcTransport`, `ResponseParser`, and `AuthManager` modules while fixing critical security vulnerabilities.

**Architecture:** Vertical extraction — each module handles one layer of the data flow (transport → parsing → auth lifecycle). `NotebookLMClient` becomes a thin facade composing the three. Security fixes ship as an independent first task.

**Tech Stack:** TypeScript (strict), vitest + msw for testing, tsup for bundling.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/rpc-transport.ts` | Create | HTTP fetch, batchexecute encoding, headers, timeouts, Set-Cookie extraction |
| `src/response-parser.ts` | Create | Parse batchexecute protocol + typed domain object parsers |
| `src/auth-manager.ts` | Create | Token state, CSRF refresh, unified auth retry |
| `src/types.ts` | Modify | Add `ConversationTurn` interface |
| `src/client.ts` | Modify | Reduce to thin facade (~400 lines) |
| `src/auth.ts` | Modify | Security fixes + export `parseCookieString` |
| `src/tools/source.ts` | Modify | async file read + path resolve |
| `src/tools/index.ts` | Modify | Eliminate `any` types |
| `src/cli.ts` | Modify | Fix version string |
| `src/__tests__/response-parser.test.ts` | Create | Unit tests with fixtures |
| `src/__tests__/rpc-transport.test.ts` | Create | MSW HTTP mock tests |
| `src/__tests__/client.test.ts` | Modify | Adapt to new internals |
| `src/__tests__/integration.test.ts` | Modify | Adapt to new internals |

---

### Task 1: Security fixes

**Files:**
- Modify: `src/auth.ts:45-48,167-176`
- Modify: `src/tools/source.ts:3,51-58`
- Modify: `src/cli.ts:12`

- [ ] **Step 1: Fix command injection in `auth.ts`**

Replace `execSync` with `execFile` in `openInBrowser`:

First, update the import at the top of `auth.ts`:

```typescript
// src/auth.ts line 4 — change:
import { execSync } from "node:child_process";
// to:
import { execFile } from "node:child_process";
```

Then replace the `openInBrowser` function (lines 167-180):

```typescript
function openInBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "linux") {
      execFile("xdg-open", [url], { stdio: "ignore" }, () => {});
    } else if (platform === "darwin") {
      execFile("open", [url], { stdio: "ignore" }, () => {});
    } else if (platform === "win32") {
      execFile("cmd", ["/c", "start", "", url], { stdio: "ignore" }, () => {});
    }
  } catch {
    console.log(`Could not open browser automatically. Open this URL manually:\n${url}`);
  }
}
```

- [ ] **Step 2: Fix file permissions in `auth.ts`**

Replace `saveTokens` function (lines 45-48):

```typescript
export function saveTokens(tokens: AuthTokens): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(AUTH_FILE, JSON.stringify(tokens, null, 2), { encoding: "utf-8", mode: 0o600 });
}
```

- [ ] **Step 3: Fix path traversal and blocking I/O in `tools/source.ts`**

Change the import and file reading logic:

```typescript
// src/tools/source.ts — replace line 3:
import * as fs from "fs";
// with:
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
```

Replace lines 52-54 inside the `notebook_add_text` execute function:

```typescript
      let documentContent = content;
      if (!documentContent && file_path) {
        const resolved = resolve(file_path);
        documentContent = await fs.readFile(resolved, "utf8");
      }
```

- [ ] **Step 4: Fix CLI version in `cli.ts`**

```typescript
// src/cli.ts line 12 — change:
  .version("0.1.24");
// to:
  .version("0.1.30");
```

- [ ] **Step 5: Export `parseCookieString` from `auth.ts`**

Change line 103 from `function` to `export function`:

```typescript
// src/auth.ts line 103 — change:
function parseCookieString(raw: string): Record<string, string> {
// to:
export function parseCookieString(raw: string): Record<string, string> {
```

- [ ] **Step 6: Build and verify**

Run: `npm run build`
Expected: No TypeScript errors, clean build.

- [ ] **Step 7: Run existing tests**

Run: `npx vitest run`
Expected: All 4 existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/auth.ts src/tools/source.ts src/cli.ts
git commit -m "fix: security hardening — command injection, file permissions, path traversal, version sync"
```

---

### Task 2: Create `response-parser.ts` with tests

**Files:**
- Create: `src/response-parser.ts`
- Create: `src/__tests__/response-parser.test.ts`

- [ ] **Step 1: Write failing tests for `parseRawResponse`**

```typescript
// src/__tests__/response-parser.test.ts
import { describe, it, expect } from "vitest";
import { ResponseParser } from "../response-parser.js";

describe("ResponseParser", () => {
  const parser = new ResponseParser();

  describe("parseRawResponse", () => {
    it("should parse batchexecute format with byte-count prefix", () => {
      const bundle = JSON.stringify([["wrb.fr", "rpcId", '["data"]', null, null, null, "generic"]]);
      const raw = `)]}'\n\n${bundle.length}\n${bundle}`;
      const result = parser.parseRawResponse(raw);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual([["wrb.fr", "rpcId", '["data"]', null, null, null, "generic"]]);
    });

    it("should handle multiple chunks", () => {
      const chunk1 = JSON.stringify([["wrb.fr", "rpc1", '"data1"']]);
      const chunk2 = JSON.stringify([["wrb.fr", "rpc2", '"data2"']]);
      const raw = `)]}'\n\n${chunk1.length}\n${chunk1}\n${chunk2.length}\n${chunk2}`;
      const result = parser.parseRawResponse(raw);
      expect(result).toHaveLength(2);
    });

    it("should skip unparseable lines", () => {
      const raw = `)]}'\n\nnot-a-number\n{invalid json}`;
      const result = parser.parseRawResponse(raw);
      expect(result).toEqual([]);
    });
  });
});
```

Run: `npx vitest run src/__tests__/response-parser.test.ts`
Expected: FAIL — `ResponseParser` does not exist.

- [ ] **Step 2: Write failing tests for `extractRpcResult`**

Append to the test file:

```typescript
  describe("extractRpcResult", () => {
    it("should extract result for matching rpcId", () => {
      const parsed = [[["wrb.fr", "testRpc", JSON.stringify(["hello", "world"]), null, null, null, "generic"]]];
      const extraction = parser.extractRpcResult(parsed, "testRpc");
      expect(extraction.data).toEqual(["hello", "world"]);
      expect(extraction.authError).toBe(false);
      expect(extraction.sessionId).toBeNull();
    });

    it("should detect auth error code 16", () => {
      const parsed = [[["wrb.fr", "testRpc", null, null, null, [16], "generic"]]];
      const extraction = parser.extractRpcResult(parsed, "testRpc");
      expect(extraction.authError).toBe(true);
      expect(extraction.data).toBeNull();
    });

    it("should extract session ID from af.httprm", () => {
      const parsed = [
        [
          ["af.httprm", null, "new-session-id-123"],
          ["wrb.fr", "testRpc", JSON.stringify(["result"]), null, null, null, "generic"],
        ],
      ];
      const extraction = parser.extractRpcResult(parsed, "testRpc");
      expect(extraction.sessionId).toBe("new-session-id-123");
      expect(extraction.data).toEqual(["result"]);
    });

    it("should return null data when rpcId not found", () => {
      const parsed = [[["wrb.fr", "otherRpc", '"data"']]];
      const extraction = parser.extractRpcResult(parsed, "testRpc");
      expect(extraction.data).toBeNull();
      expect(extraction.authError).toBe(false);
    });
  });
```

- [ ] **Step 3: Write failing tests for domain parsers**

Append to the test file:

```typescript
  describe("parseNotebook", () => {
    it("should parse a standard notebook response", () => {
      const data = [
        "My Notebook",
        [
          [["src-id-1"], "Source 1", null, 1],
          [["src-id-2"], "Source 2", null, 5],
        ],
        "nb-id-123",
        "📓",
        null,
        [1, false, 8, null, null, [1740520000], null, null, [1740500000]],
      ];
      const notebook = parser.parseNotebook(data);
      expect(notebook.id).toBe("nb-id-123");
      expect(notebook.title).toBe("My Notebook");
      expect(notebook.emoji).toBe("📓");
      expect(notebook.sources).toHaveLength(2);
      expect(notebook.sources[0].id).toBe("src-id-1");
      expect(notebook.sources[0].type).toBe("google_docs");
      expect(notebook.sources[1].type).toBe("web_page");
      expect(notebook.ownership).toBe("mine");
    });

    it("should handle wrapped [[notebookData]] format", () => {
      const inner = ["Title", [], "nb-wrapped", null, null, [1, false]];
      const data = [inner];
      const notebook = parser.parseNotebook(data);
      expect(notebook.id).toBe("nb-wrapped");
      expect(notebook.title).toBe("Title");
    });

    it("should throw on non-array data", () => {
      expect(() => parser.parseNotebook("invalid")).toThrow("Invalid notebook data");
    });
  });

  describe("parseNotebookList", () => {
    it("should parse a list of notebooks", () => {
      const data = [
        [
          ["Notebook 1", [], "nb-1", null, null, [1, false]],
          ["Notebook 2", [], "nb-2", null, null, [1, false]],
        ],
      ];
      const list = parser.parseNotebookList(data);
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe("nb-1");
      expect(list[1].id).toBe("nb-2");
    });

    it("should return empty array for null/invalid data", () => {
      expect(parser.parseNotebookList(null)).toEqual([]);
      expect(parser.parseNotebookList("bad")).toEqual([]);
    });
  });

  describe("parseSourceDetail", () => {
    it("should parse source with text blocks", () => {
      const blocks = [
        [null, null, [null, null, [[null, null, [["Hello world"]]]]]],
      ];
      const data = [
        ["src-1"],
        "My Source",
        null,
        5,
        null,
        null,
        blocks,
      ];
      // data[0] is meta array, data[3] is the text blocks container
      // Actual format: [meta, ?, ?, textBlocks]
      // meta = [sourceId_arr, title, null, type]
      const sourceData = {
        meta: [["src-1"], "My Source", null, 5],
        textData: [[blocks[0]]],
      };
      // We test the actual format the parser will receive
      const formatted = [
        [["src-1"], "My Source", null, 5],
        null,
        null,
        [[blocks[0]]],
      ];
      const detail = parser.parseSourceDetail(formatted);
      expect(detail.id).toBe("src-1");
      expect(detail.title).toBe("My Source");
      expect(detail.type).toBe("web_page");
    });
  });

  describe("parseQueryResponse", () => {
    it("should extract answer and conversation id from streaming response", () => {
      const parsed = [
        [
          [
            "wrb.fr",
            "streaming",
            JSON.stringify([["Short answer", null, 1]]),
            null, null, null, "generic",
          ],
          [
            "wrb.fr",
            "streaming",
            JSON.stringify([["This is a longer and better answer", null, 1, null, null, null, null, null, null, null, "conv-456"]]),
            null, null, null, "generic",
          ],
        ],
      ];
      const result = parser.parseQueryResponse(parsed, null);
      expect(result.answer).toBe("This is a longer and better answer");
      expect(result.conversation_id).toBe("conv-456");
    });

    it("should return empty answer if no data", () => {
      const result = parser.parseQueryResponse([], null);
      expect(result.answer).toBe("");
    });
  });

  describe("parseResearchResults", () => {
    it("should parse research task list", () => {
      const data = [
        [
          [
            "task-1",
            [
              null,
              ["my query"],
              null,
              [
                [
                  ["https://example.com", "Example", "Description", 1],
                ],
                "Summary text",
              ],
              2,
            ],
          ],
        ],
      ];
      const results = parser.parseResearchResults(data);
      expect(results).toHaveLength(1);
      expect(results[0].task_id).toBe("task-1");
      expect(results[0].status).toBe("completed");
      expect(results[0].query).toBe("my query");
      expect(results[0].sources).toHaveLength(1);
      expect(results[0].sources[0].url).toBe("https://example.com");
      expect(results[0].summary).toBe("Summary text");
    });

    it("should filter by taskId", () => {
      const data = [
        [
          ["task-1", [null, ["q1"], null, null, 1]],
          ["task-2", [null, ["q2"], null, null, 2]],
        ],
      ];
      const results = parser.parseResearchResults(data, "task-2");
      expect(results).toHaveLength(1);
      expect(results[0].task_id).toBe("task-2");
    });
  });

  describe("parseStudioStatus", () => {
    it("should parse studio artifacts list", () => {
      const data = [
        [
          ["art-1", "Title 1", 1, [], 3, "https://download.url"],
          ["art-2", "Title 2", 2, [], 1, null],
        ],
      ];
      const artifacts = parser.parseStudioStatus(data);
      expect(artifacts).toHaveLength(2);
      expect(artifacts[0].id).toBe("art-1");
      expect(artifacts[0].type).toBe("audio");
      expect(artifacts[0].status).toBe("completed");
      expect(artifacts[0].download_url).toBe("https://download.url");
      expect(artifacts[1].status).toBe("pending");
    });

    it("should return empty array for non-array", () => {
      expect(parser.parseStudioStatus(null)).toEqual([]);
    });
  });
```

- [ ] **Step 4: Implement `response-parser.ts`**

```typescript
// src/response-parser.ts
import type {
  Notebook,
  SourceSummary,
  SourceDetail,
  ResearchResult,
  ResearchSource,
  StudioArtifact,
  QueryResponse,
} from "./types.js";
import {
  SOURCE_TYPES,
  RESULT_TYPES,
  STUDIO_TYPES,
  OWNERSHIP_MINE,
} from "./constants.js";

export interface RpcResultExtraction {
  data: unknown;
  sessionId: string | null;
  authError: boolean;
}

export class ResponseParser {
  // ─── Protocol Layer ──────────────────────────────────

  parseRawResponse(responseText: string): unknown[] {
    let text = responseText;
    if (text.startsWith(")]}'")) {
      text = text.slice(4);
    }

    const lines = text.trim().split("\n");
    const results: unknown[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) {
        i++;
        continue;
      }

      const maybeByteCount = parseInt(line, 10);
      if (!isNaN(maybeByteCount) && String(maybeByteCount) === line) {
        i++;
        if (i < lines.length) {
          try {
            results.push(JSON.parse(lines[i]));
          } catch {
            // skip unparseable
          }
          i++;
        }
      } else {
        try {
          results.push(JSON.parse(line));
        } catch {
          // skip
        }
        i++;
      }
    }

    return results;
  }

  extractRpcResult(parsed: unknown[], rpcId: string): RpcResultExtraction {
    let sessionId: string | null = null;

    for (const chunk of parsed) {
      if (!Array.isArray(chunk)) continue;
      for (const item of chunk) {
        if (!Array.isArray(item)) continue;

        // Extract Session ID if provided by Google
        if (item[0] === "af.httprm" && item.length >= 3 && typeof item[2] === "string") {
          sessionId = item[2];
        }

        if (item.length < 3) continue;
        if (item[0] === "wrb.fr" && item[1] === rpcId) {
          // Check for auth error (code 16)
          if (
            item.length > 6 &&
            item[6] === "generic" &&
            Array.isArray(item[5]) &&
            item[5].includes(16)
          ) {
            return { data: null, sessionId, authError: true };
          }

          const resultStr = item[2];
          if (typeof resultStr === "string") {
            try {
              return { data: JSON.parse(resultStr), sessionId, authError: false };
            } catch {
              return { data: resultStr, sessionId, authError: false };
            }
          }
          return { data: resultStr, sessionId, authError: false };
        }
      }
    }
    return { data: null, sessionId, authError: false };
  }

  // ─── Domain Parsers ──────────────────────────────────

  parseNotebook(data: unknown): Notebook {
    if (!Array.isArray(data)) {
      throw new Error(
        "Invalid notebook data received from Google. This usually happens if the notebook ID is incorrect, it was deleted, or you don't have permission to access it.",
      );
    }

    // Unwrap if Google returns [[notebookData]]
    let d = data as unknown[];
    if (d.length > 0 && Array.isArray(d[0]) && typeof (d[0] as unknown[])[2] === "string" && ((d[0] as unknown[])[2] as string).includes("-")) {
      d = d[0] as unknown[];
    }

    const sources: SourceSummary[] = [];
    if (Array.isArray(d[1])) {
      for (const s of d[1] as unknown[]) {
        if (Array.isArray(s) && (s as unknown[])[0]) {
          const src = s as unknown[];
          sources.push({
            id: Array.isArray(src[0]) ? (src[0] as unknown[])[0] as string : String(src[0]),
            title: (src[1] as string) || "Untitled",
            type: SOURCE_TYPES.getName((src[3] as number) ?? null),
          });
        }
      }
    }

    const meta = d[5] as unknown[] | undefined;
    return {
      id: (d[2] as string) || "",
      title: (d[0] as string) || "Untitled",
      emoji: (d[3] as string) || null,
      sources,
      is_shared: meta?.[1] === true,
      ownership: meta?.[0] === OWNERSHIP_MINE ? "mine" : "shared",
      created_at: meta ? this.parseTimestamp(meta[8]) : null,
      modified_at: meta ? this.parseTimestamp(meta[5]) : null,
    };
  }

  parseNotebookList(data: unknown): Notebook[] {
    if (!Array.isArray(data)) return [];
    const arr = data as unknown[];
    if (!Array.isArray(arr[0])) return [];

    const notebooks: Notebook[] = [];
    for (const item of arr[0] as unknown[]) {
      if (Array.isArray(item)) {
        notebooks.push(this.parseNotebook(item));
      }
    }
    return notebooks;
  }

  parseSourceSummary(data: unknown): SourceSummary {
    const arr = data as unknown[];
    const source = arr?.[0]?.[0] as unknown[] | undefined;
    return {
      id: Array.isArray(source?.[0]) ? (source[0] as unknown[])[0] as string : String(source?.[0] || ""),
      title: (source?.[1] as string) || "",
      type: SOURCE_TYPES.getName((source?.[3] as number) ?? null),
    };
  }

  parseSourceDetail(data: unknown): SourceDetail {
    const arr = data as unknown[];
    const meta = arr?.[0] as unknown[] | undefined;
    const typeRaw = meta?.[3];
    return {
      id: Array.isArray(meta?.[0]) ? (meta[0] as unknown[])[0] as string : String(meta?.[0] || ""),
      title: (meta?.[1] as string) || "Untitled",
      type: SOURCE_TYPES.getName(Array.isArray(typeRaw) ? (typeRaw as unknown[])[1] as number : (typeRaw as number | null)),
      content: this.extractTextFromBlocks(arr?.[3]),
      summary: null,
      keywords: [],
    };
  }

  parseSourceGuide(data: unknown): { summary: string; keywords: string[] } {
    const arr = data as unknown[];
    return {
      summary: (arr?.[0] as string) || "",
      keywords: Array.isArray(arr?.[1]) ? arr[1] as string[] : [],
    };
  }

  parseResearchResults(data: unknown, taskId?: string): ResearchResult[] {
    const arr = data as unknown[];
    if (!Array.isArray(arr?.[0])) return [];

    const results: ResearchResult[] = [];
    for (const task of arr[0] as unknown[]) {
      if (!Array.isArray(task)) continue;
      const taskArr = task as unknown[];
      const tid = taskArr[0] as string;
      if (taskId && tid !== taskId) continue;

      const taskInfo = taskArr[1] as unknown[];
      const statusCode = taskInfo?.[4] as number;
      const statusMap: Record<number, ResearchResult["status"]> = {
        1: "in_progress",
        2: "completed",
        6: "imported",
      };

      const sources: ResearchSource[] = [];
      const sourcesArray = (taskInfo?.[3] as unknown[])?.[0];
      if (Array.isArray(sourcesArray)) {
        for (const s of sourcesArray as unknown[]) {
          if (Array.isArray(s)) {
            const src = s as unknown[];
            sources.push({
              url: (src[0] as string) || null,
              title: (src[1] as string) || "",
              description: (src[2] as string) || null,
              type: RESULT_TYPES.getName((src[3] as number) ?? null),
            });
          }
        }
      }

      results.push({
        task_id: tid,
        status: statusMap[statusCode] || "in_progress",
        query: ((taskInfo?.[1] as unknown[])?.[0] as string) || "",
        sources,
        summary: ((taskInfo?.[3] as unknown[])?.[1] as string) || null,
      });
    }

    return results;
  }

  parseQueryResponse(parsed: unknown[], conversationId: string | null): QueryResponse {
    let bestAnswer = "";
    let convId: string | null = conversationId || null;

    for (const chunk of parsed) {
      if (!Array.isArray(chunk)) continue;
      for (const item of chunk as unknown[]) {
        if (!Array.isArray(item) || (item as unknown[]).length < 3) continue;
        const arr = item as unknown[];
        if (arr[0] === "wrb.fr") {
          // Check for auth error (code 16)
          if (
            arr.length > 6 &&
            arr[6] === "generic" &&
            Array.isArray(arr[5]) &&
            (arr[5] as unknown[]).includes(16)
          ) {
            return { answer: "", conversation_id: convId, sources_used: [] };
          }

          const resultStr = arr[2];
          if (typeof resultStr === "string") {
            try {
              const data = JSON.parse(resultStr);
              if (Array.isArray(data) && Array.isArray(data[0])) {
                const inner = data[0] as unknown[];
                const answer = inner[0] as string;
                if (typeof answer === "string" && answer.length > bestAnswer.length) {
                  bestAnswer = answer;
                }
                if (inner[10]) convId = String(inner[10]);
              }
            } catch {
              // skip
            }
          }
        }
      }
    }

    return {
      answer: bestAnswer,
      conversation_id: convId,
      sources_used: [],
    };
  }

  parseStudioResult(data: unknown): string {
    const arr = data as unknown[];
    return (arr?.[0] as string) || "";
  }

  parseStudioStatus(data: unknown): StudioArtifact[] {
    if (!Array.isArray(data)) return [];
    const arr = data as unknown[];

    const artifacts: StudioArtifact[] = [];
    const items = Array.isArray(arr[0]) ? arr[0] as unknown[] : arr;

    for (const item of items) {
      if (!Array.isArray(item)) continue;
      const it = item as unknown[];
      const statusMap: Record<number, StudioArtifact["status"]> = {
        1: "pending",
        2: "generating",
        3: "completed",
        4: "failed",
      };

      artifacts.push({
        id: (it[0] as string) || "",
        type: STUDIO_TYPES.getName((it[2] as number) ?? null),
        status: statusMap[it[4] as number] || "pending",
        download_url: (it[5] as string) || null,
      });
    }

    return artifacts;
  }

  parseMindMap(data: unknown): string {
    const arr = data as unknown[];
    return (arr?.[0] as string) || "";
  }

  // ──��� Private Helpers ─────────────────────────────────

  private parseTimestamp(ts: unknown): string | null {
    if (Array.isArray(ts) && ts.length >= 1 && typeof ts[0] === "number") {
      return new Date(ts[0] * 1000).toISOString();
    }
    return null;
  }

  private extractTextFromBlocks(data: unknown): string | null {
    if (!Array.isArray(data) || !Array.isArray((data as unknown[])[0])) return null;
    let text = "";
    for (const block of (data as unknown[])[0] as unknown[]) {
      try {
        const b = block as unknown[];
        const content = (((((b?.[2] as unknown[])?.[2] as unknown[])?.[0] as unknown[])?.[0] as unknown[])?.[2] as unknown[])?.[0];
        if (typeof content === "string") {
          text += content;
        }
      } catch {
        // skip malformed blocks
      }
    }
    return text || null;
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/__tests__/response-parser.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Build to verify types**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/response-parser.ts src/__tests__/response-parser.test.ts
git commit -m "refactor: extract ResponseParser from client.ts with tests"
```

---

### Task 3: Create `rpc-transport.ts` with tests

**Files:**
- Create: `src/rpc-transport.ts`
- Create: `src/__tests__/rpc-transport.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/rpc-transport.test.ts
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { RpcTransport } from "../rpc-transport.js";
import { BASE_URL, BATCHEXECUTE_PATH, QUERY_PATH } from "../constants.js";

const mockServer = setupServer();

describe("RpcTransport", () => {
  let transport: RpcTransport;

  beforeEach(() => {
    mockServer.listen();
    transport = new RpcTransport();
  });

  afterEach(() => mockServer.resetHandlers());
  afterAll(() => mockServer.close());

  const baseOptions = {
    rpcId: "testRpc",
    params: ["param1"],
    cookies: { SID: "test-sid", HSID: "test-hsid" },
    csrfToken: "csrf-123",
    sessionId: "sid-456",
    bl: "boq_test",
  };

  describe("callRpc", () => {
    it("should send POST to batchexecute endpoint with correct headers", async () => {
      let capturedRequest: Request | null = null;

      mockServer.use(
        http.post(`${BASE_URL}${BATCHEXECUTE_PATH}`, async ({ request }) => {
          capturedRequest = request.clone();
          const bundle = JSON.stringify([["wrb.fr", "testRpc", '"result"', null, null, null, "generic"]]);
          return HttpResponse.text(`)]}'\n\n${bundle.length}\n${bundle}`);
        }),
      );

      const response = await transport.callRpc(baseOptions);

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.method).toBe("POST");
      expect(capturedRequest!.headers.get("Content-Type")).toContain("application/x-www-form-urlencoded");
      expect(capturedRequest!.headers.get("Cookie")).toContain("SID=test-sid");
      expect(capturedRequest!.headers.get("X-Same-Domain")).toBe("1");

      // Should contain parsed result
      expect(response.parsed).toHaveLength(1);
    });

    it("should include rpcids in URL params", async () => {
      let capturedUrl = "";

      mockServer.use(
        http.post(`${BASE_URL}${BATCHEXECUTE_PATH}`, ({ request }) => {
          capturedUrl = request.url;
          const bundle = JSON.stringify([["wrb.fr", "testRpc", '""']]);
          return HttpResponse.text(`)]}'\n\n${bundle.length}\n${bundle}`);
        }),
      );

      await transport.callRpc(baseOptions);

      const url = new URL(capturedUrl);
      expect(url.searchParams.get("rpcids")).toBe("testRpc");
      expect(url.searchParams.get("f.sid")).toBe("sid-456");
      expect(url.searchParams.get("bl")).toBe("boq_test");
    });

    it("should extract updated cookies from Set-Cookie headers", async () => {
      mockServer.use(
        http.post(`${BASE_URL}${BATCHEXECUTE_PATH}`, () => {
          const bundle = JSON.stringify([["wrb.fr", "testRpc", '""']]);
          return new HttpResponse(`)]}'\n\n${bundle.length}\n${bundle}`, {
            headers: {
              "Set-Cookie": "NEW_COOKIE=abc123; Path=/; Secure",
            },
          });
        }),
      );

      const response = await transport.callRpc(baseOptions);
      expect(response.updatedCookies).not.toBeNull();
      expect(response.updatedCookies!["NEW_COOKIE"]).toBe("abc123");
    });

    it("should timeout with AbortError", async () => {
      mockServer.use(
        http.post(`${BASE_URL}${BATCHEXECUTE_PATH}`, async () => {
          await new Promise((r) => setTimeout(r, 5000));
          return HttpResponse.text("");
        }),
      );

      await expect(
        transport.callRpc({ ...baseOptions, timeout: 100 }),
      ).rejects.toThrow();
    });
  });

  describe("callQuery", () => {
    it("should send POST to query endpoint", async () => {
      let capturedUrl = "";

      mockServer.use(
        http.post(`${BASE_URL}${QUERY_PATH}`, ({ request }) => {
          capturedUrl = request.url;
          const bundle = JSON.stringify([["wrb.fr", "q", '"answer"']]);
          return HttpResponse.text(`)]}'\n\n${bundle.length}\n${bundle}`);
        }),
      );

      await transport.callQuery(baseOptions);
      expect(capturedUrl).toContain(QUERY_PATH);
    });
  });
});
```

Run: `npx vitest run src/__tests__/rpc-transport.test.ts`
Expected: FAIL — `RpcTransport` does not exist.

- [ ] **Step 2: Implement `rpc-transport.ts`**

```typescript
// src/rpc-transport.ts
import {
  BASE_URL,
  BATCHEXECUTE_PATH,
  QUERY_PATH,
  USER_AGENT,
  DEFAULT_TIMEOUT,
} from "./constants.js";
import { buildCookieHeader, parseCookieString } from "./auth.js";
import { ResponseParser } from "./response-parser.js";

export interface RpcRequestOptions {
  rpcId: string;
  params: unknown;
  sourcePath?: string;
  timeout?: number;
  cookies: Record<string, string>;
  csrfToken: string;
  sessionId: string;
  bl: string;
}

export interface RpcResponse {
  parsed: unknown[];
  updatedCookies: Record<string, string> | null;
}

const COMMON_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
  Origin: BASE_URL,
  Referer: `${BASE_URL}/`,
  "X-Same-Domain": "1",
  "User-Agent": USER_AGENT,
  "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "X-Goog-Encode-Response-If-Executable": "base64",
  "X-Google-SIDRT": "1",
};

export class RpcTransport {
  private reqId = 0;
  private parser = new ResponseParser();

  async callRpc(options: RpcRequestOptions): Promise<RpcResponse> {
    const url = this.buildUrl(options);
    const body = this.buildRequestBody(options);
    return this.doFetch(url, body, options);
  }

  async callQuery(options: RpcRequestOptions): Promise<RpcResponse> {
    const url = this.buildQueryUrl(options);
    const body = this.buildQueryBody(options);
    return this.doFetch(url, body, options, {
      "X-Goog-BatchExecute-Path": QUERY_PATH,
    });
  }

  // ─── Private ─────────────────────────────────────────

  private async doFetch(
    url: string,
    body: string,
    options: RpcRequestOptions,
    extraHeaders: Record<string, string> = {},
  ): Promise<RpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || DEFAULT_TIMEOUT);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...COMMON_HEADERS,
          ...extraHeaders,
          Cookie: buildCookieHeader(options.cookies),
        },
        body,
        signal: controller.signal,
      });

      const updatedCookies = this.extractSetCookies(response);
      const text = await response.text();
      const parsed = this.parser.parseRawResponse(text);

      return { parsed, updatedCookies };
    } finally {
      clearTimeout(timer);
    }
  }

  private buildUrl(options: RpcRequestOptions): string {
    this.reqId++;
    const params: Record<string, string> = {
      rpcids: options.rpcId,
      bl: options.bl,
      hl: "en-US",
      _reqid: String(this.reqId),
      rt: "c",
    };
    if (options.sessionId) {
      params["f.sid"] = options.sessionId;
    }
    const query = new URLSearchParams(params).toString();
    return `${BASE_URL}${BATCHEXECUTE_PATH}?${query}`;
  }

  private buildQueryUrl(options: RpcRequestOptions): string {
    this.reqId++;
    const params: Record<string, string> = {
      bl: options.bl,
      hl: "en",
      _reqid: String(this.reqId),
      rt: "c",
    };
    if (options.sessionId) {
      params["f.sid"] = options.sessionId;
    }
    const query = new URLSearchParams(params).toString();
    return `${BASE_URL}${QUERY_PATH}?${query}`;
  }

  private buildRequestBody(options: RpcRequestOptions): string {
    const fReq = JSON.stringify([[[options.rpcId, JSON.stringify(options.params), null, "generic"]]]);
    const parts: string[] = [];
    if (options.csrfToken) {
      parts.push(`at=${encodeURIComponent(options.csrfToken)}`);
    }
    if (options.sessionId) {
      parts.push(`f.sid=${encodeURIComponent(options.sessionId)}`);
    }
    parts.push(`f.req=${encodeURIComponent(fReq)}`);
    return parts.join("&");
  }

  private buildQueryBody(options: RpcRequestOptions): string {
    const fReq = JSON.stringify([null, JSON.stringify(options.params)]);
    const parts = [`f.req=${encodeURIComponent(fReq)}`];
    if (options.csrfToken) {
      parts.push(`at=${encodeURIComponent(options.csrfToken)}`);
    }
    if (options.sessionId) {
      parts.push(`f.sid=${encodeURIComponent(options.sessionId)}`);
    }
    return parts.join("&");
  }

  private extractSetCookies(response: Response): Record<string, string> | null {
    const setCookies = (response.headers as any).getSetCookie?.() || [];
    if (setCookies.length === 0) return null;

    const cookies: Record<string, string> = {};
    for (const cookieStr of setCookies) {
      const parts = cookieStr.split(";")[0].split("=");
      if (parts.length >= 2) {
        cookies[parts[0].trim()] = parts[1].trim();
      }
    }
    return cookies;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/__tests__/rpc-transport.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Build to verify types**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add src/rpc-transport.ts src/__tests__/rpc-transport.test.ts
git commit -m "refactor: extract RpcTransport from client.ts with tests"
```

---

### Task 4: Create `auth-manager.ts`

**Files:**
- Create: `src/auth-manager.ts`

- [ ] **Step 1: Implement `auth-manager.ts`**

```typescript
// src/auth-manager.ts
import type { AuthTokens } from "./types.js";
import {
  buildCookieHeader,
  extractCsrfFromPage,
  extractSessionIdFromPage,
  saveTokens,
  loadTokensFromCache,
} from "./auth.js";
import { refreshCookiesHeadless, runBrowserAuthFlow } from "./browser-auth.js";
import {
  BASE_URL,
  DEFAULT_BL,
  DEFAULT_TIMEOUT,
  USER_AGENT,
  RPC_IDS,
} from "./constants.js";
import { RpcTransport } from "./rpc-transport.js";
import { ResponseParser } from "./response-parser.js";

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface AuthState {
  tokens: AuthTokens;
  csrfToken: string;
  sessionId: string;
  bl: string;
}

export class AuthManager {
  private tokens: AuthTokens;
  private csrfToken: string;
  private sessionId: string;

  constructor(tokens: AuthTokens) {
    this.tokens = tokens;
    this.csrfToken = tokens.csrf_token;
    this.sessionId = tokens.session_id;
  }

  getState(): AuthState {
    return {
      tokens: this.tokens,
      csrfToken: this.csrfToken,
      sessionId: this.sessionId,
      bl: this.tokens.bl || process.env.NOTEBOOKLM_BL || DEFAULT_BL,
    };
  }

  updateFromResponse(updatedCookies: Record<string, string> | null, sessionId: string | null): void {
    if (updatedCookies) {
      Object.assign(this.tokens.cookies, updatedCookies);
      saveTokens(this.tokens);
    }
    if (sessionId) {
      this.sessionId = sessionId;
      this.tokens.session_id = sessionId;
      saveTokens(this.tokens);
    }
  }

  async ensureAuth(): Promise<void> {
    if (!this.csrfToken || !this.sessionId) {
      await this.refreshFromPage();
    }
  }

  async refreshFromPage(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

    try {
      const response = await fetch(BASE_URL, {
        headers: {
          Cookie: buildCookieHeader(this.tokens.cookies),
          "User-Agent": USER_AGENT,
          Accept: "text/html",
        },
        signal: controller.signal,
      });

      const html = await response.text();
      const csrf = extractCsrfFromPage(html);
      const sid = extractSessionIdFromPage(html);

      if (csrf) {
        this.csrfToken = csrf;
        console.error("✅ New CSRF token extracted.");
      } else {
        console.error("⚠️ Failed to extract CSRF token from page.");
      }

      if (sid) {
        this.sessionId = sid;
        console.error("✅ New Session ID extracted.");
      } else {
        console.error("⚠️ Failed to extract Session ID from page.");
      }

      this.tokens.csrf_token = this.csrfToken;
      this.tokens.session_id = this.sessionId;
      saveTokens(this.tokens);
    } finally {
      clearTimeout(timer);
    }
  }

  async withAuthRetry<T>(
    operation: (state: AuthState) => Promise<{ result: T; authError: boolean }>,
  ): Promise<T> {
    await this.ensureAuth();

    const { result, authError } = await operation(this.getState());
    if (!authError) return result;

    // Auth failed — attempt recovery
    console.error("🔄 Session expired. Checking for updated tokens on disk...");

    // Step 1: Try fresher tokens from disk
    try {
      const freshTokens = loadTokensFromCache();
      if (freshTokens && freshTokens.extracted_at > this.tokens.extracted_at) {
        console.error("✅ Found fresher tokens on disk. Retrying with new tokens...");
        this.applyTokens(freshTokens);
        const retry = await operation(this.getState());
        if (!retry.authError) return retry.result;
      }
    } catch {
      // ignore
    }

    // Step 2: Try headless browser refresh
    console.error("🔄 Effortlessly restoring your connection in the background...");
    try {
      let newTokens: AuthTokens;
      try {
        newTokens = await refreshCookiesHeadless();
      } catch {
        console.error("⚠️ Automatic refresh encountered a hiccup. Launching a manual login window to get you back on track.");
        newTokens = await runBrowserAuthFlow();
      }

      this.applyTokens(newTokens);

      // Warmup with SETTINGS RPC
      try {
        const transport = new RpcTransport();
        const parser = new ResponseParser();
        const warmupResponse = await transport.callRpc({
          ...this.getState(),
          rpcId: RPC_IDS.SETTINGS,
          params: [null, 1],
          timeout: 5000,
          cookies: this.tokens.cookies,
        });
        const warmupExtraction = parser.extractRpcResult(warmupResponse.parsed, RPC_IDS.SETTINGS);
        this.updateFromResponse(warmupResponse.updatedCookies, warmupExtraction.sessionId);
      } catch {
        // ignore warmup error
      }

      await new Promise((r) => setTimeout(r, 1000));

      // Retry original operation
      const retry = await operation(this.getState());
      if (!retry.authError) return retry.result;

      throw new AuthenticationError(
        "Authentication expired. Run `npx @m4ykeldev/notebooklm-mcp auth` to re-authenticate.",
      );
    } catch (e) {
      if (e instanceof AuthenticationError) throw e;
      console.error("❌ Authentication failed:", (e as Error).message);
      throw new AuthenticationError(
        "Authentication expired. Run `npx @m4ykeldev/notebooklm-mcp auth` to re-authenticate.",
      );
    }
  }

  private applyTokens(tokens: AuthTokens): void {
    this.tokens = tokens;
    this.csrfToken = tokens.csrf_token;
    this.sessionId = tokens.session_id;
  }
}
```

- [ ] **Step 2: Build to verify types**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/auth-manager.ts
git commit -m "refactor: extract AuthManager with unified auth retry logic"
```

---

### Task 5: Rewrite `client.ts` as thin facade

**Files:**
- Modify: `src/client.ts` (full rewrite)
- Modify: `src/types.ts` (add `ConversationTurn`)

- [ ] **Step 1: Add `ConversationTurn` to types**

Append to `src/types.ts`:

```typescript
export interface ConversationTurn {
  text: string;
  role: 1 | 2;  // 1 = user, 2 = assistant
}
```

- [ ] **Step 2: Rewrite `client.ts`**

Replace the entire file with the thin facade:

```typescript
// src/client.ts
import type {
  AuthTokens,
  Notebook,
  SourceSummary,
  SourceDetail,
  ResearchResult,
  StudioArtifact,
  QueryResponse,
  ConversationTurn,
} from "./types.js";
import {
  RPC_IDS,
  DEFAULT_TIMEOUT,
  EXTENDED_TIMEOUT,
  AUDIO_FORMATS,
  AUDIO_LENGTHS,
  VIDEO_FORMATS,
  VIDEO_STYLES,
  INFOGRAPHIC_ORIENTATIONS,
  INFOGRAPHIC_DETAILS,
  SLIDE_DECK_FORMATS,
  SLIDE_DECK_LENGTHS,
  FLASHCARD_DIFFICULTIES,
  FLASHCARD_COUNT_DEFAULT,
  REPORT_FORMATS,
  STUDIO_TYPES,
  RESEARCH_SOURCES,
  RESEARCH_MODES,
  CHAT_GOALS,
  CHAT_RESPONSE_LENGTHS,
} from "./constants.js";
import { RpcTransport } from "./rpc-transport.js";
import { ResponseParser } from "./response-parser.js";
import { AuthManager, AuthenticationError } from "./auth-manager.js";

export { AuthenticationError };

export class NotebookLMClient {
  private transport: RpcTransport;
  private parser: ResponseParser;
  private authManager: AuthManager;
  private queryTimeout: number;
  private conversationHistory: Map<string, ConversationTurn[]> = new Map();

  constructor(tokens: AuthTokens, queryTimeout?: number) {
    this.authManager = new AuthManager(tokens);
    this.transport = new RpcTransport();
    this.parser = new ResponseParser();
    this.queryTimeout = queryTimeout ?? EXTENDED_TIMEOUT;
  }

  // ─── Generic RPC helper ──────────────────────────────

  private async callRpc<T>(
    rpcId: string,
    params: unknown,
    sourcePath: string,
    timeout: number,
    parse: (data: unknown) => T,
  ): Promise<T> {
    return this.authManager.withAuthRetry(async (state) => {
      const response = await this.transport.callRpc({
        rpcId,
        params,
        sourcePath,
        timeout,
        cookies: state.tokens.cookies,
        csrfToken: state.csrfToken,
        sessionId: state.sessionId,
        bl: state.bl,
      });
      const extraction = this.parser.extractRpcResult(response.parsed, rpcId);
      this.authManager.updateFromResponse(response.updatedCookies, extraction.sessionId);
      return { result: parse(extraction.data), authError: extraction.authError };
    });
  }

  // ─── Notebook Methods ────────────────────────────────

  async listNotebooks(maxResults = 100): Promise<Notebook[]> {
    const notebooks = await this.callRpc(
      RPC_IDS.LIST_NOTEBOOKS,
      [null, maxResults],
      "/",
      DEFAULT_TIMEOUT,
      (data) => this.parser.parseNotebookList(data),
    );
    return notebooks.slice(0, maxResults);
  }

  async getNotebook(notebookId: string): Promise<Notebook> {
    return this.callRpc(
      RPC_IDS.GET_NOTEBOOK,
      [notebookId],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      (data) => this.parser.parseNotebook(data),
    );
  }

  async createNotebook(title: string): Promise<Notebook> {
    return this.callRpc(
      RPC_IDS.CREATE_NOTEBOOK,
      [title],
      "/",
      DEFAULT_TIMEOUT,
      (data) => this.parser.parseNotebook(data),
    );
  }

  async renameNotebook(notebookId: string, newTitle: string): Promise<void> {
    await this.callRpc(
      RPC_IDS.RENAME_NOTEBOOK,
      [notebookId, [[null, null, null, [null, newTitle]]]],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      () => {},
    );
  }

  async deleteNotebook(notebookId: string): Promise<void> {
    await this.callRpc(
      RPC_IDS.DELETE_NOTEBOOK,
      [notebookId],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      () => {},
    );
  }

  async describeNotebook(notebookId: string): Promise<string> {
    return this.callRpc(
      RPC_IDS.GET_SUMMARY,
      [notebookId, null, [2]],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      (data) => this.parser.parseStudioResult(data),
    );
  }

  // ─── Source Methods ──────────────────────────────────

  async addUrlSource(notebookId: string, url: string): Promise<SourceSummary> {
    const isYouTube = url.toLowerCase().includes("youtube.com") || url.toLowerCase().includes("youtu.be");

    const sourceData = isYouTube
      ? [null, null, null, null, null, null, null, [url], null, null, 1]
      : [null, null, [url], null, null, null, null, null, null, null, 1];

    return this.callRpc(
      RPC_IDS.ADD_SOURCE,
      [[sourceData], notebookId, [2], [1, null, null, null, null, null, null, null, null, null, [1]]],
      `/notebook/${notebookId}`,
      EXTENDED_TIMEOUT,
      (data) => {
        const summary = this.parser.parseSourceSummary(data);
        return { ...summary, title: summary.title || url, type: summary.type || (isYouTube ? "youtube" : "web_page") };
      },
    );
  }

  async addTextSource(notebookId: string, text: string, title: string): Promise<SourceSummary> {
    const sourceData = [null, [title, text], null, 2, null, null, null, null, null, null, 1];

    return this.callRpc(
      RPC_IDS.ADD_SOURCE,
      [[sourceData], notebookId, [2], [1, null, null, null, null, null, null, null, null, null, [1]]],
      `/notebook/${notebookId}`,
      EXTENDED_TIMEOUT,
      (data) => {
        const summary = this.parser.parseSourceSummary(data);
        return { ...summary, title: summary.title || title, type: summary.type || "pasted_text" };
      },
    );
  }

  async addDriveSource(notebookId: string, documentId: string, title: string, mimeType: string): Promise<SourceSummary> {
    const sourceData = [[documentId, mimeType, 1, title], null, null, null, null, null, null, null, null, null, 1];

    return this.callRpc(
      RPC_IDS.ADD_SOURCE,
      [[sourceData], notebookId, [2], [1, null, null, null, null, null, null, null, null, null, [1]]],
      `/notebook/${notebookId}`,
      EXTENDED_TIMEOUT,
      (data) => {
        const summary = this.parser.parseSourceSummary(data);
        return { ...summary, title: summary.title || title, type: summary.type || "google_docs" };
      },
    );
  }

  async getSource(sourceId: string, notebookId: string): Promise<SourceDetail> {
    return this.callRpc(
      RPC_IDS.GET_SOURCE,
      [[sourceId]],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      (data) => this.parser.parseSourceDetail(data),
    );
  }

  async getSourceGuide(sourceId: string, notebookId: string): Promise<{ summary: string; keywords: string[] }> {
    return this.callRpc(
      RPC_IDS.GET_SOURCE_GUIDE,
      [sourceId, notebookId, [2]],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      (data) => this.parser.parseSourceGuide(data),
    );
  }

  async checkFreshness(sourceId: string, notebookId: string): Promise<boolean | null> {
    try {
      return await this.callRpc(
        RPC_IDS.CHECK_FRESHNESS,
        [sourceId, notebookId],
        `/notebook/${notebookId}`,
        DEFAULT_TIMEOUT,
        (data) => {
          const arr = data as unknown[];
          return arr?.[0] === true;
        },
      );
    } catch {
      return null;
    }
  }

  async syncDrive(sourceIds: string[], notebookId: string): Promise<void> {
    for (const sourceId of sourceIds) {
      await this.callRpc(
        RPC_IDS.SYNC_DRIVE,
        [sourceId, notebookId],
        `/notebook/${notebookId}`,
        EXTENDED_TIMEOUT,
        () => {},
      );
    }
  }

  async deleteSource(sourceId: string, notebookId: string): Promise<void> {
    await this.callRpc(
      RPC_IDS.DELETE_SOURCE,
      [sourceId, notebookId],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      () => {},
    );
  }

  // ─── Query ───────────────────────────────────────────

  async query(
    notebookId: string,
    queryText: string,
    sourceIds?: string[],
    conversationId?: string,
  ): Promise<QueryResponse> {
    const history = conversationId
      ? (this.conversationHistory.get(conversationId) || []).map((t) => [t.text, null, t.role])
      : [];

    const sourcesNested = sourceIds ? sourceIds.map((sid) => [[[sid]]]) : [];

    const params = [
      sourcesNested,
      queryText,
      history,
      [2, null, [1], [1]],
      conversationId || null,
      null,
      null,
      notebookId,
      1,
    ];

    return this.authManager.withAuthRetry(async (state) => {
      const response = await this.transport.callQuery({
        rpcId: "query",
        params,
        sourcePath: `/notebook/${notebookId}`,
        timeout: this.queryTimeout,
        cookies: state.tokens.cookies,
        csrfToken: state.csrfToken,
        sessionId: state.sessionId,
        bl: state.bl,
      });

      this.authManager.updateFromResponse(response.updatedCookies, null);

      const queryResult = this.parser.parseQueryResponse(response.parsed, conversationId || null);

      // Check for auth error in the streaming response
      // parseQueryResponse returns empty answer on auth error
      const hasAuthError = response.parsed.some((chunk) => {
        if (!Array.isArray(chunk)) return false;
        return (chunk as unknown[]).some((item) => {
          if (!Array.isArray(item)) return false;
          const arr = item as unknown[];
          return arr.length > 6 && arr[6] === "generic" && Array.isArray(arr[5]) && (arr[5] as unknown[]).includes(16);
        });
      });

      if (!hasAuthError && queryResult.answer && queryResult.conversation_id) {
        const convId = queryResult.conversation_id;
        const hist = this.conversationHistory.get(convId) || [];
        hist.push({ text: queryText, role: 1 });
        hist.push({ text: queryResult.answer, role: 2 });
        this.conversationHistory.set(convId, hist.slice(-10));
      }

      return { result: queryResult, authError: hasAuthError };
    });
  }

  // ─── Research ────────────────────────────────────────

  async startResearch(notebookId: string, queryText: string, source = "web", mode = "fast"): Promise<{ taskId: string }> {
    const sourceCode = RESEARCH_SOURCES.getCode(source);
    const modeCode = RESEARCH_MODES.getCode(mode);

    const rpcId = modeCode === 5 ? RPC_IDS.START_DEEP_RESEARCH : RPC_IDS.START_FAST_RESEARCH;
    const params = modeCode === 5
      ? [null, [1], [queryText, sourceCode], 5, notebookId]
      : [[queryText, sourceCode], null, 1, notebookId];

    return this.callRpc(
      rpcId,
      params,
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      (data) => ({ taskId: this.parser.parseStudioResult(data) }),
    );
  }

  async pollResearch(notebookId: string, taskId?: string): Promise<ResearchResult[]> {
    return this.callRpc(
      RPC_IDS.POLL_RESEARCH,
      [null, null, notebookId],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      (data) => this.parser.parseResearchResults(data, taskId),
    );
  }

  async importResearch(notebookId: string, taskId: string, sourceIndices?: number[]): Promise<void> {
    await this.callRpc(
      RPC_IDS.IMPORT_RESEARCH,
      [notebookId, taskId, sourceIndices || null],
      `/notebook/${notebookId}`,
      EXTENDED_TIMEOUT,
      () => {},
    );
  }

  // ─── Studio ──────────────────────────────────────────

  private formatSourcesNested(sourceIds: string[]): unknown[] {
    return sourceIds.map((sid) => [[sid]]);
  }

  private formatSourcesSimple(sourceIds: string[]): unknown[] {
    return sourceIds.map((sid) => [sid]);
  }

  private async createStudioArtifact(
    notebookId: string,
    sourceIds: string[],
    content: unknown[],
  ): Promise<string> {
    return this.callRpc(
      RPC_IDS.CREATE_STUDIO,
      [[2], notebookId, content],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      (data) => this.parser.parseStudioResult(data),
    );
  }

  async createAudioOverview(
    notebookId: string,
    sourceIds: string[],
    options: { format?: string; length?: string; language?: string; focus_prompt?: string } = {},
  ): Promise<string> {
    const formatCode = AUDIO_FORMATS.getCode(options.format || "deep_dive");
    const lengthCode = AUDIO_LENGTHS.getCode(options.length || "default");
    const sourcesNested = this.formatSourcesNested(sourceIds);
    const sourcesSimple = this.formatSourcesSimple(sourceIds);

    const content = [
      null, null, STUDIO_TYPES.getCode("audio"), sourcesNested, null, null,
      [null, [options.focus_prompt || null, lengthCode, null, sourcesSimple, options.language || null, null, formatCode]],
    ];
    return this.createStudioArtifact(notebookId, sourceIds, content);
  }

  async createVideoOverview(
    notebookId: string,
    sourceIds: string[],
    options: { format?: string; visual_style?: string; language?: string; focus_prompt?: string } = {},
  ): Promise<string> {
    const formatCode = VIDEO_FORMATS.getCode(options.format || "explainer");
    const styleCode = VIDEO_STYLES.getCode(options.visual_style || "auto_select");
    const sourcesNested = this.formatSourcesNested(sourceIds);
    const sourcesSimple = this.formatSourcesSimple(sourceIds);

    const content = [
      null, null, STUDIO_TYPES.getCode("video"), sourcesNested, null, null, null, null,
      [null, null, [sourcesSimple, options.language || null, options.focus_prompt || null, null, formatCode, styleCode]],
    ];
    return this.createStudioArtifact(notebookId, sourceIds, content);
  }

  async createInfographic(
    notebookId: string,
    sourceIds: string[],
    options: { orientation?: string; detail_level?: string; language?: string; focus_prompt?: string } = {},
  ): Promise<string> {
    const orientationCode = INFOGRAPHIC_ORIENTATIONS.getCode(options.orientation || "landscape");
    const detailCode = INFOGRAPHIC_DETAILS.getCode(options.detail_level || "standard");
    const sourcesNested = this.formatSourcesNested(sourceIds);

    const content: unknown[] = [null, null, STUDIO_TYPES.getCode("infographic"), sourcesNested];
    for (let i = 0; i < 10; i++) content.push(null);
    content.push([[options.focus_prompt || null, options.language || null, null, orientationCode, detailCode]]);
    return this.createStudioArtifact(notebookId, sourceIds, content);
  }

  async createSlideDeck(
    notebookId: string,
    sourceIds: string[],
    options: { format?: string; length?: string; language?: string; focus_prompt?: string } = {},
  ): Promise<string> {
    const formatCode = SLIDE_DECK_FORMATS.getCode(options.format || "detailed_deck");
    const lengthCode = SLIDE_DECK_LENGTHS.getCode(options.length || "default");
    const sourcesNested = this.formatSourcesNested(sourceIds);

    const content: unknown[] = [null, null, STUDIO_TYPES.getCode("slide_deck"), sourcesNested];
    for (let i = 0; i < 12; i++) content.push(null);
    content.push([[options.focus_prompt || null, options.language || null, formatCode, lengthCode]]);
    return this.createStudioArtifact(notebookId, sourceIds, content);
  }

  async createReport(
    notebookId: string,
    sourceIds: string[],
    options: { report_format?: string; custom_prompt?: string; language?: string } = {},
  ): Promise<string> {
    const formatName = options.report_format || "Briefing Doc";
    const fmt = REPORT_FORMATS[formatName] || REPORT_FORMATS["Briefing Doc"];
    const prompt = formatName === "Create Your Own" ? options.custom_prompt || "" : fmt.prompt;
    const sourcesNested = this.formatSourcesNested(sourceIds);
    const sourcesSimple = this.formatSourcesSimple(sourceIds);

    const content = [
      null, null, STUDIO_TYPES.getCode("report"), sourcesNested, null, null, null,
      [null, [fmt.title, fmt.description, null, sourcesSimple, options.language || null, prompt, null, true]],
    ];
    return this.createStudioArtifact(notebookId, sourceIds, content);
  }

  async createFlashcards(notebookId: string, sourceIds: string[], difficulty = "medium"): Promise<string> {
    const difficultyCode = FLASHCARD_DIFFICULTIES.getCode(difficulty);
    const sourcesNested = this.formatSourcesNested(sourceIds);

    const content = [
      null, null, STUDIO_TYPES.getCode("flashcards"), sourcesNested, null, null, null, null, null,
      [null, [1, null, null, null, null, null, [difficultyCode, FLASHCARD_COUNT_DEFAULT]]],
    ];
    return this.createStudioArtifact(notebookId, sourceIds, content);
  }

  async createQuiz(notebookId: string, sourceIds: string[], questionCount = 5, difficulty = "medium"): Promise<string> {
    const difficultyCode = FLASHCARD_DIFFICULTIES.getCode(difficulty);
    const sourcesNested = this.formatSourcesNested(sourceIds);

    const content = [
      null, null, STUDIO_TYPES.getCode("flashcards"), sourcesNested, null, null, null, null, null,
      [null, [2, null, null, null, null, null, null, [questionCount, difficultyCode]]],
    ];
    return this.createStudioArtifact(notebookId, sourceIds, content);
  }

  async createDataTable(notebookId: string, sourceIds: string[], description: string, language?: string): Promise<string> {
    const sourcesNested = this.formatSourcesNested(sourceIds);

    const content: unknown[] = [null, null, STUDIO_TYPES.getCode("data_table"), sourcesNested];
    for (let i = 0; i < 14; i++) content.push(null);
    content.push([[description, language || null]]);
    return this.createStudioArtifact(notebookId, sourceIds, content);
  }

  async createMindMap(notebookId: string, sourceIds: string[], title?: string): Promise<string> {
    const sourcesNested = this.formatSourcesNested(sourceIds);

    const genData = await this.callRpc(
      RPC_IDS.GENERATE_MIND_MAP,
      [notebookId, sourcesNested, title || null],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      (data) => {
        const arr = data as unknown[];
        return arr?.[0];
      },
    );

    return this.callRpc(
      RPC_IDS.SAVE_MIND_MAP,
      [notebookId, genData, title || null],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      (data) => this.parser.parseMindMap(data),
    );
  }

  async pollStudio(notebookId: string): Promise<StudioArtifact[]> {
    return this.callRpc(
      RPC_IDS.POLL_STUDIO,
      [[2], notebookId],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      (data) => this.parser.parseStudioStatus(data),
    );
  }

  async deleteStudio(notebookId: string, artifactId: string): Promise<void> {
    await this.callRpc(
      RPC_IDS.DELETE_STUDIO,
      [notebookId, artifactId],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      () => {},
    );
  }

  // ─��─ Chat Configure ─────────────────────────────────

  async chatConfigure(notebookId: string, goal?: string, customPrompt?: string, responseLength?: string): Promise<void> {
    const goalCode = goal ? CHAT_GOALS.getCode(goal) : 1;
    const lengthCode = responseLength ? CHAT_RESPONSE_LENGTHS.getCode(responseLength) : 1;

    await this.callRpc(
      RPC_IDS.PREFERENCES,
      [notebookId, goalCode, customPrompt || null, lengthCode],
      `/notebook/${notebookId}`,
      DEFAULT_TIMEOUT,
      () => {},
    );
  }

  // ─── Auth ────────────────────────────────────────────

  async refreshAuth(): Promise<void> {
    await this.authManager.refreshFromPage();
  }
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Clean build, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/client.ts src/types.ts
git commit -m "refactor: rewrite client.ts as thin facade over transport, parser, and auth-manager"
```

---

### Task 6: Update existing tests and `tools/index.ts`

**Files:**
- Modify: `src/__tests__/client.test.ts`
- Modify: `src/__tests__/integration.test.ts`
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Update `client.test.ts`**

The mocks need to also cover the new modules. Update the mock section and imports:

```typescript
// src/__tests__/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { NotebookLMClient } from "../client.js";
import { BASE_URL, BATCHEXECUTE_PATH, QUERY_PATH, RPC_IDS } from "../constants.js";

// Mock browser-auth.ts
vi.mock("../browser-auth.js", () => ({
  refreshCookiesHeadless: vi.fn(),
  runBrowserAuthFlow: vi.fn(),
}));

// Mock auth.js
vi.mock("../auth.js", () => ({
  buildCookieHeader: vi.fn((cookies: Record<string, string>) => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ")),
  extractCsrfFromPage: vi.fn(() => "mock-csrf"),
  extractSessionIdFromPage: vi.fn(() => "mock-sid"),
  saveTokens: vi.fn(),
  loadTokensFromCache: vi.fn(() => null),
  parseCookieString: vi.fn((raw: string) => ({})),
}));

import { refreshCookiesHeadless } from "../browser-auth.js";

const server = setupServer();

describe("NotebookLMClient", () => {
  beforeEach(() => {
    server.listen();
    vi.clearAllMocks();
  });

  afterEach(() => {
    server.resetHandlers();
  });
  
  afterAll(() => server.close());

  const mockTokens = {
    cookies: { SID: "valid-sid" },
    csrf_token: "old-csrf",
    session_id: "old-sid",
    extracted_at: Date.now() / 1000,
  };

  it("should list notebooks successfully", async () => {
    const mockBundle = [
      "wrb.fr",
      RPC_IDS.LIST_NOTEBOOKS,
      JSON.stringify([[["Notebook 1", [], "nb-id-1", null, null, [1, false, 8, null, null, null, null, null, [1740520000], null, null, [1740520000]]]]]),
      null, null, null, "generic"
    ];

    server.use(
      http.post(`${BASE_URL}${BATCHEXECUTE_PATH}`, () => {
        const json = JSON.stringify([mockBundle]);
        return HttpResponse.text(`)]}'\n\n${json.length}\n${json}`);
      })
    );

    const client = new NotebookLMClient(mockTokens);
    const notebooks = await client.listNotebooks();
    expect(notebooks).toHaveLength(1);
    expect(notebooks[0].title).toBe("Notebook 1");
  });

  it("should handle session expiration and retry in execute", async () => {
    let callCount = 0;

    server.use(
      http.post(`${BASE_URL}${BATCHEXECUTE_PATH}`, ({ request }) => {
        const url = new URL(request.url);
        const rpcId = url.searchParams.get("rpcids");

        if (rpcId === RPC_IDS.LIST_NOTEBOOKS) {
          callCount++;
          if (callCount <= 2) {
            const authErrorBundle = ["wrb.fr", RPC_IDS.LIST_NOTEBOOKS, null, null, null, [16], "generic"];
            const json = JSON.stringify([authErrorBundle]);
            return HttpResponse.text(`)]}'\n\n${json.length}\n${json}`);
          }

          const successBundle = [
            "wrb.fr",
            RPC_IDS.LIST_NOTEBOOKS,
            JSON.stringify([[["Notebook 1", [], "nb-id-1", null, null, [1, false, 8, null, null, null, null, null, [1740520000], null, null, [1740520000]]]]]),
            null, null, null, "generic"
          ];
          const json = JSON.stringify([successBundle]);
          return HttpResponse.text(`)]}'\n\n${json.length}\n${json}`);
        }

        if (rpcId === RPC_IDS.SETTINGS) {
          const successBundle = ["wrb.fr", RPC_IDS.SETTINGS, JSON.stringify([null, 1]), null, null, null, "generic"];
          const json = JSON.stringify([successBundle]);
          return HttpResponse.text(`)]}'\n\n${json.length}\n${json}`);
        }

        return HttpResponse.text("<html>CSRF</html>");
      }),
      http.get(`${BASE_URL}`, () => {
        return HttpResponse.text(`<html>CSRF</html>`);
      })
    );

    (refreshCookiesHeadless as any).mockResolvedValue({
      cookies: { SID: "new-sid" },
      csrf_token: "new-csrf",
      session_id: "new-sid",
      extracted_at: Date.now() / 1000,
    });

    const client = new NotebookLMClient(mockTokens);
    const notebooks = await client.listNotebooks();

    expect(notebooks).toHaveLength(1);
    expect(refreshCookiesHeadless).toHaveBeenCalled();
  });

  it("should handle session expiration and retry in query", async () => {
    let callCount = 0;

    server.use(
      http.post(`${BASE_URL}${QUERY_PATH}`, () => {
        callCount++;
        if (callCount <= 2) {
          const authErrorBundle = ["wrb.fr", "rpc-query", null, null, null, [16], "generic"];
          const json = JSON.stringify([authErrorBundle]);
          return HttpResponse.text(`)]}'\n\n${json.length}\n${json}`);
        }

        const successBundle = [
          "wrb.fr",
          "rpc-query",
          JSON.stringify([["This is the answer", null, 1, null, null, null, null, null, null, null, "conv-123"]]),
          null, null, null, "generic"
        ];
        const json = JSON.stringify([successBundle]);
        return HttpResponse.text(`)]}'\n\n${json.length}\n${json}`);
      }),
      http.get(`${BASE_URL}`, () => {
        return HttpResponse.text(`<html>CSRF</html>`);
      }),
      http.post(`${BASE_URL}${BATCHEXECUTE_PATH}`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("rpcids") === RPC_IDS.SETTINGS) {
          const successBundle = ["wrb.fr", RPC_IDS.SETTINGS, JSON.stringify([null, 1]), null, null, null, "generic"];
          const json = JSON.stringify([successBundle]);
          return HttpResponse.text(`)]}'\n\n${json.length}\n${json}`);
        }
        return new HttpResponse(null, { status: 404 });
      })
    );

    (refreshCookiesHeadless as any).mockResolvedValue({
      cookies: { SID: "new-sid" },
      csrf_token: "new-csrf",
      session_id: "new-sid",
      extracted_at: Date.now() / 1000,
    });

    const client = new NotebookLMClient(mockTokens);
    const response = await client.query("nb-123", "Hello");

    expect(response.answer).toBe("This is the answer");
    expect(response.conversation_id).toBe("conv-123");
    expect(refreshCookiesHeadless).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Update `integration.test.ts`**

Add `loadTokensFromCache` and `parseCookieString` to the auth mock:

```typescript
// src/__tests__/integration.test.ts — update the auth mock (lines 14-19):
vi.mock("../auth.js", () => ({
  buildCookieHeader: vi.fn((cookies: Record<string, string>) => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ")),
  extractCsrfFromPage: vi.fn(() => "mock-csrf"),
  extractSessionIdFromPage: vi.fn(() => "mock-sid"),
  saveTokens: vi.fn(),
  loadTokensFromCache: vi.fn(() => null),
  parseCookieString: vi.fn((raw: string) => ({})),
}));
```

The rest of the test file remains unchanged — it tests through the public API which hasn't changed.

- [ ] **Step 3: Eliminate `any` in `tools/index.ts`**

```typescript
// src/tools/index.ts — full replacement:
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NotebookLMClient } from "../client.js";

export interface McpTool<T extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema?: T; 
  execute: (
    client: NotebookLMClient,
    args: z.infer<z.ZodObject<T>>,
    opts: { queryTimeout?: number }
  ) => Promise<Record<string, unknown>>;
}

export function registerTools(
  server: McpServer, 
  tools: McpTool<z.ZodRawShape>[], 
  getClient: (timeout?: number) => NotebookLMClient, 
  opts?: { queryTimeout?: number, onClientReset?: () => void }
) {
  for (const tool of tools) {
    const config = {
      description: tool.description,
      ...(tool.schema ? { inputSchema: tool.schema } : {}),
    };
    server.registerTool(tool.name, config, async (args) => {
      try {
        const result = await tool.execute(getClient(opts?.queryTimeout), args as z.infer<z.ZodObject<z.ZodRawShape>>, { queryTimeout: opts?.queryTimeout });
        if (result && result._client_action === "reset" && opts?.onClientReset) {
          opts.onClientReset();
          delete result._client_action;
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "success", ...result }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: String(e) }, null, 2) }], isError: true };
      }
    });
  }
}

// Re-usable helper for tools that require confirmation
export function pendingConfirmation(message: string) {
  return { status: "pending_confirmation", message };
}
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (response-parser, rpc-transport, client, integration).

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: Clean build, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/__tests__/client.test.ts src/__tests__/integration.test.ts src/tools/index.ts
git commit -m "refactor: update tests for new architecture and eliminate any types in tool registration"
```

---

## Verification Checklist

After all tasks are complete, run these final checks:

```bash
# Full build
npm run build

# Full test suite
npx vitest run

# Verify dist output works
node dist/cli.js --version
# Expected: 0.1.30

# Verify file count — should have 3 new source files
ls src/response-parser.ts src/rpc-transport.ts src/auth-manager.ts

# Verify client.ts line count reduced
wc -l src/client.ts
# Expected: ~350-450 lines (down from ~1400)
```
