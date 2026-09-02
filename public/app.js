const landingView = document.getElementById('landing-view');
const appView = document.getElementById('app-view');
const startBtn = document.getElementById('start-btn');

startBtn.addEventListener('click', () => {
  landingView.hidden = true;
  appView.hidden = false;
});

// ============================================================
// Role gate: who is running this case? (KYC Agent / Compliance Officer)
// ============================================================
// currentRole persists only for this page's JS session (a plain variable,
// not sessionStorage/localStorage) - it resets to null on every reload,
// including the same-tab-refresh resume path further down. See
// server.js's /api/verify-role comment: this is a client-side UI gate
// only, not real access control on the routes it's meant to protect.
let currentRole = null;
let roleGateOnVerified = null;
let pendingRoleChoice = null; // 'agent' | 'manager', chosen but not yet verified

const roleGateOverlay = document.getElementById('role-gate');
const roleChoiceAgentBtn = document.getElementById('role-choice-agent');
const roleChoiceManagerBtn = document.getElementById('role-choice-manager');
const roleGatePasswordStep = document.getElementById('role-gate-password-step');
const roleGatePasswordInput = document.getElementById('role-gate-password');
const roleGateError = document.getElementById('role-gate-error');
const roleGateSubmitBtn = document.getElementById('role-gate-submit-btn');

// Opens the role gate overlay at the role-choice step. onVerified runs once,
// right after a correct password closes the gate - callers decide what
// "proceed" means (start the run that was pending, or nothing at all when
// reached via "Back to role selection").
function openRoleGate(onVerified) {
  roleGateOnVerified = onVerified || null;
  pendingRoleChoice = null;
  roleChoiceAgentBtn.classList.remove('role-choice-btn--active');
  roleChoiceManagerBtn.classList.remove('role-choice-btn--active');
  roleGatePasswordStep.hidden = true;
  roleGatePasswordInput.value = '';
  roleGateError.hidden = true;
  roleGateError.textContent = '';
  roleGateSubmitBtn.disabled = false;
  roleGateSubmitBtn.textContent = 'Continue';
  roleGateOverlay.hidden = false;
}

function closeRoleGate() {
  roleGateOverlay.hidden = true;
  pendingRoleChoice = null;
}

// Shared handler for both role buttons, which stay visible/clickable the
// whole time (no more separate "choose again" step) - picking a role
// reveals the password step if it wasn't already showing, and picking the
// OTHER role while it's already showing just re-targets the selection:
// re-highlights the clicked button and clears any typed password/error
// left over from the previous choice.
function chooseRole(role) {
  pendingRoleChoice = role;
  roleChoiceAgentBtn.classList.toggle('role-choice-btn--active', role === 'agent');
  roleChoiceManagerBtn.classList.toggle('role-choice-btn--active', role === 'manager');
  roleGatePasswordStep.hidden = false;
  roleGateError.hidden = true;
  roleGateError.textContent = '';
  roleGatePasswordInput.value = '';
  roleGatePasswordInput.focus();
}

roleChoiceAgentBtn.addEventListener('click', () => chooseRole('agent'));
roleChoiceManagerBtn.addEventListener('click', () => chooseRole('manager'));

roleGatePasswordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    roleGateSubmitBtn.click();
  }
});

roleGateSubmitBtn.addEventListener('click', async () => {
  if (!pendingRoleChoice) return;
  roleGateError.hidden = true;
  roleGateSubmitBtn.disabled = true;
  roleGateSubmitBtn.textContent = 'Checking…';

  try {
    const res = await fetch('/api/verify-role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: pendingRoleChoice, password: roleGatePasswordInput.value }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      currentRole = pendingRoleChoice;
      applyRoleRestrictions();
      const onVerified = roleGateOnVerified;
      closeRoleGate();
      onVerified?.();
    } else {
      roleGateError.textContent = 'Incorrect password, try again.';
      roleGateError.hidden = false;
      roleGateSubmitBtn.disabled = false;
      roleGateSubmitBtn.textContent = 'Continue';
    }
  } catch (err) {
    roleGateError.textContent = 'Something went wrong checking the password.';
    roleGateError.hidden = false;
    roleGateSubmitBtn.disabled = false;
    roleGateSubmitBtn.textContent = 'Continue';
  }
});

