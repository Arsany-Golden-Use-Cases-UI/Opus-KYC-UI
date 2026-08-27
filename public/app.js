const landingView = document.getElementById('landing-view');
const appView = document.getElementById('app-view');
const startBtn = document.getElementById('start-btn');

startBtn.addEventListener('click', () => {
  landingView.hidden = true;
  appView.hidden = false;
});

const form = document.getElementById('kyc-form');
const submitBtn = document.getElementById('submit-btn');
const formError = document.getElementById('form-error');
const statusPanel = document.getElementById('status-panel');
const statusText = document.getElementById('status-text');
const statusElapsed = document.getElementById('status-elapsed');
const statusProgress = document.getElementById('status-progress');
const statusStepsCount = document.getElementById('status-steps-count');
const progressBarFill = document.getElementById('progress-bar-fill');
const progressBarRunning = document.getElementById('progress-bar-running');
const statusStepPills = document.getElementById('status-step-pills');
const errorPanel = document.getElementById('error-panel');
const errorStatus = document.getElementById('error-status');
const errorNodes = document.getElementById('error-nodes');
const resultsPanel = document.getElementById('results-panel');
const resetBtn = document.getElementById('reset-btn');

const POLL_INTERVAL_MS = 4000;

// Extensible color-coding for Final Decision / Routing Flag values, using
// only the brand's accent colors (no red exists in the palette - pink is the
// negative/flagged accent instead). We don't yet know the full set of
// possible values, so this matches on keywords rather than exact strings -
// add rules here (checked in order, first match wins) as real values are
// confirmed. Blue is intentionally not used for status badges - the brand
// guidelines reserve it for interactive elements/links. Unmatched values
// fall back to 'neutral' (grey).
const TONE_RULES = [
  { test: /approve|pass|clear|accept/i, tone: 'green' },
  { test: /reject|declin|deny|fail/i, tone: 'pink' },
  { test: /flag|escalat|hold|pending/i, tone: 'yellow' },
  { test: /human_review|manual|review|refer/i, tone: 'neutral' },
];
const TONE_CLASSES = ['tone-green', 'tone-pink', 'tone-yellow', 'tone-blue', 'tone-neutral'];

// Job-level status is a fixed enum (not fuzzy-matched like the above).
const JOB_STATUS_TONE = {
  FAILED: 'pink',
  TIMED_OUT: 'pink',
  CANCELLED: 'neutral',
};

function toneFor(value) {
  if (!value) return 'neutral';
  const str = String(value);
  for (const rule of TONE_RULES) {
    if (rule.test.test(str)) return rule.tone;
  }
  return 'neutral';
}

function setBadgeTone(el, value) {
  el.textContent = value ?? '—';
  el.classList.remove(...TONE_CLASSES);
  el.classList.add(`tone-${toneFor(value)}`);
}

let pollTimer = null;
let elapsedTimer = null;
let pollStartTime = null;

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `Elapsed: ${minutes}m ${seconds}s`;
}

function startElapsedTimer() {
  pollStartTime = Date.now();
  statusElapsed.textContent = formatElapsed(0);
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    statusElapsed.textContent = formatElapsed(Date.now() - pollStartTime);
  }, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

// Renders live step progress from the audit data the poll response carries
// (nbNodes/executedNodes/nbExecutedNodes/runningNode/remainingNodes - see
// server.js's GET /api/run/:id, which mirrors the Opus /job/{id}/audit
// response). Falls back to hiding the progress block (leaving just the
// status text/spinner) whenever nbNodes is missing or zero, e.g. before the
// first audit call has resolved, or if it failed server-side.
function renderProgress(data) {
  const nbNodes = data.nbNodes;
  const executedNodes = data.executedNodes || [];
  const runningNode = data.runningNode || null;
  // remaining_nodes_to_execute's own documented ordering already reflects
  // what's left, so we just drop the running node out of it (some responses
  // include it there too, some don't) rather than re-deriving order.
  const remainingNodes = (data.remainingNodes || []).filter((name) => name !== runningNode);

  if (!nbNodes) {
    statusProgress.hidden = true;
    statusText.textContent = 'Processing…';
    return;
  }

  const completed = typeof data.nbExecutedNodes === 'number' ? data.nbExecutedNodes : executedNodes.length;

  statusProgress.hidden = false;
  statusText.textContent = runningNode ? `Running: ${runningNode}` : 'Processing…';
  statusStepsCount.textContent = runningNode
    ? `${completed} / ${nbNodes} steps — running: ${runningNode}`
    : `${completed} / ${nbNodes} steps`;

  // Fill reflects completed steps; the running node (if any) shows as a
  // separate lighter/pulsing segment rather than counting as done.
  const completedPct = Math.max(0, Math.min(100, (completed / nbNodes) * 100));
  const runningPct = runningNode ? Math.max(0, Math.min(100 - completedPct, (1 / nbNodes) * 100)) : 0;
  progressBarFill.style.width = `${completedPct}%`;
  progressBarRunning.style.width = `${runningPct}%`;
  progressBarRunning.hidden = !runningNode;

  statusStepPills.innerHTML = '';

  executedNodes.forEach((name) => {
    const pill = document.createElement('span');
    pill.className = 'step-pill step-pill--done';
    pill.textContent = `✓ ${name}`;
    statusStepPills.appendChild(pill);
  });

  if (runningNode) {
    const pill = document.createElement('span');
    pill.className = 'step-pill step-pill--running';
    pill.textContent = runningNode;
    statusStepPills.appendChild(pill);
  }

  remainingNodes.forEach((name) => {
    const pill = document.createElement('span');
    pill.className = 'step-pill step-pill--pending';
    pill.textContent = name;
    statusStepPills.appendChild(pill);
  });
}

