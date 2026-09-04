require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const OPUS_BASE_URL = process.env.OPUS_BASE_URL || 'https://operator.opus.com';
const OPUS_SERVICE_KEY = process.env.OPUS_SERVICE_KEY;
const OPUS_WORKSPACE_ID = process.env.OPUS_WORKSPACE_ID;
const OPUS_WORKFLOW_ID = process.env.OPUS_WORKFLOW_ID || '862c7f7c-302a-4e96-9985-ab8e41cd007b';

// /job/execute validates callbackUrl as an actual URL (an empty string 400s
// with "callbackUrl must be a URL address", despite the API reference
// flagging empty-string as plausibly acceptable - see README). We don't use
// the callback mechanism (we poll instead), so this just needs to pass
// validation - it's never called.
const OPUS_CALLBACK_URL = process.env.OPUS_CALLBACK_URL || 'https://example.com/opus-callback';

if (!OPUS_SERVICE_KEY) {
  console.warn('WARNING: OPUS_SERVICE_KEY is not set. Copy .env.example to .env and fill it in.');
}

// Input node variable names - fixed, from the workflow's Input node.
const INPUT_VARS = {
  idDocument: process.env.OPUS_INPUT_ID_DOCUMENT || 'workflow_input_6o3r11awf',
  proofOfAddress: process.env.OPUS_INPUT_PROOF_OF_ADDRESS || 'workflow_input_efxj86krs',
  applicationFormJson: process.env.OPUS_INPUT_APPLICATION_FORM_JSON || 'workflow_input_izxwtowwa',
  screeningPolicy: process.env.OPUS_INPUT_SCREENING_POLICY || 'workflow_input_x9wtpmxp3',
};

// Output node variable IDs - fixed, from the workflow's Output node.
const OUTPUT_VARS = {
  finalDecision: 'workflow_output_6i9dir9f4',
  routingFlag: 'workflow_output_ue2rxr9l2',
  auditSummary: 'workflow_output_vb2z7u2xp',
  caseFile: 'workflow_output_76olv4bsy',
};

// "KYC Human Review" node's two declared outputs - read off the workflow
// builder canvas directly, not discoverable through GET /workflow/{id} in
// a way that's tied to this specific review step. These IDs have already
// changed three times in one day (2026-08-31): once switching the node to
// off-platform, again after updating the node's webhook URL to add the
// Vercel protection-bypass query param, and now a third time after the
// node was recreated with a clean webhook URL (no query string this time)
// - Opus appears to regenerate output IDs whenever this node's config is
// edited, not just on platform-mode changes. If reviews start failing
// again with the outputs coming back null, re-check these against the
// node's Outputs tab before assuming the bug is elsewhere. These are the
// output_data keys the off-platform callback (API reference section 9.2)
// expects on the POST to callback.url.
//
// BOTH IDS CONFIRMED STILL CORRECT 2026-09-02 against a live dispatch's
// expected_output_schema, which declared exactly these two keys (as
// display_name "Can Approve ?" and "comments" respectively).
const REVIEW_OUTPUT_VARS = {
  canApprove: process.env.OPUS_REVIEW_OUTPUT_CAN_APPROVE || 'workflow_output_d43knd8rq', // True/False
  comments: process.env.OPUS_REVIEW_OUTPUT_COMMENTS || 'workflow_output_m7r06wbko', // Text
};

const FAILURE_STATUSES = ['FAILED', 'CANCELLED', 'TIMED_OUT'];

// ---------------------------------------------------------------------
// Case history (ADDED 2026-08-31, moved to Upstash Redis 2026-09-02)
//
// A simple log of every case run through this app, backing the Case
// Queue tab with real data instead of invented mockup numbers.
// Originally a local JSON file, which didn't work on Vercel -
// serverless functions there don't share a writable, durable filesystem
// across invocations, so writes from one request were invisible to the
// next. Now backed by Upstash Redis (via Vercel's KV integration) so
// every invocation reads/writes the same store regardless of which
// instance handles the request.
// ---------------------------------------------------------------------

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const HISTORY_KEY = 'case-history';

async function loadHistory() {
  try {
    const raw = await redis.get(HISTORY_KEY);
    if (!raw) return [];
    // @upstash/redis auto-deserializes JSON-looking string values on get(),
    // so `raw` normally already comes back as a parsed array - but guard
    // for a plain string too (e.g. an older/different client behavior)
    // rather than assuming one shape and crashing on the other.
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('case history read error', err);
    return [];
  }
}