// Open the role gate immediately on page load - it's the first thing a
// visitor sees, before the intake form (hidden by default in the markup -
// see #intake-form-card) is ever revealed. revealIntakeForm is a plain
// function declaration further down, safe to reference here since it's
// hoisted and won't actually run until the user submits a correct
// password, well after this whole script has finished its initial pass.
openRoleGate(revealIntakeForm);

// ============================================================
// Tab shell: sidebar navigation between the app's views.
// ============================================================
const navItems = Array.from(document.querySelectorAll('.nav-item'));
const viewPanels = Array.from(document.querySelectorAll('[data-view-panel]'));
const headerViewTitle = document.getElementById('header-view-title');

const VIEW_TITLES = {
  queue: 'Case Queue',
  intake: 'New Intake',
  mycases: 'My Cases',
  pending: 'Pending Reviews',
  sanctions: 'Sanctions Alerts',
  reports: 'Reports',
  settings: 'Settings',
  // No sidebar nav item of its own - see the [data-view-panel="review"]
  // comment in index.html for how this view is actually reached.
  review: 'Human Review',
};

// Each tab's data is fetched/rendered once, the first time it's opened,
// rather than on every visit - the underlying data (real history or
// static mock data) doesn't change within a single page load.
const viewLoaded = {};

// data-roles is a comma-separated list of roles allowed to see a given nav
// item (e.g. "agent,manager" or "manager") - see applyRoleRestrictions()
// further down. No data-roles attribute at all means "visible to
// everyone" (defensive default, not currently used by any real item).
// currentRole being unset (null, e.g. before the role gate has been
// passed) fails closed - nothing is "allowed" until a real role is set.
function isRoleAllowed(navItemEl) {
  const rolesAttr = navItemEl.dataset.roles;
  if (!rolesAttr) return true;
  const allowed = rolesAttr.split(',').map((r) => r.trim()).filter(Boolean);
  return Boolean(currentRole) && allowed.includes(currentRole);
}

function switchToView(viewName) {
  if (!VIEW_TITLES[viewName]) return;

  // Safety net (see applyRoleRestrictions()): refuse to activate a panel
  // the current role can't see, even if something other than a sidebar
  // click calls this directly. Redirect to Case Queue instead, since
  // every role that can pass the role gate can see it - but guard the
  // redirect itself against the same check failing (e.g. currentRole not
  // set yet at all), which would otherwise recurse forever.
  const targetBtn = navItems.find((btn) => btn.dataset.view === viewName);
  if (targetBtn && !isRoleAllowed(targetBtn)) {
    const fallbackBtn = navItems.find((btn) => btn.dataset.view === 'queue');
    if (viewName !== 'queue' && fallbackBtn && isRoleAllowed(fallbackBtn)) {
      switchToView('queue');
    }
    return;
  }

  navItems.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  viewPanels.forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== viewName;
  });
  headerViewTitle.textContent = VIEW_TITLES[viewName];

  if (!viewLoaded[viewName]) {
    viewLoaded[viewName] = true;
    loadViewData(viewName);
  }
}

// Central place role-dependent sidebar visibility is (re-)applied - called
// right after currentRole changes (role verified, or reset in
// backToRoleSelection()) so nothing is ever left stuck showing/hidden from
// a previous role.
function applyRoleRestrictions() {
  navItems.forEach((btn) => {
    btn.hidden = !isRoleAllowed(btn);
  });

  // Checked against the actual visible panel (not which nav-item carries
  // .active) because the standalone "review" panel has no nav item of its
  // own - relying on nav-item state would miss it entirely and leave it
  // sitting there as the active view after a role switch. Covers two
  // cases: a manager-only tab (e.g. Sanctions Alerts) left active by a
  // Compliance Officer who then switches to KYC Agent, and the "review"
  // panel itself, which should never stay active across a role change
  // regardless of role.
  const activePanel = viewPanels.find((panel) => !panel.hidden);
  const activeBtn = activePanel && navItems.find((btn) => btn.dataset.view === activePanel.dataset.viewPanel);
  if (!activeBtn || !isRoleAllowed(activeBtn)) {
    switchToView('queue');
  }
}

function loadViewData(viewName) {
  if (viewName === 'queue') {
    renderCaseTable('queue-table-wrap', 'queue-stats');
  } else if (viewName === 'mycases') {
    renderCaseTable('mycases-table-wrap', null);
  } else if (viewName === 'sanctions') {
    renderSanctionsTable();
  } else if (viewName === 'reports') {
    renderReports();
  } else if (viewName === 'settings') {
    renderSettings();
  } else if (viewName === 'pending') {
    renderPendingReviews();
  }
}