function resetProgress() {
  statusProgress.hidden = true;
  statusStepPills.innerHTML = '';
  progressBarFill.style.width = '0%';
  progressBarRunning.style.width = '0%';
  progressBarRunning.hidden = true;
  statusElapsed.textContent = '';
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function clearError() {
  formError.hidden = true;
  formError.textContent = '';
}

function setBusy(isBusy) {
  submitBtn.disabled = isBusy;
  submitBtn.textContent = isBusy ? 'Running…' : 'Run KYC Workflow';
}

async function uploadFile(file, kind) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('kind', kind);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed.');
  return data.fileUrl;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const idDocumentFile = document.getElementById('id-document').files[0];
  const proofOfAddressFile = document.getElementById('proof-of-address').files[0];
  const applicationFormJson = document.getElementById('application-form-json').value.trim();
  const screeningPolicy = document.getElementById('screening-policy').value.trim();

  if (!idDocumentFile || !proofOfAddressFile) {
    showError('Please attach both the ID Document and Proof of Address files.');
    return;
  }
  if (proofOfAddressFile.type !== 'application/pdf') {
    showError('Proof of Address must be a PDF file.');
    return;
  }
  if (proofOfAddressFile.size > 10 * 1024 * 1024) {
    showError('Proof of Address must be 10MB or smaller.');
    return;
  }
  try {
    JSON.parse(applicationFormJson);
  } catch {
    showError('Application Form JSON is not valid JSON.');
    return;
  }
  try {
    JSON.parse(screeningPolicy);
  } catch {
    showError('Screening Policy is not valid JSON.');
    return;
  }

  setBusy(true);
  resultsPanel.hidden = true;
  errorPanel.hidden = true;
  statusPanel.hidden = false;
  statusText.textContent = 'Uploading documents…';
  resetProgress();

  try {
    const [idDocumentFileUrl, proofOfAddressFileUrl] = await Promise.all([
      uploadFile(idDocumentFile, 'idDocument'),
      uploadFile(proofOfAddressFile, 'proofOfAddress'),
    ]);

    statusText.textContent = 'Starting workflow…';

    const runRes = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idDocumentFileUrl, proofOfAddressFileUrl, applicationFormJson, screeningPolicy }),
    });
    const runData = await runRes.json();
    if (!runRes.ok) throw new Error(runData.error || 'Failed to start job.');

    statusText.textContent = 'Processing — this may take a few minutes…';
    pollStatus(runData.jobExecutionId);
  } catch (err) {
    setBusy(false);
    statusPanel.hidden = true;
    showError(err.message || 'Something went wrong.');
  }
});

