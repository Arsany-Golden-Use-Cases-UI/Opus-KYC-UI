---
title: Opus External Integration API Reference — Source of Truth
purpose: Single portable document for any external frontend/backend (including AI code-gen tools like Lovable) to integrate with Opus — initiate workflows, poll status, read results, audit failures.
verified_against: opus_operator_openapi.json (title "Opus Operator", 431 paths) + Field Guides 07/08 + live Munich RE integration proof (2026-07-16)
last_updated: 2026-07-17
supersedes: APIs-and-Jobs/README.md (this file is the full version; the README stays as a short index)
tags: [opus-product, api, jobs, external-integration, source-of-truth, reference]
---

# 🔌 Opus External Integration API Reference

> **What this document is.** Everything an external system needs to trigger an Opus workflow, hand it inputs, wait for it to finish, and get results or a precise failure reason — with exact request/response shapes, not paraphrases. Written to be **self-contained**: copy this one file into another project or paste it into an AI coding tool (Lovable, Cursor, a codegen agent) and it has enough to generate a correct integration without needing anything else from this vault.
>
> **What this document is not.** It does not cover building or editing a workflow's internal graph (nodes, edges, agents) — that is workflow *authoring*, done in the Opus canvas or over the collaboration WebSocket (a separate, internal-only surface). This document covers *running* a workflow that already exists and reading its outcome.
>
> **Source-of-truth rule.** Where this document conflicts with the live OpenAPI spec at your Opus deployment's `/docs` (or `/openapi.json`), **the live spec wins.** This document is dated and was cross-checked against a real spec snapshot — re-verify before relying on anything marked ⚠️ below.

## Table of contents