navItems.forEach((btn) => {
  btn.addEventListener('click', () => switchToView(btn.dataset.view));
});

const intakeFormCard = document.getElementById('intake-form-card');

// Revealed only once a role is verified - see the openRoleGate() calls at
// load time and in backToRoleSelection() below.
function revealIntakeForm() {
  intakeFormCard.hidden = false;
  backToRoleBtn.hidden = false;
}

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
const reviewPanel = document.getElementById('review-panel');
const reviewReadonlyPanel = document.getElementById('review-readonly-panel');
const reviewApproveBtn = document.getElementById('review-approve-btn');
const reviewRejectBtn = document.getElementById('review-reject-btn');
const reviewComments = document.getElementById('review-comments');
const reviewError = document.getElementById('review-error');
const reviewSubmitBtn = document.getElementById('review-submit-btn');
const errorPanel = document.getElementById('error-panel');
const errorStatus = document.getElementById('error-status');
const errorNodes = document.getElementById('error-nodes');
const resultsPanel = document.getElementById('results-panel');
const resetBtn = document.getElementById('reset-btn');
// Single shared button in the header (see index.html) replacing what used
// to be three separately-wired copies (intake form, status panel, results
// panel) - its visibility now just tracks intakeFormCard's, toggled
// alongside it in revealIntakeForm()/backToRoleSelection() below.
const backToRoleBtn = document.getElementById('back-to-role-btn');

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
  WAITING_REVIEW: 'yellow',
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

  const runArgs = { idDocumentFile, proofOfAddressFile, applicationFormJson, screeningPolicy };

  // No role check here anymore - the role gate now runs at page load
  // (before the intake form is even revealed), so by the time this button
  // is visible/clickable, currentRole is already verified.
  startRun(runArgs);
});

// The upload+run flow itself - unchanged from before role gating was added,
// just extracted into its own function so it can run either immediately
// (role already verified this session) or as the openRoleGate() callback
// once a password is confirmed.
async function startRun({ idDocumentFile, proofOfAddressFile, applicationFormJson, screeningPolicy }) {
  setBusy(true);
  resultsPanel.hidden = true;
  errorPanel.hidden = true;
  statusPanel.hidden = false;
  statusText.textContent = 'Uploading documents…';
  resetProgress();
  resetReview();

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
    setJobIdInUrl(runData.jobExecutionId);
    pollStatus(runData.jobExecutionId);
  } catch (err) {
    setBusy(false);
    statusPanel.hidden = true;
    showError(err.message || 'Something went wrong.');
  }
}

// ---------------------------------------------------------------------
// In-platform Human Review (see server.js's GET/POST /api/run/:id/review
// for the actual Opus API calls - this is just the UI side: show the form
// once a review is picked up, submit it, then resume the normal poll).
// ---------------------------------------------------------------------

let currentReviewJobId = null;
let currentReviewId = null;
let reviewCanApprove = null; // true | false | null (not yet chosen)
let reviewCheckInFlight = false;

function setReviewChoice(value) {
  reviewCanApprove = value;
  reviewApproveBtn.classList.toggle('review-toggle-btn--active-approve', value === true);
  reviewRejectBtn.classList.toggle('review-toggle-btn--active-reject', value === false);
}

reviewApproveBtn.addEventListener('click', () => setReviewChoice(true));
reviewRejectBtn.addEventListener('click', () => setReviewChoice(false));

function resetReview() {
  reviewPanel.hidden = true;
  reviewReadonlyPanel.hidden = true;
  reviewError.hidden = true;
  reviewError.textContent = '';
  reviewComments.value = '';
  reviewSubmitBtn.disabled = false;
  reviewSubmitBtn.textContent = 'Continue';
  currentReviewJobId = null;
  currentReviewId = null;
  setReviewChoice(null);
  const inputsContainer = document.getElementById('review-inputs');
  if (inputsContainer) inputsContainer.innerHTML = '';
}