async function saveHistory(entries) {
  try {
    await redis.set(HISTORY_KEY, JSON.stringify(entries));
  } catch (err) {
    console.error('case history write error', err);
  }
}

// ---------------------------------------------------------------------
// Screening policy (ADDED 2026-09-04)
//
// One saved policy document, edited in Settings and applied to every
// case - replacing what used to be a raw JSON textarea filled in per
// case on the intake form. Same Redis-backed pattern as case history
// above: its own key, the same string-or-object read guard.
//
// Seeded from default-screening-policy.json, which is not invented
// placeholder content - it's the real CBUAE framework read straight out
// of the workflow's own Input node default (GET /workflow/{id} ->
// nodes[input].input_schema.schema.workflow_input_x9wtpmxp3.default,
// captured 2026-09-04). Returned on a miss WITHOUT writing, so a read
// never mutates the store, and POST /api/run below still sends the
// correct full policy for cases submitted before anyone opens Settings.
// ---------------------------------------------------------------------

const SCREENING_POLICY_KEY = 'screening-policy';
const DEFAULT_SCREENING_POLICY = require('./default-screening-policy.json');

// updatedAt/updatedBy are an audit stamp in the same spirit as a case's
// ranBy/reviewedBy - both null while the default is still in force, since
// nobody has saved anything yet.
function defaultPolicyRecord() {
  return { policy: DEFAULT_SCREENING_POLICY, updatedAt: null, updatedBy: null };
}

async function loadScreeningPolicy() {
  try {
    const raw = await redis.get(SCREENING_POLICY_KEY);
    if (!raw) return defaultPolicyRecord();

    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || !parsed.policy) return defaultPolicyRecord();

    return {
      policy: parsed.policy,
      updatedAt: parsed.updatedAt || null,
      updatedBy: parsed.updatedBy || null,
    };
  } catch (err) {
    console.error('screening policy read error', err);
    return defaultPolicyRecord();
  }
}

// Deliberately NOT swallowing errors the way saveHistory() does above:
// that one is best-effort logging nobody is waiting on, whereas this is a
// user's explicit save, and silently losing their edits while the UI says
// "saved" would be worse than surfacing the failure.
async function saveScreeningPolicy(policy, updatedBy) {
  const record = {
    policy,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || null,
  };
  await redis.set(SCREENING_POLICY_KEY, JSON.stringify(record));
  return record;
}

app.get('/api/screening-policy', async (req, res) => {
  res.json(await loadScreeningPolicy());
});

// Like every other route here, this has no server-side role check - see
// /api/verify-role's comment on what the client-side gate does and
// doesn't protect. Settings hides the Save button from a KYC Agent, but
// that's UI intent, not enforcement.
app.put('/api/screening-policy', async (req, res) => {
  try {
    const { policy, updatedBy } = req.body || {};

    // Only checked far enough to keep reads sane. The policy's own shape
    // is deliberately not validated here - it will keep evolving, and a
    // strict validator would just become a second schema to keep in sync
    // with the editor.
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      return res.status(400).json({ error: 'policy must be an object.' });
    }

    const record = await saveScreeningPolicy(policy, updatedBy);
    res.json({ ok: true, updatedAt: record.updatedAt, updatedBy: record.updatedBy });
  } catch (err) {
    console.error('screening policy write error', err);
    res.status(500).json({ error: err.message || 'Failed to save screening policy.' });
  }
});

// Best-effort applicant name extraction from the raw Application Form JSON
// string the client sent - shape varies by test data, so this tries a few
// likely paths rather than assuming one schema, and never throws.
function extractApplicantName(applicationFormJson) {
  try {
    const parsed = JSON.parse(applicationFormJson);
    return (
      parsed?.applicant?.full_name ||
      parsed?.applicantName ||
      parsed?.full_name ||
      parsed?.applicant_name ||
      null
    );
  } catch {
    return null;
  }
}

async function addHistoryEntry(entry) {
  const entries = await loadHistory();
  entries.push(entry);
  await saveHistory(entries);
}

async function updateHistoryEntry(jobId, updates) {
  const entries = await loadHistory();
  const idx = entries.findIndex((e) => e.jobId === jobId);
  if (idx === -1) return;
  entries[idx] = { ...entries[idx], ...updates };
  await saveHistory(entries);
}

