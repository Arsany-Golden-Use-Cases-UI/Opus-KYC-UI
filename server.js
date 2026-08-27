require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');

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

const FAILURE_STATUSES = ['FAILED', 'CANCELLED', 'TIMED_OUT'];

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

      return res.json({ status, outputs });
    }

    if (FAILURE_STATUSES.includes(status)) {
      const auditRes = await opusFetch(`/job/${jobId}/audit`);
      const audit = await auditRes.json();

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
