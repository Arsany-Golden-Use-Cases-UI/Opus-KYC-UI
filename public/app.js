const landingView = document.getElementById('landing-view');
const appView = document.getElementById('app-view');
const startBtn = document.getElementById('start-btn');

// ADDED 2026-09-11. Without this, a refresh at ANY stage - Case Queue,
// Reports, a Case Detail page, mid-way through New Intake, anywhere -
// always landed back on this splash screen, because landingView/appView
// visibility was only ever set by the click handler below, never
// persisted anywhere. Tab-scoped (sessionStorage, not localStorage) to
// match currentRole's own persistence just below - a brand new tab still
// sees the splash once, only a same-tab refresh skips it. Wrapped in
// try/catch for the same reason every other storage access in this file
// is: a storage failure should degrade to "the splash just doesn't skip"
// rather than break the click handler that already worked fine before
// this was added.
const LANDING_DISMISSED_KEY = 'kyc-landing-dismissed';

function markLandingDismissed() {
  try {
    sessionStorage.setItem(LANDING_DISMISSED_KEY, '1');
  } catch (err) {
    console.error('landing dismissed save error', err);
  }
}

function wasLandingDismissed() {
  try {
    return sessionStorage.getItem(LANDING_DISMISSED_KEY) === '1';
  } catch (err) {
    console.error('landing dismissed read error', err);
    return false;
  }
}

startBtn.addEventListener('click', () => {
  landingView.hidden = true;
  appView.hidden = false;
  markLandingDismissed();
});

// A same-tab refresh past this point (this session already saw the
// splash and clicked through) - skip straight to the app shell. The role
// gate and whichever tab/case was open are restored separately, further
// down, once the rest of the app has finished defining itself.
if (wasLandingDismissed()) {
  landingView.hidden = true;
  appView.hidden = false;
}

// ============================================================
// Role gate: who is running this case? (KYC Agent / Compliance Officer)
// ============================================================
// currentRole survives a refresh, but only within this browser tab: it's
// mirrored into sessionStorage (see saveRoleSession() below), NOT
// localStorage, so closing the tab or the browser drops it and a shared
// compliance workstation doesn't stay verified indefinitely. Only the
// verified role and name are stored - never the password. See server.js's
// /api/verify-role comment: this is a client-side UI gate only, not real
// access control on the routes it's meant to protect, and persisting it
// doesn't change that either way.
let currentRole = null;
// Free-text, required alongside the password - tracked with every case a
// person runs or reviews (see the ranBy/reviewedBy fields sent alongside
// POST /api/run and POST /api/run/:id/review below). Same set/reset
// lifecycle as currentRole: set together on a verified Continue, cleared
// together in backToRoleSelection().
let currentUserName = null;
let roleGateOnVerified = null;
let pendingRoleChoice = null; // 'agent' | 'manager', chosen but not yet verified

const roleGateOverlay = document.getElementById('role-gate');
const roleChoiceAgentBtn = document.getElementById('role-choice-agent');
const roleChoiceManagerBtn = document.getElementById('role-choice-manager');
const roleGatePasswordStep = document.getElementById('role-gate-password-step');
const roleGateNameInput = document.getElementById('role-gate-name');
const roleGatePasswordInput = document.getElementById('role-gate-password');
const roleGateError = document.getElementById('role-gate-error');
const roleGateSubmitBtn = document.getElementById('role-gate-submit-btn');

// Tab-scoped persistence of a verified role, so a refresh doesn't send
// someone back through the gate they cleared seconds ago. Stores only
// { role, name } - the password is never written anywhere.
const ROLE_SESSION_KEY = 'kyc-role-session';

// Keep in sync with the two role-choice buttons above and server.js's
// ROLE_PASSWORDS. Used to validate what comes back out of storage: if the
// valid roles ever change, a stored value from an older build is treated
// as no session at all rather than trusted blindly.
const VALID_ROLES = ['agent', 'manager'];

// Every one of these wraps storage access in try/catch: sessionStorage
// itself can throw (private mode, storage disabled, sandboxed iframe),
// and a storage failure should degrade to "the gate just doesn't persist"
// rather than breaking the gate - or, on write, failing a verification
// that has already succeeded.
function saveRoleSession(role, name) {
  try {
    sessionStorage.setItem(ROLE_SESSION_KEY, JSON.stringify({ role, name }));
  } catch (err) {
    console.error('role session save error', err);
  }
}

function clearRoleSession() {
  try {
    sessionStorage.removeItem(ROLE_SESSION_KEY);
  } catch (err) {
    console.error('role session clear error', err);
  }
}

// Restores currentRole/currentUserName from a previous verification in
// this tab. Returns true only if a usable session was found, so the
// caller knows whether to skip the gate. Anything malformed is dropped
// rather than left to linger - same fall-back-to-a-known-good-state
// approach as the screening policy's corrupt-value guard in server.js.
function restoreRoleSession() {
  let raw;
  try {
    raw = sessionStorage.getItem(ROLE_SESSION_KEY);
  } catch (err) {
    console.error('role session read error', err);
    return false;
  }
  if (!raw) return false;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearRoleSession();
    return false;
  }

  const role = parsed && parsed.role;
  const name = parsed && typeof parsed.name === 'string' ? parsed.name.trim() : '';

  // A blank name is rejected for the same reason the gate itself requires
  // one: it's what ends up on the case as ranBy/reviewedBy.
  if (!VALID_ROLES.includes(role) || !name) {
    clearRoleSession();
    return false;
  }

  currentRole = role;
  currentUserName = name;
  return true;
}

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
  roleGateNameInput.value = '';
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
// left over from the previous choice. The name isn't cleared here - it's
// the same person's identity regardless of which role they end up
// claiming, unlike the password/error, which are role-specific-feeling
// artifacts of the previous choice.
function chooseRole(role) {
  pendingRoleChoice = role;
  roleChoiceAgentBtn.classList.toggle('role-choice-btn--active', role === 'agent');
  roleChoiceManagerBtn.classList.toggle('role-choice-btn--active', role === 'manager');
  roleGatePasswordStep.hidden = false;
  roleGateError.hidden = true;
  roleGateError.textContent = '';
  roleGatePasswordInput.value = '';
  (roleGateNameInput.value ? roleGatePasswordInput : roleGateNameInput).focus();
}

roleChoiceAgentBtn.addEventListener('click', () => chooseRole('agent'));
roleChoiceManagerBtn.addEventListener('click', () => chooseRole('manager'));

function submitRoleGateOnEnter(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    roleGateSubmitBtn.click();
  }
}
roleGateNameInput.addEventListener('keydown', submitRoleGateOnEnter);
roleGatePasswordInput.addEventListener('keydown', submitRoleGateOnEnter);