// Called on every in-progress poll tick once the audit data shows the
// workflow sitting at the "KYC Human Review" node - see the runningNode
// check in pollStatus() below. Best-effort: a "not pending yet" response
// just means keep waiting for the next regular poll tick, same cadence
// the API reference recommends for this step (~4s, which matches
// POLL_INTERVAL_MS already).
// The dispatch's "inputs" carry whatever the workflow feeds into this
// review step (shape/keys not yet fully proven live - see server.js's
// [hitl-dispatch] log comment). Handles Opus's common {value, ...}
// wrapper if present, falls back to showing the raw value otherwise, and
// always includes an expandable raw-JSON view underneath so nothing the
// reviewer might need is ever hidden by a rendering guess gone wrong.
function unwrapReviewValue(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) return v.value;
  return v;
}

function renderReviewInputs(inputs) {
  const container = document.getElementById('review-inputs');
  if (!container) return;
  container.innerHTML = '';

  const entries = Object.entries(inputs || {});
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-row';
    const label = document.createElement('div');
    label.className = 'settings-row-value';
    label.textContent = 'No case context was included with this review.';
    empty.appendChild(label);
    container.appendChild(empty);
    return;
  }

  entries.forEach(([key, rawValue]) => {
    const value = unwrapReviewValue(rawValue);
    const row = document.createElement('div');
    row.className = 'settings-row';

    const label = document.createElement('div');
    label.className = 'settings-row-label';
    // Strip Opus's workflow_input_/workflow_output_ id prefix before
    // humanizing - what's left is sometimes still an opaque id fragment
    // rather than a real label, but that's still more scannable than the
    // full prefixed id, and the raw-JSON view below has the ground truth.
    label.textContent = humanizeLabel(key.replace(/^workflow_(input|output)_/, ''));

    const valueEl = document.createElement('div');
    valueEl.className = 'settings-row-value';
    if (value !== null && typeof value === 'object') {
      valueEl.textContent = JSON.stringify(value);
    } else {
      valueEl.textContent = value === null || value === undefined || value === '' ? '\u2014' : String(value);
    }

    row.appendChild(label);
    row.appendChild(valueEl);
    container.appendChild(row);
  });

  const details = document.createElement('details');
  details.className = 'case-file-json';
  const summary = document.createElement('summary');
  summary.textContent = 'View raw review inputs (JSON)';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(inputs, null, 2);
  details.appendChild(summary);
  details.appendChild(pre);
  container.appendChild(details);
}

// Fetches GET /api/run/:id/review for a specific jobId and, if a review is
// actually pending, renders it into the interactive card and switches to
// the standalone "review" view so it's actually visible regardless of
// whichever tab was showing before. Works independent of any active poll
// loop - used both by maybeCheckForReview() below (while polling a job
// this tab started/resumed) and by openPendingReview() (clicking a card
// on the Pending Reviews tab, where there's no poll loop for that job at
// all). Always shows the interactive card unconditionally - callers are
// responsible for only calling this when currentRole === 'manager'
// (maybeCheckForReview does; openPendingReview's caller can only be a
// manager in the first place, since Pending Reviews is data-roles="manager"
// only). Returns true if a review was actually shown, false if nothing is
// pending for this job right now.
async function loadAndShowReview(jobId) {
  const res = await fetch(`/api/run/${jobId}/review`);
  const data = await res.json();
  // SWITCHED 2026-08-27 to the off-platform webhook mechanism (server.js
  // has the full story) - there's no separate reviewId anymore, Opus's
  // dispatch is keyed by jobId directly, so `pending` alone is the signal.
  if (!data.pending) return false;

  currentReviewJobId = jobId;
  renderReviewInputs(data.inputs || {});
  reviewPanel.hidden = false;
  switchToView('review');
  return true;
}

async function maybeCheckForReview(jobId) {
  if (reviewCheckInFlight || !reviewPanel.hidden || !reviewReadonlyPanel.hidden) return;
  reviewCheckInFlight = true;
  try {
    // Only a verified Compliance Officer sees the interactive Approve/
    // Reject card - anyone else (KYC Agent, or no role set, e.g. after a
    // same-tab refresh resets currentRole) gets a read-only notice
    // instead. This is a client-side-only check - see server.js's
    // /api/verify-role comment on what it doesn't protect.
    if (currentRole === 'manager') {
      await loadAndShowReview(jobId);
    } else {
      const res = await fetch(`/api/run/${jobId}/review`);
      const data = await res.json();
      if (data.pending) {
        currentReviewJobId = jobId;
        reviewReadonlyPanel.hidden = false;
      }
    }
  } catch (err) {
    // Swallow - this is a best-effort check layered on top of the main
    // status poll, which will just try again next tick.
    console.error('review check error', err);
  } finally {
    reviewCheckInFlight = false;
  }
}

