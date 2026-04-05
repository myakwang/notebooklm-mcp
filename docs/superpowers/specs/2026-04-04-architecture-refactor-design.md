# Architecture Refactor & Security Hardening — Design Spec

**Date:** 2026-04-04  
**Scope:** Refactor `client.ts` into layered modules + fix critical security vulnerabilities  
**Approach:** Clean Architecture lite (Vertical Extraction) + parallel security PRs  
**Breaking changes:** Internal only — no external API changes (MCP tools remain identical)

---

## 1. Problem Statement

`src/client.ts` is a 1,400-line God Class handling HTTP transport, batchexecute protocol encoding, response parsing, authentication lifecycle, and all domain logic. This causes:

- **Untestable parsing:** 20+ `as any[]` casts with no type safety on Google's nested array responses
- **Duplicated auth retry:** ~60 identical lines in both `execute()` and `query()` for token refresh/retry
- **Fragile changes:** Any protocol change risks breaking domain methods because parsing is inline
- **Security vulnerabilities:** Command injection, insecure file permissions, path traversal (detailed in Section 5)

## 2. Target Architecture

```
MCP Tool
  -> NotebookLMClient (thin facade, ~400 lines)
       -> AuthManager (token lifecycle + unified retry)
       -> RpcTransport (HTTP + batchexecute protocol)
       -> ResponseParser (typed parsing of Google responses)
```

Data flow for a typical operation:

```
tool.execute(client, args)
  -> client.listNotebooks()
    -> authManager.withAuthRetry(async (state) => {
         response = transport.callRpc({ rpcId, params, ...state })
         authManager.updateFromResponse(response)
         extraction = parser.extractRpcResult(response.parsed, rpcId)
         return { result: parser.parseNotebookList(extraction.data), authError: extraction.authError }
       })
```

## 3. New Modules

### 3.1 `src/rpc-transport.ts`

**Responsibility:** HTTP fetch, batchexecute encoding, headers, timeouts, cookie extraction from responses.

**Public interface:**

```typescript
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

export class RpcTransport {
  private reqId = 0;
  async callRpc(options: RpcRequestOptions): Promise<RpcResponse>;
  async callQuery(options: RpcRequestOptions): Promise<RpcResponse>;
}
```

**Extracted from `client.ts`:**
- `buildUrl()`, `buildQueryUrl()`, `buildRequestBody()`
- `parseResponse()` (batchexecute byte-count splitting + JSON parsing — protocol-level, not domain)
- `fetch()` blocks from `execute()` and `query()` (including duplicate headers)
- Set-Cookie parsing (duplicated in both methods)