app.get('/api/case-history', async (req, res) => {
  const entries = (await loadHistory()).sort(
    (a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)
  );
  res.json({ entries });
});

// Real (non-secret) connection info for the Settings tab - never the
// service key itself, just whether one is set.
app.get('/api/config', (req, res) => {
  res.json({
    host: OPUS_BASE_URL,
    workflowId: OPUS_WORKFLOW_ID,
    serviceKeyConfigured: Boolean(OPUS_SERVICE_KEY),
  });
});

// Role gate for "who is running this case" (KYC Agent vs Compliance
// Officer) - checks a password against AGENT_PASSWORD / MANAGER_PASSWORD
// and returns ok:true/false. This only guards the frontend's own UI state
// (see public/app.js's currentRole) - it does NOT add any check to
// /api/run/:id/review itself, which still accepts a submission from
// anyone who can reach this server regardless of role. If that route ever
// needs real enforcement, it should require its own proof of the verified
// role (e.g. a signed token issued here), not just trust client-side state.
const ROLE_PASSWORDS = {
  agent: process.env.AGENT_PASSWORD,
  manager: process.env.MANAGER_PASSWORD,
};

app.post('/api/verify-role', (req, res) => {
  const { role, password } = req.body || {};
  const expected = ROLE_PASSWORDS[role];

  if (!expected || typeof password !== 'string' || password !== expected) {
    return res.status(401).json({ ok: false, error: 'Incorrect password' });
  }

  res.json({ ok: true });
});