reviewSubmitBtn.addEventListener('click', async () => {
  if (reviewCanApprove === null) {
    reviewError.textContent = 'Choose Approve or Reject before continuing.';
    reviewError.hidden = false;
    return;
  }
  reviewError.hidden = true;
  reviewSubmitBtn.disabled = true;
  reviewSubmitBtn.textContent = 'Submitting…';

  try {
    const res = await fetch(`/api/run/${currentReviewJobId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canApprove: reviewCanApprove, comments: reviewComments.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to submit review.');

    resetReview();
    if (pollTimer) {
      // Reached via the normal in-progress flow - the main poll loop
      // (started by the original pollStatus() call) never stopped while
      // the review panel was up, and it'll pick up progress past this
      // node on its own next tick, no need to restart it here.
      switchToView('intake');
      statusText.textContent = 'Review submitted — resuming workflow…';
    } else {
      // Reached via the Pending Reviews tab - there's no poll loop for
      // this job in this tab (it may belong to a case someone else
      // started, or one this tab never polled). Just go back to the
      // list, where it'll no longer appear now that its status has been
      // cleared server-side.
      switchToView('pending');
      renderPendingReviews();
    }
  } catch (err) {
    reviewError.textContent = err.message || 'Something went wrong submitting the review.';
    reviewError.hidden = false;
    reviewSubmitBtn.disabled = false;
    reviewSubmitBtn.textContent = 'Continue';
  }
});

function pollStatus(jobId) {
  startElapsedTimer();

  // A single transient error (e.g. Opus's 50 req/min rate limit tripping
  // for one tick) used to kill the whole poll loop outright - confirmed
  // live 2026-08-27 via a pink #form-error banner surfacing a 429 on an
  // otherwise-healthy in-progress job. Now a run of transient failures is
  // tolerated and polling only gives up once it's clearly stuck, not on
  // the first hiccup.
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 4; // ~16s of silence at a 4s interval

  // Checks for a pending human review on a fixed cadence, independent of
  // whether progress "looks stalled". A prior version only checked once
  // nbExecutedNodes held steady across two ticks, on the theory that a
  // job paused for review has nothing left to execute - but confirmed
  // live 2026-08-27 (job 73121): a real DISPATCHED review sat there the
  // whole time while nbExecutedNodes kept advancing anyway (other
  // branches/retries still running server-side), so the stall never
  // "held" for two consecutive ticks and the check never fired. A fixed
  // interval catches it regardless, while still staying well under
  // Opus's 50 req/min limit (1 extra call roughly every 8s, on top of
  // the main poll's 2 calls every 4s).
  let pollTickCount = 0;
  const REVIEW_CHECK_EVERY_N_TICKS = 2; // ~every 8s at a 4s poll interval

  const poll = async () => {
    try {
      const res = await fetch(`/api/run/${jobId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to check job status.');

      consecutiveFailures = 0;

      if (data.status === 'COMPLETED') {
        stopPolling();
        setBusy(false);
        statusPanel.hidden = true;
        setJobIdInUrl(null);
        showResults(data.outputs);
      } else if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(data.status)) {
        stopPolling();
        setBusy(false);
        statusPanel.hidden = true;
        setJobIdInUrl(null);
        showFailure(data);
      } else {
        statusText.textContent = `Processing (${data.status})…`;
        renderProgress(data);

        pollTickCount += 1;
        if (pollTickCount % REVIEW_CHECK_EVERY_N_TICKS === 0) {
          maybeCheckForReview(jobId);
        }
      }
    } catch (err) {
      consecutiveFailures += 1;
      console.error(`poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`, err);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stopPolling();
        setBusy(false);
        statusPanel.hidden = true;
        setJobIdInUrl(null);
        showError(err.message || 'Something went wrong while polling.');
      } else {
        // Transient - surface it in the status line without tearing down
        // the panel, then just try again on the next tick.
        statusText.textContent = 'Checking status… (a request was rate-limited, retrying)';
      }
    }
  };

  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

// Persists the in-flight job's ID in the URL (not localStorage - this is
// meant to survive a same-tab refresh, not to be a durable cross-session
// record) so a refresh mid-run can resume watching it instead of losing
// track entirely. Cleared once the job reaches a terminal state.
function setJobIdInUrl(jobId) {
  const url = new URL(window.location.href);
  if (jobId) {
    url.searchParams.set('job', jobId);
  } else {
    url.searchParams.delete('job');
  }
  history.replaceState(null, '', url);
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


// ============================================================
// Case Queue / My Cases: real history from /api/case-history.
// ============================================================
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatTimestamp(iso) {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '\u2014';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function buildBadgeSpan(value, toneOverride) {
  const span = document.createElement('span');
  span.className = 'badge';
  const tone = toneOverride || toneFor(value);
  span.classList.add(`tone-${tone}`);
  span.textContent = value ?? '\u2014';
  return span;
}

function buildDataTable(columns, rows, emptyMessage) {
  const wrap = document.createElement('div');

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'data-table-empty';
    empty.textContent = emptyMessage;
    wrap.appendChild(empty);
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col.label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach((col) => {
      const td = document.createElement('td');
      const rendered = col.render(row);
      if (rendered instanceof Node) {
        td.appendChild(rendered);
      } else {
        td.textContent = rendered ?? '\u2014';
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  wrap.appendChild(table);
  return wrap;
}

const CASE_TABLE_COLUMNS = [
  { label: 'Case', render: (row) => (row.title || 'Banking KYC run') },
  { label: 'Applicant', render: (row) => row.applicantName || '\u2014' },
  { label: 'Submitted', render: (row) => formatTimestamp(row.submittedAt) },
  {
    label: 'Status',
    render: (row) => buildBadgeSpan(row.status, JOB_STATUS_TONE[row.status] || (row.status === 'COMPLETED' ? 'green' : 'neutral')),
  },
  { label: 'Decision', render: (row) => (row.finalDecision ? buildBadgeSpan(row.finalDecision) : '\u2014') },
  { label: 'Routing', render: (row) => (row.routingFlag ? buildBadgeSpan(row.routingFlag) : '\u2014') },
  {
    label: 'Duration',
    render: (row) => {
      const start = new Date(row.submittedAt).getTime();
      const end = row.completedAt ? new Date(row.completedAt).getTime() : Date.now();
      if (Number.isNaN(start)) return '\u2014';
      return formatDuration(end - start);
    },
  },
];

async function fetchCaseHistory() {
  const res = await fetch('/api/case-history');
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data.entries) ? data.entries : [];
}

function renderQueueStats(containerId, entries) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const total = entries.length;
  const inProgress = entries.filter((e) => e.status === 'IN_PROGRESS').length;
  const completed = entries.filter((e) => e.status === 'COMPLETED').length;
  const failed = entries.filter((e) => e.status && e.status !== 'IN_PROGRESS' && e.status !== 'COMPLETED' && e.status !== 'WAITING_REVIEW').length;

  const tiles = [
    { label: 'Total Cases', value: total },
    { label: 'In Progress', value: inProgress },
    { label: 'Completed', value: completed },
    { label: 'Failed / Cancelled', value: failed },
  ];

  el.innerHTML = '';
  tiles.forEach((tile) => {
    const div = document.createElement('div');
    div.className = 'stat-tile';
    const label = document.createElement('div');
    label.className = 'stat-tile-label';
    label.textContent = tile.label;
    const value = document.createElement('div');
    value.className = 'stat-tile-value';
    value.textContent = String(tile.value);
    div.appendChild(label);
    div.appendChild(value);
    el.appendChild(div);
  });
}

async function renderCaseTable(tableWrapId, statsContainerId) {
  const wrap = document.getElementById(tableWrapId);
  if (!wrap) return;
  wrap.textContent = 'Loading\u2026';

  try {
    const entries = await fetchCaseHistory();
    wrap.innerHTML = '';
    wrap.appendChild(
      buildDataTable(CASE_TABLE_COLUMNS, entries, 'No cases have been run through this console yet.')
    );
    if (statsContainerId) renderQueueStats(statsContainerId, entries);
  } catch (err) {
    wrap.textContent = 'Could not load case history.';
  }
}

async function renderPendingReviews() {
  const wrap = document.getElementById('pending-reviews-list');
  if (!wrap) return;
  wrap.textContent = 'Loading…';

  try {
    const entries = await fetchCaseHistory();
    const pending = entries.filter((e) => e.status === 'WAITING_REVIEW');
    wrap.innerHTML = '';

    if (!pending.length) {
      const empty = document.createElement('div');
      empty.className = 'data-table-empty';
      empty.textContent = 'No cases are currently awaiting review.';
      wrap.appendChild(empty);
      return;
    }

    pending.forEach((entry) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'review-queue-card';
      card.dataset.jobId = entry.jobId;

      const title = document.createElement('div');
      title.className = 'review-queue-card-title';
      title.textContent = entry.applicantName || entry.title || `Case ${entry.jobId}`;

      const meta = document.createElement('div');
      meta.className = 'review-queue-card-meta';
      meta.textContent = `Case ${entry.jobId} · Submitted ${formatTimestamp(entry.submittedAt)}`;

      card.appendChild(title);
      card.appendChild(meta);

      card.addEventListener('click', () => openPendingReview(entry.jobId));
      wrap.appendChild(card);
    });
  } catch (err) {
    wrap.textContent = 'Could not load pending reviews.';
  }
}

async function openPendingReview(jobId) {
  try {
    resetReview();
    const found = await loadAndShowReview(jobId);
    if (!found) {
      // Dispatch not found (e.g. already resolved by someone else, or the
      // in-memory pendingReviewDispatches entry was lost across a
      // serverless cold start while Redis still shows WAITING_REVIEW) -
      // refresh the list instead of showing a broken form.
      renderPendingReviews();
    }
  } catch (err) {
    console.error('open pending review error', err);
    renderPendingReviews();
  }
}

// ============================================================
// Sanctions Alerts: invented sample data - preview only.
// ============================================================
const SANCTIONS_SAMPLE_ROWS = [
  { name: 'Karim El-Sayed', list: 'OFAC SDN', matchScore: '92%', status: 'Open', flagged: '2 days ago' },
  { name: 'Nadia Petrov', list: 'EU Consolidated', matchScore: '78%', status: 'Under Review', flagged: '4 days ago' },
  { name: 'Global Horizon Trading LLC', list: 'UN Sanctions', matchScore: '65%', status: 'Cleared', flagged: '1 week ago' },
  { name: 'Youssef Haddad', list: 'OFAC SDN', matchScore: '88%', status: 'Open', flagged: '1 week ago' },
  { name: 'Alina Marchetti', list: 'UK HMT', matchScore: '71%', status: 'Cleared', flagged: '2 weeks ago' },
];

const SANCTIONS_COLUMNS = [
  { label: 'Name / Entity', render: (row) => row.name },
  { label: 'List', render: (row) => row.list },
  { label: 'Match Score', render: (row) => row.matchScore },
  {
    label: 'Status',
    render: (row) => {
      const tone = row.status === 'Cleared' ? 'green' : row.status === 'Open' ? 'pink' : 'yellow';
      return buildBadgeSpan(row.status, tone);
    },
  },
  { label: 'Flagged', render: (row) => row.flagged },
];

function renderSanctionsTable() {
  const wrap = document.getElementById('sanctions-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  wrap.appendChild(buildDataTable(SANCTIONS_COLUMNS, SANCTIONS_SAMPLE_ROWS, 'No alerts.'));
}

// ============================================================
// Reports: invented sample data - preview only.
// ============================================================
function renderReports() {
  const statsEl = document.getElementById('reports-stats');
  const breakdownsEl = document.getElementById('reports-breakdowns');
  if (!statsEl || !breakdownsEl) return;

  const stats = [
    { label: 'Cases This Month', value: '164' },
    { label: 'Avg. Turnaround', value: '6m 40s' },
    { label: 'Auto-Approved', value: '71%' },
    { label: 'Escalated to Review', value: '12%' },
  ];

  statsEl.innerHTML = '';
  stats.forEach((tile) => {
    const div = document.createElement('div');
    div.className = 'stat-tile';
    const label = document.createElement('div');
    label.className = 'stat-tile-label';
    label.textContent = tile.label;
    const value = document.createElement('div');
    value.className = 'stat-tile-value';
    value.textContent = tile.value;
    div.appendChild(label);
    div.appendChild(value);
    statsEl.appendChild(div);
  });

  const breakdowns = [
    {
      title: 'Risk Tier Mix',
      rows: [
        { label: 'Low', pct: 58 },
        { label: 'Medium', pct: 29 },
        { label: 'High', pct: 13 },
      ],
    },
    {
      title: 'Automation Outcome',
      rows: [
        { label: 'Approved', pct: 71 },
        { label: 'Human Review', pct: 21 },
        { label: 'Rejected', pct: 8 },
      ],
    },
  ];

  breakdownsEl.innerHTML = '';
  breakdowns.forEach((block) => {
    const blockEl = document.createElement('div');
    blockEl.className = 'report-block';

    const title = document.createElement('div');
    title.className = 'report-block-title';
    title.textContent = block.title;
    blockEl.appendChild(title);

    block.rows.forEach((row) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'report-row';

      const label = document.createElement('div');
      label.className = 'report-row-label';
      label.textContent = row.label;

      const track = document.createElement('div');
      track.className = 'report-bar-track';
      const fill = document.createElement('div');
      fill.className = 'report-bar-fill';
      fill.style.width = `${row.pct}%`;
      track.appendChild(fill);

      const value = document.createElement('div');
      value.className = 'report-row-value';
      value.textContent = `${row.pct}%`;

      rowEl.appendChild(label);
      rowEl.appendChild(track);
      rowEl.appendChild(value);
      blockEl.appendChild(rowEl);
    });

    breakdownsEl.appendChild(blockEl);
  });
}

// ============================================================
// Settings: real connection info from /api/config.
// ============================================================
async function renderSettings() {
  const el = document.getElementById('settings-connection');
  if (!el) return;
  el.textContent = 'Loading\u2026';

  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const config = await res.json();

    const rows = [
      { label: 'Opus Host', value: config.host || '\u2014' },
      { label: 'Workflow ID', value: config.workflowId || '\u2014' },
      { label: 'Service Key Configured', value: config.serviceKeyConfigured ? 'Yes' : 'No' },
    ];

    el.innerHTML = '';
    rows.forEach((row) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'settings-row';
      const label = document.createElement('div');
      label.className = 'settings-row-label';
      label.textContent = row.label;
      const value = document.createElement('div');
      value.className = 'settings-row-value';
      value.textContent = row.value;
      rowEl.appendChild(label);
      rowEl.appendChild(value);
      el.appendChild(rowEl);
    });
  } catch (err) {
    el.textContent = 'Could not load connection settings.';
  }
}

resetBtn.addEventListener('click', () => {
  form.reset();
  resultsPanel.hidden = true;
  errorPanel.hidden = true;
  clearError();
  setJobIdInUrl(null);
});

// "Back to role selection" - the single shared header button (#back-to-role-btn),
// visible whenever a role is verified regardless of which view is showing
// (intake form, in-progress/polling, or Result - see revealIntakeForm()
// above, which is where it's un-hidden). Only resets what this browser tab
// is showing (stops polling, clears currentRole, hides the intake form and
// the in-progress/result/review/error panels, reopens the role gate) - it
// does not cancel the job on Opus's side. There's no such thing as
// canceling it from this app anyway: the API reference documents no
// cancel/stop endpoint for a job in the Jobs domain (only
// /executor/execution/{id}/stop, a lower-level, unconfirmed surface - see
// API reference §4.7).
function backToRoleSelection() {
  stopPolling();
  currentRole = null;
  applyRoleRestrictions();
  setBusy(false);
  intakeFormCard.hidden = true;
  backToRoleBtn.hidden = true;
  statusPanel.hidden = true;
  resultsPanel.hidden = true;
  errorPanel.hidden = true;
  resetProgress();
  resetReview();
  setJobIdInUrl(null);
  openRoleGate(revealIntakeForm);
}

backToRoleBtn.addEventListener('click', backToRoleSelection);

// Resume watching an in-flight job after a same-tab refresh, if the URL
// still carries a ?job= param from before the reload. Skips straight past
// the landing view/upload form to the status panel and re-enters the same
// poll loop a fresh submission would have started.
(function resumeJobFromUrl() {
  const jobId = new URLSearchParams(window.location.search).get('job');
  if (!jobId) return;

  landingView.hidden = true;
  appView.hidden = false;
  setBusy(true);
  resultsPanel.hidden = true;
  errorPanel.hidden = true;
  statusPanel.hidden = false;
  statusText.textContent = 'Resuming — reconnecting to the running workflow…';
  resetProgress();
  resetReview();
  pollStatus(jobId);
})();