0. [Quick start](#0-quick-start-the-whole-thing-in-30-seconds)
1. [Core concepts — read this first](#1-core-concepts--read-this-first)
2. [Authentication](#2-authentication)
3. [The value wire-format contract](#3-the-value-wire-format-contract-read-before-writing-any-payload)
4. [The core run sequence](#4-the-core-run-sequence)
5. [Job management (list/search/archive/duplicate/delete)](#5-job-management)
6. [Scheduled (recurring) jobs](#6-scheduled-recurring-jobs)
7. [File management beyond upload](#7-file-management-beyond-upload)
8. [API key management](#8-api-key-management)
9. [Three human-in-the-loop mechanisms — do not conflate them](#9-three-human-in-the-loop-mechanisms--do-not-conflate-them) (job-completion callback · off-platform callback · in-platform review API)
10. [Shortcut surfaces (web app, MCP)](#10-shortcut-surfaces)
11. [Error handling & retry policy](#11-error-handling--retry-policy)
12. [Wiring your own UI (three-tier pattern)](#12-wiring-your-own-ui)
13. [Full worked examples (Python + TypeScript)](#13-full-worked-examples)
14. [Gotchas & known platform quirks](#14-gotchas--known-platform-quirks)
15. [Confidence / provenance ledger](#15-confidence--provenance-ledger)

---

## 0. Quick start — the whole thing in 30 seconds

A "job" is one run of one workflow against one set of inputs. The fixed sequence:

```
GET  /workflow/{workflowId}          → discover the input schema (jobPayloadSchema)   [optional once known]
POST <presigned-upload-url-flow>     → get a fileUrl for each file input              [skip if no file inputs]
POST /job/initiate                   → { workflowId } → jobExecutionId
POST /job/execute                    → { jobExecutionId, jobPayloadSchemaInstance, callbackUrl } → run starts
GET  /job/{jobExecutionId}/status    → poll until terminal: COMPLETED | FAILED | CANCELLED | TIMED_OUT
GET  /job/{jobExecutionId}/results   → (only after COMPLETED) → jobResultsPayloadSchema
GET  /job/{jobExecutionId}/audit     → (if FAILED) → which node broke
```

Minimal Python:

```python
import requests, time

BASE = "https://operator.opus.com"          # confirm your environment — see §2
H = {"x-service-key": "YOUR_KEY", "Content-Type": "application/json"}

job = requests.post(f"{BASE}/job/initiate", headers=H,
                     json={"workflowId": "wf-abc-123", "title": "My run"}).json()
job_id = job["jobExecutionId"]

requests.post(f"{BASE}/job/execute", headers=H, json={
    "jobExecutionId": job_id,
    "jobPayloadSchemaInstance": {
        "po_number": {"value": "PO-2026-99887", "type": "str"}
    },
    "callbackUrl": ""   # see §9.1 — currently required by the spec; empty string is accepted
})

while True:
    status = requests.get(f"{BASE}/job/{job_id}/status", headers=H).json()["status"]
    if status in ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"):
        break
    time.sleep(3)

if status == "COMPLETED":
    results = requests.get(f"{BASE}/job/{job_id}/results", headers=H).json()
else:
    audit = requests.get(f"{BASE}/job/{job_id}/audit", headers=H).json()
```

Everything below is the detail behind each line — exact schemas, the type/value wire format (the #1 source of integration bugs), every supporting endpoint, and every known gotcha.

---

## 1. Core concepts — read this first

**Job vs execution vs workflow.** A *workflow* is the graph you build once in the Opus canvas. A *job* (also called a *job execution*, `jobExecutionId`) is one run of that graph against one set of inputs — you can create many jobs from the same workflow. There is a lower-level *executor* domain (`/executor/execution/{execution_id}`) that appears to operate on the same underlying identifier space as `jobExecutionId` — this is unconfirmed by direct empirical proof in this document's research pass; treat the `/job/*` surface as canonical and the `/executor/*` surface as an advanced/lower-level alternative (§4.7).

**The Input and Output nodes are your API contract.** Whatever variables the workflow's Input node declares become the `jobPayloadSchema` you must satisfy on execute. Whatever Output node the run actually reaches becomes the `jobResultsPayloadSchema` you read back. Design (or ask the workflow's author to design) those two nodes deliberately — the external API surface follows directly from them.

**V1 vs V2, `workflowId` vs `referenceEntityId`.** Opus has an older workflow format (V1) and the current canvas-based format (V2, what this whole vault is otherwise about). Two ways to address a workflow show up across the API:
- **`workflowId`** — used throughout `/job/initiate`, `/workflow/{workflowId}`, etc. For a V2 workflow this is the same ID you see in the Opus builder's URL when editing the workflow (the "V2 executor workflow UUID"). This is the ID most integrators will have in hand and is the one used in every worked example in this document.
- **`referenceEntityId`** — a "workflow reference UUID," documented as an alternative address form (required in place of `workflowId` for scheduled jobs on V2 workflows, per §6). This looks tied to a separate "reference-workflow" / marketplace-publishing layer on top of raw workflow IDs. ⚠️ The precise relationship between the two has not been independently re-derived beyond the spec's own terse field descriptions — if you have a `referenceEntityId` rather than a builder-URL workflow ID, both are accepted by `/job/initiate`; confirm which one you were actually given.
- **`workflowVersionId` / `workflowVersionNumber`** — optional, pin a specific published version. Omit either to run whatever version is currently active/latest.

**⚠️ Two status vocabularies exist — do not conflate them.** This is the single most common point of confusion when reading other Opus internal documentation (including this vault's own WebSocket/builder notes):

| Vocabulary | Where it appears | Values | Who cares |
|---|---|---|---|
| **Job-level status** | `GET /job/{id}/status`, `/job/search` | `PENDING`, `IN_PROGRESS`, `WAITING`, `COMPLETED`, `FAILED`, `CANCELLED`, `UNKNOWN`, `TIMED_OUT` (UPPERCASE) | **This is what you poll.** Everything in this document uses this vocabulary unless stated otherwise. |
| **Node-level compliance gates** | Internal builder/WebSocket state, surfaced indirectly inside audit data | `mapping_computed`, `input_compliant`, `running`, `output_compliant`, `sleeping`, `done`, `failed`, etc. (snake_case) | Workflow *authors* debugging why one node in the graph didn't run — not something you poll directly over this API. |

If you ever see snake_case lifecycle words in Opus documentation, that's the second vocabulary (per-node), not the job status you poll.

---

## 2. Authentication

| Header | Use for | Lives where |
|---|---|---|
| `x-service-key: <key>` | Server-side automation — your backend, scripts, an AI-generated integration. **This is the header for everything in this document.** | Your server only. **Never** in a browser, mobile app bundle, or any client-shipped code. |
| `Authorization: Bearer <jwt>` | User-session calls made from inside the Opus web app itself (e.g. `/mcp/workflows/{id}/activate` is bearer-only — a headless service key cannot call it). | The Opus frontend session. Not relevant to most external integrations. |

**Host.** Do not hard-code a single host as universal truth — Opus issues you the base URL for your environment. `https://operator.opus.com` is confirmed live in production use (verified against a real integration, 2026-07). Other environments may use a different host — confirm which one your service key targets before building against it.

**Getting a service key** — `POST /api-keys` (full schema in §8). A key carries `scopes` (e.g. job execution, file upload) and an optional expiry. **The secret is shown once, at creation, and never again** — store it in a secret manager or environment variable immediately.

> **The one rule that matters most in this whole document:** the service key authorizes running your workflows and reading their results/inputs. If it reaches client-side JavaScript, a mobile bundle, or anything an end user's browser can inspect, anyone can extract and reuse it. Every "wiring up a UI" pattern in this document (§12) exists solely to keep this key server-side.

---

## 3. The value wire-format contract (read before writing any payload)

This is where most integration bugs live — including one that cost real debugging time on this exact platform, captured below as a proven fix.

### 3.1 The canonical shape

Every input value inside `jobPayloadSchemaInstance` (and every output value inside `jobResultsPayloadSchema`) is wrapped, never a bare value:

```json
{ "value": <the actual data>, "type": "<type-name-as-a-string>" }
```

- ❌ `{"po_number": "PO-2026-99887"}` — invalid, bare value.
- ✅ `{"po_number": {"value": "PO-2026-99887", "type": "str"}}` — correct.

### 3.2 Type vocabulary

| Type string | Meaning | Example value |
|---|---|---|
| `str` | Text | `"Hello"` |
| `int` | Integer (coerces to/from `float` automatically where the workflow expects it) | `42` |
| `float` | Floating point — use for money, scores, ratios | `3.14` |
| `bool` | Boolean | `true` |
| `file` | A single uploaded file — value is the `fileUrl` from the upload flow (§4.2) | `"https://files.opus.com/media/..."` |
| `array` | A list — for a list of files, upload each separately and pass the list of URLs (see the gotcha below) | `["url1", "url2"]` |
| `object` | A nested dictionary — fields are themselves typed | `{"k": "v"}` |
| `date` | A formatted date | — |

The full underlying V2 type system also composes container types via `allowed_types` + `type_definition` (documented in Field Guide 03) — the vocabulary above is the practically relevant subset for constructing job payloads.

### 3.3 ⚠️ The proven gotcha: array (multi-file) inputs need `typeDefinition`

**This is a confirmed, real platform behavior — not a guess.** Sending an array-typed input (most commonly: multiple files into one input) with only `{value, type: "array"}` and no further detail causes the **Input node to fail silently in ~150ms**, with no useful error text, cascading a `FAILED` status to the whole job. The executor needs to know the *element type* of the array, and it expects that information under a specific **camelCase** sibling key:

```json
{
  "value": ["https://files.opus.com/media/a.pdf", "https://files.opus.com/media/b.pdf"],
  "type": "array",
  "displayName": "Supporting Documents",
  "typeDefinition": {
    "id": "file",
    "variable_name": "file",
    "allowed_types": [{ "type": "file" }]
  }
}
```

Key facts, proven against a real job run (wf `61152903`, 2026-07-16):
- The field **must** be `typeDefinition` (camelCase) as a **sibling** of `value`/`type` — **not** `type_definition` (snake_case), which the executor silently ignores.
- **Do not send the full/rich type-definition object as the value of `type` itself** — e.g. `"type": {"type": "array", ...}` instead of the bare string `"type": "array"`. This is a distinct, separately-proven mistake from the snake_case one above, and it doesn't fail quietly like the snake_case case — **it returns an HTTP 500.** `type` must always be a bare string; the richer object only ever belongs under the separate `typeDefinition` key.
- Single-file inputs (`type: "file"`) do **not** need this — there is no array to describe the element of.
- This is why an older workflow version with mostly single-file inputs can appear to "work fine" while a newer version of the same workflow, with more array/multi-file inputs, mysteriously fails at the Input node for every job — the array inputs are the only ones exercising this requirement.
- `displayName` alongside is optional metadata, not required for correctness, but harmless to include.

**Practical rule:** for any input typed `str`/`int`/`float`/`bool`/`file`, send just `{value, type}`. For any input typed `array` or `object`, add the camelCase `typeDefinition` sibling describing the contained type — do not assume the plain `{value, type}` shape is sufficient just because it works for scalars.

### 3.4 A second, different wire convention exists — do not mix them up

The off-platform human-task callback mechanism (§9.2) uses a **different** nested convention for its own `type` field — there, `type` itself is an object (`{"type": "float", "type_definition": null}`, snake_case nested), not a bare string with a camelCase sibling. This is a genuinely different endpoint family with its own proven contract (drawn from real captured dispatch payloads) — **do not carry the `/job/execute` convention (§3.3) over to the off-platform callback, or vice versa.** Use §3.3's shape for `jobPayloadSchemaInstance`/`jobResultsPayloadSchema`, and §9.2's shape only when POSTing to an off-platform callback URL.

---

## 4. The core run sequence

### 4.1 Discover the workflow's input/output schema

**`GET /workflow/{workflowId}`**

- **Auth:** `x-service-key`
- **Query params:** `version` (number, optional), `workflowVersionId` (string, optional) — pin a specific version; omit for the latest active one.
- **Response:** the workflow's name and its `jobPayloadSchema` — one entry per Input-node variable, with type, nullability, and tags (e.g. `allowed_file_types`).

```json
// response (abridged, real shape from Field Guide 08)
{
  "name": "Invoice Verification",
  "jobPayloadSchema": {
    "invoice_file": {
      "variable_name": "invoice_file",
      "type": "file",
      "is_nullable": false,
      "tags": [{ "variable_name": "allowed_file_types", "value": ["PDF"] }]
    },
    "po_number": { "variable_name": "po_number", "type": "str", "is_nullable": false }
  }
}
```

⚠️ The live spec does not itself formally document this response body's schema (it resolves the workflow by legacy V1 ID or V2 executor ID and returns "the v2 workflow object from the executor" without a typed contract) — the shape above is the field-guide's captured real example; treat it as the working contract, but the exact envelope (is `jobPayloadSchema` top-level or nested under something else on your deployment) is worth confirming with one real call before building extensively against it blind.

**Alternative — schema only, no full graph:** `GET /reference-workflow/v2/workflow-object/{workflowId}/variables-schema` (query: `version`) proxies the same information without the full workflow graph, if you only need the I/O contract.

### 4.2 Upload files (skip entirely if the workflow has no file inputs)

**Small files — presigned single-file flow.**

Two upload endpoints exist with the same shape; the spec explicitly names one "internal":

| Endpoint | Notes |
|---|---|
| **`POST /job/file/upload`** | Not marked internal in the spec; supports `workspaceId`/`workflowId` targeting fields. **Recommended default.** |
| `POST /file/internal/upload` | Operation is literally named "internal" in the spec (`InternalFileController_upload`, summary "(internal)"). The field guide's worked example uses this one successfully, so it evidently works for external callers too — but its long-term intended audience is less certain. |

⚠️ Both exist and both work per available evidence; prefer `/job/file/upload` for new integrations since it is not flagged internal.

```
POST /job/file/upload
x-service-key: YOUR_KEY
{
  "fileExtension": "pdf",
  "originalName": "invoice.pdf",
  "accessScope": "workspace",          // if "workspace": one of workspaceId / workflowId required
  "workspaceId": "ws-...",             // OR workflowId — target workspace ownership
}
// => 201
{ "presignedUrl": "https://s3.../...", "fileUrl": "https://files.opus.com/media/..." }
```

Then **`PUT <presignedUrl>`** the raw bytes directly to storage — no service key.

🚨 **For `/job/file/upload`'s presigned URL specifically: send NO `Content-Type` header at all — proven live, 2026-07-16.** Setting one (even the correct MIME type for the real file) causes an **HTTP 403** on this endpoint's presigned URL; the endpoint also only accepts `PUT` (`POST` → `404`). This directly **contradicts** older field-guide narrative (and the general convention for `/file/internal/upload`'s presigned URL, below) that says to match `Content-Type` to the file — that guidance is confirmed **wrong for `/job/file/upload`**. Storage replies `200 OK` with no body on success. Use the returned `fileUrl` as the value of the `file`-typed input in `jobPayloadSchemaInstance`.

⚠️ This "no Content-Type" rule is proven specifically for **`/job/file/upload`**'s presigned URL. The field guide's original worked example for the *other* upload endpoint, **`/file/internal/upload`**, sets `Content-Type: application/pdf` and reports success — unconfirmed independently here, but plausible that the two endpoints sign their presigned URLs differently (a presigned URL's signature can include or exclude specific headers; sending a header outside what was signed is a classic cause of a 403). **Do not assume the two upload endpoints share upload behavior just because their request/response JSON shapes look similar** — test the specific endpoint you use.

**Large files (>~5MB) — multipart flow** (only documented under `/file/internal/multipart/*`, no `/job/file/multipart/*` alternative exists):

```
POST /file/internal/multipart/initiate
{ "fileName": "big.xlsx", "fileSize": 15000000, "contentType": "...", "jobId": "<optional>" }
// => 201 (response shape not formally documented in the spec — expect one upload URL per part, per field-guide narrative; confirm on first real call)

PUT each part's URL with its byte range → collect the ETag from each response

POST /file/internal/multipart/complete
{ "fileKey": "<from initiate>", "uploadId": "<from initiate>" }
// ⚠️ the current live schema for this endpoint shows only fileKey + uploadId — NOT the
// ordered {partNumber, etag} list the field guide describes. This is a genuine spec
// discrepancy as of this writing; the field guide may be describing an older/different
// version of this call. Confirm the exact required body with one real multipart run
// before depending on either shape.

POST /file/internal/multipart/abort
{ "fileKey": "...", "uploadId": "..." }   // release storage on partial failure
```

**Multiple files into one input:** upload each file separately, then pass the array of `fileUrl`s as the value with `type: "array"` **and** the `typeDefinition` sibling from §3.3 — this is exactly the case that gotcha covers.

### 4.3 Initiate a job

**`POST /job/initiate`** — the canonical, current endpoint.

- **Auth:** `x-service-key`
- **Request body** (`JobInitiateRequestDto`):

| Field | Required | Notes |
|---|---|---|
| `workflowId` | one of `workflowId` / `referenceEntityId` | See §1 for the distinction |
| `referenceEntityId` | — | |
| `workflowVersionId` | no | pin a version |
| `workflowVersionNumber` | no | pin a version by number |
| `title` | no | metadata for the job list |
| `description` | no | metadata |
| `refUserId` | no | — |
| `source` | no, default `"api"` | enum: `email-agent`, `chat-agent`, `scheduled`, `api`, `manual`, `agent`, `opus-ai`, `web-app` |
| `workspaces` | no | — |
| `initialInput` | no | object — an alternate path to seed input at initiate time; the documented flow (this whole document) uses the separate `/job/execute` call instead |
| `webAppId` | no | only relevant if triggered through a generated web app (§10) |

- **Response `201`** (`JobInitiateResponseDto`): `{ "jobExecutionId": "<string>" }`

```json
POST /job/initiate
{ "workflowId": "wf-abc-123", "title": "Invoice 99887", "description": "Q4 vendor invoice" }
// => { "jobExecutionId": "jex-xyz-456" }
```

**⚠️ `POST /job/v2/initiate` is deprecated and now a hard redirect.** Confirmed directly from the live spec: it returns an **HTTP 308 permanent redirect to `POST /job/initiate`**, preserving your method and body. There is no longer any ambiguity about which path to build against — **use `/job/initiate`.** If your HTTP client doesn't follow 308 redirects by default for POST (some strip the body on redirect, depending on library/version), you may see unexpected behavior calling the `v2` path — safest to just call `/job/initiate` directly and skip the redirect entirely.

### 4.4 Execute the job

**`POST /job/execute`**

- **Auth:** `x-service-key`
- **Request body** (`JobExecuteRequestDto`):

| Field | Required (per live spec) | Notes |
|---|---|---|
| `jobExecutionId` | ✅ | from initiate |
| `jobPayloadSchemaInstance` | ✅ | map of `variable_name → {value, type[, typeDefinition]}` — see §3. Keys match the Input node's variable names exactly. |
| `callbackUrl` | ✅ (per spec) | ⚠️ see note below — the field guide's own worked example omits this field entirely and (per that guide) succeeds; the live spec nonetheless marks it required. See §9.1 for what it's for. |
| `workspaces` | no | comma-separated workspace IDs, for machine-key callers validating access |

```json
POST /job/execute
{
  "jobExecutionId": "jex-xyz-456",
  "jobPayloadSchemaInstance": {
    "invoice_file": { "value": "https://files.opus.com/media/...", "type": "file" },
    "po_number": { "value": "PO-2026-99887", "type": "str" }
  },
  "callbackUrl": ""
}
// => 201
{ "success": true, "message": "Job execution has been started", "jobExecutionId": "jex-xyz-456" }
```

**Response** (`JobExecuteResponseDto`): `success` (bool), `jobExecutionId`, `message`, `error` (object, presumably populated on failure).

🚨 **`success: true` here does NOT mean the run will succeed — proven live, 2026-07-16.** This response only confirms the request was accepted and a run started; the workflow can still fail immediately afterward (e.g. at the Input node, per §3.3's gotcha) while this call still returned `{"success": true, "message": "Job execution has been started"}`. **Never treat this response as confirmation of a good run.** Always follow up with the poll loop (§4.5) and, on `FAILED`, the audit (§4.7) — this response tells you the request was valid, not that the workflow worked.

⚠️ **The `callbackUrl` required-vs-documented-optional discrepancy is real and dated.** The field guide (2026-06-30) shows a working example with no `callbackUrl` key at all. The live spec (checked 2026-07-17) marks it required. Two explanations are both plausible and neither has been re-confirmed empirically here: (a) the requirement is enforced but an **empty string satisfies it**, or (b) the requirement was added after the field guide was written and the guide's example is now stale. **Send an empty string if you have no receiving endpoint, and confirm with one real call that this is accepted before building a production integration around its absence.**

### 4.5 Poll status

**`GET /job/{jobExecutionId}/status`**

- **Auth:** `x-service-key`
- **Response `200`**: `{ "status": "<STATUS>" }`

| Status | Meaning | Poll action |
|---|---|---|
| `PENDING` | Job created, not yet running | keep polling |
| `IN_PROGRESS` | Nodes executing | keep polling |
| `WAITING` | Paused — typically a human task, sub-workflow, or external callback | keep polling (may be a long wait — hours is normal, not a hang) |
| `COMPLETED` | Reached an output node successfully | stop; read results |
| `FAILED` | A node failed, run halted | stop; inspect audit (§4.7) |
| `CANCELLED` | Run stopped before completing | stop |
| `TIMED_OUT` | ⚠️ Not documented in the older field guide — confirmed present in the live `status` enum (via `/job/search`'s filter enum) alongside the others. Treat as terminal, same handling as `FAILED`. | stop |
| `UNKNOWN` | State could not be determined | treat as an error; re-check or alert |

**Polling cadence:** start ~3 seconds; back off for slow jobs or ones sitting in `WAITING`; set a ceiling/timeout rather than looping forever; keep the `jobExecutionId` so the run can be checked later instead of blindly re-initiating (re-initiating creates a brand-new, separate job — it is not idempotent against a previous attempt).

### 4.6 Read results

**`GET /job/{jobExecutionId}/results`** — call only after `COMPLETED`.

- **Response `200`** (`JobResultsResponseDto`): `{ "jobResultsPayloadSchema": { "<output_variable>": {value, type} } }`

⚠️ **Result shape varies by branch.** A workflow with multiple terminal Output nodes returns whichever one the run actually reached — the same job ID can structurally differ in its result shape run to run depending on which path the workflow took. Keep variable names consistent across a workflow's output nodes so the fields your integration depends on stay stable regardless of branch; otherwise your client must inspect which fields are actually present before reading them.

### 4.7 Audit / debug a failure

Two separate audit surfaces exist. Use the first; the second is a lower-level alternative worth knowing about.

**Primary: `GET /job/{jobExecutionId}/audit`** (`JobAuditResponseDto`, fully spec-documented):

```json
{
  "nb_nodes": 12,
  "remaining_nodes_to_execute": ["Node A", "Node B"],
  "next_node_to_execute": "Node A",
  "running_node": null,
  "executed_nodes": ["Input", "Extract Data"],
  "nb_executed_nodes": 2,
  "failed_nodes": ["Extract Data"],
  "nb_failed_nodes": 1,
  "audit": { "nodes_execution_data": { "...": "per-node status, timing, index — free-form object" } }
}
```

This is your first stop on a `FAILED` job — `failed_nodes` tells you exactly which node broke; `nodes_execution_data` (inside `audit`) carries the per-node detail, though its inner shape is a free-form object in the spec (not further typed) — inspect one real failed job's response to learn its exact keys for your workflow.

**`GET /job/{jobExecutionId}`** (job detail) conveniently embeds this same `audit` block plus `input`/`output` (raw objects), `user{name,email}`, `workflow{id,name,description,industry}`, `workflowEstimation{workflow_cost,workflow_time}`, `createdAt`, `builderType` (`OPUS_V1`/`OPUS_V2`), `workflowVersionId`/`Number`, and `status` — useful as a single richer read instead of separately calling status + audit.

**Lower-level alternative: the executor domain** (⚠️ response schemas are not documented at all in the live spec — summaries only, treat everything here as needing empirical confirmation before depending on it):

| Endpoint | Summary (from the spec) |
|---|---|
| `GET /executor/execution/{execution_id}` | "Get details of an execution by ID" — presumably a richer raw payload than job detail |
| `GET /executor/execution/{execution_id}/activity` | "Get per-node inputs, outputs, statuses, and compliance info for an execution" (query: `include_sub_workflows` bool) — sounds like it may expose actual per-node input/output *values*, not just status/timing |
| `GET /executor/execution/{execution_id}/audit` | "Get the chronological execution trace with event codes, levels, and timestamps" — a structured event log, distinct in kind from the Job domain's audit summary |
| `POST /executor/execution/{execution_id}/stop` | Stop a running execution |
| `GET /executor/workflow/{workflow_id}/executions` | List all active executions for a workflow (query: `version`) |

⚠️ Whether `execution_id` here is literally the same value as `jobExecutionId` has not been independently proven in this document's research — it is a reasonable inference (the Job API is understood to sit in front of an "Executor" runtime engine) but should be confirmed by comparing IDs from one real run before an integration depends on the pairing. If confirmed, `/executor/execution/{id}/activity` may be the more useful endpoint than `/job/{id}/audit` when you need actual per-node input/output values rather than just status/timing.

---

## 5. Job management

Beyond the run sequence, the Job domain exposes standard CRUD/list operations:

| Endpoint | Purpose |
|---|---|
| `GET /job/{jobId}` | Job detail (see §4.7) |
| `PATCH /job/{jobId}` | Update a job record |
| `POST /job/{jobId}/archive` / `DELETE /job/{jobId}/archive` | Archive / unarchive |
| `GET /job/{jobId}/duplicate` | Duplicate a job |
| `DELETE /job/{jobId}/delete` | Delete a job |
| `GET /job/search` | Full job list with rich per-job objects (see §4.7's job-detail shape) |
| `GET /job/search-light` | Same filters, lightweight per-job objects — prefer this for dashboards/lists where you don't need the full audit/estimation payload per row |

**Shared query params on `search` / `search-light`:** `groupIds[]`, `workflowId`, `referenceId`, `workspaceIDs[]`, `offset` (default 0), `maxResults` (default 25), `status[]` (the same enum as §4.5, including `TIMED_OUT`), `archiveStatus` (`all` | `archivedOnly` | `nonArchivedOnly`), `query` (free text), `startDate`, `endDate`, `webAppId`.

`search-light`'s per-job item: `jobExecutionId`, `title`, `description`, `status`, `createdAt`, `archived`, `builderType`, `referenceId`, `workflow{id,name,active,industry}`, `user{name,email}`, `workspace{id,name}`, `workflowEstimation{workflow_cost,workflow_time}`, `workflowVersionId`/`Number`.

---

## 6. Scheduled (recurring) jobs

If the trigger is "every morning at six" rather than an ad-hoc event, use scheduling instead of standing up your own cron that calls `/job/initiate`.

**`POST /job/scheduled`** (`CreateScheduledJobRequestDto`):

| Field | Required | Notes |
|---|---|---|
| `workflowId` | required for V1 workflows | |
| `referenceEntityId` | required for V2 workflows | note the V1/V2-specific requirement is explicit here, unlike the plainer `/job/initiate` |
| `builderType` | no, defaults `OPUS_V1` | enum `OPUS_V1` / `OPUS_V2` — **set this explicitly to `OPUS_V2`** for a canvas-built workflow, since the default is the older format |
| `title` | ✅ | |
| `description` | no | |
| `schedule` | ✅ | see below |
| `jobPayloadSchemaInstance` | no | the payload template each triggered run will use — same wire format as §3 |

⚠️ Note the schedule is **not** a raw cron expression, despite older documentation suggesting so — it's a structured config:

```json
"schedule": {
  "startDate": "2026-03-01",             // ISO date
  "frequency": "WEEKLY",                  // DAILY | WEEKLY | MONTHLY
  "timeOfDay": "09:00",                   // HH:MM, 24h
  "dayOfWeek": "MONDAY",                  // required when frequency=WEEKLY
  "dayOfMonth": 1,                        // required when frequency=MONTHLY
  "totalRuns": null,                      // omit/null = unlimited
  "stopDate": null,                       // omit/null = no end date
  "timezone": "Europe/Berlin"
}
```

Response: `{ "scheduledJobId": "<string>" }`.

Other endpoints: `GET /job/scheduled` (list, same filter style as job search plus `status[]` = `ACTIVE`|`PAUSED`|`COMPLETED`|`ERROR`), `GET/PATCH/DELETE /job/scheduled/{id}`, `GET /job/scheduled/{id}/jobs` (jobs a schedule has triggered), `POST /job/scheduled/{id}/pause` / `.../resume`.

---

## 7. File management beyond upload

🚨 **`POST /job/file/download`'s body has two conflicting sources — an unresolved discrepancy, not a typo.** Proven live (2026-07-16): the working body is **`{fileUrl, workspaceId}`, both fields required.** The OpenAPI spec snapshot (2026-07-17, one day later) instead documents **`{fileUrl, customExpiry}`, both marked required, with no `workspaceId` field at all.** Neither source has been reconciled against the other in this pass — possibilities include the spec being stale/incomplete for this one endpoint, the contract changing in the intervening day, or both field sets being accepted (extras typically ignored, missing fields typically 400). **Until tested, send both `workspaceId` and `customExpiry` alongside `fileUrl`** (belt-and-braces) rather than trusting either source alone, and note which combination actually works so this entry can be corrected.

| Endpoint | Purpose |
|---|---|
| `POST /job/file/download` | Presigned download URL. See the discrepancy callout above before choosing a body shape. Response: `{presignedUrl, fileUrl, contentType, contentLength}`. |
| `GET /job/file/list` | List files accessible to the caller. Rich filter set: `groupIds[]`, `search`, `dateFrom`, `dateTo`, `page` (default 1), `limit` (default 20), `extensions` (comma list), `accessScope`, `filterGroup`, `filterWorkspace`. Returns paginated `{data:[...], total, page, limit, totalPages}`, each item with `id, fileUrl, originalName, displayName, contentType, sizeBytes, accessScope, uploadedBy{id,name,lastName}, createdAt, updatedAt`. |
| `POST /job/file/rename` | Body `{id, displayName}` → `{id, displayName}`. |
| `POST /job/file/delete` | Soft delete. Body `{id}` → `{message, id}`. |

---

## 8. API key management

| Endpoint | Purpose |
|---|---|
| `POST /api-keys` | Create. Body: `{name, scopes:[...], expiresAt?, keyPrefix?}`. Response (**secret shown once**): `{id, name, key, scopes, createdAt, expiresAt, isActive, keyPrefix}`. |
| `GET /api-keys` | List your keys (secret never re-shown): `{id, name, scopes, createdAt, expiresAt, isActive, lastUsedAt, totalLifetimeCalls, owner}`. |
| `PATCH /api-keys/status/{id}/{activeStatus}` | Enable/disable. |
| `POST /api-keys/{id}/rotate` | Rotate (issues a new secret). |
| `POST /api-keys/{id}/reset-limits` | Reset rate-limit counters. |
| `DELETE /api-keys/revoke/{id}` | Revoke. |
| `DELETE /api-keys/delete/{id}` | Delete outright. |
| ~~`GET /api-keys/scopes`~~ | **Deprecated** in the live spec — the list of valid scope strings is not reliably discoverable through the API; get the current scope list from the Opus dashboard/UI when creating a key. |

---

## 9. Three human-in-the-loop mechanisms — do not conflate them

Opus has **three unrelated** ways an external caller touches a paused/human step. They serve different purposes, are triggered differently, and — critically — **use different casing conventions for near-identically-named fields** (flagged explicitly at the end of §9.3). Mixing them up is a likely source of integration bugs for anyone skimming rather than reading all three sections below.

### 9.1 Job-completion callback (`callbackUrl` on `/job/execute`)

You supply this URL *proactively* when calling `/job/execute` (§4.4). The evident intent is a push notification when the job reaches a terminal state, as an alternative to polling `/job/{id}/status`.

⚠️ **The exact payload Opus POSTs to your `callbackUrl` is not documented anywhere in the live spec or the field guides available for this document.** Do not assume a shape for it. Safe approach: treat an inbound call to your callback endpoint purely as a **wake-up signal** ("something happened — go check"), then call `GET /job/{id}/status` and, if `COMPLETED`, `GET /job/{id}/results` as the actual source of truth, rather than trusting fields parsed directly out of the callback body. Confirm the real payload shape with one live test before building deeper logic on it.

### 9.2 Off-platform human/task completion callback (fully documented, proven contract)

This is a **completely different** mechanism: when a workflow reaches a human task or review step configured as "off-platform" (delegated to an external system rather than the Opus web app), **Opus itself POSTs to a webhook URL you configured on that task template** — not the `callbackUrl` you set at execute time. Your system later POSTs an answer back. This is a two-exchange round trip, not a single request/response.

```
Exchange 1 — DISPATCH (Opus → your webhook, configured on the task template in advance)
  POST <your configured webhook>
  { execution_id, workflow_id, workflow_name, inputs: {...}, callback: {url, token, token_header}, expected_output_schema }
  Your system returns 2xx within 15s — this just ACKNOWLEDGES receipt, it is NOT the answer.

Exchange 2 — CALLBACK (your system → Opus, minutes/days later)
  POST <callback.url from exchange 1 — use verbatim, never construct it yourself>
  X-Opus-Callback-Token: <callback.token from exchange 1>
  { "output_data": { "<output_auto_id>": {"value": ..., "type": {"type": "float", "type_definition": null}} },
    "status": "success" | "failed", "error": "<required if status=failed>" }
```

**Critical rules** (each independently proven to cause real failures if violated):
1. Every `output_data` value is wrapped `{value, type}` — never bare.
2. Keys in `output_data` are the **auto-generated output IDs** from `expected_output_schema` (e.g. `workflow_output_91qpvueu3`), **never** the human-readable display names.
3. `callback.url` varies by environment — always use the exact URL handed to you in the dispatch payload, never rebuild it from a host you assume.
4. The callback token is **single-use** — a second submission gets `401`. Track submission state client-side and show "already submitted" rather than resubmitting.
5. `execution_id` is your idempotency key — the same dispatch can arrive twice on retry; upsert, don't duplicate.

**Retry/reliability behavior of the dispatch (Opus → you):** 15-second timeout via `python-httpx`; `408/425/429/500/502/503/504` get up to 3 retries with exponential backoff (0.5–5s); any other `4xx` is treated as permanent misconfiguration; network errors/timeouts trip a circuit breaker after 5 consecutive failures, half-opening after 60s.

**Response codes when you call back:** `200` accepted & workflow resumed; `400` bad body shape or missing required `error` on a failed status; `401` bad/replayed/expired token (surface as "this has expired," not "auth failed"); `404` execution not found.

This entire mechanism only matters if you are building the *receiving* side of an off-platform human task — a much narrower use case than the core run sequence in §4. Full narrative, a reference Flask receiver, and every edge case live in Field Guide 07 (`Field-Guides/07-Human-in-the-Loop-and-Off-Platform.md`) if you need to implement this side.

### 9.3 In-platform review completion via API (proven live — full headless automation possible)

This is a **third, separate** mechanism, distinct from both above: completing an **in-platform** review (the kind a person would normally clear inside the Opus web app's queue) entirely through the API, without a human ever opening the UI. Field Guide 07 mentions in-platform reviews are "handled through the `/review` endpoints" without giving exact schemas — this section gives the proven, exact contract (verified live, 2026-07-16).

**Sequence:**

```
GET  /review?groupIds=<workspace_id>              → lists reviews (each maps to a parent execution)
POST /review/v2/{reviewId}/pickup                 → 201, locks the review to your service key
POST /review/v2/{reviewId}/complete               → 201 COMPLETED
     body: { "outputData": { "<output_auto_id>": "<value>" } }
```

- Only works on a review currently in **`DISPATCHED`** (unassigned) state.
- `outputData`'s keys are the same **auto-generated output-variable IDs** convention used everywhere else on this platform (e.g. `workflow_output_xyz123`) — never the human-readable display name.
- The exact string/value format expected per output is **defined by that specific review's own instructions**, not a platform-wide rule — e.g. one observed "Claim Extraction Review" template expected a single free-text field formatted `"N correct"` or `"N correction: <value>"`, with unmentioned items left as-is. Read the review's own instructions/schema rather than assuming a universal format.
- Map a review back to its originating job via the review detail's `job.createdAt`.

**Gotchas, both proven:**
- **`409` if already opened in the UI.** A review a human has already opened in the Opus web app's Cases page becomes assigned-to-user — a subsequent `pickup` call from the service key gets `409`. Pick a review up via the API only if no human has touched it yet.
- **Short SLA — act fast.** Reviews expire quickly; if not completed in time, the underlying job **retries from scratch and re-dispatches a brand-new review ID.** If you're automating this, tight-poll `GET /review` (roughly every ~4s) after pickup and complete promptly — don't assume the review ID you first saw is still valid if you paused.

**Downstream wiring gotcha (workflow-authoring level, not API, but the reason a review "does nothing"):** on one real workflow, a human's correction was submitted correctly via this API but landed in a field (`diagnosis_alignment`) that a downstream node never actually read (it consumed a different field, `diagnoses[].text_es`) — so the correction silently never reached the logic meant to use it, and placeholder output persisted. If a review's correction appears to have no effect, audit the resolver→consumer field mapping inside the workflow itself before assuming the API call failed.

**🚨 The casing trap between §9.2 and §9.3.** These two HITL mechanisms use **opposite** casing for their otherwise similarly-purposed output-submission field:

| Mechanism | Field name | Casing |
|---|---|---|
| §9.2 off-platform callback | `output_data` | snake_case |
| §9.3 in-platform review complete | `outputData` | camelCase |

Copy-pasting a working payload from one mechanism into the other's endpoint is a very plausible, easy-to-make mistake — always re-check which of the two you are actually calling.

---

## 10. Shortcut surfaces

Three alternate ways to expose a workflow, all sitting on top of the same Jobs API underneath:

- **Web app (Opus-hosted generated frontend).** `POST /v1/web-app` creates one; `GET /v1/web-app/id/{id}/schema` gets its I/O schema; `POST /v1/web-app/id/{id}/job/initiate` starts a run (body only carries `title`/`source` metadata in the documented spec — how form values reach the run isn't specified there; likely tied to the web app's own session state rather than something you construct directly). `POST .../html/generate`, `.../html/modify`, `.../html/undo`, `.../html/restore`, `GET .../html/versions` manage the AI-generated HTML. `GET .../runs`, `GET/PUT .../chat` round out the surface. Reach for this when an Opus-hosted page is acceptable and you want something working in minutes rather than building your own frontend.
- **MCP (workflow as a tool).** `PATCH /mcp/workflows/{workflowId}/activate` / `.../deactivate` — ⚠️ **these are `bearer`-secured, not `x-service-key`** — a headless service-key integration cannot call them; this is a user-session action. Once activated, the workflow appears in your org's MCP tool catalogue for clients like Claude Desktop/Code to call directly, with `jobPayloadSchema` becoming the tool's input schema.
- **Embed (your own UI).** The fully custom route — see §12.

---

## 11. Error handling & retry policy

| HTTP code | Means | Action |
|---|---|---|
| `400` / `422` | Bad or semantically invalid body | Fix the payload. Do not retry as-is. |
| `401` / `403` | Missing/invalid key, or valid key lacking the needed scope | Fix the credential/scopes. |
| `404` | Workflow or job ID doesn't exist | Check the ID. Do not retry. |
| `429` | Rate limited | Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped. |
| `5xx` | Server error | Same exponential backoff, a few attempts. |
| `308` | Permanent redirect (currently only on `POST /job/v2/initiate` → `/job/initiate`) | Follow it, or better, call the canonical path directly. |

**Rule of thumb:** retry on `429`/`5xx` with backoff; never auto-retry `4xx` in the 400–404 range — those fail identically until the request itself changes.

**`FAILED` status ≠ an HTTP error.** A `FAILED` job means every call so far returned `2xx` — the run was accepted and started, and a node inside the graph failed during execution. Go to `/job/{id}/audit` (§4.7), not the HTTP layer, to find out what broke.

---

## 12. Wiring your own UI

**The one rule:** the browser never talks to Opus directly. Your service key must live only on a server you control.

```
Browser (your UI — no key)
   → Your server (holds x-service-key)
      → Opus Jobs API
```

Your server does not need to mirror the Opus API one-to-one — expose a small, purpose-built surface:

| Your endpoint (browser calls this) | What your server does |
|---|---|
| `POST /api/upload` | Presign via `/job/file/upload` (§4.2), return the presigned URL or proxy the bytes, keep the resulting `fileUrl`. |
| `POST /api/run` | `/job/initiate` then `/job/execute` (§4.3–4.4); return the `jobExecutionId`. |
| `GET /api/run/{id}` | `/job/{id}/status`, and on `COMPLETED` also `/job/{id}/results` (§4.5–4.6). |

Walkthrough: user picks a file → browser posts to your `/api/upload` → your server presigns + uploads + holds `fileUrl` → browser posts to your `/api/run` with the form fields → your server initiates + executes and returns a job ID → browser polls your `/api/run/{id}` → your server forwards to Opus's status/results and relays them → browser renders (branching its display on whichever output fields are actually present, per §4.6's branch-shape warning).

---

## 13. Full worked examples

### 13.1 Python

```python
import requests, time

BASE = "https://operator.opus.com"    # confirm your environment
H = {"x-service-key": "YOUR_KEY", "Content-Type": "application/json"}

# 1. (optional) discover the schema
schema = requests.get(f"{BASE}/workflow/wf-abc-123", headers=H).json()

# 2. upload a file (skip if no file inputs)
presign = requests.post(f"{BASE}/job/file/upload", headers=H, json={
    "fileExtension": "pdf", "originalName": "invoice.pdf", "accessScope": "workspace",
    "workspaceId": "ws-..."
}).json()
with open("invoice.pdf", "rb") as f:
    # NO Content-Type header here — proven live, setting one 403s on this endpoint's
    # presigned URL specifically (see §4.2). Do not "helpfully" add one back.
    requests.put(presign["presignedUrl"], data=f)
file_url = presign["fileUrl"]

# 3. initiate
job = requests.post(f"{BASE}/job/initiate", headers=H,
                     json={"workflowId": "wf-abc-123", "title": "Invoice 99887"}).json()
job_id = job["jobExecutionId"]

# 4. execute — note the array/multi-file typeDefinition gotcha (§3.3) if you have one
requests.post(f"{BASE}/job/execute", headers=H, json={
    "jobExecutionId": job_id,
    "jobPayloadSchemaInstance": {
        "invoice_file": {"value": file_url, "type": "file"},
        "po_number": {"value": "PO-2026-99887", "type": "str"},
        # multi-file example:
        # "supporting_docs": {
        #     "value": [file_url_1, file_url_2], "type": "array",
        #     "typeDefinition": {"id": "file", "variable_name": "file", "allowed_types": [{"type": "file"}]}
        # }
    },
    "callbackUrl": ""
})

# 5. poll to a terminal state
while True:
    status = requests.get(f"{BASE}/job/{job_id}/status", headers=H).json()["status"]
    if status in ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"):
        break
    time.sleep(3)

# 6. read results or audit
if status == "COMPLETED":
    results = requests.get(f"{BASE}/job/{job_id}/results", headers=H).json()
    print(results["jobResultsPayloadSchema"])
else:
    audit = requests.get(f"{BASE}/job/{job_id}/audit", headers=H).json()
    print("failed nodes:", audit["failed_nodes"])
```

> **A Python SDK exists** (`opus-aaico`, `pip install opus-aaico`) that wraps this whole sequence behind a single `run()` call with status callbacks, retry, and exponential backoff on `429`/`5xx` built in — the fastest path if Python fits your stack. It is a separate, distinct thing from `opus_code_sdk` (the in-workflow Code Node's Python global) — do not conflate the two.

### 13.2 TypeScript / JavaScript (server-side — Node, Lovable backend function, etc.)

```typescript
const BASE = "https://operator.opus.com";  // confirm your environment
const HEADERS = {
  "x-service-key": process.env.OPUS_SERVICE_KEY!,   // NEVER expose this to the browser
  "Content-Type": "application/json",
};

async function runOpusWorkflow(workflowId: string, inputs: Record<string, any>) {
  // 1. initiate
  const initRes = await fetch(`${BASE}/job/initiate`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({ workflowId, title: "Run from integration" }),
  });
  const { jobExecutionId } = await initRes.json();

  // 2. execute
  await fetch(`${BASE}/job/execute`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({
      jobExecutionId,
      jobPayloadSchemaInstance: inputs,   // caller builds this using the §3 wire format
      callbackUrl: "",
    }),
  });

  // 3. poll
  let status: string;
  do {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch(`${BASE}/job/${jobExecutionId}/status`, { headers: HEADERS });
    ({ status } = await statusRes.json());
  } while (!["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(status));

  // 4. results or audit
  if (status === "COMPLETED") {
    const resultsRes = await fetch(`${BASE}/job/${jobExecutionId}/results`, { headers: HEADERS });
    return (await resultsRes.json()).jobResultsPayloadSchema;
  }
  const auditRes = await fetch(`${BASE}/job/${jobExecutionId}/audit`, { headers: HEADERS });
  const audit = await auditRes.json();
  throw new Error(`Opus job ${status}: node(s) failed — ${audit.failed_nodes?.join(", ")}`);
}

// Building a multi-file array input correctly (§3.3):
const supportingDocsInput = {
  value: [fileUrl1, fileUrl2],
  type: "array",
  typeDefinition: { id: "file", variable_name: "file", allowed_types: [{ type: "file" }] },
};
```

---

## 14. Gotchas & known platform quirks

- **`success: true` on `/job/execute` does not mean the run will succeed** — proven live; it only confirms the request was accepted (§4.4). Always poll status + audit; never stop at this response.
- **`/job/v2/initiate` is deprecated and 308-redirects to `/job/initiate`.** Just call `/job/initiate` directly (§4.3).
- **Array/multi-file inputs need camelCase `typeDefinition`** as a sibling of `value`/`type`, or the Input node fails silently in ~150ms with no useful error (§3.3). Proven, real, cost real debugging hours on a live integration — not a theoretical edge case.
- **Sending the type as a rich object instead of a bare string 500s** — `type` must always be the bare string (`"array"`, `"file"`, etc.); the richer schema only ever belongs under the separate `typeDefinition` key (§3.3). A distinct mistake from the snake_case one above, and it fails loudly (500) rather than silently.
- **Two different `type` wire conventions exist** — the Jobs API's flat `{value, type: "<string>"}` (+`typeDefinition` for containers) vs. the off-platform callback's nested `{value, type: {type, type_definition}}` (§3.4). Know which endpoint you're calling.
- **`/job/file/upload`'s presigned PUT rejects a `Content-Type` header with a 403** — proven live; send raw bytes with no `Content-Type` at all on this specific endpoint (§4.2). This is the opposite of the general presigned-upload convention and of what the field guide's example shows for the *other* upload endpoint (`/file/internal/upload`) — the two endpoints are not proven to behave the same way.
- **Three human-in-the-loop mechanisms exist with an opposite-casing trap between two of them** — job-completion `callbackUrl` (undocumented payload), off-platform callback (`output_data`, snake_case), and in-platform review completion (`outputData`, camelCase) (§9). Copying a payload from one into the other's endpoint is an easy, real mistake.
- **`callbackUrl` is marked required on `/job/execute`** in the live spec, but the field guide's own worked example omits it entirely (§4.4) — a real, unresolved-as-of-this-writing discrepancy. Test with an empty string first.
- **`POST /job/file/download`'s required body fields conflict between two sources one day apart** — proven-live usage says `{fileUrl, workspaceId}`; the OpenAPI spec snapshot says `{fileUrl, customExpiry}` with no `workspaceId` at all (§7). Send both until confirmed.
- **`TIMED_OUT` is a real terminal job status** absent from the older field guide's status table — include it in your terminal-state check alongside `COMPLETED`/`FAILED`/`CANCELLED` (§4.5).
- **Two file-upload endpoints exist** (`/job/file/upload` vs `/file/internal/upload`) with the latter explicitly named "internal" in the spec despite the field guide using it in its worked example (§4.2). Prefer the non-internal one for new work — and see the Content-Type gotcha above before assuming they behave identically.
- **Two audit surfaces exist** (`/job/{id}/audit`, spec-documented vs `/executor/execution/{id}/audit`, summary-only) — the pairing between `jobExecutionId` and `execution_id` is a reasonable inference, not independently proven here (§4.7).
- **In-platform reviews have a short SLA and re-dispatch a brand-new review ID if missed** — if automating review completion (§9.3), tight-poll after pickup and complete promptly; a review already opened by a human in the UI 409s for the service key.
- **A review's correction can be submitted correctly via the API and still have zero downstream effect** if a workflow's consuming node reads a different field than the one the reviewer's correction landed in — this is a workflow-wiring bug, not an API bug, but it looks exactly like "the API call didn't work" (§9.3).
- **Result shape varies by which Output node the run reached** — a workflow with several terminal outputs can return structurally different result payloads from run to run (§4.6).
- **Scheduled jobs use a structured schedule (`frequency`/`timeOfDay`/`dayOfWeek`/`dayOfMonth`), not a raw cron expression** (§6), contrary to older documentation's looser description.
- **`GET /api-keys/scopes` is deprecated** — get the current valid scope list from the dashboard, not the API (§8).
- **`/mcp/workflows/{id}/activate|deactivate` requires `Authorization: Bearer`, not `x-service-key`** — a headless integration cannot call these directly (§10).
- **A long `WAITING` status is normal**, not a hang — typically a human task pending response, possibly for hours (§4.5).
- **Re-initiating is not idempotent** — a network blip after `/job/initiate` should be resolved by checking the status of the `jobExecutionId` you already hold, not by blindly calling initiate again (which creates a brand-new, separate job).
- **There is no plain "list all jobs" endpoint** — use `/job/search` or `/job/search-light` with filters (§5), even to browse everything.

---

## 15. Confidence / provenance ledger

Kept explicit so this document doesn't overclaim, and so a future update knows exactly what to re-verify.

**✅ Directly verified against the live OpenAPI spec (2026-07-17 snapshot, "Opus Operator" title, 431 paths):** every exact field name, requiredness, and enum value quoted in §4–§8 and §10 for `/job/*`, `/file/internal/*`, `/api-keys`, `/mcp/workflows/*/activate|deactivate`, `/v1/web-app/*`; the `/job/v2/initiate` deprecation and its 308 redirect target; the full job-status enum including `TIMED_OUT`; the scheduled-job structured-schedule shape.

**✅ Proven empirically on a real, live job run (Munich RE integration, wf `61152903`, 2026-07-16 — also cross-confirmed against the `opus-workflow-engineer` skill's own honesty ledger):**
- The array-input `typeDefinition` camelCase requirement, and the sibling fact that sending the rich type object instead of a bare string 500s (§3.3).
- `success: true` on `/job/execute` not implying a successful run (§4.4).
- `/job/file/upload`'s presigned PUT rejecting a `Content-Type` header with 403 (§4.2).
- The full in-platform review completion sequence — `GET /review`, `POST /review/v2/{id}/pickup`, `POST /review/v2/{id}/complete` with camelCase `outputData` — including the 409-on-UI-opened and short-SLA/re-dispatch behaviors (§9.3).

**✅ Captured from real dispatch/callback payloads, per Field Guide 07:** the entire off-platform callback contract in §9.2, including retry/circuit-breaker behavior and response codes.

**⚠️ Field-guide narrative, not independently re-verified against a live call in this pass:** the exact response envelope of `GET /workflow/{id}` (§4.1) and the multipart-upload response shapes (§4.2) — the live spec does not document these response bodies at all, so the field guide's worked examples are the best available source, but they are dated 2026-06-30 and unconfirmed against the current live behavior. Also: `/file/internal/upload`'s Content-Type-set-correctly claim, now that the *other* upload endpoint has been proven to require the opposite (§4.2).

**❓ Open / unconfirmed — flagged inline above, do not treat as settled:** whether `callbackUrl` genuinely must be non-empty on `/job/execute` (§4.4); the exact payload shape Opus posts to a job-completion `callbackUrl` (§9.1); whether `execution_id` (executor domain) and `jobExecutionId` (job domain) are the same identifier (§4.7); the precise semantic difference between `workflowId` and `referenceEntityId` on `/job/initiate` beyond their bare field descriptions (§1); the true current required/optional shape of `/file/internal/multipart/complete`'s body (§4.2); the true required body of `POST /job/file/download` — `{fileUrl, workspaceId}` (proven-live) vs `{fileUrl, customExpiry}` (spec) (§7).

## Cross-references

- `Field-Guides/08-Jobs-API-and-Hooking-Up-a-UI.md` — the original narrative source for §4/§12/§13.
- `Field-Guides/07-Human-in-the-Loop-and-Off-Platform.md` — full depth on §9.2, including a reference Flask receiver implementation.
- `Field-Guides/03-Variables-Mappings-and-Data-Flow.md` — the underlying V2 type system (`allowed_types`/`type_definition`) that §3's job-payload types are drawn from.
- `Internal-Details/Backend-API/opus_operator_openapi.json` — the raw spec this document was cross-checked against; re-run the same checks against your deployment's own `/docs` before treating anything ⚠️-flagged above as settled.
- `../../04-Technical-Solutions/Opus-SDK/opus-aaico.md` — the Python SDK wrapping this entire sequence.
- `~/.claude/skills/opus-workflow-engineer/SKILL.md` (§"Jobs API — running a workflow headless") — the canonical, most-current proven RUN-path recipe this update was reconciled against; keep this document in sync with it going forward.
- Memory: `project-munich-jobs-api-blocker` — the original incident behind §3.3's, §4.2's, and §9.3's proven gotchas.