roleGateSubmitBtn.addEventListener('click', async () => {
  if (!pendingRoleChoice) return;
  roleGateError.hidden = true;

  const name = roleGateNameInput.value.trim();
  const password = roleGatePasswordInput.value;
  // A blank name shouldn't get past the gate any more than a blank
  // password would - checked before ever hitting the network, same as
  // the intake form's own field checks (see showError() call sites
  // above) validate on submit rather than live-disabling the button.
  if (!name || !password) {
    roleGateError.textContent = 'Enter your name and password to continue.';
    roleGateError.hidden = false;
    return;
  }

  roleGateSubmitBtn.disabled = true;
  roleGateSubmitBtn.textContent = 'Checking…';

  try {
    const res = await fetch('/api/verify-role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: pendingRoleChoice, password }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      currentRole = pendingRoleChoice;
      currentUserName = name;
      // Mirrored to sessionStorage here, in the one place the role is
      // actually verified, so a refresh in this tab can skip the gate -
      // see the bootstrap at the bottom of this file.
      saveRoleSession(currentRole, currentUserName);
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

// The page-load decision (gate vs. restore a verified session) lives at
// the very bottom of this file, in bootstrapRoleGate(). It used to be an
// unconditional openRoleGate(revealIntakeForm) right here, which was fine
// only because it merely *passed* revealIntakeForm as a callback to run
// later. Restoring a session has to actually CALL revealIntakeForm() and
// applyRoleRestrictions() during that initial pass, and those touch
// consts declared further down (navItems/viewPanels, intakeFormCard,
// backToRoleBtn) - reaching them from here would throw on the temporal
// dead zone, so the decision runs once everything is initialized.

// ============================================================
// Tab shell: sidebar navigation between the app's views.
// ============================================================
const navItems = Array.from(document.querySelectorAll('.nav-item'));
const viewPanels = Array.from(document.querySelectorAll('[data-view-panel]'));
const headerViewTitle = document.getElementById('header-view-title');
const pendingReviewsBadge = document.getElementById('pending-reviews-badge');

const VIEW_TITLES = {
  queue: 'Case Queue',
  intake: 'New Intake',
  // RENAMED 2026-09-09 from "Pending Reviews" - see the sidebar/panel
  // comments in index.html for why the key itself stayed "pending".
  pending: 'Review Log',
  reports: 'Reports',
  settings: 'Settings',
  // No sidebar nav item of its own - see the [data-view-panel="review"]
  // comment in index.html for how this view is actually reached.
  review: 'Human Review',
  // Same as above - see the [data-view-panel="casedetail"] comment in
  // index.html.
  casedetail: 'Case Detail',
  // Same as above - see the [data-view-panel="reviewlogdetail"] comment in
  // index.html. Reached only from a completed card on the Review Log tab.
  reviewlogdetail: 'Review Detail',
};

// Each tab's data is fetched/rendered once, the first time it's opened,
// rather than on every visit - the underlying data (real history or
// static mock data) doesn't change within a single page load.
const viewLoaded = {};

// ADDED 2026-09-11. The subset of VIEW_TITLES that switchToView() mirrors
// into the URL's `view` param (see setViewInUrl()) so a refresh can
// restore them - the five tab-bar views only. casedetail/reviewlogdetail
// go in the URL too, but with a case id attached, so they set it
// themselves rather than through this generic path; 'review' never goes
// in the URL at all. See restoreViewFromUrl() at the bottom of this file
// for the other half of this.
const VIEW_RESTORABLE_TABS = new Set(['queue', 'intake', 'pending', 'reports', 'settings']);

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

  // The case-detail panel runs its own independent poll loop while it's
  // the visible view (see startCaseDetailPolling() near renderCaseTable())
  // - stop it the moment we're actually navigating away, so it doesn't
  // keep hitting /api/run/:id in the background for a case nobody's
  // looking at anymore.
  const previousPanel = viewPanels.find((panel) => !panel.hidden);
  if (previousPanel && previousPanel.dataset.viewPanel === 'casedetail' && viewName !== 'casedetail') {
    stopCaseDetailPolling();
  }

  navItems.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  viewPanels.forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== viewName;
  });
  headerViewTitle.textContent = VIEW_TITLES[viewName];

  // ADDED 2026-09-11. Only the five tab-bar views get written here - the
  // two standalone detail panels (casedetail, reviewlogdetail) set the URL
  // themselves right after this, with the case's jobId attached (see
  // loadAndShowCaseDetail() and openReviewLogDetail()), and 'review' is
  // deliberately never written at all (see setViewInUrl()'s own comment).
  if (VIEW_RESTORABLE_TABS.has(viewName)) {
    setViewInUrl(viewName);
  }

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
  // cases: a manager-only tab (e.g. Reports) left active by a
  // Compliance Officer who then switches to KYC Agent, and the "review"
  // panel itself, which should never stay active across a role change
  // regardless of role.
  const activePanel = viewPanels.find((panel) => !panel.hidden);
  const activeBtn = activePanel && navItems.find((btn) => btn.dataset.view === activePanel.dataset.viewPanel);
  if (!activeBtn || !isRoleAllowed(activeBtn)) {
    switchToView('queue');
  }

  refreshPendingReviewsBadge();
}

// Real-time "how many cases need me" count on the sidebar's Pending
// Reviews item - a KYC Agent never sees this nav item at all (data-roles
// on it is manager-only), so there's nothing to show for that role;
// hidden entirely at 0 rather than showing "0", same convention as any
// other empty-state elsewhere in this app.
function setPendingReviewsBadgeCount(count) {
  if (!pendingReviewsBadge) return;
  pendingReviewsBadge.textContent = String(count);
  pendingReviewsBadge.hidden = !count;
}

// Called from applyRoleRestrictions() (so it's live right after sign-in,
// a role switch, or backToRoleSelection()'s reset) and again after a
// review is submitted from the in-progress poll flow (the Pending
// Reviews tab's own renderPendingReviews() updates the badge itself from
// the fetch it already made, rather than calling this and fetching
// twice). A transient fetch error here just leaves whatever count was
// already showing rather than blanking out a moment-ago-accurate one.
async function refreshPendingReviewsBadge() {
  if (!pendingReviewsBadge) return;
  if (currentRole !== 'manager') {
    pendingReviewsBadge.hidden = true;
    return;
  }
  try {
    const entries = await fetchCaseHistory();
    setPendingReviewsBadgeCount(entries.filter((e) => e.status === 'WAITING_REVIEW').length);
  } catch (err) {
    // see comment above - leave the existing badge state alone.
  }
}

function loadViewData(viewName) {
  if (viewName === 'queue') {
    renderCaseTable('queue-table-wrap', 'queue-stats');
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
  // The saved screening policy this case will run against - the form
  // doesn't carry it (the server applies the one saved policy - see
  // renderScreeningPolicyEditor() and its comment further down), this
  // just builds the editor for it in place.
  renderScreeningPolicyEditor();
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

// Case Detail (standalone view-panel, no nav item - reached only via a
// Case Queue row click, see loadAndShowCaseDetail() near
// renderCaseTable()). Deliberately its own full set of status/progress/
// results/error elements, separate from New Intake's above, so browsing
// another case's live status here can never collide with a job New Intake
// (or another case-detail visit) is actively tracking.
const caseDetailTitle = document.getElementById('case-detail-title');
const caseDetailSubtitle = document.getElementById('case-detail-subtitle');
const caseDetailInputs = document.getElementById('case-detail-inputs');
const caseDetailStatusPanel = document.getElementById('case-detail-status-panel');
const caseDetailStatusText = document.getElementById('case-detail-status-text');
const caseDetailStatusElapsedEl = document.getElementById('case-detail-status-elapsed');
const caseDetailStatusProgress = document.getElementById('case-detail-status-progress');
const caseDetailStatusStepsCount = document.getElementById('case-detail-status-steps-count');
const caseDetailProgressBarFill = document.getElementById('case-detail-progress-bar-fill');
const caseDetailProgressBarRunning = document.getElementById('case-detail-progress-bar-running');
const caseDetailStatusStepPills = document.getElementById('case-detail-status-step-pills');
const caseDetailReviewNotice = document.getElementById('case-detail-review-notice');
const caseDetailErrorPanel = document.getElementById('case-detail-error-panel');
const caseDetailErrorStatus = document.getElementById('case-detail-error-status');
const caseDetailErrorNodes = document.getElementById('case-detail-error-nodes');
const caseDetailResultHeadline = document.getElementById('case-detail-result-headline');
const caseDetailAuditCard = document.getElementById('case-detail-audit-card');

// Bundles passed into the now-parameterized renderProgress()/resetProgress()
// (see below) so they write into these elements instead of New Intake's.
const CASE_DETAIL_PROGRESS_ELEMENTS = {
  progress: caseDetailStatusProgress,
  text: caseDetailStatusText,
  stepsCount: caseDetailStatusStepsCount,
  barFill: caseDetailProgressBarFill,
  barRunning: caseDetailProgressBarRunning,
  pills: caseDetailStatusStepPills,
};
const CASE_DETAIL_RESET_ELEMENTS = {
  progress: caseDetailStatusProgress,
  pills: caseDetailStatusStepPills,
  barFill: caseDetailProgressBarFill,
  barRunning: caseDetailProgressBarRunning,
  elapsed: caseDetailStatusElapsedEl,
};

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

// Same keyword-matching shape as TONE_RULES above, and deliberately kept
// as its own list rather than folded into TONE_RULES/an icon-per-tone
// map - a tone (e.g. 'pink') can apply to values that shouldn't
// necessarily share an icon, and vice versa. ︎ (VS15, "text
// presentation") on the warning sign keeps it a plain glyph that
// inherits the badge's text color instead of rendering as a colored
// emoji, matching ✓/✕ either side of it - 👤 (bust-in-silhouette) has no
// text-presentation variant but renders as a plain outline on most
// platforms already, unlike a skin-toned person emoji.
const BADGE_ICON_RULES = [
  { test: /approve|pass|clear|accept/i, icon: '\u2713' },
  { test: /reject|declin|deny|fail/i, icon: '\u2715' },
  { test: /flag|escalat|hold|pending/i, icon: '\u26a0\ufe0e' },
  { test: /human_review|manual|review|refer/i, icon: '\ud83d\udc64' },
];

function iconFor(value) {
  if (!value) return '';
  const str = String(value);
  for (const rule of BADGE_ICON_RULES) {
    if (rule.test.test(str)) return rule.icon;
  }
  return '';
}

// Sentence case ("HUMAN_REVIEW" -> "Human review") rather than
// humanizeLabel()'s title case ("Human Review") - matches how a
// reference design Arsany shared displays these two headline badges
// specifically. Returns null (not '—') on nothing to format, so the
// caller's own '—' fallback stays the single place that placeholder
// is spelled out.
function sentenceCaseValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const spaced = String(value).replace(/[_-]+/g, ' ').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Final Decision / Routing Flag headline badges only (setBadgeTone's only
// two callers, in showResults()) - UPDATED 2026-09-08 to show a
// humanized, sentence-cased label with a leading icon instead of the raw
// enum string, matching that reference design. Case Queue table pills
// (buildBadgeSpan) and everything else using tone-* colors are
// untouched - they still show the raw value, no icon.
function setBadgeTone(el, value) {
  const label = sentenceCaseValue(value) ?? '—';
  const icon = iconFor(value);
  el.textContent = icon ? `${icon} ${label}` : label;
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
// `elements` defaults to New Intake's own status/progress elements so the
// existing call site below (mid-poll, IN_PROGRESS) needs no change - the
// case-detail panel's own poll loop passes CASE_DETAIL_PROGRESS_ELEMENTS
// instead so it never writes into New Intake's DOM.
function renderProgress(data, elements = {
  progress: statusProgress,
  text: statusText,
  stepsCount: statusStepsCount,
  barFill: progressBarFill,
  barRunning: progressBarRunning,
  pills: statusStepPills,
}) {
  const nbNodes = data.nbNodes;
  const executedNodes = data.executedNodes || [];
  const runningNode = data.runningNode || null;
  // remaining_nodes_to_execute's own documented ordering already reflects
  // what's left, so we just drop the running node out of it (some responses
  // include it there too, some don't) rather than re-deriving order.
  const remainingNodes = (data.remainingNodes || []).filter((name) => name !== runningNode);

  if (!nbNodes) {
    elements.progress.hidden = true;
    elements.text.textContent = 'Processing…';
    return;
  }

  const completed = typeof data.nbExecutedNodes === 'number' ? data.nbExecutedNodes : executedNodes.length;

  elements.progress.hidden = false;
  elements.text.textContent = runningNode ? `Running: ${runningNode}` : 'Processing…';
  elements.stepsCount.textContent = runningNode
    ? `${completed} / ${nbNodes} steps — running: ${runningNode}`
    : `${completed} / ${nbNodes} steps`;

  // Fill reflects completed steps; the running node (if any) shows as a
  // separate lighter/pulsing segment rather than counting as done.
  const completedPct = Math.max(0, Math.min(100, (completed / nbNodes) * 100));
  const runningPct = runningNode ? Math.max(0, Math.min(100 - completedPct, (1 / nbNodes) * 100)) : 0;
  elements.barFill.style.width = `${completedPct}%`;
  elements.barRunning.style.width = `${runningPct}%`;
  elements.barRunning.hidden = !runningNode;

  elements.pills.innerHTML = '';

  executedNodes.forEach((name) => {
    const pill = document.createElement('span');
    pill.className = 'step-pill step-pill--done';
    pill.textContent = `✓ ${name}`;
    elements.pills.appendChild(pill);
  });

  if (runningNode) {
    const pill = document.createElement('span');
    pill.className = 'step-pill step-pill--running';
    pill.textContent = runningNode;
    elements.pills.appendChild(pill);
  }

  remainingNodes.forEach((name) => {
    const pill = document.createElement('span');
    pill.className = 'step-pill step-pill--pending';
    pill.textContent = name;
    elements.pills.appendChild(pill);
  });
}

function resetProgress(elements = {
  progress: statusProgress,
  pills: statusStepPills,
  barFill: progressBarFill,
  barRunning: progressBarRunning,
  elapsed: statusElapsed,
}) {
  elements.progress.hidden = true;
  elements.pills.innerHTML = '';
  elements.barFill.style.width = '0%';
  elements.barRunning.style.width = '0%';
  elements.barRunning.hidden = true;
  elements.elapsed.textContent = '';
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

// Assembles the Application Form JSON from the structured intake fields
// that replaced what used to be one raw textarea (see the af-* inputs in
// index.html). Every key in the shape is written unconditionally from this
// literal rather than by iterating over whatever happens to be filled in,
// so a blank field lands as ""/0/false/[] and the workflow's Input node
// always receives the complete object. Returns a STRING, not an object:
// server.js sends this to Opus as type 'json_string' (see the README
// correction on why that type matters), so it must stay serialized.
function buildApplicationFormJson() {
  const str = (id) => (document.getElementById(id).value || '').trim();
  // '' -> 0, and any non-numeric text -> 0 rather than NaN, which would
  // serialize as null and drop the number-ness of the field.
  const num = (id) => Number(str(id)) || 0;
  const bool = (id) => document.getElementById(id).checked;

  return JSON.stringify({
    applicant: {
      full_name: str('af-full-name'),
      date_of_birth: str('af-date-of-birth'),
      nationality: str('af-nationality'),
      place_of_birth: str('af-place-of-birth'),
      sex: str('af-sex'),
      marital_status: str('af-marital-status'),
      residency_status: str('af-residency-status'),
      emirates_id_number: str('af-emirates-id-number'),
      passport_number: str('af-passport-number'),
      passport_country: str('af-passport-country'),
    },
    contact: {
      mobile: str('af-mobile'),
      email: str('af-email'),
      address: {
        line_1: str('af-address-line-1'),
        line_2: str('af-address-line-2'),
        city: str('af-address-city'),
        emirate: str('af-address-emirate'),
        country: str('af-address-country'),
      },
    },
    employment: {
      status: str('af-employment-status'),
      employer: str('af-employer'),
      occupation: str('af-occupation'),
      industry: str('af-industry'),
      monthly_income_aed: num('af-monthly-income-aed'),
      years_at_employer: num('af-years-at-employer'),
    },
    source_of_funds: str('af-source-of-funds'),
    expected_monthly_deposits_aed: num('af-expected-monthly-deposits-aed'),
    expected_transaction_volume: str('af-expected-transaction-volume'),
    pep_self_declaration: bool('af-pep-self-declaration'),
    us_person_for_fatca: bool('af-us-person-for-fatca'),
    // Comma-separated in the UI - split, trimmed, and empties dropped, so
    // a blank input yields [] rather than [""], and "a, ,b" yields two
    // entries rather than three.
    tax_residency_countries: str('af-tax-residency-countries')
      .split(',')
      .map((country) => country.trim())
      .filter(Boolean),
    product_requested: str('af-product-requested'),
    branch: str('af-branch'),
    channel: str('af-channel'),
    // Auto-stamped at submit rather than being a user field - same
    // toISOString() format as case history's submittedAt/completedAt.
    submitted_at: new Date().toISOString(),
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const idDocumentFile = document.getElementById('id-document').files[0];
  const proofOfAddressFile = document.getElementById('proof-of-address').files[0];
  const applicationFormJson = buildApplicationFormJson();

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
  // Nothing left to JSON-validate here: buildApplicationFormJson()
  // constructs and serializes the application form (so malformed JSON is
  // unreachable), and the screening policy is no longer typed per case -
  // the server loads the saved one.
  const runArgs = { idDocumentFile, proofOfAddressFile, applicationFormJson };

  // No role check here anymore - the role gate now runs at page load
  // (before the intake form is even revealed), so by the time this button
  // is visible/clickable, currentRole is already verified.
  startRun(runArgs);
});

// The upload+run flow itself - unchanged from before role gating was added,
// just extracted into its own function so it can run either immediately
// (role already verified this session) or as the openRoleGate() callback
// once a password is confirmed.
async function startRun({ idDocumentFile, proofOfAddressFile, applicationFormJson }) {
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
      body: JSON.stringify({ idDocumentFileUrl, proofOfAddressFileUrl, applicationFormJson, ranBy: currentUserName }),
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

// Mirrors buildApplicationFormJson()'s exact shape (New Intake, above)
// and that form's own section grouping/labels - so a submitted case's
// Application Form reads the same whether you're filling it in or
// reviewing it afterwards in Case Inputs. [path, label, kind] per field;
// kind is undefined (plain text), 'bool', or 'list'. ADDED 2026-09-08
// alongside buildApplicationFormReview() below, replacing what used to
// be this whole object dumped as one JSON-stringified settings-row.
const APPLICATION_FORM_SECTIONS = [
  {
    title: 'Applicant Details',
    fields: [
      ['applicant.full_name', 'Full Name'],
      ['applicant.date_of_birth', 'Date of Birth'],
      ['applicant.nationality', 'Nationality'],
      ['applicant.place_of_birth', 'Place of Birth'],
      ['applicant.sex', 'Sex'],
      ['applicant.marital_status', 'Marital Status'],
      ['applicant.residency_status', 'Residency Status'],
      ['applicant.emirates_id_number', 'Emirates ID Number'],
      ['applicant.passport_number', 'Passport Number'],
      ['applicant.passport_country', 'Passport Country'],
    ],
  },
  {
    title: 'Contact Details',
    fields: [
      ['contact.mobile', 'Mobile'],
      ['contact.email', 'Email'],
      ['contact.address.line_1', 'Address Line 1'],
      ['contact.address.line_2', 'Address Line 2'],
      ['contact.address.city', 'City'],
      ['contact.address.emirate', 'Emirate'],
      ['contact.address.country', 'Country'],
    ],
  },
  {
    title: 'Employment',
    fields: [
      ['employment.status', 'Employment Status'],
      ['employment.employer', 'Employer'],
      ['employment.occupation', 'Occupation'],
      ['employment.industry', 'Industry'],
      ['employment.monthly_income_aed', 'Monthly Income (AED)'],
      ['employment.years_at_employer', 'Years at Employer'],
    ],
  },
  {
    title: 'Account & Compliance',
    fields: [
      ['product_requested', 'Product Requested'],
      ['source_of_funds', 'Source of Funds'],
      ['expected_monthly_deposits_aed', 'Expected Monthly Deposits (AED)'],
      ['expected_transaction_volume', 'Expected Transaction Volume'],
      ['branch', 'Branch'],
      ['channel', 'Channel'],
      ['tax_residency_countries', 'Tax Residency Countries', 'list'],
      ['pep_self_declaration', 'PEP Self-Declaration', 'bool'],
      ['us_person_for_fatca', 'US Person for FATCA', 'bool'],
    ],
  },
];

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

// Returns a Node (not a string) so the boolean case can be a real <span
// class="badge"> instead of literal "Yes"/"No" text.
function formatReviewFieldValue(rawValue, kind) {
  if (kind === 'bool') {
    const badge = document.createElement('span');
    badge.className = `badge ${rawValue ? 'tone-blue' : 'tone-neutral'}`;
    badge.textContent = rawValue ? 'Yes' : 'No';
    return badge;
  }
  if (kind === 'list') {
    const text = Array.isArray(rawValue) && rawValue.length ? rawValue.join(', ') : '\u2014';
    return document.createTextNode(text);
  }
  const text = rawValue === null || rawValue === undefined || rawValue === '' ? '\u2014' : String(rawValue);
  return document.createTextNode(text);
}

// Renders a parsed Application Form JSON object as read-only grouped
// fields, in the exact sections/labels buildApplicationFormJson() and the
// New Intake form itself use. Always renders every field (with the app's
// usual '\u2014' placeholder for anything blank) rather than hiding empty
// ones, so nothing looks like it silently disappeared.
function buildApplicationFormReview(formData) {
  const container = document.createElement('div');
  container.className = 'application-form-review';

  APPLICATION_FORM_SECTIONS.forEach((section) => {
    const heading = document.createElement('h4');
    heading.className = 'form-section-title review-section-title';
    heading.textContent = section.title;
    container.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'review-field-grid';
    section.fields.forEach(([path, label, kind]) => {
      const field = document.createElement('div');
      field.className = 'review-field';

      const labelEl = document.createElement('div');
      labelEl.className = 'review-field-label';
      labelEl.textContent = label;

      const valueEl = document.createElement('div');
      valueEl.className = 'review-field-value';
      valueEl.appendChild(formatReviewFieldValue(getPath(formData, path), kind));

      field.appendChild(labelEl);
      field.appendChild(valueEl);
      grid.appendChild(field);
    });
    container.appendChild(grid);
  });

  return container;
}

// Small icon + label + value card for a file-type input (ID Document /
// Proof of Address) - same data as a plain settings-row would show, just
// styled to read as a file reference instead of a generic key/value pair.
function buildFilePreviewCard(label, value) {
  const card = document.createElement('div');
  card.className = 'file-preview-card';

  const icon = document.createElement('span');
  icon.className = 'file-preview-icon';
  icon.textContent = '\ud83d\udcc4';
  card.appendChild(icon);

  const body = document.createElement('div');
  body.className = 'file-preview-body';

  const labelEl = document.createElement('div');
  labelEl.className = 'file-preview-label';
  labelEl.textContent = label;
  body.appendChild(labelEl);

  const text = value === null || value === undefined || value === '' ? '\u2014' : String(value);
  const valueEl = document.createElement('div');
  valueEl.className = 'file-preview-value';
  valueEl.textContent = text;
  valueEl.title = text;
  body.appendChild(valueEl);

  card.appendChild(body);
  return card;
}

// A leaf value inside renderJsonTree() below - plain text for most
// things, but a real badge (reusing the exact classes/tones the rest of
// the app already uses for these same two vocabularies) for a boolean or
// a severity word, since "HIGH" or "true" sitting in a dense block of
// extracted-field text is easy to skim right past otherwise.
function renderJsonLeafValue(value) {
  if (typeof value === 'boolean') {
    const badge = document.createElement('span');
    badge.className = `badge ${value ? 'tone-blue' : 'tone-neutral'}`;
    badge.textContent = value ? 'Yes' : 'No';
    return badge;
  }
  if (typeof value === 'string' && SEVERITY_LEVELS.includes(value.trim().toUpperCase())) {
    const level = value.trim().toUpperCase();
    const badge = document.createElement('span');
    badge.className = `badge ${severityTone(level)}`;
    badge.textContent = level;
    return badge;
  }
  const text = value === null || value === undefined || value === '' ? '\u2014' : String(value);
  return document.createTextNode(text);
}

// ADDED 2026-09-09: structured renderer for a parsed JSON value (object,
// array, or scalar), used for any review-input field whose label ends in
// "JSON" (see renderReviewInputs() below) - replaces what used to be the
// entire stringified blob dumped as one dense, right-aligned monospace
// line in a plain settings-row. Recurses for nested objects/arrays;
// humanizeKey() (already used elsewhere for policy field labels) turns
// each snake_case key into a real label.
function renderJsonTree(value) {
  if (Array.isArray(value)) {
    const wrap = document.createElement('div');
    wrap.className = 'json-tree';
    if (!value.length) {
      wrap.textContent = '\u2014';
      return wrap;
    }
    // An array of short plain values (e.g. tax_residency_countries) reads
    // better as one comma-joined line than as N single-item rows; an
    // array of longer strings (e.g. Key Sanctions Findings, each a full
    // sentence) comma-joins into the same run-on-paragraph problem this
    // whole rewrite exists to fix, so it gets a real bullet list instead;
    // an array of objects (e.g. Policy Breaches) gets a numbered sub-tree
    // per item.
    const allPrimitive = value.every((v) => v === null || typeof v !== 'object');
    if (allPrimitive) {
      const strings = value.map((v) => (v === null || v === undefined || v === '' ? '\u2014' : String(v)));
      if (strings.every((s) => s.length <= 40)) {
        wrap.textContent = strings.join(', ');
        return wrap;
      }
      const list = document.createElement('ul');
      list.className = 'json-tree-list';
      strings.forEach((s) => {
        const li = document.createElement('li');
        li.textContent = s;
        list.appendChild(li);
      });
      wrap.appendChild(list);
      return wrap;
    }
    value.forEach((item, i) => {
      const itemRow = document.createElement('div');
      itemRow.className = 'json-tree-array-item';
      const idx = document.createElement('div');
      idx.className = 'json-tree-array-index';
      idx.textContent = `#${i + 1}`;
      itemRow.append(idx, renderJsonTree(item));
      wrap.appendChild(itemRow);
    });
    return wrap;
  }

  if (value && typeof value === 'object') {
    const wrap = document.createElement('div');
    wrap.className = 'json-tree';
    const objEntries = Object.entries(value);
    if (!objEntries.length) {
      wrap.textContent = '\u2014';
      return wrap;
    }
    objEntries.forEach(([key, v]) => {
      const row = document.createElement('div');
      row.className = 'json-tree-row';
      const labelEl = document.createElement('div');
      labelEl.className = 'json-tree-label';
      labelEl.textContent = humanizeKey(key);
      const valueEl = document.createElement('div');
      valueEl.className = 'json-tree-value';
      if (v && typeof v === 'object') {
        valueEl.appendChild(renderJsonTree(v));
      } else {
        valueEl.appendChild(renderJsonLeafValue(v));
      }
      row.append(labelEl, valueEl);
      wrap.appendChild(row);
    });
    return wrap;
  }

  const wrap = document.createElement('div');
  wrap.appendChild(renderJsonLeafValue(value));
  return wrap;
}

// ADDED 2026-09-09: Opus's own free-text summaries (Human Readable
// Summary, Risk Summary, etc.) commonly run several hundred characters
// with no real line breaks, using " - " as an ad hoc separator between
// points - see the field itself for an example. Split into a real list
// once there are enough " - " breaks to look intentional (3+); a shorter
// string, or one with only an incidental hyphen or two, is left as a
// plain paragraph instead of an oddly tiny 1-2-item list. A hyphen inside
// a value that isn't surrounded by spaces on both sides (a date like
// "2026-03-01", an id like "DOC-001") is never matched, so it's never
// mistaken for a separator.
function renderProseValue(text) {
  const wrap = document.createElement('div');
  wrap.className = 'review-prose';
  const segments = text.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length >= 3) {
    const list = document.createElement('ul');
    list.className = 'review-prose-list';
    segments.forEach((seg) => {
      const li = document.createElement('li');
      li.textContent = seg;
      list.appendChild(li);
    });
    wrap.appendChild(list);
  } else {
    const p = document.createElement('p');
    p.textContent = text;
    wrap.appendChild(p);
  }
  return wrap;
}

// containerId defaults to the HITL review card's own inputs block; the
// case-detail panel (loadAndShowCaseDetail(), near renderCaseTable())
// passes 'case-detail-inputs' instead to render a job's original inputs
// there, reusing this same generic key/value rendering - PLUS, as of
// 2026-09-08, special-cased display for whichever of these New Intake
// input labels are actually present: any URL-shaped value (ID Document,
// Proof of Address, or anything else Opus labels as a document - broadened
// 2026-09-09 from an exact "ID Document"/"Proof of Address" label match,
// which silently missed "Proof Of Address Document" and left it as a bare
// link in a plain row) becomes a file-preview card; Application Form JSON
// gets parsed and rendered via buildApplicationFormReview() instead of a
// JSON blob; any other field whose label ends in "JSON" (Extracted
// Identity JSON, Extracted POA JSON, Risk Assessment JSON, ...) gets
// parsed and rendered via renderJsonTree() above instead of the raw
// stringified blob; a long plain-text field (a free-text summary) gets
// renderProseValue() above instead of one dense monospace line; and
// Screening Policy (too large to usefully show inline, and not part of
// what the applicant submitted) is dropped from the visible list - it's
// still in the raw-JSON details block below, nothing is deleted. None of
// this is keyed on Opus's opaque variable IDs (never available
// client-side) - it matches on the human label/value shape instead, so it
// only ever activates when that shape is actually present and otherwise
// falls back to the original flat row unchanged. A HITL review dispatch's
// inputs (this function's other caller) come from a different node
// entirely and won't match any of these labels, so that caller benefits
// from the same broadened matching without needing its own special-casing.
function renderReviewInputs(inputs, containerId = 'review-inputs') {
  const container = document.getElementById(containerId);
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

  const fileFieldEntries = [];
  const plainEntries = [];
  // Long free text and *-labeled-JSON fields - anything too dense for the
  // compact label/value row below - each gets its own full-width block,
  // in the order encountered.
  const detailEntries = [];
  let applicationForm = null;

  entries.forEach(([key, rawValue]) => {
    const value = unwrapReviewValue(rawValue);
    // A case-detail input (server.js's GET /api/run/:id/inputs) carries a
    // real label fetched live from the workflow's Input node definition -
    // prefer that. A HITL review dispatch's inputs (the other caller of
    // this function) never have one, so this falls back to the same
    // strip-the-id-prefix-and-humanize heuristic as before - what's left
    // is sometimes still an opaque id fragment rather than a real label,
    // but that's still more scannable than the full prefixed id, and the
    // raw-JSON view below has the ground truth either way.
    const rawLabel = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue.label : null;
    const label = rawLabel || humanizeLabel(key.replace(/^workflow_(input|output)_/, ''));
    const normalizedLabel = label.trim().toLowerCase();

    if (normalizedLabel === 'application form json' || normalizedLabel === 'application form') {
      let parsed = null;
      if (typeof value === 'string') {
        try {
          parsed = JSON.parse(value);
        } catch {
          parsed = null;
        }
      } else if (value && typeof value === 'object') {
        parsed = value;
      }
      if (parsed) {
        applicationForm = parsed;
        return;
      }
      // Fell through (couldn't parse) - render it the old way rather than
      // silently dropping it.
    }

    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) {
      fileFieldEntries.push([label, value]);
      return;
    }

    if (normalizedLabel === 'screening policy') {
      // Not part of what the applicant submitted, and too large to show
      // inline - still in the raw-JSON block below via `inputs`, just not
      // in the visible list.
      return;
    }

    if (/\bjson\b/i.test(label)) {
      let parsed = null;
      if (typeof value === 'string') {
        try {
          parsed = JSON.parse(value);
        } catch {
          parsed = null;
        }
      } else if (value && typeof value === 'object') {
        parsed = value;
      }
      if (parsed !== null && typeof parsed === 'object') {
        detailEntries.push({ label, kind: 'json', value: parsed });
        return;
      }
      // Couldn't parse - fall through to the plain row below rather than
      // silently dropping it.
    }

    if (typeof value === 'string' && value.length > 180) {
      detailEntries.push({ label, kind: 'prose', value });
      return;
    }

    plainEntries.push([label, value]);
  });

  if (fileFieldEntries.length) {
    const row = document.createElement('div');
    row.className = 'file-preview-row';
    fileFieldEntries.forEach(([label, value]) => row.appendChild(buildFilePreviewCard(label, value)));
    container.appendChild(row);
  }

  if (applicationForm) {
    container.appendChild(buildApplicationFormReview(applicationForm));
  }

  plainEntries.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'settings-row-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('div');
    valueEl.className = 'settings-row-value';
    if (value !== null && typeof value === 'object') {
      valueEl.textContent = JSON.stringify(value);
    } else {
      valueEl.textContent = value === null || value === undefined || value === '' ? '\u2014' : String(value);
    }

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    container.appendChild(row);
  });

  detailEntries.forEach(({ label, kind, value }) => {
    const block = document.createElement('div');
    block.className = 'review-detail-block';

    const title = document.createElement('div');
    title.className = 'review-detail-title';
    title.textContent = label;
    block.appendChild(title);

    block.appendChild(kind === 'json' ? renderJsonTree(value) : renderProseValue(value));
    container.appendChild(block);
  });

  const details = document.createElement('details');
  details.className = 'case-file-json';
  const summary = document.createElement('summary');
  summary.textContent = containerId === 'case-detail-inputs' ? 'View raw application JSON' : 'View raw review inputs (JSON)';
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
  // Deliberately NOT bailing out just because reviewReadonlyPanel is
  // already showing (unlike reviewPanel below) - a previously-pending
  // review can get resolved from somewhere else entirely (another
  // tab/session's interactive submit, or Pending Reviews/Case Detail) at
  // any point while this poll loop keeps running, and the notice needs to
  // keep being re-checked so it can clear once that happens - see the
  // `else if` branch below. Bug fixed 2026-09-02: this used to also bail
  // out once the notice was shown, so it never looked again for the rest
  // of the poll loop's life, even long after the review was actually
  // resolved and the job kept right on progressing underneath it.
  if (reviewCheckInFlight || !reviewPanel.hidden) return;
  reviewCheckInFlight = true;
  try {
    // Only a verified Compliance Officer sees the interactive Approve/
    // Reject card - anyone else (a KYC Agent, or no role set at all,
    // e.g. a ?job= resume in a fresh tab that never cleared the gate)
    // gets a read-only notice instead. This is a client-side-only check
    // - see server.js's /api/verify-role comment on what it doesn't
    // protect.
    if (currentRole === 'manager') {
      await loadAndShowReview(jobId);
    } else {
      const res = await fetch(`/api/run/${jobId}/review`);
      const data = await res.json();
      if (data.pending) {
        currentReviewJobId = jobId;
        reviewReadonlyPanel.hidden = false;
      } else if (!reviewReadonlyPanel.hidden) {
        // Was pending as of the last check, isn't anymore - clear the
        // stale notice rather than leaving it stuck showing forever (see
        // the bug note above).
        reviewReadonlyPanel.hidden = true;
        currentReviewJobId = null;
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
      body: JSON.stringify({ canApprove: reviewCanApprove, comments: reviewComments.value, reviewedBy: currentUserName }),
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
      refreshPendingReviewsBadge();
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
        teardownPolling();
        showResults(data.outputs);
      } else if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(data.status)) {
        teardownPolling();
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
        teardownPolling();
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

// ADDED 2026-09-11. Same idea as setJobIdInUrl() above, but for which
// tab/panel is on screen, so a refresh doesn't just skip the splash (see
// wasLandingDismissed() near the top of this file) but also comes back to
// the same page rather than defaulting to New Intake every time. `caseId`
// is only meaningful for the two standalone detail panels (casedetail,
// reviewlogdetail) - a plain tab clears it. Deliberately never called
// with 'review' (see switchToView()'s own call site below): that panel
// is reached mid-poll or from a one-off click and has no case-history
// record to rebuild it from on a fresh load, unlike the other two.
function setViewInUrl(viewName, caseId) {
  const url = new URL(window.location.href);
  url.searchParams.set('view', viewName);
  if (caseId) {
    url.searchParams.set('case', caseId);
  } else {
    url.searchParams.delete('case');
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

// Shared teardown for all three ways New Intake's poll loop can end
// (COMPLETED, a failure status, or giving up after repeated errors) - see
// poll() in pollStatus() above. Clearing reviewReadonlyPanel here is
// necessary, not just belt-and-suspenders: once stopPolling() runs, there
// is no next tick left for maybeCheckForReview() to ever re-check and
// clear it on its own (that fix only covers a review getting resolved
// while the job is still in progress) - without this, a stale "Awaiting
// Compliance Officer Review" notice would be stranded on screen forever,
// right next to the Result/error card that just replaced it.
function teardownPolling() {
  stopPolling();
  setBusy(false);
  statusPanel.hidden = true;
  setJobIdInUrl(null);
  reviewReadonlyPanel.hidden = true;
  currentReviewJobId = null;
}

// `elements` defaults to New Intake's own error elements; the case-detail
// panel's poll loop passes its own instead (see startCaseDetailPolling()
// near renderCaseTable()).
function showFailure(data, elements = { panel: errorPanel, status: errorStatus, nodes: errorNodes }) {
  elements.panel.hidden = false;
  elements.status.textContent = `Status: ${data.status}`;
  elements.status.classList.remove(...TONE_CLASSES);
  elements.status.classList.add(`tone-${JOB_STATUS_TONE[data.status] || 'neutral'}`);
  const nodes = data.failedNodes || [];
  elements.nodes.innerHTML = nodes.length
    ? `<p>Failed node(s):</p><ul>${nodes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : '<p>No specific failed node was reported. See server logs / the audit endpoint for detail.</p>';
}

// Best-effort extraction of an overall risk level from the real Audit
// Summary text - there is no separate structured risk-score output today
// (see the :root palette comment and buildProfileCard()'s own note that
// the case file's schema isn't guaranteed), so this is the only place a
// level could plausibly come from. Deliberately narrow: only matches
// "overall risk is/level is/assessed as low|medium|high" specifically,
// NOT a bare "risk is low" - a summary can mention several risk
// sub-components (e.g. "sanctions risk is assessed as low") alongside
// the overall one, and matching the first "risk is X" found would risk
// picking up the wrong one. Returns null (never a guess) if that
// specific phrase isn't present, which is what tells renderRiskSignal()
// below to hide the gauge entirely rather than show a made-up reading.
const OVERALL_RISK_PATTERN = /overall\s+risk(?:\s+(?:level|profile|score))?\s+(?:is|assessed\s+as)\s+(low|medium|high)\b/i;

function extractOverallRiskLevel(auditSummary) {
  if (typeof auditSummary !== 'string') return null;
  const match = auditSummary.match(OVERALL_RISK_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

const RISK_LEVEL_MARKER_POSITION = { low: '12%', medium: '50%', high: '88%' };

// tileEl/markerEl are the whole gauge tile and just its marker dot -
// hides the entire tile (not just the marker) on no match, so a case
// with no detectable level doesn't show an empty/misleading gauge shell.
function renderRiskSignal(auditSummary, tileEl, markerEl) {
  if (!tileEl || !markerEl) return;
  const level = extractOverallRiskLevel(auditSummary);
  if (!level) {
    tileEl.hidden = true;
    return;
  }
  markerEl.style.left = RISK_LEVEL_MARKER_POSITION[level];
  const levelLabel = `Overall risk: ${humanizeLabel(level)}`;
  markerEl.title = levelLabel;
  markerEl.setAttribute('aria-label', levelLabel);
  tileEl.hidden = false;
}

// `elements` defaults to New Intake's own results elements; the
// case-detail panel's poll loop passes its own instead.
function showResults(outputs, elements = {
  panel: resultsPanel,
  finalDecision: document.getElementById('final-decision'),
  routingFlag: document.getElementById('routing-flag'),
  auditSummary: document.getElementById('audit-summary'),
  caseFile: document.getElementById('case-file'),
  riskSignalTile: document.getElementById('risk-signal-tile'),
  riskGaugeMarker: document.getElementById('risk-gauge-marker'),
}) {
  const panels = Array.isArray(elements.panel) ? elements.panel : [elements.panel];
  panels.forEach((panel) => { panel.hidden = false; });

  setBadgeTone(elements.finalDecision, outputs.finalDecision);
  setBadgeTone(elements.routingFlag, outputs.routingFlag);
  elements.auditSummary.textContent = outputs.auditSummary ?? '—';
  renderRiskSignal(outputs.auditSummary, elements.riskSignalTile, elements.riskGaugeMarker);

  const caseFileEl = elements.caseFile;
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
// Case Queue: real history from /api/case-history.
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

// onRowClick is optional - passing none leaves rows inert, no row
// highlighting or click handling (see renderCaseTable() below for the
// only current caller, which always passes one). getRowHref is also
// optional - when it returns a URL for a row, that row gets a real link
// stretched over it (see the stretched-link block below), so right-click
// offers "open link in new tab"/"copy link" and ctrl/cmd/middle-click open
// a new tab, on top of the existing plain-click behavior.
function buildDataTable(columns, rows, emptyMessage, onRowClick, getRowHref) {
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
    if (onRowClick) {
      tr.classList.add('data-table-row-clickable');
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.addEventListener('click', () => onRowClick(row));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onRowClick(row);
        }
      });
    }
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

    // Stretched-link pattern: a real <a href> laid over the whole row (its
    // containing block is the position:relative tr set via
    // data-table-row-clickable above), nested inside the first <td> since a
    // <tr> can only contain <td>/<th> directly. tabIndex -1 and
    // aria-hidden keep it out of the tab order and off screen readers -
    // the tr itself already covers keyboard/AT access (role="button",
    // tabIndex, Enter/Space, right above). A plain left click still runs
    // onRowClick() with no page reload, same as before; ctrl/cmd/shift+click
    // or the browser's own "open link in new tab"/"copy link" (right-click)
    // fall through to the anchor's real href instead.
    const rowHref = onRowClick && getRowHref ? getRowHref(row) : null;
    if (rowHref) {
      const link = document.createElement('a');
      link.href = rowHref;
      link.className = 'row-stretch-link';
      link.tabIndex = -1;
      link.setAttribute('aria-hidden', 'true');
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        const opensElsewhere = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
        if (!opensElsewhere) {
          e.preventDefault();
          onRowClick(row);
        }
      });
      tr.firstElementChild.appendChild(link);
    }

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
  // Absent on any case run before this field existed - degrades to the
  // same '\u2014' placeholder every other optional column here already uses.
  { label: 'Ran by', render: (row) => row.ranBy || '\u2014' },
  {
    label: 'Status',
    render: (row) => buildBadgeSpan(row.status, JOB_STATUS_TONE[row.status] || (row.status === 'COMPLETED' ? 'green' : 'neutral')),
  },
  { label: 'Decision', render: (row) => (row.finalDecision ? buildBadgeSpan(row.finalDecision) : '\u2014') },
  { label: 'Routing', render: (row) => (row.routingFlag ? buildBadgeSpan(row.routingFlag) : '\u2014') },
  { label: 'Reviewed by', render: (row) => row.reviewedBy || '\u2014' },
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

// The three states the stat tiles, the status bar, and the breakdown
// donut all read from - one place computing "completed / in progress /
// failed" so the three visuals can never disagree with each other. Same
// bucketing renderQueueStats() used before this got split out: total is
// every entry, failed/cancelled is anything that isn't IN_PROGRESS,
// COMPLETED, or the synthetic WAITING_REVIEW value (that one has no
// bucket of its own here, same as before - it just doesn't currently
// come up in the counts, since nothing sums these three back to total).
function computeQueueStatusCounts(entries) {
  const total = entries.length;
  const inProgress = entries.filter((e) => e.status === 'IN_PROGRESS').length;
  const completed = entries.filter((e) => e.status === 'COMPLETED').length;
  const failed = entries.filter((e) => e.status && e.status !== 'IN_PROGRESS' && e.status !== 'COMPLETED' && e.status !== 'WAITING_REVIEW').length;
  return { total, inProgress, completed, failed };
}

// Green/blue/dark - reused as-is from elsewhere in the app (the risk
// gauge and the Approved checkmark use the same green, --color-blue is
// the one accent color everywhere else, and var(--color-text) is the
// same dark ink used for high-emphasis fills like the Approved tile).
// Deliberately inline rather than global tokens, same reasoning
// .badge-lg.tone-green and the risk gauge gradient already used - this
// is the one other place these three get to mean "status identity" in a
// chart, not "positive/negative" the way badges use color.
const QUEUE_STATUS_COLORS = {
  completed: '#57d873',
  inProgress: 'var(--color-blue)',
  failed: 'var(--color-text)',
};

function renderQueueStatTiles(containerId, counts) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const tiles = [
    { label: 'Total Cases', value: counts.total, accent: 'neutral' },
    { label: 'In Progress', value: counts.inProgress, accent: 'blue' },
    { label: 'Completed', value: counts.completed, accent: 'green' },
    { label: 'Failed / Cancelled', value: counts.failed, accent: 'neutral' },
  ];

  el.innerHTML = '';
  tiles.forEach((tile) => {
    const div = document.createElement('div');
    div.className = `stat-tile stat-tile--accent-${tile.accent}`;
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

// Proportional green/blue/dark segments, left to right in the same order
// as the legend below. A count-less state (e.g. no failed cases at all)
// just contributes a 0-width segment rather than a gap - no total means
// no bar at all (an empty case history), not a broken one.
function renderQueueStatusBar(containerId, counts) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  if (!counts.total) return;

  [
    ['completed', counts.completed],
    ['inProgress', counts.inProgress],
    ['failed', counts.failed],
  ].forEach(([key, value]) => {
    if (!value) return;
    const seg = document.createElement('div');
    seg.className = 'queue-status-bar-segment';
    seg.style.background = QUEUE_STATUS_COLORS[key];
    seg.style.width = `${(value / counts.total) * 100}%`;
    el.appendChild(seg);
  });
}

// A ring built from one <circle> per segment (stroke-dasharray to draw
// only that segment's arc length, stroke-dashoffset to rotate it into
// place after whatever came before it), starting at 12 o'clock via the
// -90deg rotation on each. A thin 1.5% gap between segments keeps
// adjacent same-ish-lightness colors visually separable up close, same
// spacer intent the dataviz skill's mark spec calls for on stacked bars.
function buildQueueDonutSvg(counts) {
  const size = 120;
  const strokeWidth = 14;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = counts.total ? circumference * 0.015 : 0;
  const svgNS = 'http://www.w3.org/2000/svg';

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.classList.add('queue-donut-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${counts.completed} completed, ${counts.inProgress} in progress, ${counts.failed} failed, out of ${counts.total} total cases`);

  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('cx', String(size / 2));
  track.setAttribute('cy', String(size / 2));
  track.setAttribute('r', String(radius));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'var(--color-surface-muted)');
  track.setAttribute('stroke-width', String(strokeWidth));
  svg.appendChild(track);

  let cumulative = 0;
  [
    ['completed', counts.completed],
    ['inProgress', counts.inProgress],
    ['failed', counts.failed],
  ].forEach(([key, value]) => {
    if (!value || !counts.total) return;
    const share = value / counts.total;
    const arcLength = Math.max(share * circumference - gap, 0);
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', String(size / 2));
    circle.setAttribute('cy', String(size / 2));
    circle.setAttribute('r', String(radius));
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', QUEUE_STATUS_COLORS[key]);
    circle.setAttribute('stroke-width', String(strokeWidth));
    circle.setAttribute('stroke-linecap', 'round');
    circle.setAttribute('stroke-dasharray', `${arcLength} ${circumference - arcLength}`);
    circle.setAttribute('stroke-dashoffset', String(-cumulative));
    circle.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
    svg.appendChild(circle);
    cumulative += share * circumference;
  });

  return svg;
}

function buildQueueLegendRow(color, label, value, total) {
  const row = document.createElement('div');
  row.className = 'queue-legend-row';

  const dot = document.createElement('span');
  dot.className = 'queue-legend-dot';
  dot.style.background = color;

  const labelEl = document.createElement('span');
  labelEl.className = 'queue-legend-label';
  labelEl.textContent = label;

  const pctEl = document.createElement('span');
  pctEl.className = 'queue-legend-pct';
  pctEl.textContent = total ? `${Math.round((value / total) * 100)}%` : '\u2014';

  const countEl = document.createElement('span');
  countEl.className = 'queue-legend-count';
  countEl.textContent = String(value);

  row.append(dot, labelEl, pctEl, countEl);
  return row;
}

function renderQueueBreakdown(containerId, counts) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';

  const donutWrap = document.createElement('div');
  donutWrap.className = 'queue-donut-wrap';
  donutWrap.appendChild(buildQueueDonutSvg(counts));

  const center = document.createElement('div');
  center.className = 'queue-donut-center';
  const centerValue = document.createElement('div');
  centerValue.className = 'queue-donut-center-value';
  centerValue.textContent = String(counts.total);
  const centerLabel = document.createElement('div');
  centerLabel.className = 'queue-donut-center-label';
  centerLabel.textContent = 'total';
  center.append(centerValue, centerLabel);
  donutWrap.appendChild(center);

  const legend = document.createElement('div');
  legend.className = 'queue-legend';
  legend.appendChild(buildQueueLegendRow(QUEUE_STATUS_COLORS.completed, 'Completed', counts.completed, counts.total));
  legend.appendChild(buildQueueLegendRow(QUEUE_STATUS_COLORS.inProgress, 'In progress', counts.inProgress, counts.total));
  legend.appendChild(buildQueueLegendRow(QUEUE_STATUS_COLORS.failed, 'Failed', counts.failed, counts.total));

  el.append(donutWrap, legend);
}

function renderQueueOverview(statsContainerId, barContainerId, breakdownContainerId, entries) {
  const counts = computeQueueStatusCounts(entries);
  renderQueueStatTiles(statsContainerId, counts);
  renderQueueStatusBar(barContainerId, counts);
  renderQueueBreakdown(breakdownContainerId, counts);
}

// Search box + status filter pills above the table - both act on the
// same cached entries so switching one never has to refetch, and both
// reset (see renderCaseTable()) whenever the Case Queue view is opened
// fresh rather than persisting across navigation, same as the rest of
// this app's per-view state.
const QUEUE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'IN_PROGRESS', label: 'In progress' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'FAILED', label: 'Failed' },
];

let queueEntriesCache = [];
let queueStatusFilter = 'all';
let queueSearchTerm = '';

function queueEntryMatchesFilter(entry, filterKey) {
  if (filterKey === 'all') return true;
  if (filterKey === 'FAILED') {
    return Boolean(entry.status) && entry.status !== 'IN_PROGRESS' && entry.status !== 'COMPLETED' && entry.status !== 'WAITING_REVIEW';
  }
  return entry.status === filterKey;
}

function renderQueueFilterButtons() {
  const el = document.getElementById('queue-filter-buttons');
  if (!el) return;
  el.innerHTML = '';
  QUEUE_FILTERS.forEach((filter) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-pill' + (queueStatusFilter === filter.key ? ' filter-pill--active' : '');
    btn.textContent = filter.label;
    btn.addEventListener('click', () => {
      if (queueStatusFilter === filter.key) return;
      queueStatusFilter = filter.key;
      renderQueueFilterButtons();
      renderQueueTableFromCache();
    });
    el.appendChild(btn);
  });
}

function renderQueueTableFromCache() {
  const wrap = document.getElementById('queue-table-wrap');
  if (!wrap) return;

  const term = queueSearchTerm.trim().toLowerCase();
  const filtered = queueEntriesCache.filter((entry) => {
    if (!queueEntryMatchesFilter(entry, queueStatusFilter)) return false;
    if (!term) return true;
    const haystack = `${entry.applicantName || ''} ${entry.title || ''} ${entry.jobId || ''}`.toLowerCase();
    return haystack.includes(term);
  });

  const emptyMessage = queueEntriesCache.length
    ? 'No cases match your search or filter.'
    : 'No cases have been run through this console yet.';

  wrap.innerHTML = '';
  wrap.appendChild(buildDataTable(CASE_TABLE_COLUMNS, filtered, emptyMessage, openCaseDetail, caseQueueRowHref));
}

async function renderCaseTable(tableWrapId, statsContainerId) {
  const wrap = document.getElementById(tableWrapId);
  if (!wrap) return;
  wrap.textContent = 'Loading\u2026';

  // Fresh view of the queue resets search/filter, same as any other
  // per-view state elsewhere in the app - it's a summary of "what's here
  // right now", not a saved query.
  queueStatusFilter = 'all';
  queueSearchTerm = '';
  const searchInput = document.getElementById('queue-search');
  if (searchInput) searchInput.value = '';
  renderQueueFilterButtons();

  try {
    queueEntriesCache = await fetchCaseHistory();
    renderQueueTableFromCache();
    if (statsContainerId) {
      renderQueueOverview(statsContainerId, 'queue-status-bar', 'queue-breakdown', queueEntriesCache);
    }
  } catch (err) {
    wrap.textContent = 'Could not load case history.';
  }
}

// Wired once at load - #queue-search is static markup, not rebuilt per
// view switch, unlike the filter pills (which do need rebuilding, since
// their active state depends on queueStatusFilter).
(function initQueueSearch() {
  const input = document.getElementById('queue-search');
  if (!input) return;
  input.addEventListener('input', () => {
    queueSearchTerm = input.value;
    renderQueueTableFromCache();
  });
})();

// BROADENED 2026-09-09 - was "pending reviews only" (status ===
// "WAITING_REVIEW"). Now the single Review Log: every case that has ever
// gone to human review, whether it's still waiting on a Compliance
// Officer or already decided. A completed one only shows up here if its
// decision was actually saved - see server.js's POST /api/run:id/review
// for where .reviewRecord is written; a review submitted before that
// existed has no record to show and simply won't appear once it drops off
// WAITING_REVIEW, same as it would have before this change.
//
// Pending cases are listed first (they need someone's attention) with the
// existing card style; completed ones follow, each carrying its
// Approved/Rejected badge - both groups already come back newest-first
// from fetchCaseHistory(), so within each group order is preserved.
async function renderPendingReviews() {
  const wrap = document.getElementById('pending-reviews-list');
  if (!wrap) return;
  wrap.textContent = 'Loading…';

  try {
    const entries = await fetchCaseHistory();
    const pending = entries.filter((e) => e.status === 'WAITING_REVIEW');
    const completed = entries.filter((e) => e.status !== 'WAITING_REVIEW' && e.reviewRecord);
    // Reuses this fetch rather than calling refreshPendingReviewsBadge()
    // (which would fetch a second time) - same count, same source. Still
    // the pending count only - see the badge's own comment in index.html.
    setPendingReviewsBadgeCount(pending.length);
    wrap.innerHTML = '';

    if (!pending.length && !completed.length) {
      const empty = document.createElement('div');
      empty.className = 'data-table-empty';
      empty.textContent = 'No cases have been sent for review yet.';
      wrap.appendChild(empty);
      return;
    }

    pending.forEach((entry) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'review-queue-card';
      card.dataset.jobId = entry.jobId;

      const top = document.createElement('div');
      top.className = 'review-queue-card-top';
      const title = document.createElement('div');
      title.className = 'review-queue-card-title';
      title.textContent = entry.applicantName || entry.title || `Case ${entry.jobId}`;
      const badge = document.createElement('span');
      badge.className = 'badge tone-yellow';
      badge.textContent = 'Pending';
      top.append(title, badge);

      const meta = document.createElement('div');
      meta.className = 'review-queue-card-meta';
      meta.textContent = `Case ${entry.jobId} · Submitted ${formatTimestamp(entry.submittedAt)}`;

      card.appendChild(top);
      card.appendChild(meta);

      card.addEventListener('click', () => openPendingReview(entry.jobId));
      wrap.appendChild(card);
    });

    completed.forEach((entry) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'review-queue-card';
      card.dataset.jobId = entry.jobId;

      const top = document.createElement('div');
      top.className = 'review-queue-card-top';
      const title = document.createElement('div');
      title.className = 'review-queue-card-title';
      title.textContent = entry.applicantName || entry.title || `Case ${entry.jobId}`;
      const badge = document.createElement('span');
      badge.className = `badge ${entry.reviewRecord.canApprove ? 'tone-green' : 'tone-pink'}`;
      badge.textContent = entry.reviewRecord.canApprove ? 'Approved' : 'Rejected';
      top.append(title, badge);

      const meta = document.createElement('div');
      meta.className = 'review-queue-card-meta';
      let metaText = `Case ${entry.jobId} · Submitted ${formatTimestamp(entry.submittedAt)}`;
      if (entry.reviewRecord.reviewedBy) metaText += ` · Reviewed by ${entry.reviewRecord.reviewedBy}`;
      meta.textContent = metaText;

      card.appendChild(top);
      card.appendChild(meta);

      card.addEventListener('click', () => openReviewLogDetail(entry));
      wrap.appendChild(card);
    });
  } catch (err) {
    wrap.textContent = 'Could not load the review log.';
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

// ADDED 2026-09-09. Read-only counterpart to loadAndShowReview() above -
// renders an already-decided review from its saved .reviewRecord (case
// history, not a live Opus dispatch - there is no live dispatch left for a
// completed review, see server.js's POST /api/run/:id/review). Everything
// needed is already sitting on `entry` (the Review Log card that was
// clicked), no extra fetch required.
function openReviewLogDetail(entry) {
  const record = entry.reviewRecord;
  if (!record) return;

  document.getElementById('reviewlog-detail-title').textContent =
    entry.applicantName || entry.title || `Case ${entry.jobId}`;

  let subtitle = `Case ${entry.jobId} · Submitted ${formatTimestamp(entry.submittedAt)}`;
  if (record.reviewedAt) subtitle += ` · Reviewed ${formatTimestamp(record.reviewedAt)}`;
  document.getElementById('reviewlog-detail-subtitle').textContent = subtitle;

  const decisionEl = document.getElementById('reviewlog-detail-decision');
  decisionEl.className = `badge badge-lg ${record.canApprove ? 'tone-green' : 'tone-pink'}`;
  decisionEl.textContent = record.canApprove ? 'Approved' : 'Rejected';

  const commentsEl = document.getElementById('reviewlog-detail-comments');
  commentsEl.innerHTML = '';
  const commentsText = (record.comments || '').trim();
  if (commentsText) {
    commentsEl.appendChild(renderProseValue(commentsText));
  } else {
    const p = document.createElement('p');
    p.textContent = 'No comments were left with this decision.';
    commentsEl.appendChild(p);
  }
  if (record.reviewedBy) {
    const byLine = document.createElement('p');
    byLine.className = 'review-detail-byline';
    byLine.textContent = `— ${record.reviewedBy}`;
    commentsEl.appendChild(byLine);
  }

  // Same renderer the live review form and Case Detail both already use
  // (see its own comment above) - reviewRecord.inputs was saved in the
  // exact same {value, type, label} shape labelInputs() always produces,
  // so it gets identical readable JSON-tree/prose treatment here, no
  // special-casing needed.
  renderReviewInputs(record.inputs || {}, 'reviewlog-detail-inputs');

  switchToView('reviewlogdetail');
  // ADDED 2026-09-11 - see setViewInUrl()'s comment: this is the one of
  // the two detail panels that carries a case id in the URL, so a refresh
  // lands back on this exact case's Review Detail rather than New Intake.
  setViewInUrl('reviewlogdetail', entry.jobId);
}

// "Return to previous page" (ADDED 2026-09-09) - both Case Detail and
// Review Detail have exactly one entry point each (a Case Queue row and a
// completed Review Log card, respectively - see loadAndShowCaseDetail()'s
// and openReviewLogDetail()'s own comments), so "back" is just a fixed
// switchToView() to that origin tab, not real browser-history navigation.
document.getElementById('case-detail-back-btn')?.addEventListener('click', () => switchToView('queue'));
document.getElementById('reviewlog-detail-back-btn')?.addEventListener('click', () => switchToView('pending'));

// ============================================================
// Case Detail: opened by clicking a Case Queue row. Both roles
// can view (see the investigation this was built from - no server-side or
// client-side restriction on case data, only on submitting a review
// decision), so behavior only branches on the case's own status, plus
// role for the WAITING_REVIEW case specifically.
// ============================================================

let caseDetailJobId = null;
let caseDetailPollTimer = null;
let caseDetailElapsedTimer = null;
let caseDetailPollStartTime = null;

function startCaseDetailElapsedTimer() {
  caseDetailPollStartTime = Date.now();
  caseDetailStatusElapsedEl.textContent = formatElapsed(0);
  if (caseDetailElapsedTimer) clearInterval(caseDetailElapsedTimer);
  caseDetailElapsedTimer = setInterval(() => {
    caseDetailStatusElapsedEl.textContent = formatElapsed(Date.now() - caseDetailPollStartTime);
  }, 1000);
}

function stopCaseDetailElapsedTimer() {
  if (caseDetailElapsedTimer) {
    clearInterval(caseDetailElapsedTimer);
    caseDetailElapsedTimer = null;
  }
}

function stopCaseDetailPolling() {
  if (caseDetailPollTimer) {
    clearInterval(caseDetailPollTimer);
    caseDetailPollTimer = null;
  }
  stopCaseDetailElapsedTimer();
}

function resetCaseDetailPanel() {
  stopCaseDetailPolling();
  caseDetailInputs.innerHTML = '';
  caseDetailStatusPanel.hidden = true;
  resetProgress(CASE_DETAIL_RESET_ELEMENTS);
  caseDetailReviewNotice.hidden = true;
  caseDetailErrorPanel.hidden = true;
  caseDetailResultHeadline.hidden = true;
  caseDetailAuditCard.hidden = true;
}

// Row click handler for Case Queue (see renderCaseTable()
// above). A WAITING_REVIEW row for a verified Compliance Officer skips
// the case-detail panel entirely and opens the same interactive form a
// Pending Reviews card would - loadAndShowReview() already trusts its
// callers to have checked currentRole === 'manager' first, exactly as
// this does. Every other case (including WAITING_REVIEW for anyone else)
// goes through loadAndShowCaseDetail().
// Same-destination URL loadAndShowCaseDetail() already puts in the address
// bar via setViewInUrl(), so a Case Queue row's link and its plain-click
// behavior always agree, and restoreViewFromUrl() can rebuild the exact
// same panel from it on a fresh load (e.g. a right-click "open in new
// tab"). Returns null - no link for that row - for a WAITING_REVIEW case a
// manager would click into the interactive review form instead (see
// openCaseDetail() below): that flow has never had a URL representation to
// restore from, so no href for it would be safe to hand out.
function caseQueueRowHref(entry) {
  if (entry.status === 'WAITING_REVIEW' && currentRole === 'manager') return null;
  const url = new URL(window.location.href);
  url.searchParams.set('view', 'casedetail');
  url.searchParams.set('case', entry.jobId);
  return url.toString();
}

function openCaseDetail(entry) {
  if (entry.status === 'WAITING_REVIEW' && currentRole === 'manager') {
    // Same reset-before-load convention openPendingReview() uses - clears
    // any stale Approve/Reject choice, comments, or error banner left over
    // from a different review that was opened but never submitted.
    resetReview();
    loadAndShowReview(entry.jobId);
    return;
  }
  loadAndShowCaseDetail(entry.jobId, entry);
}

// Fetches and renders one case's full detail into the standalone
// "casedetail" view: original inputs (always - never persisted on our
// side, see server.js's GET /api/run/:id/inputs) plus a status-dependent
// outcome below them. `entry` is the case-history row that was clicked -
// its .status is our own Redis-backed record (the only place the
// synthetic WAITING_REVIEW value exists; Opus itself never reports it),
// which is what decides the initial branch. Runs fully independent of New
// Intake's own poll loop and of whatever this same panel showed for a
// previously-opened case - see caseDetailJobId, checked before every
// render below so a late response for an old jobId can never clobber it.
async function loadAndShowCaseDetail(jobId, entry) {
  caseDetailJobId = jobId;
  resetCaseDetailPanel();
  switchToView('casedetail');
  // ADDED 2026-09-11 - see setViewInUrl()'s comment: the other detail
  // panel that carries a case id in the URL, for the same reason.
  setViewInUrl('casedetail', jobId);

  caseDetailTitle.textContent = entry.applicantName || entry.title || `Case ${jobId}`;
  let subtitle = `Case ${jobId} · Submitted ${formatTimestamp(entry.submittedAt)}`;
  // Appended only when present, unlike the table columns' unconditional
  // '—' fallback - most cases are never reviewed at all (no HITL pause),
  // so "Reviewed by —" would be permanent noise here rather than a
  // meaningful "missing data" signal.
  if (entry.ranBy) subtitle += ` · Ran by ${entry.ranBy}`;
  if (entry.reviewedBy) subtitle += ` · Reviewed by ${entry.reviewedBy}`;
  caseDetailSubtitle.textContent = subtitle;

  try {
    const inputsRes = await fetch(`/api/run/${jobId}/inputs`);
    const inputsData = await inputsRes.json();
    if (caseDetailJobId === jobId) renderReviewInputs(inputsData.inputs || {}, 'case-detail-inputs');
  } catch (err) {
    console.error('case detail inputs fetch error', err);
  }

  if (entry.status === 'WAITING_REVIEW') {
    // Reached only for a non-manager - a Compliance Officer viewing a
    // WAITING_REVIEW row never gets here (see openCaseDetail() above). No
    // output yet since the case is mid-decision, just the notice.
    if (caseDetailJobId === jobId) caseDetailReviewNotice.hidden = false;
    return;
  }

  startCaseDetailPolling(jobId);
}

// Polls this one job's status independently of any other poll loop in the
// app (New Intake's, or a different case-detail visit) - its own timer,
// its own elements. A COMPLETED or FAILED/CANCELLED/TIMED_OUT result stops
// itself after the first tick, same as an already-finished case would;
// anything else keeps polling exactly like New Intake's own pollStatus().
function startCaseDetailPolling(jobId) {
  startCaseDetailElapsedTimer();

  const tick = async () => {
    // A response can land after the user has already opened a different
    // case (or left this view) - drop it rather than clobbering whatever
    // this panel is showing now.
    if (caseDetailJobId !== jobId) return;
    try {
      const res = await fetch(`/api/run/${jobId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to check job status.');
      if (caseDetailJobId !== jobId) return;

      if (data.status === 'COMPLETED') {
        stopCaseDetailPolling();
        caseDetailStatusPanel.hidden = true;
        showResults(data.outputs, {
          panel: [caseDetailResultHeadline, caseDetailAuditCard],
          finalDecision: document.getElementById('case-detail-final-decision'),
          routingFlag: document.getElementById('case-detail-routing-flag'),
          auditSummary: document.getElementById('case-detail-audit-summary'),
          caseFile: document.getElementById('case-detail-case-file'),
          riskSignalTile: document.getElementById('case-detail-risk-signal-tile'),
          riskGaugeMarker: document.getElementById('case-detail-risk-gauge-marker'),
        });
      } else if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(data.status)) {
        stopCaseDetailPolling();
        caseDetailStatusPanel.hidden = true;
        showFailure(data, { panel: caseDetailErrorPanel, status: caseDetailErrorStatus, nodes: caseDetailErrorNodes });
      } else {
        caseDetailStatusPanel.hidden = false;
        renderProgress(data, CASE_DETAIL_PROGRESS_ELEMENTS);
      }
    } catch (err) {
      console.error('case detail poll error', err);
    }
  };

  tick();
  caseDetailPollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

// ============================================================
// Reports: real management-information stats, computed client-side from
// the same GET /api/case-history entries Case Queue already fetches (see
// fetchCaseHistory()/renderQueueStats() above) - no dedicated
// endpoint, consistent with that existing pattern; case history is a
// single small Redis blob, already loaded in full everywhere else. Scoped
// to the current calendar month throughout, so every tile/row describes
// the same period rather than mixing an all-time figure next to a
// monthly one.
//
// Risk Tier Mix (a prior sample-data placeholder) was dropped rather than
// built: a risk rating only ever appears, if at all, inside Opus's free-
// text auditSummary/caseFile output, neither of which is even persisted
// to case history (only finalDecision/routingFlag/status are) - no
// reliable structured source exists to build it from.
// ============================================================

// finalDecision/routingFlag are free strings straight from Opus's Output
// node - the exact value set has never been confirmed live (see README's
// own "possible values aren't confirmed" note). Same case-insensitive
// keyword matching already used for badge coloring elsewhere (see
// TONE_RULES above), not an exact-match enum.
const REPORTS_APPROVE_PATTERN = /approve|pass|clear|accept/i;
const REPORTS_REJECT_PATTERN = /reject|declin|deny|fail/i;

// Colors for the Automation Outcome donut - the same green/blue/dark
// three-color vocabulary QUEUE_STATUS_COLORS already established for a
// donut+legend breakdown elsewhere in this app (Case Queue), reused here
// for visual consistency even though the underlying statuses differ
// (outcome, not case state).
const REPORTS_OUTCOME_COLORS = {
  Approved: '#57d873',
  'Human Review': 'var(--color-blue)',
  Rejected: 'var(--color-text)',
};

// ADDED 2026-09-09: date-range picker for the Reports page (was fixed to
// "this calendar month" only). Each range also carries the immediately
// preceding, equal-length window so the stat tiles can show a real
// vs.-previous-period trend rather than a bare snapshot - see
// computeReportsStatsForWindow() below, run twice per render (once per
// window), not sample data.
function getReportsRangeBounds(range, now = new Date()) {
  if (range === 'lastMonth') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    return { start, end, prevStart, prevEnd: start, subtitle: 'Last calendar month, computed from real case history.' };
  }
  if (range === 'last90') {
    const dayMs = 24 * 60 * 60 * 1000;
    const end = now;
    const start = new Date(now.getTime() - 90 * dayMs);
    const prevEnd = start;
    const prevStart = new Date(start.getTime() - 90 * dayMs);
    return { start, end, prevStart, prevEnd, subtitle: 'The last 90 days, computed from real case history.' };
  }
  // default: thisMonth
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { start, end, prevStart, prevEnd: start, subtitle: 'This calendar month, computed from real case history.' };
}

// Same COMPLETED-only scoping computeReportsStats always used (an
// IN_PROGRESS/WAITING_REVIEW case has no decision or final turnaround
// yet, and a FAILED/CANCELLED/TIMED_OUT one isn't an automation
// decision, it's an error - neither belongs in the outcome/turnaround
// figures), just parameterized on an explicit [start, end) window instead
// of hardcoding "this calendar month" - see getReportsRangeBounds() above
// for the windows actually passed in.
function computeReportsStatsForWindow(entries, start, end) {
  const inWindow = entries.filter((e) => {
    const d = new Date(e.submittedAt);
    return !Number.isNaN(d.getTime()) && d >= start && d < end;
  });
  const completed = inWindow.filter((e) => e.status === 'COMPLETED');

  const avgTurnaroundMs = completed.length
    ? completed.reduce((sum, e) => sum + (new Date(e.completedAt).getTime() - new Date(e.submittedAt).getTime()), 0) / completed.length
    : null;

  // reviewedBy is our own reliable, structured signal for "a human
  // decided this" - set only when a real HITL review was actually
  // submitted (see server.js's POST /api/run/:id/review) - so it's
  // checked first and takes priority over finalDecision keyword-matching,
  // which only ever splits whatever's left into Approved/Rejected.
  // Anything finalDecision doesn't clearly match either pattern defaults
  // into Human Review too, rather than risk silently mis-bucketing an
  // unrecognized value as a confident Approved/Rejected.
  const outcomeCounts = { Approved: 0, 'Human Review': 0, Rejected: 0 };
  completed.forEach((e) => {
    if (e.reviewedBy) {
      outcomeCounts['Human Review'] += 1;
    } else if (e.finalDecision && REPORTS_APPROVE_PATTERN.test(e.finalDecision)) {
      outcomeCounts.Approved += 1;
    } else if (e.finalDecision && REPORTS_REJECT_PATTERN.test(e.finalDecision)) {
      outcomeCounts.Rejected += 1;
    } else {
      outcomeCounts['Human Review'] += 1;
    }
  });

  return {
    caseCount: inWindow.length,
    avgTurnaroundMs,
    completedCount: completed.length,
    outcomeCounts,
  };
}

// Real per-week case counts for the trend chart at the bottom of Reports -
// six rolling 7-day windows ending now, most recent (partial) week last.
// Independent of the range <select> above: this always looks back from
// today regardless of which reporting window is selected, same as a
// ticker showing recent activity alongside a period-specific summary.
function computeWeeklyCaseVolume(entries, weeks = 6, now = new Date()) {
  const dayMs = 24 * 60 * 60 * 1000;
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const end = new Date(now.getTime() - i * 7 * dayMs);
    const start = new Date(end.getTime() - 7 * dayMs);
    buckets.push({ start, end, count: 0 });
  }
  entries.forEach((e) => {
    const d = new Date(e.submittedAt);
    if (Number.isNaN(d.getTime())) return;
    const bucket = buckets.find((b) => d >= b.start && d < b.end);
    if (bucket) bucket.count += 1;
  });
  return buckets;
}

function formatReportsWeekRange(start, end) {
  const opts = { month: 'short', day: 'numeric' };
  const endInclusive = new Date(end.getTime() - 1);
  return `${start.toLocaleDateString(undefined, opts)}–${endInclusive.toLocaleDateString(undefined, opts)}`;
}

// goodWhen: 'up' when a larger current-vs-previous number is the
// favorable outcome (more cases handled), 'down' when a smaller one is
// (a faster turnaround). --good is always green regardless of whether
// the raw number went up or down - the arrow glyph shows the actual
// direction, the color shows whether that direction is the good one for
// this particular metric. --neutral (muted gray, never red - see this
// file's palette comment) covers both an unfavorable change and the
// no-prior-data/no-change cases alike.
function buildReportsTrendEl(delta, goodWhen, note) {
  const wrap = document.createElement('div');
  if (delta === null || delta === 0) {
    wrap.className = 'stat-tile-trend stat-tile-trend--neutral';
    wrap.textContent = note;
    return wrap;
  }
  const arrow = delta > 0 ? '▲' : '▼';
  const favorable = goodWhen === 'up' ? delta > 0 : delta < 0;
  wrap.className = `stat-tile-trend ${favorable ? 'stat-tile-trend--good' : 'stat-tile-trend--neutral'}`;
  const arrowSpan = document.createElement('span');
  arrowSpan.textContent = `${arrow} ${Math.abs(delta)}% `;
  const noteSpan = document.createElement('span');
  noteSpan.className = 'stat-tile-trend-note';
  noteSpan.textContent = note;
  wrap.append(arrowSpan, noteSpan);
  return wrap;
}

function renderReportsStatTiles(containerId, current, previous) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';

  const casesDelta = previous.caseCount ? Math.round(((current.caseCount - previous.caseCount) / previous.caseCount) * 100) : null;
  const casesNote = previous.caseCount ? `vs. previous period (${previous.caseCount})` : 'No prior-period cases to compare';

  const turnaroundDelta = (current.avgTurnaroundMs !== null && previous.avgTurnaroundMs)
    ? Math.round(((current.avgTurnaroundMs - previous.avgTurnaroundMs) / previous.avgTurnaroundMs) * 100)
    : null;
  const turnaroundNote = !previous.avgTurnaroundMs
    ? 'No prior-period figure to compare'
    : turnaroundDelta > 0
      ? 'Slower than previous period'
      : turnaroundDelta < 0
        ? 'Faster than previous period'
        : 'Same as previous period';

  const tiles = [
    { label: 'Cases', value: String(current.caseCount), delta: casesDelta, goodWhen: 'up', note: casesNote },
    {
      label: 'Avg. Turnaround',
      value: current.avgTurnaroundMs === null ? '—' : formatDuration(current.avgTurnaroundMs),
      delta: turnaroundDelta,
      goodWhen: 'down',
      note: turnaroundNote,
    },
  ];

  tiles.forEach((tile) => {
    const div = document.createElement('div');
    div.className = 'stat-tile';
    const label = document.createElement('div');
    label.className = 'stat-tile-label';
    label.textContent = tile.label;
    const value = document.createElement('div');
    value.className = 'stat-tile-value';
    value.textContent = tile.value;
    div.append(label, value, buildReportsTrendEl(tile.delta, tile.goodWhen, tile.note));
    el.appendChild(div);
  });
}

// Donut+legend for Automation Outcome, built the same way
// buildQueueDonutSvg()/buildQueueLegendRow() build Case Queue's - kept as
// separate functions (rather than generalizing those) so this page can't
// accidentally change Case Queue's rendering, and vice versa.
function buildReportsDonutSvg(outcomeCounts, completedCount) {
  const size = 120;
  const strokeWidth = 14;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = completedCount ? circumference * 0.015 : 0;
  const svgNS = 'http://www.w3.org/2000/svg';

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.classList.add('queue-donut-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `${outcomeCounts.Approved} approved, ${outcomeCounts['Human Review']} human review, ${outcomeCounts.Rejected} rejected, out of ${completedCount} completed cases`
  );

  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('cx', String(size / 2));
  track.setAttribute('cy', String(size / 2));
  track.setAttribute('r', String(radius));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'var(--color-surface-muted)');
  track.setAttribute('stroke-width', String(strokeWidth));
  svg.appendChild(track);

  let cumulative = 0;
  ['Approved', 'Human Review', 'Rejected'].forEach((key) => {
    const value = outcomeCounts[key];
    if (!value || !completedCount) return;
    const share = value / completedCount;
    const arcLength = Math.max(share * circumference - gap, 0);
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', String(size / 2));
    circle.setAttribute('cy', String(size / 2));
    circle.setAttribute('r', String(radius));
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', REPORTS_OUTCOME_COLORS[key]);
    circle.setAttribute('stroke-width', String(strokeWidth));
    circle.setAttribute('stroke-linecap', 'round');
    circle.setAttribute('stroke-dasharray', `${arcLength} ${circumference - arcLength}`);
    circle.setAttribute('stroke-dashoffset', String(-cumulative));
    circle.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
    svg.appendChild(circle);
    cumulative += share * circumference;
  });

  return svg;
}

function buildReportsLegendRow(color, label, value, total) {
  const row = document.createElement('div');
  row.className = 'queue-legend-row';

  const dot = document.createElement('span');
  dot.className = 'queue-legend-dot';
  dot.style.background = color;

  const labelEl = document.createElement('span');
  labelEl.className = 'queue-legend-label';
  labelEl.textContent = label;

  const pctEl = document.createElement('span');
  pctEl.className = 'queue-legend-pct';
  pctEl.textContent = total ? `${Math.round((value / total) * 100)}%` : '—';

  const countEl = document.createElement('span');
  countEl.className = 'queue-legend-count';
  countEl.textContent = String(value);

  row.append(dot, labelEl, pctEl, countEl);
  return row;
}

function buildReportsBreakdown(outcomeCounts, completedCount) {
  const wrap = document.createElement('div');
  wrap.className = 'queue-breakdown';

  const donutWrap = document.createElement('div');
  donutWrap.className = 'queue-donut-wrap';
  donutWrap.appendChild(buildReportsDonutSvg(outcomeCounts, completedCount));

  const center = document.createElement('div');
  center.className = 'queue-donut-center';
  const centerValue = document.createElement('div');
  centerValue.className = 'queue-donut-center-value';
  centerValue.textContent = String(completedCount);
  const centerLabel = document.createElement('div');
  centerLabel.className = 'queue-donut-center-label';
  centerLabel.textContent = 'completed';
  center.append(centerValue, centerLabel);
  donutWrap.appendChild(center);

  const legend = document.createElement('div');
  legend.className = 'queue-legend';
  legend.appendChild(buildReportsLegendRow(REPORTS_OUTCOME_COLORS.Approved, 'Approved', outcomeCounts.Approved, completedCount));
  legend.appendChild(buildReportsLegendRow(REPORTS_OUTCOME_COLORS['Human Review'], 'Human Review', outcomeCounts['Human Review'], completedCount));
  legend.appendChild(buildReportsLegendRow(REPORTS_OUTCOME_COLORS.Rejected, 'Rejected', outcomeCounts.Rejected, completedCount));

  wrap.append(donutWrap, legend);
  return wrap;
}

function renderReportsTrendChart(containerId, buckets) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  buckets.forEach((bucket, i) => {
    const col = document.createElement('div');
    col.className = 'trend-bar-col';

    const valueEl = document.createElement('div');
    valueEl.className = 'trend-bar-value';
    valueEl.textContent = String(bucket.count);

    const bar = document.createElement('div');
    bar.className = i === buckets.length - 1 ? 'trend-bar trend-bar--current' : 'trend-bar';
    // Floors at 4% so a genuine 0-count week still shows a sliver rather
    // than disappearing entirely - a missing bar reads as "no data", not
    // "zero cases", at this size.
    const heightPct = Math.max(4, Math.round((bucket.count / maxCount) * 100));
    bar.style.height = `${heightPct}%`;

    const labelEl = document.createElement('div');
    labelEl.className = 'trend-bar-label';
    labelEl.textContent = formatReportsWeekRange(bucket.start, bucket.end);

    col.append(valueEl, bar, labelEl);
    el.appendChild(col);
  });
}

// Cached so the range <select> can re-render instantly from data already
// in hand instead of re-fetching case history on every change - see
// initReportsRangeSelect() below. Repopulated on every real visit to the
// Reports tab by renderReports() (called from loadViewData()).
let reportsEntriesCache = [];
let reportsRange = 'thisMonth';

function renderReportsContent() {
  const statsEl = document.getElementById('reports-stats');
  const breakdownsEl = document.getElementById('reports-breakdowns');
  if (!statsEl || !breakdownsEl) return;

  const bounds = getReportsRangeBounds(reportsRange);
  const subtitleEl = document.getElementById('reports-subtitle');
  if (subtitleEl) subtitleEl.textContent = bounds.subtitle;

  const current = computeReportsStatsForWindow(reportsEntriesCache, bounds.start, bounds.end);
  const previous = computeReportsStatsForWindow(reportsEntriesCache, bounds.prevStart, bounds.prevEnd);

  renderReportsStatTiles('reports-stats', current, previous);

  breakdownsEl.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'report-block report-block--donut';
  const title = document.createElement('div');
  title.className = 'report-block-title';
  title.textContent = 'Automation Outcome';
  block.append(title, buildReportsBreakdown(current.outcomeCounts, current.completedCount));
  breakdownsEl.appendChild(block);

  renderReportsTrendChart('reports-trend-chart', computeWeeklyCaseVolume(reportsEntriesCache));
}

async function renderReports() {
  const statsEl = document.getElementById('reports-stats');
  const breakdownsEl = document.getElementById('reports-breakdowns');
  if (!statsEl || !breakdownsEl) return;

  try {
    reportsEntriesCache = await fetchCaseHistory();
  } catch (err) {
    statsEl.textContent = 'Could not load report data.';
    breakdownsEl.innerHTML = '';
    return;
  }

  renderReportsContent();
}

(function initReportsRangeSelect() {
  const select = document.getElementById('reports-range-select');
  if (!select) return;
  select.addEventListener('change', () => {
    reportsRange = select.value;
    renderReportsContent();
  });
})();

// ============================================================
// Screening policy: one saved document applied to every case, replacing
// what used to be a raw JSON textarea filled in per case on the intake
// form. server.js owns the storage (Redis, seeded from
// default-screening-policy.json) and applies it in POST /api/run, so
// nothing here ever has to send it - the editor below only reads/writes
// it through GET and PUT /api/screening-policy.
//
// The editor itself lives directly on New Intake (#intake-policy-editor,
// inside the same <form> as Application Form, using the same
// .form-section/.field styling) rather than tucked behind a link to a
// separate Settings page - see revealIntakeForm() above, which is what
// calls renderScreeningPolicyEditor(). Editable by either role (KYC
// Agent or Compliance Officer) - see buildPolicyEditor()'s own comment
// on why `disabled` is still there but always false.
// ============================================================

async function fetchScreeningPolicy() {
  const res = await fetch('/api/screening-policy');
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

// ------------------------------------------------------------------
// Editor internals. State lives in these module-level variables (names
// kept as settingsPolicy* from when this lived in Settings) rather than
// being threaded through every helper - there's only ever one instance
// of this editor on the page, the same reasoning behind
// currentReviewJobId/reviewCanApprove for the review panel elsewhere in
// this file.
//
// settingsPolicyDraft is mutated directly, field by field, by the input
// handlers below rather than rebuilding the whole form on every
// keystroke - a full re-render on every input event would drop focus
// out of whatever field the person is still typing in. Add/remove-row
// actions are the exception: those DO re-render (just the affected
// list), since there's no keystroke-in-flight to protect and it's the
// simplest way to keep row indices correct.
// ------------------------------------------------------------------
let settingsPolicyDraft = null;
let settingsPolicyBaseline = null; // last-saved (or last-loaded) copy - Discard resets to this
let settingsPolicyDirty = false;
let settingsPolicySaving = false;

// Collapsed by default (see buildPolicyEditor()'s <details> wrapper
// below) - a full risk-factor catalog/decision-matrix editor isn't
// something most people running a case need to see every time, matching
// a reference design Arsany shared (2026-09-09): a one-line summary
// with a "View policy" disclosure instead of everything open by default.
// Survives Save/Discard's buildPolicyEditor() re-render (both read this
// instead of hard-coding closed) since neither should collapse a policy
// the person had deliberately opened to edit.
let policyEditorExpanded = false;

const RISK_FACTOR_CATEGORY_LABELS = {
  customer: 'Customer',
  geography: 'Geography',
  occupation_industry: 'Occupation / Industry',
  document_integrity: 'Document Integrity',
  product_channel: 'Product / Channel',
};

const DECISION_MATRIX_LABELS = {
  PROHIBITED_present: 'A PROHIBITED factor is present',
  HIGH_present: 'A HIGH factor is present',
  two_or_more_MEDIUM: 'Two or more MEDIUM factors',
  single_MEDIUM: 'A single MEDIUM factor',
  all_LOW_or_none: 'All factors LOW, or none present',
};

// The fixed vocabulary the default policy's risk_factor_catalog already
// uses. Not enforced server-side (nothing in this policy is - see
// server.js's PUT /api/screening-policy comment), just what the
// severity <select> offers. A saved value outside this list (from an
// older build or an external edit) is added as an extra option instead
// of being silently coerced to something else, so opening the editor
// can never quietly change data nobody touched.
const SEVERITY_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'PROHIBITED'];

function severityTone(sev) {
  if (sev === 'LOW') return 'tone-green';
  if (sev === 'MEDIUM') return 'tone-yellow';
  if (sev === 'HIGH' || sev === 'PROHIBITED') return 'tone-pink';
  return 'tone-neutral';
}

function humanizeKey(key) {
  return String(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function markPolicyDirty() {
  settingsPolicyDirty = true;
  updatePolicyEditorFooter();
}

function updatePolicyEditorFooter() {
  const statusEl = document.getElementById('policy-editor-status');
  const saveBtn = document.getElementById('policy-save-btn');
  const discardBtn = document.getElementById('policy-discard-btn');
  if (!statusEl || !saveBtn || !discardBtn) return;

  saveBtn.disabled = !settingsPolicyDirty || settingsPolicySaving;
  discardBtn.disabled = !settingsPolicyDirty || settingsPolicySaving;

  if (settingsPolicySaving) {
    statusEl.textContent = 'Saving…';
    statusEl.className = 'policy-editor-status';
  } else if (settingsPolicyDirty) {
    statusEl.textContent = 'Unsaved changes';
    statusEl.className = 'policy-editor-status is-dirty';
  } else {
    statusEl.textContent = '';
    statusEl.className = 'policy-editor-status';
  }
}

// Drops rows/entries that are entirely blank (an add-then-abandon) and
// trims every string field - run once, on a deep clone, right before
// Save. Working from a clone means a failed save can't leave the form
// the person is still looking at silently trimmed/pruned out from under
// them.
function cleanedPolicyForSave(policy) {
  const cleaned = JSON.parse(JSON.stringify(policy));
  const trim = (v) => (typeof v === 'string' ? v.trim() : v);

  cleaned.policy_name = trim(cleaned.policy_name);
  cleaned.policy_version = trim(cleaned.policy_version);
  cleaned.issuing_authority = trim(cleaned.issuing_authority);
  cleaned.framework_overview = trim(cleaned.framework_overview);

  Object.values(cleaned.risk_categories || {}).forEach((cat) => {
    cat.description = trim(cat.description);
    cat.monitoring = trim(cat.monitoring);
  });

  Object.keys(cleaned.risk_factor_catalog || {}).forEach((catKey) => {
    cleaned.risk_factor_catalog[catKey] = (cleaned.risk_factor_catalog[catKey] || [])
      .map((f) => ({
        factor_id: trim(f.factor_id),
        name: trim(f.name),
        severity: f.severity,
        description: trim(f.description),
      }))
      .filter((f) => f.factor_id || f.name || f.description);
  });

  Object.keys(cleaned.decision_matrix || {}).forEach((key) => {
    cleaned.decision_matrix[key] = trim(cleaned.decision_matrix[key]);
  });

  cleaned.edd_requirements_if_referred = (cleaned.edd_requirements_if_referred || [])
    .map(trim)
    .filter(Boolean);
  cleaned.reporting_obligations = (cleaned.reporting_obligations || []).map(trim).filter(Boolean);

  return cleaned;
}

// Shared builder for every plain label+input/textarea field in the
// editor. value === undefined/null becomes '' - deliberately not
// `value || ''`, which would also blank out a legitimate 0 (e.g.
// Renewal Period (years)).
function buildLabeledInput({ label, value, type, textarea, rows, disabled, onInput }) {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  const input = document.createElement(textarea ? 'textarea' : 'input');
  if (!textarea) input.type = type || 'text';
  if (textarea && rows) input.rows = rows;
  input.value = value === undefined || value === null ? '' : value;
  input.disabled = Boolean(disabled);
  input.addEventListener('input', () => {
    onInput(input.value);
    markPolicyDirty();
  });
  wrap.appendChild(input);
  return wrap;
}

function buildRemoveButton(onClick, ariaLabel) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'row-remove-btn';
  btn.textContent = '✕';
  btn.setAttribute('aria-label', ariaLabel || 'Remove');
  btn.addEventListener('click', onClick);
  return btn;
}

// Rebuilds one category's rows + its "+ Add risk factor" button.
// `factors` is the live array from settingsPolicyDraft.risk_factor_catalog
// - add/remove mutate it in place (push/splice) so the draft never falls
// out of sync with what's on screen.
function renderFactorCategory(listEl, catKey, factors, disabled) {
  listEl.innerHTML = '';

  factors.forEach((factor, idx) => {
    const row = document.createElement('div');
    row.className = 'factor-row';

    const top = document.createElement('div');
    top.className = 'factor-row-top';

    const idField = buildLabeledInput({
      label: 'ID',
      value: factor.factor_id,
      disabled,
      onInput: (v) => { factor.factor_id = v; },
    });
    idField.classList.add('factor-field-id');

    const nameField = buildLabeledInput({
      label: 'Name',
      value: factor.name,
      disabled,
      onInput: (v) => { factor.name = v; },
    });
    nameField.classList.add('factor-field-name');

    const sevWrap = document.createElement('div');
    sevWrap.className = 'field factor-field-severity';
    const sevLabel = document.createElement('label');
    sevLabel.textContent = 'Severity';
    const sevSelect = document.createElement('select');
    const levels = !factor.severity || SEVERITY_LEVELS.includes(factor.severity)
      ? SEVERITY_LEVELS
      : [...SEVERITY_LEVELS, factor.severity];
    levels.forEach((lvl) => {
      const opt = document.createElement('option');
      opt.value = lvl;
      opt.textContent = lvl;
      if (factor.severity === lvl) opt.selected = true;
      sevSelect.appendChild(opt);
    });
    sevSelect.disabled = disabled;
    sevSelect.addEventListener('change', () => {
      factor.severity = sevSelect.value;
      markPolicyDirty();
    });
    sevWrap.append(sevLabel, sevSelect);

    top.append(idField, nameField, sevWrap);

    if (!disabled) {
      top.appendChild(buildRemoveButton(() => {
        factors.splice(idx, 1);
        renderFactorCategory(listEl, catKey, factors, disabled);
        markPolicyDirty();
      }, `Remove ${factor.name || 'risk factor'}`));
    }

    row.appendChild(top);

    const descField = buildLabeledInput({
      label: 'Description',
      value: factor.description,
      textarea: true,
      rows: 2,
      disabled,
      onInput: (v) => { factor.description = v; },
    });
    descField.classList.add('factor-field-description');
    row.appendChild(descField);

    listEl.appendChild(row);
  });

  if (!disabled) {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'add-row-btn';
    addBtn.textContent = '+ Add risk factor';
    addBtn.addEventListener('click', () => {
      factors.push({ factor_id: '', name: '', severity: 'LOW', description: '' });
      renderFactorCategory(listEl, catKey, factors, disabled);
      markPolicyDirty();
      const rows = listEl.querySelectorAll('.factor-row');
      rows[rows.length - 1]?.querySelector('input')?.focus();
    });
    listEl.appendChild(addBtn);
  }
}

// Same add/remove-row pattern as renderFactorCategory, for the two plain
// string-array sections (EDD requirements, reporting obligations).
function renderStringList(listEl, items, disabled, placeholder) {
  listEl.innerHTML = '';

  items.forEach((value, idx) => {
    const row = document.createElement('div');
    row.className = 'string-list-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    input.disabled = disabled;
    input.addEventListener('input', () => {
      items[idx] = input.value;
      markPolicyDirty();
    });
    row.appendChild(input);

    if (!disabled) {
      row.appendChild(buildRemoveButton(() => {
        items.splice(idx, 1);
        renderStringList(listEl, items, disabled, placeholder);
        markPolicyDirty();
      }, `Remove ${placeholder || 'item'}`));
    }

    listEl.appendChild(row);
  });

  if (!disabled) {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'add-row-btn';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => {
      items.push('');
      renderStringList(listEl, items, disabled, placeholder);
      markPolicyDirty();
      const rows = listEl.querySelectorAll('.string-list-row input');
      rows[rows.length - 1]?.focus();
    });
    listEl.appendChild(addBtn);
  }
}

// Builds the full editor into `el` from the current settingsPolicyDraft.
// Called on initial load and again after Save/Discard, where it's the
// simplest way to get every field's closures pointed at the right
// (possibly now-replaced) draft object.
function buildPolicyEditor(el, updatedAt, updatedBy) {
  el.innerHTML = '';
  // Editable by whoever is running the case (KYC Agent or Compliance
  // Officer) - it used to be a per-case field anyone filled in, and that
  // stays true here even though it's now one saved document. `disabled`
  // is kept (rather than ripping the parameter out of every helper
  // below) as the one place to restore a role restriction later if
  // that's ever wanted again - see server.js's PUT /api/screening-policy
  // comment, which already notes there's no server-side check either
  // way, so this was always UI intent only.
  const disabled = false;
  const draft = settingsPolicyDraft;

  // --- Collapsed-by-default summary card. Everything below (Overview
  // through the Save/Discard footer) goes into `body`, not `el` directly
  // - <details> only shows it once expanded. Native <details>/<summary>
  // rather than a hand-rolled toggle, same as the existing "View full
  // case file (JSON)" / "View raw application JSON" disclosures
  // elsewhere - just with its own header markup instead of the plain
  // text summary those use, so `.policy-summary-header` below has to
  // out-specificity the generic `details summary` rule that styles
  // those (a single class beats two type selectors, so this is safe
  // without !important). -->
  const details = document.createElement('details');
  details.className = 'policy-summary';
  details.open = policyEditorExpanded;
  details.addEventListener('toggle', () => {
    policyEditorExpanded = details.open;
    toggleLabel.textContent = details.open ? 'Hide policy' : 'View policy';
  });

  const summary = document.createElement('summary');
  summary.className = 'policy-summary-header';

  const icon = document.createElement('div');
  icon.className = 'policy-summary-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 2.8v5.4c0 4.8-3 8.9-7 10.3-4-1.4-7-5.5-7-10.3V5.8L12 3z"/></svg>';

  const textWrap = document.createElement('div');
  textWrap.className = 'policy-summary-text';
  const titleEl = document.createElement('div');
  titleEl.className = 'policy-summary-title';
  titleEl.textContent = `Screening policy: ${draft.policy_name || 'Untitled policy'}`;

  // Real counts from the actual catalog, not a static blurb - a category
  // with an empty array still counts as a category (matches
  // RISK_FACTOR_CATEGORY_LABELS' fixed 5 today), an edited/added factor
  // changes this line the next time it renders.
  const factorCount = Object.values(draft.risk_factor_catalog || {}).reduce(
    (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
    0
  );
  const categoryCount = Object.keys(draft.risk_factor_catalog || {}).length;
  const subtitleEl = document.createElement('div');
  subtitleEl.className = 'policy-summary-subtitle';
  subtitleEl.textContent = `Version ${draft.policy_version || '—'} · ${factorCount} risk factor${factorCount === 1 ? '' : 's'} across ${categoryCount} categor${categoryCount === 1 ? 'y' : 'ies'} · this case will be checked against it`;
  textWrap.append(titleEl, subtitleEl);

  const toggleWrap = document.createElement('div');
  toggleWrap.className = 'policy-summary-toggle';
  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'policy-summary-toggle-label';
  toggleLabel.textContent = policyEditorExpanded ? 'Hide policy' : 'View policy';
  const chevron = document.createElement('span');
  chevron.className = 'policy-summary-chevron';
  chevron.textContent = '⌄';
  toggleWrap.append(toggleLabel, chevron);

  summary.append(icon, textWrap, toggleWrap);
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'policy-summary-body';
  details.appendChild(body);
  el.appendChild(details);

  // --- Overview ---
  const overviewSection = document.createElement('div');
  overviewSection.className = 'form-section';
  const overviewTitle = document.createElement('h3');
  overviewTitle.className = 'form-section-title';
  overviewTitle.textContent = 'Overview';
  overviewSection.appendChild(overviewTitle);

  const nameVersionAuthorityRow = document.createElement('div');
  nameVersionAuthorityRow.className = 'field-row field-row-3';
  nameVersionAuthorityRow.appendChild(buildLabeledInput({
    label: 'Policy Name',
    value: draft.policy_name,
    disabled,
    onInput: (v) => { draft.policy_name = v; },
  }));
  nameVersionAuthorityRow.appendChild(buildLabeledInput({
    label: 'Version',
    value: draft.policy_version,
    disabled,
    onInput: (v) => { draft.policy_version = v; },
  }));
  nameVersionAuthorityRow.appendChild(buildLabeledInput({
    label: 'Issuing Authority',
    value: draft.issuing_authority,
    disabled,
    onInput: (v) => { draft.issuing_authority = v; },
  }));
  overviewSection.appendChild(nameVersionAuthorityRow);

  overviewSection.appendChild(buildLabeledInput({
    label: 'Framework Overview',
    value: draft.framework_overview,
    textarea: true,
    rows: 3,
    disabled,
    onInput: (v) => { draft.framework_overview = v; },
  }));
  body.appendChild(overviewSection);

  // --- Risk categories (LOW / MEDIUM / HIGH) ---
  const catSection = document.createElement('div');
  catSection.className = 'form-section';
  const catTitle = document.createElement('h3');
  catTitle.className = 'form-section-title';
  catTitle.textContent = 'Risk Categories';
  catSection.appendChild(catTitle);

  const catGrid = document.createElement('div');
  catGrid.className = 'risk-category-grid';
  Object.keys(draft.risk_categories || {}).forEach((catKey) => {
    const cat = draft.risk_categories[catKey];
    const block = document.createElement('div');
    block.className = 'risk-category-block';

    const header = document.createElement('div');
    header.className = 'risk-category-block-header';
    const badge = document.createElement('span');
    badge.className = `badge ${severityTone(catKey)}`;
    badge.textContent = catKey;
    header.appendChild(badge);
    block.appendChild(header);

    block.appendChild(buildLabeledInput({
      label: 'Description',
      value: cat.description,
      textarea: true,
      rows: 2,
      disabled,
      onInput: (v) => { cat.description = v; },
    }));
    block.appendChild(buildLabeledInput({
      label: 'Renewal Period (years)',
      value: cat.renewal_period_years,
      type: 'number',
      disabled,
      onInput: (v) => { cat.renewal_period_years = v === '' ? '' : Number(v); },
    }));
    block.appendChild(buildLabeledInput({
      label: 'Monitoring',
      value: cat.monitoring,
      disabled,
      onInput: (v) => { cat.monitoring = v; },
    }));

    catGrid.appendChild(block);
  });
  catSection.appendChild(catGrid);
  body.appendChild(catSection);

  // --- Risk factor catalog: the add/remove-row editor itself ---
  const factorSection = document.createElement('div');
  factorSection.className = 'form-section';
  const factorTitle = document.createElement('h3');
  factorTitle.className = 'form-section-title';
  factorTitle.textContent = 'Risk Factor Catalog';
  factorSection.appendChild(factorTitle);

  Object.keys(draft.risk_factor_catalog || {}).forEach((catKey) => {
    if (!Array.isArray(draft.risk_factor_catalog[catKey])) draft.risk_factor_catalog[catKey] = [];

    const catWrap = document.createElement('div');
    catWrap.className = 'factor-category';
    const catHeading = document.createElement('h4');
    catHeading.className = 'factor-category-title';
    catHeading.textContent = RISK_FACTOR_CATEGORY_LABELS[catKey] || humanizeKey(catKey);
    catWrap.appendChild(catHeading);

    const list = document.createElement('div');
    list.className = 'factor-list';
    catWrap.appendChild(list);
    renderFactorCategory(list, catKey, draft.risk_factor_catalog[catKey], disabled);

    factorSection.appendChild(catWrap);
  });
  body.appendChild(factorSection);

  // --- Decision matrix ---
  const matrixSection = document.createElement('div');
  matrixSection.className = 'form-section';
  const matrixTitle = document.createElement('h3');
  matrixTitle.className = 'form-section-title';
  matrixTitle.textContent = 'Decision Matrix';
  matrixSection.appendChild(matrixTitle);

  Object.keys(draft.decision_matrix || {}).forEach((key) => {
    matrixSection.appendChild(buildLabeledInput({
      label: DECISION_MATRIX_LABELS[key] || humanizeKey(key),
      value: draft.decision_matrix[key],
      textarea: true,
      rows: 2,
      disabled,
      onInput: (v) => { draft.decision_matrix[key] = v; },
    }));
  });
  body.appendChild(matrixSection);

  // --- EDD requirements ---
  const eddSection = document.createElement('div');
  eddSection.className = 'form-section';
  const eddTitle = document.createElement('h3');
  eddTitle.className = 'form-section-title';
  eddTitle.textContent = 'EDD Requirements if Referred';
  eddSection.appendChild(eddTitle);
  if (!Array.isArray(draft.edd_requirements_if_referred)) draft.edd_requirements_if_referred = [];
  const eddList = document.createElement('div');
  eddList.className = 'string-list';
  eddSection.appendChild(eddList);
  renderStringList(eddList, draft.edd_requirements_if_referred, disabled, 'Requirement');
  body.appendChild(eddSection);

  // --- Reporting obligations ---
  const reportSection = document.createElement('div');
  reportSection.className = 'form-section';
  const reportTitle = document.createElement('h3');
  reportTitle.className = 'form-section-title';
  reportTitle.textContent = 'Reporting Obligations';
  reportSection.appendChild(reportTitle);
  if (!Array.isArray(draft.reporting_obligations)) draft.reporting_obligations = [];
  const reportList = document.createElement('div');
  reportList.className = 'string-list';
  reportSection.appendChild(reportList);
  renderStringList(reportList, draft.reporting_obligations, disabled, 'Obligation');
  body.appendChild(reportSection);

  // --- Footer: last-updated stamp, and Save/Discard for a Compliance
  //     Officer only (see the comment at the top of this section) ---
  const footer = document.createElement('div');
  footer.className = 'form-section policy-editor-footer';

  const meta = document.createElement('div');
  meta.className = 'policy-editor-meta';
  meta.textContent = updatedAt
    ? `Last updated ${formatTimestamp(updatedAt)}${updatedBy ? ` by ${updatedBy}` : ''}`
    : 'Using packaged default — not yet saved.';
  footer.appendChild(meta);

  if (!disabled) {
    const status = document.createElement('div');
    status.id = 'policy-editor-status';
    status.className = 'policy-editor-status';
    footer.appendChild(status);

    const errorEl = document.createElement('div');
    errorEl.id = 'policy-editor-error';
    errorEl.className = 'error-banner';
    errorEl.hidden = true;
    footer.appendChild(errorEl);

    const btnRow = document.createElement('div');
    btnRow.className = 'policy-editor-buttons';

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.id = 'policy-discard-btn';
    discardBtn.className = 'btn policy-editor-btn policy-editor-btn--secondary';
    discardBtn.textContent = 'Discard changes';
    discardBtn.disabled = true;
    discardBtn.addEventListener('click', () => {
      settingsPolicyDraft = JSON.parse(JSON.stringify(settingsPolicyBaseline));
      settingsPolicyDirty = false;
      buildPolicyEditor(el, updatedAt, updatedBy);
    });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.id = 'policy-save-btn';
    saveBtn.className = 'btn btn-primary policy-editor-btn';
    saveBtn.textContent = 'Save policy';
    saveBtn.disabled = true;
    saveBtn.addEventListener('click', async () => {
      errorEl.hidden = true;
      const cleaned = cleanedPolicyForSave(settingsPolicyDraft);
      if (!cleaned.policy_name) {
        errorEl.textContent = 'Policy Name is required.';
        errorEl.hidden = false;
        return;
      }

      settingsPolicySaving = true;
      saveBtn.textContent = 'Saving…';
      updatePolicyEditorFooter();

      try {
        const res = await fetch('/api/screening-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ policy: cleaned, updatedBy: currentUserName }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save screening policy.');

        settingsPolicyBaseline = cleaned;
        settingsPolicyDraft = JSON.parse(JSON.stringify(cleaned));
        settingsPolicyDirty = false;
        settingsPolicySaving = false;
        buildPolicyEditor(el, data.updatedAt, data.updatedBy);
      } catch (err) {
        settingsPolicySaving = false;
        saveBtn.textContent = 'Save policy';
        updatePolicyEditorFooter();
        errorEl.textContent = err.message || 'Failed to save screening policy.';
        errorEl.hidden = false;
      }
    });

    btnRow.append(discardBtn, saveBtn);
    footer.appendChild(btnRow);
  }

  body.appendChild(footer);
  updatePolicyEditorFooter();
}

// Called once from revealIntakeForm() (see the section comment above) -
// New Intake's panel is never torn down and rebuilt on tab-switch (see
// switchToView()), so there's no equivalent of viewLoaded's once-per-load
// guard to rely on here; revealIntakeForm() itself already only runs once
// per role-gate pass, which is enough.
async function renderScreeningPolicyEditor() {
  const el = document.getElementById('intake-policy-editor');
  if (!el) return;
  el.textContent = 'Loading…';

  try {
    const { policy, updatedAt, updatedBy } = await fetchScreeningPolicy();
    settingsPolicyBaseline = policy;
    settingsPolicyDraft = JSON.parse(JSON.stringify(policy));
    settingsPolicyDirty = false;
    settingsPolicySaving = false;
    buildPolicyEditor(el, updatedAt, updatedBy);
  } catch (err) {
    el.textContent = 'Could not load the screening policy.';
  }
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
  currentUserName = null;
  // Dropped alongside the in-memory values, so "Back" really does force
  // re-verification rather than the next refresh silently restoring the
  // role that was just stepped out of.
  clearRoleSession();
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
  // Deliberate reset back to New Intake, same as always - unlike the
  // page-load bootstrap below, "back to role selection" does not restore
  // whichever tab/case was open (that would defeat the point of backing
  // out). Still clears the view/case URL params rather than leaving them
  // stale, since intake is where this is headed.
  setViewInUrl('intake');
  openRoleGate(revealIntakeForm);
}

backToRoleBtn.addEventListener('click', backToRoleSelection);

// ADDED 2026-09-11. Restores whichever tab or detail panel was open
// before a same-tab refresh, from the `view` (and, for the two detail
// panels, `case`) query params switchToView()/loadAndShowCaseDetail()/
// openReviewLogDetail() keep in the URL (see setViewInUrl() near
// setJobIdInUrl() above). Only called from the page-load bootstrap right
// below, never from backToRoleSelection()'s re-verification - that one is
// an explicit reset, not a refresh, and should still land on New Intake.
async function restoreViewFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  if (!view) return;

  // A `view` param at all means this load is either a refresh past the
  // splash or a shared/bookmarked link straight into the app - either way,
  // skip the splash the same way resumeJobFromUrl() does for a `job` param.
  landingView.hidden = true;
  appView.hidden = false;
  markLandingDismissed();

  if (view === 'intake') return; // already the default view, nothing more to do

  if (view === 'casedetail' || view === 'reviewlogdetail') {
    const caseId = params.get('case');
    if (!caseId) return; // no case id to rebuild the panel from - stay on New Intake
    try {
      const entries = await fetchCaseHistory();
      const entry = entries.find((e) => e.jobId === caseId);
      // Entry gone (deleted/archived since) or a review-log link for a
      // case that turns out to have no saved review record - either way,
      // fall back to staying on New Intake rather than showing a broken
      // half-populated panel.
      if (!entry) return;
      if (view === 'casedetail') {
        loadAndShowCaseDetail(entry.jobId, entry);
      } else if (entry.reviewRecord) {
        openReviewLogDetail(entry);
      }
    } catch (err) {
      console.error('view restore error', err);
    }
    return;
  }

  // Plain tabs (queue/pending/reports/settings) - switchToView() already
  // guards against an unrecognized view name, and applyRoleRestrictions()
  // (already run by the caller below) has already redirected to Case
  // Queue if this role can't see the requested tab, so this can't
  // override that with something the current role isn't allowed to see.
  switchToView(view);
}

// The page-load role decision (see the note where openRoleGate() used to
// be called, near the top). Runs before resumeJobFromUrl() below to keep
// the original ordering: decide the role first, then pick a job back up.
//
// A restored session takes exactly the same two steps the verify-success
// branch takes - applyRoleRestrictions() then revealIntakeForm() - rather
// than reimplementing what "being verified" means. restoreViewFromUrl()
// then puts back whichever tab/case was actually open before the refresh
// (see its own comment above) - UPDATED 2026-09-11: the landing view used
// to be shown unconditionally at this point every time; it no longer is,
// see wasLandingDismissed() near the top of this file.
(function bootstrapRoleGate() {
  if (restoreRoleSession()) {
    applyRoleRestrictions();
    revealIntakeForm();
    restoreViewFromUrl();
  } else {
    openRoleGate(() => {
      revealIntakeForm();
      restoreViewFromUrl();
    });
  }
})();

// Resume watching an in-flight job after a same-tab refresh, if the URL
// still carries a ?job= param from before the reload. Skips straight past
// the landing view/upload form to the status panel and re-enters the same
// poll loop a fresh submission would have started.
(function resumeJobFromUrl() {
  const jobId = new URLSearchParams(window.location.search).get('job');
  if (!jobId) return;

  landingView.hidden = true;
  appView.hidden = false;
  markLandingDismissed();
  setBusy(true);
  resultsPanel.hidden = true;
  errorPanel.hidden = true;
  statusPanel.hidden = false;
  statusText.textContent = 'Resuming — reconnecting to the running workflow…';
  resetProgress();
  resetReview();
  pollStatus(jobId);
})();