// Thin wrapper around fetch() for calls to the Opus API: attaches auth, retries
// 429/5xx with backoff (per the API reference, section 11), and throws on other errors.
async function opusFetch(reqPath, options = {}, { retries = 3 } = {}) {
  const url = `${OPUS_BASE_URL}${reqPath}`;
  const headers = {
    'x-service-key': OPUS_SERVICE_KEY,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...options, headers });
    if (res.ok) return res;

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    const text = await res.text().catch(() => '');
    const err = new Error(`Opus API ${options.method || 'GET'} ${reqPath} failed: ${res.status} ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
}

// Debug helper - confirms declared input types (e.g. whether
// application_form_json's field expects "str" vs "object") against the live
// schema. Not used by the frontend form.
app.get('/api/schema', async (req, res) => {
  try {
    const schemaRes = await opusFetch(`/workflow/${OPUS_WORKFLOW_ID}`);
    const schema = await schemaRes.json();
    res.json(schema);
  } catch (err) {
    console.error('schema fetch error', err);
    res.status(500).json({ error: err.message || 'Failed to fetch workflow schema.' });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const kind = req.body.kind; // 'idDocument' | 'proofOfAddress'

    if (!file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    if (kind === 'proofOfAddress') {
      if (file.mimetype !== 'application/pdf') {
        return res.status(400).json({ error: 'Proof of Address must be a PDF file.' });
      }
      if (file.size > 10 * 1024 * 1024) {
        return res.status(400).json({ error: 'Proof of Address must be 10MB or smaller.' });
      }
    }

    const originalName = file.originalname || 'upload';
    const fileExtension = (path.extname(originalName).replace('.', '') || 'bin').toLowerCase();

    const presignRes = await opusFetch('/job/file/upload', {
      method: 'POST',
      body: JSON.stringify({
        fileExtension,
        originalName,
        accessScope: 'workspace',
        workspaceId: OPUS_WORKSPACE_ID,
        workflowId: OPUS_WORKFLOW_ID,
      }),
    });
    const { presignedUrl, fileUrl } = await presignRes.json();

    // Proven live (API reference section 4.2): no Content-Type header on this
    // presigned PUT - sending one, even the correct MIME type, causes a 403.
    const putRes = await fetch(presignedUrl, { method: 'PUT', body: file.buffer });
    if (!putRes.ok) {
      const text = await putRes.text().catch(() => '');
      throw new Error(`Upload to storage failed: ${putRes.status} ${text}`);
    }

    res.json({ fileUrl });
  } catch (err) {
    console.error('upload error', err);
    res.status(500).json({ error: err.message || 'Upload failed.' });
  }
});

app.post('/api/run', async (req, res) => {
  try {
    // No screeningPolicy here on purpose - it's no longer sent per case,
    // it's loaded from the saved policy below.
    const { idDocumentFileUrl, proofOfAddressFileUrl, applicationFormJson, title, ranBy } = req.body;

    if (!idDocumentFileUrl) return res.status(400).json({ error: 'ID Document file is required.' });
    if (!proofOfAddressFileUrl) return res.status(400).json({ error: 'Proof of Address file is required.' });
    if (!applicationFormJson) return res.status(400).json({ error: 'Application Form JSON is required.' });

    // Still validated server-side even though the client now builds this
    // string itself (buildApplicationFormJson() in app.js) rather than
    // accepting typed JSON - anything can POST here.
    try {
      JSON.parse(applicationFormJson);
    } catch {
      return res.status(400).json({ error: 'Application Form JSON is not valid JSON.' });
    }

    // Applied from the one saved policy rather than the request body (it
    // used to be a per-case textarea on the intake form) - see the
    // screening-policy section above. Falls back to the packaged default
    // when nothing has been saved yet, so this is never empty.
    const { policy: screeningPolicy } = await loadScreeningPolicy();

    const initRes = await opusFetch('/job/initiate', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: OPUS_WORKFLOW_ID,
        title: title || 'Banking KYC run',
      }),
    });
    const { jobExecutionId } = await initRes.json();
    currentJobId = jobExecutionId;

    // Wire format per API reference section 3: every value is {value, type},
    // type is always a bare string. Confirmed live against GET /api/schema:
    // this workflow's Input node declares Application Form JSON / Screening
    // Policy as allowed_types [{type: "json_string"}] - not "str" or "object" -
    // so the raw JSON text is sent with type "json_string".
    const jobPayloadSchemaInstance = {
      [INPUT_VARS.idDocument]: { value: idDocumentFileUrl, type: 'file' },
      [INPUT_VARS.proofOfAddress]: { value: proofOfAddressFileUrl, type: 'file' },
      [INPUT_VARS.applicationFormJson]: { value: applicationFormJson, type: 'json_string' },
      // Stored as an object, so re-serialized here - the wire value has to
      // stay a JSON string for the json_string type.
      [INPUT_VARS.screeningPolicy]: { value: JSON.stringify(screeningPolicy), type: 'json_string' },
    };

    await opusFetch('/job/execute', {
      method: 'POST',
      body: JSON.stringify({
        jobExecutionId,
        jobPayloadSchemaInstance,
        callbackUrl: OPUS_CALLBACK_URL,
      }),
    });

    // Log to case history right away (IN_PROGRESS) so it shows up in the
    // Case Queue immediately, not just once it finishes - best-effort,
    // never lets a logging problem fail the actual job start.
    try {
      await addHistoryEntry({
        jobId: jobExecutionId,
        title: title || 'Banking KYC run',
        applicantName: extractApplicantName(applicationFormJson),
        submittedAt: new Date().toISOString(),
        status: 'IN_PROGRESS',
        finalDecision: null,
        routingFlag: null,
        completedAt: null,
        // Required client-side at the role gate (public/app.js's
        // roleGateSubmitBtn handler) - null only ever appears on a case
        // run before this field existed, and the UI degrades that to the
        // same '—' placeholder every other optional field here already uses.
        ranBy: ranBy || null,
      });
    } catch (historyErr) {
      console.error('case history log error', historyErr);
    }

    // success:true here only means the request was accepted, not that the run
    // will succeed (API reference section 4.4) - the browser must poll status/audit.
    res.json({ jobExecutionId });
  } catch (err) {
    console.error('run error', err);
    res.status(500).json({ error: err.message || 'Failed to start job.' });
  }
});

app.get('/api/run/:id', async (req, res) => {
  try {
    const jobId = req.params.id;

    const statusRes = await opusFetch(`/job/${jobId}/status`);
    const { status } = await statusRes.json();

    if (status === 'COMPLETED') {
      const resultsRes = await opusFetch(`/job/${jobId}/results`);
      const { jobResultsPayloadSchema } = await resultsRes.json();

      const outputs = {};
      for (const [key, varName] of Object.entries(OUTPUT_VARS)) {
        outputs[key] = jobResultsPayloadSchema?.[varName]?.value ?? null;
      }

      try {
        await updateHistoryEntry(jobId, {
          status,
          finalDecision: outputs.finalDecision ?? null,
          routingFlag: outputs.routingFlag ?? null,
          completedAt: new Date().toISOString(),
        });
      } catch (historyErr) {
        console.error('case history update error', historyErr);
      }

      return res.json({ status, outputs });
    }

    if (FAILURE_STATUSES.includes(status)) {
      const auditRes = await opusFetch(`/job/${jobId}/audit`);
      const audit = await auditRes.json();

      try {
        await updateHistoryEntry(jobId, { status, completedAt: new Date().toISOString() });
      } catch (historyErr) {
        console.error('case history update error', historyErr);
      }

      return res.json({
        status,
        failedNodes: audit.failed_nodes || [],
        nextNodeToExecute: audit.next_node_to_execute || null,
        audit,
      });
    }

    // PENDING, IN_PROGRESS, WAITING, UNKNOWN - keep polling. Also surface
    // live step progress from the audit endpoint (API reference §4.7 - not
    // documented as failure-only: nb_nodes/executed_nodes/nb_executed_nodes
    // are populated for in-progress runs too). Best-effort: if this call
    // fails, still return the bare status like before rather than a 500.
    const progress = {};
    try {
      const auditRes = await opusFetch(`/job/${jobId}/audit`);
      const audit = await auditRes.json();
      progress.nbNodes = audit.nb_nodes;
      progress.executedNodes = audit.executed_nodes || [];
      progress.nbExecutedNodes = audit.nb_executed_nodes;
      // The node currently in flight (API reference §4.7). null while
      // between nodes / before the first one has picked up.
      progress.runningNode = audit.running_node || null;
      progress.nextNodeToExecute = audit.next_node_to_execute || null;
      progress.remainingNodes = audit.remaining_nodes_to_execute || [];
    } catch (auditErr) {
      console.error('progress audit fetch error', auditErr);
    }

    res.json({ status, ...progress });
  } catch (err) {
    console.error('poll error', err);
    res.status(500).json({ error: err.message || 'Failed to check job status.' });
  }
});

// A job's original inputs are never persisted on our side (case history
// only ever stores the summary fields shown in the queue tables) - this
// always goes straight to Opus's job-detail endpoint instead, which
// embeds the raw `input` object regardless of the job's current status
// (API reference section 4.7). Works for a case run long ago just as well
// as one still in progress, since Opus is the only place this ever lived.
//
// The `input` object's own keys are Opus's opaque Input-node variable
// names (e.g. workflow_input_6o3r11awf), not human-readable - see
// fetchInputLabels() below for where the real label comes from.
//
// CONFIRMED LIVE 2026-09-02 (this sandbox does have a network path to
// operator.opus.com after all - an earlier comment here claiming
// otherwise was stale): whether each `input` value comes back bare or
// still wrapped as {value, type} the way jobPayloadSchemaInstance sent it
// was NOT re-checked against a real job - that would mean starting a real
// job, a side-effecting action outside what this investigation called
// for. Still unwrapped defensively client-side either way (see
// unwrapReviewValue in app.js, already written to handle both shapes).
app.get('/api/run/:id/inputs', async (req, res) => {
  try {
    const jobId = req.params.id;
    const detailRes = await opusFetch(`/job/${jobId}`);
    const detail = await detailRes.json();
    res.json({ inputs: await labelInputs(detail.input || {}) });
  } catch (err) {
    console.error('case inputs fetch error', err);
    res.status(500).json({ error: err.message || 'Failed to fetch case inputs.' });
  }
});

// Wraps each raw input value as {value, type, label} - merging in
// fetchInputLabels()'s live-fetched label (undefined, i.e. omitted once
// JSON-serialized, if none is found) alongside whatever shape Opus itself
// sent the value in. Shared by GET /api/run/:id/inputs above (a job's
// original Input-node values) and GET /api/run/:id/review below (a
// pending HITL dispatch's own inputs, from a completely different node -
// see fetchInputLabels()) - both need the exact same wrap-and-merge, just
// against a different raw inputs object.
async function labelInputs(rawInputs) {
  // Best-effort - a slow/unreachable workflow-schema call should never
  // break the inputs response itself, just fall back to unlabeled
  // (renderReviewInputs() in app.js already humanizes the raw key when
  // no label is present, same as before this existed).
  let labels = {};
  try {
    labels = await fetchInputLabels();
  } catch (labelErr) {
    console.error('input label fetch error', labelErr);
  }

  const inputs = {};
  for (const [varName, entry] of Object.entries(rawInputs)) {
    const wrapped = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : { value: entry };
    inputs[varName] = { ...wrapped, label: labels[varName] };
  }
  return inputs;
}

// variable_name -> display_name, scanned across every node in the
// workflow (not just the Input node) - e.g. workflow_input_6o3r11awf ->
// "ID Document" (the Input node), or workflow_input_9556ka0z9 ->
// "Extracted Identity JSON" (the separate "KYC Human Task" node a HITL
// dispatch's inputs actually come from). Powers the labels above.
//
// CONFIRMED LIVE 2026-09-02 against this exact workflow via /api/schema:
// the API reference's documented response shape for GET
// /workflow/{workflowId} (a top-level jobPayloadSchema) is wrong for this
// workflow - already flagged in README's "Corrections to the API
// reference" (section 4.1). The real path, and where display_name/
// description actually live, is:
//   nodes[<any node id>].input_schema.schema[variable_name]
// Originally scoped to just nodes[workflow_input_node_id] (there's no
// equivalent top-level pointer to "the review node" to narrow this the
// same way) - broadened after confirming live that a HITL dispatch's
// inputs belong to a different node entirely ("KYC Human Task"), with
// variable_name values that look globally unique across the graph, so
// scanning every node's input_schema carries no realistic collision risk.
async function fetchInputLabels() {
  // Labels are a nice-to-have on top of the inputs response, not
  // load-bearing (the raw-key fallback in labelInputs()'s callers covers a
  // missing/failed call just fine) - but neither fetch() nor opusFetch's
  // own retry loop has any timeout of its own, only retries on an actual
  // 429/5xx response. A connection that just hangs (no response at all)
  // would otherwise block the whole inputs response indefinitely. Bounded
  // here so a slow/unreachable workflow-schema call degrades to "no
  // labels" within a few seconds instead of hanging the request.
  const schemaRes = await opusFetch(`/workflow/${OPUS_WORKFLOW_ID}`, { signal: AbortSignal.timeout(5000) });
  const workflow = await schemaRes.json();

  const labels = {};
  for (const node of Object.values(workflow.nodes || {})) {
    const schema = node && node.input_schema && node.input_schema.schema;
    if (!schema) continue;
    for (const [varName, def] of Object.entries(schema)) {
      if (def && def.display_name) labels[varName] = def.display_name;
    }
  }
  return labels;
}

// ---------------------------------------------------------------------
// Off-platform Human Review (API reference section 9.2)
//
// SWITCHED 2026-08-27 from the in-platform review API (section 9.3, see
// git history for that implementation). That approach required us to
// *poll and guess* which of the workspace's DISPATCHED reviews belonged to
// our job - even with a job-start lower bound, it was still fundamentally
// a best-effort match, and a submitted answer landing with no visible
// effect downstream was never fully root-caused (could have been the
// match, could have been workflow-level field wiring - see the "Downstream
// wiring gotcha" note in the API reference's own section 9.3).
//
// The off-platform mechanism sidesteps all of that: Opus itself PUSHES a
// dispatch to a webhook URL configured directly on the "KYC Human Review"
// node (in the Opus workflow builder, not here), tagged with the job's own
// execution_id - no matching/guessing needed. This is a two-exchange round
// trip:
//
//   Exchange 1 (DISPATCH, Opus -> us): POST /api/opus-webhook/human-review
//   with { execution_id, workflow_id, workflow_name, inputs,
//   callback: {url, token, token_header}, expected_output_schema }. We
//   must ack with 2xx within 15s - this is NOT the place to do anything
//   slow, just store it.
//
//   Exchange 2 (CALLBACK, us -> Opus, whenever the user submits the
//   in-app review form): POST to the exact callback.url from exchange 1
//   (never reconstructed), with header [callback.token_header]:
//   callback.token, body { output_data: {<id>: {value, type}}, status }.
//   The token is single-use - a second submission for the same dispatch
//   gets 401 from Opus.
//
// CONFIRMED AGAINST A LIVE DISPATCH 2026-09-02 (replacing an earlier
// "unverified, inferred from the API reference's one worked example" note
// here). What a real dispatch actually sends:
//
//   expected_output_schema is a FLAT map, keyed directly by output
//   variable id - no wrapping "schema" key to drill through:
//     { "workflow_output_d43knd8rq": { type: "bool", display_name:
//         "Can Approve ?", variable_name: "...", description: "...",
//         is_nullable: false }, ... }
//
//   Its per-field `type` is a BARE STRING ("bool"/"str"), which is NOT
//   the shape the callback wants back - see typeFor() in POST
//   /api/run/:id/review for the re-wrap and why.
//
//   inputs follows the same bare-string convention ({type: "str"|"file",
//   value: ...}), keyed by the human-task node's own input variable ids.
//
// NOTE: this requires a public URL - Opus's servers cannot reach a local
// dev server, so exchange 1 only works against the deployed (Vercel)
// instance, never localhost.
// ---------------------------------------------------------------------

// jobId (== the dispatch's execution_id) -> the stored dispatch, until this
// job's review is submitted (or the process restarts - in-memory only,
// same caveat as everywhere else in this file: fine for one dev/small
// instance, would need a shared store behind multiple serverless
// instances, since a Vercel deployment doesn't guarantee the dispatch and
// the later submit hit the same warm instance).
const pendingReviewDispatches = new Map();
let currentJobId = null;

app.post('/api/opus-webhook/human-review', async (req, res) => {
  const body = req.body || {};
  const { execution_id: jobId, callback, inputs, expected_output_schema: expectedOutputSchema } = body;

  console.log(`[hitl-dispatch] received for jobId=${jobId}`);
  // Was a full JSON.stringify(body) dump, kept only until
  // expected_output_schema's real shape had been seen once - now confirmed
  // (see the note above), so this logs just the parts worth watching for
  // future drift. Deliberately NOT the whole body: that wrote
  // callback.token (a single-use credential) into the logs in plaintext,
  // alongside several KB of summary prose per dispatch.
  console.log('[hitl-dispatch] expected_output_schema:', JSON.stringify(expectedOutputSchema || {}));
  console.log('[hitl-dispatch] input keys:', Object.keys(inputs || {}).join(', '));
  console.log('[hitl-dispatch] currentJobId at receipt:', currentJobId);

  if (!jobId || !callback || !callback.url || !callback.token) {
    console.error('[hitl-dispatch] malformed dispatch - missing execution_id or callback info', body);
    // Still 2xx: per the API reference, a non-2xx here triggers Opus's own
    // retry/circuit-breaker behavior, which won't fix a payload that's
    // malformed on arrival. Ack it, just don't store anything usable.
    return res.status(200).json({ received: true, warning: 'malformed dispatch, ignored' });
  }

  const dispatchRecord = {
    callback,
    inputs: inputs || {},
    expectedOutputSchema: expectedOutputSchema || {},
    workflowId: body.workflow_id,
    workflowName: body.workflow_name,
    receivedAt: Date.now(),
  };

  // Opus's dispatch execution_id is its own internal per-node execution UUID,
  // not the jobExecutionId our /job/initiate call got back and that the
  // frontend polls with. Store under both so GET /api/run/:id/review can
  // find it. Assumes one job is in flight for human review at a time
  // (true for this dev/test tool).
  pendingReviewDispatches.set(String(jobId), dispatchRecord);
  if (currentJobId) {
    pendingReviewDispatches.set(String(currentJobId), dispatchRecord);

    // Persist "awaiting review" into the Redis-backed case history (keyed
    // by jobExecutionId, i.e. currentJobId here - NOT Opus's raw
    // execution_id above, which is a different id space entirely) so the
    // Pending Reviews tab can list it. Deliberately not keyed off jobId:
    // if currentJobId isn't set yet, we have no case-history entry to
    // attach this to at all, so there's nothing correct to update.
    try {
      await updateHistoryEntry(currentJobId, { status: 'WAITING_REVIEW' });
    } catch (historyErr) {
      console.error('case history update error (webhook)', historyErr);
    }
  }

  res.status(200).json({ received: true });
});

app.get('/api/run/:id/review', async (req, res) => {
  const jobId = req.params.id;
  const dispatch = pendingReviewDispatches.get(jobId);
  if (!dispatch) return res.json({ pending: false });
  res.json({
    pending: true,
    // dispatch.inputs is keyed by the "KYC Human Task" node's own
    // variable names, not the workflow's Input node - see
    // fetchInputLabels()'s comment for how labelInputs() still finds
    // their real display_name (workflow-wide scan, not Input-node-only).
    inputs: await labelInputs(dispatch.inputs || {}),
    workflowName: dispatch.workflowName || null,
  });
});

app.post('/api/run/:id/review', async (req, res) => {
  try {
    const jobId = req.params.id;
    const { canApprove, comments, reviewedBy } = req.body;

    const dispatch = pendingReviewDispatches.get(jobId);
    if (!dispatch) {
      return res.status(400).json({ error: 'No pending review dispatch found for this job. Refresh and try again.' });
    }
    if (typeof canApprove !== 'boolean') {
      return res.status(400).json({ error: 'canApprove must be true or false.' });
    }

    const { callback, expectedOutputSchema } = dispatch;

    // Takes the type NAME the dispatch declared for each field and wraps it
    // in the nested form the callback body needs. The two are deliberately
    // different shapes, CONFIRMED LIVE 2026-09-02 from a real dispatch:
    //
    //   dispatch expected_output_schema[varId].type  ->  "bool" (bare string)
    //   callback output_data[varId].type             ->  {type: "bool", type_definition: null}
    //
    // API reference section 3.4 is emphatic that the off-platform callback
    // uses the nested object convention and that carrying the bare-string
    // convention over from /job/execute is a real, separately-proven
    // failure - so the declared name is re-wrapped here rather than echoed
    // straight through. An already-nested value (should Opus ever go back
    // to sending one) passes through untouched. Falls back to a sensible
    // guess only if a field is missing from the schema entirely - logged
    // loudly, since that would mean our two hardcoded REVIEW_OUTPUT_VARS
    // ids no longer match this dispatch's actual schema.
    function typeFor(varId, fallbackTypeName) {
      const declared = expectedOutputSchema && expectedOutputSchema[varId];
      const declaredType = declared && declared.type;

      if (declaredType && typeof declaredType === 'object') return declaredType;
      if (typeof declaredType === 'string' && declaredType) {
        return { type: declaredType, type_definition: null };
      }

      console.warn(`[hitl-callback] jobId=${jobId} no schema entry for ${varId} - using fallback type`, fallbackTypeName);
      return { type: fallbackTypeName, type_definition: null };
    }

    const outputData = {
      [REVIEW_OUTPUT_VARS.canApprove]: {
        value: canApprove,
        type: typeFor(REVIEW_OUTPUT_VARS.canApprove, 'bool'),
      },
      [REVIEW_OUTPUT_VARS.comments]: {
        value: comments || '',
        type: typeFor(REVIEW_OUTPUT_VARS.comments, 'str'),
      },
    };

    const tokenHeader = callback.token_header || 'X-Opus-Callback-Token';

    // The token is single-use and this is a genuine external URL (not our
    // own OPUS_BASE_URL), so this deliberately bypasses opusFetch (which
    // is hardcoded to OPUS_BASE_URL + our service key) and calls
    // callback.url directly, exactly as given.
    const callbackRes = await fetch(callback.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [tokenHeader]: callback.token,
      },
      body: JSON.stringify({ output_data: outputData, status: 'success' }),
    });

    if (!callbackRes.ok) {
      const errText = await callbackRes.text().catch(() => '');
      throw new Error(`Opus callback failed: ${callbackRes.status} ${errText}`);
    }

    pendingReviewDispatches.delete(jobId);

    // Clear the awaiting-review state back to a normal in-progress status
    // now that a decision has been submitted, so the case drops off the
    // Pending Reviews list. jobId here is req.params.id, which the
    // frontend always populates from the same jobExecutionId it polls
    // with - the correct case-history key, unlike the dispatch's own
    // execution_id (see the webhook handler above).
    try {
      // Required client-side at the role gate, same as ranBy above - null
      // only on a review submitted before this field existed.
      await updateHistoryEntry(jobId, { status: 'IN_PROGRESS', reviewedBy: reviewedBy || null });
    } catch (historyErr) {
      console.error('case history update error (review submit)', historyErr);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('review complete error', err);
    res.status(500).json({ error: err.message || 'Failed to submit review.' });
  }
});

const PORT = process.env.PORT || 3000;

// Only bind a port when run directly (`node server.js` / `npm start`).
// When required as a module (e.g. by api/index.js on Vercel), just export
// the app - the serverless runtime handles the request lifecycle itself.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