function pollStatus(jobId) {
  startElapsedTimer();

  const poll = async () => {
    try {
      const res = await fetch(`/api/run/${jobId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to check job status.');

      if (data.status === 'COMPLETED') {
        stopPolling();
        setBusy(false);
        statusPanel.hidden = true;
        showResults(data.outputs);
      } else if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(data.status)) {
        stopPolling();
        setBusy(false);
        statusPanel.hidden = true;
        showFailure(data);
      } else {
        statusText.textContent = `Processing (${data.status})…`;
        renderProgress(data);
      }
    } catch (err) {
      stopPolling();
      setBusy(false);
      statusPanel.hidden = true;
      showError(err.message || 'Something went wrong while polling.');
    }
  };

  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopElapsedTimer();
}

function showFailure(data) {
  errorPanel.hidden = false;
  errorStatus.textContent = `Status: ${data.status}`;
  errorStatus.classList.remove(...TONE_CLASSES);
  errorStatus.classList.add(`tone-${JOB_STATUS_TONE[data.status] || 'neutral'}`);
  const nodes = data.failedNodes || [];
  errorNodes.innerHTML = nodes.length
    ? `<p>Failed node(s):</p><ul>${nodes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : '<p>No specific failed node was reported. See server logs / the audit endpoint for detail.</p>';
}

function showResults(outputs) {
  resultsPanel.hidden = false;

  setBadgeTone(document.getElementById('final-decision'), outputs.finalDecision);
  setBadgeTone(document.getElementById('routing-flag'), outputs.routingFlag);
  document.getElementById('audit-summary').textContent = outputs.auditSummary ?? '—';

  const caseFileEl = document.getElementById('case-file');
  caseFileEl.innerHTML = '';
  const caseFile = outputs.caseFile;

  if (caseFile === null || caseFile === undefined || caseFile === '') {
    caseFileEl.textContent = '—';
    return;
  }

  let parsed = null;
  if (typeof caseFile === 'object') {
    parsed = caseFile;
  } else if (typeof caseFile === 'string') {
    try {
      parsed = JSON.parse(caseFile);
    } catch {
      parsed = null;
    }
  }

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const card = buildProfileCard(parsed);
    if (card) caseFileEl.appendChild(card);

    const details = document.createElement('details');
    details.className = 'case-file-json';
    const summary = document.createElement('summary');
    summary.textContent = 'View full case file (JSON)';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(parsed, null, 2);
    details.appendChild(summary);
    details.appendChild(pre);
    caseFileEl.appendChild(details);
  } else if (parsed !== null) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'View Case File (JSON)';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(parsed, null, 2);
    details.appendChild(summary);
    details.appendChild(pre);
    caseFileEl.appendChild(details);
  } else {
    const pre = document.createElement('pre');
    pre.textContent = String(caseFile);
    caseFileEl.appendChild(pre);
  }
}

// Builds a colored "profile card" (avatar + name + subtitle + tag pills)
// out of whatever flat fields a case-file object happens to have. The API
// doesn't guarantee a schema, so this uses best-effort heuristics and
// simply returns null if nothing name-like is found, leaving the raw JSON
// view as the only output.
const NAME_KEYS = ['applicantname', 'name', 'fullname', 'subjectname', 'applicant', 'customername'];

function humanizeLabel(key) {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function initialsFor(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = words[0][0] || '';
  const second = words.length > 1 ? words[1][0] || '' : '';
  return (first + second).toUpperCase();
}

function buildProfileCard(data) {
  const entries = Object.entries(data).filter(
    ([, v]) => v !== null && v !== undefined && (typeof v !== 'object')
  );
  if (!entries.length) return null;

  const nameEntry = entries.find(([k]) => NAME_KEYS.includes(k.toLowerCase()));
  if (!nameEntry) return null;

  const name = String(nameEntry[1]);
  const rest = entries.filter(([k]) => k !== nameEntry[0]);

  const subtitleFields = rest.slice(0, 3);
  const tagFields = rest.slice(3, 7);

  const card = document.createElement('div');
  card.className = 'profile-card';

  const avatar = document.createElement('div');
  avatar.className = 'profile-card-avatar';
  avatar.textContent = initialsFor(name);
  card.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'profile-card-body';

  const nameEl = document.createElement('p');
  nameEl.className = 'profile-card-name';
  nameEl.textContent = name;
  body.appendChild(nameEl);

  if (subtitleFields.length) {
    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'profile-card-subtitle';
    subtitleEl.textContent = subtitleFields.map(([, v]) => String(v)).join(' \u00b7 ');
    body.appendChild(subtitleEl);
  }

  if (tagFields.length) {
    const tags = document.createElement('div');
    tags.className = 'profile-card-tags';
    tagFields.forEach(([k, v]) => {
      const tag = document.createElement('span');
      tag.className = 'profile-card-tag';
      tag.textContent = `${humanizeLabel(k)}: ${v}`;
      tags.appendChild(tag);
    });
    body.appendChild(tags);
  }

  card.appendChild(body);
  return card;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

resetBtn.addEventListener('click', () => {
  form.reset();
  resultsPanel.hidden = true;
  errorPanel.hidden = true;
  clearError();
});
