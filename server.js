require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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
const REVIEW_OUTPUT_VARS = {
  canApprove: process.env.OPUS_REVIEW_OUTPUT_CAN_APPROVE || 'workflow_output_d43knd8rq', // True/False
  comments: process.env.OPUS_REVIEW_OUTPUT_COMMENTS || 'workflow_output_m7r06wbko', // Text
};

const FAILURE_STATUSES = ['FAILED', 'CANCELLED', 'TIMED_OUT'];

// ---------------------------------------------------------------------
// Case history (ADDED 2026-08-31)
//
// A simple local log of every case run through this app, backing the new
// Case Queue / My Cases tabs with real data instead of invented mockup
// numbers. Deliberately just a JSON file, not a database - this is a
// single small dev instance.
//
// KNOWN LIMITATION: this will NOT persist on Vercel. Serverless functions
// there don't share a writable, durable filesystem across invocations -
// this file works for local (`npm start`) use only. A real deployment
// with persistent history needs an actual database (e.g. a hosted
// Postgres/Redis) swapped in behind loadHistory()/saveHistory() below.
// ---------------------------------------------------------------------

const HISTORY_FILE = path.join(__dirname, 'data', 'case-history.json');

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveHistory(entries) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.error('case history write error', err);
  }
}

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

function addHistoryEntry(entry) {
  const entries = loadHistory();
  entries.push(entry);
  saveHistory(entries);
}

function updateHistoryEntry(jobId, updates) {
  const entries = loadHistory();
  const idx = entries.findIndex((e) => e.jobId === jobId);
  if (idx === -1) return;
  entries[idx] = { ...entries[idx], ...updates };
  saveHistory(entries);
}

app.get('/api/case-history', (req, res) => {
  const entries = loadHistory().sort(
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
    const { idDocumentFileUrl, proofOfAddressFileUrl, applicationFormJson, screeningPolicy, title } = req.body;

    if (!idDocumentFileUrl) return res.status(400).json({ error: 'ID Document file is required.' });
    if (!proofOfAddressFileUrl) return res.status(400).json({ error: 'Proof of Address file is required.' });
    if (!applicationFormJson) return res.status(400).json({ error: 'Application Form JSON is required.' });
    if (!screeningPolicy) return res.status(400).json({ error: 'Screening Policy is required.' });

    for (const [label, raw] of [
      ['Application Form JSON', applicationFormJson],
      ['Screening Policy', screeningPolicy],
    ]) {
      try {
        JSON.parse(raw);
      } catch {
        return res.status(400).json({ error: `${label} is not valid JSON.` });
      }
    }

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
      [INPUT_VARS.screeningPolicy]: { value: screeningPolicy, type: 'json_string' },
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
      addHistoryEntry({
        jobId: jobExecutionId,
        title: title || 'Banking KYC run',
        applicantName: extractApplicantName(applicationFormJson),
        submittedAt: new Date().toISOString(),
        status: 'IN_PROGRESS',
        finalDecision: null,
        routingFlag: null,
        completedAt: null,
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
        updateHistoryEntry(jobId, {
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
        updateHistoryEntry(jobId, { status, completedAt: new Date().toISOString() });
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
// UNVERIFIED AGAINST A LIVE DISPATCH as of 2026-08-27 (this sandbox has no
// network path to operator.opus.com, and the Opus node hasn't been
// switched to off-platform yet) - the exact shape of expected_output_schema
// (in particular, the "type" object to echo back per field) is inferred
// from the API reference's one worked example (a "float" field) rather
// than a real KYC dispatch. The full raw payload is logged on first
// receipt specifically so this can be corrected against reality fast if
// the shape differs. NOTE: this requires a public URL - Opus's servers
// cannot reach a local dev server, so exchange 1 only works against the
// deployed (Vercel) instance, never localhost.
// ---------------------------------------------------------------------

// jobId (== the dispatch's execution_id) -> the stored dispatch, until this
// job's review is submitted (or the process restarts - in-memory only,
// same caveat as everywhere else in this file: fine for one dev/small
// instance, would need a shared store behind multiple serverless
// instances, since a Vercel deployment doesn't guarantee the dispatch and
// the later submit hit the same warm instance).
const pendingReviewDispatches = new Map();
let currentJobId = null;

app.post('/api/opus-webhook/human-review', (req, res) => {
  const body = req.body || {};
  const { execution_id: jobId, callback, inputs, expected_output_schema: expectedOutputSchema } = body;

  console.log(`[hitl-dispatch] received for jobId=${jobId}`);
  // Full raw dump on first receipt - this is the one live look we get at
  // expected_output_schema's real shape (see UNVERIFIED note above). Keep
  // this until that's confirmed once.
  console.log('[hitl-dispatch] raw payload:', JSON.stringify(body));
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
  }

  res.status(200).json({ received: true });
});

app.get('/api/run/:id/review', (req, res) => {
  const jobId = req.params.id;
  const dispatch = pendingReviewDispatches.get(jobId);
  if (!dispatch) return res.json({ pending: false });
  res.json({
    pending: true,
    inputs: dispatch.inputs || {},
    workflowName: dispatch.workflowName || null,
  });
});

app.post('/api/run/:id/review', async (req, res) => {
  try {
    const jobId = req.params.id;
    const { canApprove, comments } = req.body;

    const dispatch = pendingReviewDispatches.get(jobId);
    if (!dispatch) {
      return res.status(400).json({ error: 'No pending review dispatch found for this job. Refresh and try again.' });
    }
    if (typeof canApprove !== 'boolean') {
      return res.status(400).json({ error: 'canApprove must be true or false.' });
    }

    const { callback, expectedOutputSchema } = dispatch;

    // Echo back whatever "type" descriptor Opus itself declared for each
    // field in expected_output_schema, rather than hardcoding one - the
    // API reference only shows one worked example (a "float" field) and
    // explicitly wraps every value as {value, type}, never bare. Falls
    // back to a sensible guess only if a field is unexpectedly absent from
    // the schema (logged loudly - that would mean our two hardcoded
    // REVIEW_OUTPUT_VARS ids no longer match this dispatch's actual schema).
    function typeFor(varId, fallback) {
      const declared = expectedOutputSchema && expectedOutputSchema[varId];
      if (declared && declared.type) return declared.type;
      console.warn(`[hitl-callback] jobId=${jobId} no schema entry for ${varId} - using fallback type`, fallback);
      return fallback;
    }

    const outputData = {
      [REVIEW_OUTPUT_VARS.canApprove]: {
        value: canApprove,
        type: typeFor(REVIEW_OUTPUT_VARS.canApprove, { type: 'bool', type_definition: null }),
      },
      [REVIEW_OUTPUT_VARS.comments]: {
        value: comments || '',
        type: typeFor(REVIEW_OUTPUT_VARS.comments, { type: 'str', type_definition: null }),
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
