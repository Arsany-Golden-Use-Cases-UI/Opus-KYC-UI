# Opus Banking KYC — UI

A simple web UI to trigger the Opus **Banking — KYC** workflow
(`862c7f7c-302a-4e96-9985-ab8e41cd007b`), following the wire format and run
sequence documented in `Opus-External-Integration-API-Reference.md`.

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Copy the env template and fill in your real values — **never** commit `.env`:

   ```
   copy .env.example .env
   ```

   Edit `.env`:

   - `OPUS_SERVICE_KEY` — your Opus service key (create one via `POST /api-keys`
     in the Opus dashboard). Server-side only, never sent to the browser.
   - `OPUS_BASE_URL` — your Opus environment's base URL.
   - `OPUS_WORKSPACE_ID` — the workspace uploaded files should belong to.
   - `OPUS_WORKFLOW_ID` — defaults to the Banking KYC workflow ID above;
     only override if you're pointing this at a different workflow.
   - `OPUS_CALLBACK_URL` — defaults to a placeholder URL. We poll for status
     rather than using the callback mechanism, so this is never actually
     called — it only needs to pass Opus's URL validation (see "Corrections
     to the API reference" below).

3. The Input node's variable names and types are confirmed live (via
   `GET /api/schema`, see "Corrections to the API reference" below) and baked
   into `server.js`:

   | Field | Variable name | Wire type |
   |---|---|---|
   | ID Document | `workflow_input_6o3r11awf` | `file` |
   | Proof of Address | `workflow_input_efxj86krs` | `file` |
   | Application Form JSON | `workflow_input_izxwtowwa` | `json_string` |
   | Screening Policy | `workflow_input_x9wtpmxp3` | `json_string` |

   No further action needed here — only relevant if the workflow's Input node
   changes shape later.

4. Run the server:

   ```
   npm start
   ```

   Then open http://localhost:3000

## How it works

- The Opus service key lives only on the server (`server.js`), read from
  `process.env.OPUS_SERVICE_KEY`. It is never sent to the browser or hardcoded.
- `POST /api/upload` — presigns and uploads a file via Opus's `/job/file/upload`
  flow, returns the resulting `fileUrl`. Enforces PDF + 10MB for Proof of Address.
- `POST /api/run` — calls `/job/initiate` then `/job/execute` with the four
  inputs wrapped in the `{value, type}` wire format.
- `GET /api/run/:id` — polls `/job/{id}/status`; on `COMPLETED` also calls
  `/job/{id}/results` and unwraps the four output fields; on
  `FAILED`/`CANCELLED`/`TIMED_OUT` calls `/job/{id}/audit` and returns the
  failed node names.
- `GET /api/schema` — debug helper, proxies `GET /workflow/{workflowId}` so you
  can inspect the real Input/Output node variable names and declared types if
  the workflow ever changes.

The frontend (`public/index.html` + `public/app.js`) uploads both files, then
calls `/api/run`, then polls `/api/run/:id` every 4 seconds until the job
reaches a terminal state. Final Decision, Routing Flag, Audit Summary, and
Case File are displayed as plain labeled text/blocks — no color-coding or
icons yet, since the possible values aren't confirmed. Case File is
pretty-printed in a collapsible section if it parses as JSON, otherwise shown
as plain text.

## Deploying to Vercel

`server.js` exports the Express `app` (it only calls `app.listen()` when run
directly, via `require.main === module`), and `api/index.js` re-exports it as
a single serverless function. `vercel.json` rewrites every `/api/(.*)`
request to that function; everything under `public/` is served by Vercel's
normal static file handling, unchanged.

1. Import the repo into Vercel (or run `vercel` from the project root).
2. Set these environment variables in the Vercel project's Settings →
   Environment Variables — nothing is read from `.env` in production, only
   `process.env`:

   | Variable | Required | Notes |
   |---|---|---|
   | `OPUS_SERVICE_KEY` | Yes | Real Opus service key. Never commit this. |
   | `OPUS_WORKSPACE_ID` | Yes | Workspace uploaded files belong to. |
   | `OPUS_WORKFLOW_ID` | No | Defaults to the Banking KYC workflow ID. |
   | `OPUS_BASE_URL` | No | Defaults to `https://operator.opus.com`. |
   | `OPUS_CALLBACK_URL` | No | Defaults to a placeholder URL (see below). |
   | `OPUS_INPUT_ID_DOCUMENT` | No | Override only if the Input node's variable name changes. |
   | `OPUS_INPUT_PROOF_OF_ADDRESS` | No | Same. |
   | `OPUS_INPUT_APPLICATION_FORM_JSON` | No | Same. |
   | `OPUS_INPUT_SCREENING_POLICY` | No | Same. |

3. Deploy. No build step is required.

## Corrections to the API reference

- **§4.4 / §14 — `callbackUrl` does not accept an empty string.** The API
  reference flags this as an open question ("send an empty string... and
  confirm with one real call"). Tested live against this workflow: `""`
  fails with `400 {"message":["callbackUrl must be a URL address"]}`. It
  must be a syntactically valid URL — a placeholder that's never actually
  hit works fine, since we poll `/job/{id}/status` rather than relying on
  the callback. Configured via `OPUS_CALLBACK_URL` (default
  `https://example.com/opus-callback`).

- **§3.2 — the type vocabulary table is incomplete: `"json_string"` also
  exists and is distinct from `"str"`.** `GET /workflow/{workflowId}`
  (via `/api/schema`) shows this workflow's Application Form JSON and
  Screening Policy inputs declared with `"allowed_types": [{"type":
  "json_string"}]`, not `"str"` or `"object"`. Sending `type: "str"` for a
  `json_string`-typed input is a real, proven failure mode distinct from the
  ones §3.3/§14 already document (array `typeDefinition`, snake_case
  `type_definition`, rich-object `type`): the Input node fails in ~16ms with
  no error text and cascades `FAILED` to every downstream node — confirmed
  by pulling `GET /job/{id}/audit`'s full `nodes_execution_data` for a failed
  run (`jobExecutionId: 72964`, 2026-08-26), which shows the Input node's
  `execution_input` recorded exactly `{"type": "str", ...}` for both fields
  moments before failing. The value itself (a JSON-formatted string) is
  unchanged — only the `type` string differs from `"str"`. `type_definition`
  is `null` and not enforced for `json_string`, so no `typeDefinition`
  sibling is needed (unlike the array case in §3.3).

- **§4.1 — `GET /workflow/{workflowId}` does not return a top-level
  `jobPayloadSchema` field.** The reference flags this response shape as
  unconfirmed. Live: it returns the full V2 workflow graph (`nodes`, `edges`,
  etc., no `jobPayloadSchema` key at all). Each input variable's definition
  lives at `nodes[workflow_input_node_id].input_schema.schema[variable_name]`,
  keyed by the workflow's `workflow_input_node_id` field — `type` is nested
  under `allowed_types[0].type`, not a bare `type` field.

## Next steps

- Once you share real output values / UI reference screenshots, styling
  (colors, badges, icons) can be layered onto `public/styles.css` and
  `public/app.js`'s `showResults()` without touching the backend.