**Does NOT:**
- Handle auth retry (that's AuthManager)
- Parse semantic content (returns protocol-parsed `parsed: unknown[]`, not domain objects)
- Maintain token state (receives everything via parameters)
- Extract session IDs from payload (that's ResponseParser via `af.httprm`)

### 3.2 `src/response-parser.ts`

**Responsibility:** Transform raw Google batchexecute arrays into typed domain objects.

**Public interface:**

```typescript
export interface RpcResultExtraction {
  data: unknown;
  sessionId: string | null;
  authError: boolean;
}

export class ResponseParser {
  // Protocol layer
  parseRawResponse(responseText: string): unknown[];
  extractRpcResult(parsed: unknown[], rpcId: string): RpcResultExtraction;

  // Domain parsers
  parseNotebook(data: unknown): Notebook;
  parseNotebookList(data: unknown): Notebook[];
  parseSourceSummary(data: unknown): SourceSummary;
  parseSourceDetail(data: unknown): SourceDetail;
  parseSourceGuide(data: unknown): { summary: string; keywords: string[] };
  parseResearchResults(data: unknown, taskId?: string): ResearchResult[];
  parseQueryResponse(parsed: unknown[], conversationId: string | null): QueryResponse;
  parseStudioResult(data: unknown): string;
  parseStudioStatus(data: unknown): StudioArtifact[];
  parseMindMap(data: unknown): string;
}
```

**Extracted from `client.ts`:**
- `extractRpcResult()` -> returns struct instead of throwing (includes session ID from `af.httprm`)
- `parseNotebook()`, `parseTimestamp()`, `extractTextFromBlocks()`
- All `as any[]` positional access patterns from every domain method

**Note:** `parseResponse()` (raw batchexecute splitting) stays in `RpcTransport` as it's protocol-level parsing. `ResponseParser` operates on already-split `unknown[]` chunks.

**Key design change:** `extractRpcResult()` returns `{ authError: true }` instead of throwing `AuthenticationError`. The decision of what to do about an auth error belongs to `AuthManager`, not the parser.

### 3.3 `src/auth-manager.ts`

**Responsibility:** Token state management, CSRF/session refresh, and unified auth retry logic.

**Public interface:**

```typescript
export interface AuthState {
  tokens: AuthTokens;
  csrfToken: string;
  sessionId: string;
  bl: string;
}

export class AuthManager {
  constructor(tokens: AuthTokens);
  getState(): AuthState;
  updateFromResponse(cookies: Record<string, string> | null, sessionId: string | null): void;
  async refreshFromPage(): Promise<void>;
  async withAuthRetry<T>(
    operation: (state: AuthState) => Promise<{ result: T; authError: boolean }>
  ): Promise<T>;
}
```

**Extracted from `client.ts`:**
- Auth retry blocks from `execute()` (~lines 254-304) — removed
- Auth retry blocks from `query()` (~lines 802-853) — removed
- `refreshAuthTokens()` -> `refreshFromPage()`
- Mutable state: tokens, csrfToken, sessionId

**Retry sequence (implemented once in `withAuthRetry`):**
1. Execute the operation
2. If `authError: false` -> return result
3. If `authError: true` and already retrying -> throw AuthenticationError
4. Try `loadTokensFromCache()` — if fresher tokens found, update state and retry
5. Try `refreshCookiesHeadless()` — if succeeds, update state and retry
6. Try `runBrowserAuthFlow()` — if succeeds, update state and retry
7. Warmup with SETTINGS RPC call
8. Retry original operation

### 3.4 `src/client.ts` (reduced)

**Responsibility:** Thin facade composing transport + parser + auth. Domain method signatures.

**Estimated:** ~400 lines (down from ~1,400)

**Key simplifications:**
- Each method follows: `authManager.withAuthRetry` -> `transport.callRpc` -> `parser.parseX`
- Studio creation methods (9 variants) share `createStudioArtifact()` private helper
- `formatSourcesNested()` and `formatSourcesSimple()` remain as private helpers
- Conversation history typed as `Map<string, ConversationTurn[]>`

## 4. Type Improvements

### 4.1 `src/types.ts` additions

```typescript
export interface ConversationTurn {
  text: string;
  role: 1 | 2;  // 1 = user, 2 = assistant
}
```

### 4.2 `src/tools/index.ts` — eliminate `any`

```typescript
// Before:
const config: any = { description: tool.description };
server.registerTool(tool.name, config, async (args: any) => {

// After:
const config = {
  description: tool.description,
  ...(tool.schema ? { inputSchema: tool.schema } : {}),
};
server.registerTool(tool.name, config, async (args: z.infer<z.ZodObject<T>>) => {
```

## 5. Security Fixes (Parallel PRs)

These are independent of the architecture refactor and can ship first.

### 5.1 Command Injection — `auth.ts:167-176` (CRITICAL)

**Before:**
```typescript
execSync(`xdg-open "${url}"`, { stdio: "ignore" });
```

**After:**
```typescript
import { execFile } from "node:child_process";
execFile("xdg-open", [url], { stdio: "ignore" }, () => {});
```

Same fix for `open` (macOS) and `start` (Windows). `execFile` does not spawn a shell.

### 5.2 Insecure File Permissions — `auth.ts:45-48` (CRITICAL)

**Before:**
```typescript
mkdirSync(CONFIG_DIR, { recursive: true });
writeFileSync(AUTH_FILE, JSON.stringify(tokens, null, 2), "utf-8");
```

**After:**
```typescript
mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
writeFileSync(AUTH_FILE, JSON.stringify(tokens, null, 2), { encoding: "utf-8", mode: 0o600 });
```

### 5.3 Path Traversal + Blocking I/O — `tools/source.ts:51-58` (HIGH)

**Before:**
```typescript
documentContent = fs.readFileSync(file_path, "utf8");
```

**After:**
```typescript
import { resolve } from "node:path";
const resolved = resolve(file_path);
documentContent = await fs.promises.readFile(resolved, "utf8");
```

### 5.4 CLI Version Mismatch — `cli.ts:12`

```typescript
// Before:
.version("0.1.24");
// After:
.version("0.1.30");
```

### 5.5 Cookie Parsing Centralization

Move `parseCookieString()` from `auth.ts` to an exported function. Use it in both `auth.ts` and the new `rpc-transport.ts` (replacing the inline Set-Cookie parsing currently duplicated in `client.ts`).

## 6. Testing Strategy

### 6.1 `response-parser.test.ts` (NEW)

- Test `parseRawResponse()` with captured batchexecute response fixtures
- Test `extractRpcResult()` with valid responses, auth errors (code 16), and missing data
- Test each domain parser (`parseNotebook`, `parseSourceDetail`, etc.) with fixture data
- Test `extractTextFromBlocks()` with the deep nested path

### 6.2 `rpc-transport.test.ts` (NEW)

- Test `callRpc()` with MSW HTTP mocks — verify correct URL construction, headers, body encoding
- Test `callQuery()` with MSW — verify different URL/body format
- Test timeout behavior (AbortController)
- Test Set-Cookie extraction from responses

### 6.3 Existing tests

- `client.test.ts` — adapt to new internal structure (client now delegates to transport/parser)
- `integration.test.ts` — maintain as-is

## 7. Migration Order

The refactoring is designed to be done in sequential PRs that each leave the codebase in a working state:

1. **PR: Security fixes** — All Section 5 changes. Independent, no architecture changes.
2. **PR: Extract `response-parser.ts`** — Move all parsing logic. `client.ts` imports and uses it. Add `response-parser.test.ts`.
3. **PR: Extract `rpc-transport.ts`** — Move HTTP/protocol logic. `client.ts` imports and uses it. Add `rpc-transport.test.ts`.
4. **PR: Extract `auth-manager.ts`** — Move auth state + unify retry. Delete duplicated retry blocks from `client.ts`.
5. **PR: Cleanup `client.ts`** — Extract `createStudioArtifact()` helper, type conversation history, fix `tools/index.ts` types.

Each PR can be reviewed and merged independently. If any PR is reverted, the others still work.

## 8. Out of Scope

- New RPC implementations (GET_CONVERSATIONS, LIST_MIND_MAPS, SUBSCRIPTION)
- Interface abstractions / dependency injection
- Changes to MCP tool names, descriptions, or parameters
- Changes to `constants.ts` or `browser-auth.ts` (beyond security fix)
- Test coverage beyond transport + parser layers
