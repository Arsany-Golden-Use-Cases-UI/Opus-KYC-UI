// ADDED 2026-09-11 - one-off correction for case-history entries whose
// `completedAt` was stamped wrong by the bug described in server.js's
// fetchOpusFinishedAt() comment: completedAt used to be set to whatever
// moment this server's /api/run/:id endpoint happened to get polled and
// notice a job was done, not the moment the job actually finished on
// Opus's side. That bug is fixed going forward (every future poll now
// pulls the real finishedAt from Opus - see server.js), but every entry
// already sitting in Redis from before the fix still carries its old,
// inflated completedAt (Case Queue's Duration column and Reports' Avg.
// Turnaround are both computed client-side from submittedAt/completedAt,
// so those numbers are still wrong for old entries until this is run).
//
// This script re-fetches GET /job/{id} from Opus for every COMPLETED/
// FAILED/CANCELLED/TIMED_OUT entry in case history and corrects its
// completedAt to Opus's own `finishedAt`. Run ONCE after deploying the
// server.js fix - it's idempotent (safe to run again; entries already
// matching Opus's finishedAt are simply left alone) but there's no
// ongoing reason to run it repeatedly once history is caught up.
//
// USAGE (from the project root, same folder as server.js/.env):
//   node scripts/backfill-case-durations.js            -> dry run: prints
//     what WOULD change, writes nothing
//   node scripts/backfill-case-durations.js --apply     -> actually
//     writes the corrected history back to Redis
//
// Uses the exact same env vars server.js does (KV_REST_API_URL/TOKEN,
// OPUS_BASE_URL, OPUS_SERVICE_KEY), loaded from .env via dotenv - run
// this from a machine that has that same .env, same as server.js itself.
require('dotenv').config();
const { Redis } = require('@upstash/redis');

const OPUS_BASE_URL = process.env.OPUS_BASE_URL || 'https://operator.opus.com';
const OPUS_SERVICE_KEY = process.env.OPUS_SERVICE_KEY;
const HISTORY_KEY = 'case-history';
const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const APPLY = process.argv.includes('--apply');

if (!OPUS_SERVICE_KEY) {
  console.error('OPUS_SERVICE_KEY is not set - copy .env.example to .env and fill it in (same as server.js requires).');
  process.exit(1);
}
if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error('KV_REST_API_URL / KV_REST_API_TOKEN are not set - same Redis env vars server.js requires.');
  process.exit(1);
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Same retry-on-429/5xx behavior as server.js's own opusFetch(), kept
// separate rather than imported since server.js doesn't export it.
async function opusFetch(reqPath, { retries = 3 } = {}) {
  const url = `${OPUS_BASE_URL}${reqPath}`;
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, { headers: { 'x-service-key': OPUS_SERVICE_KEY } });
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const text = await res.text().catch(() => '');
    throw new Error(`Opus API GET ${reqPath} failed: ${res.status} ${text}`);
  }
}

async function loadHistory() {
  const raw = await redis.get(HISTORY_KEY);
  if (!raw) return [];
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? parsed : [];
}

function formatDurationMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

(async () => {
  console.log(APPLY ? 'Running in APPLY mode - Redis will be updated.' : 'Running in DRY RUN mode - nothing will be written (pass --apply to write).');

  const entries = await loadHistory();
  console.log(`Loaded ${entries.length} case-history entries.`);

  let checked = 0;
  let changed = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    if (!entry.jobId || !TERMINAL_STATUSES.includes(entry.status)) {
      skipped += 1;
      continue;
    }

    checked += 1;
    let detail;
    try {
      const res = await opusFetch(`/job/${entry.jobId}`);
      detail = await res.json();
    } catch (err) {
      failed += 1;
      console.warn(`  [${entry.jobId}] could not fetch from Opus - left unchanged (${err.message})`);
      continue;
    }

    const realFinishedAt = detail.finishedAt || null;
    if (!realFinishedAt) {
      console.warn(`  [${entry.jobId}] Opus returned no finishedAt - left unchanged (job may predate this field, or never reached a terminal state on Opus's side).`);
      continue;
    }

    if (entry.completedAt === realFinishedAt) {
      continue; // already correct - nothing to report or change
    }

    const submittedMs = new Date(entry.submittedAt).getTime();
    const oldDurationMs = entry.completedAt ? new Date(entry.completedAt).getTime() - submittedMs : null;
    const newDurationMs = new Date(realFinishedAt).getTime() - submittedMs;

    console.log(
      `  [${entry.jobId}] ${entry.applicantName || entry.title || '(untitled)'}: ` +
      `${formatDurationMs(oldDurationMs)} -> ${formatDurationMs(newDurationMs)} ` +
      `(completedAt ${entry.completedAt || '(none)'} -> ${realFinishedAt})`
    );
    changed += 1;

    if (APPLY) {
      entry.completedAt = realFinishedAt;
    }

    // Light pacing so a large history doesn't hammer the Opus API in a
    // tight loop - not required for the ~20-entry scale seen so far, but
    // costs nothing and stays safe if history grows.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (APPLY && changed > 0) {
    await redis.set(HISTORY_KEY, JSON.stringify(entries));
    console.log(`Wrote ${changed} corrected entries back to Redis.`);
  }

  console.log(
    `Done. ${checked} terminal entries checked, ${changed} ${APPLY ? 'corrected' : 'would be corrected'}, ` +
    `${failed} could not be checked, ${skipped} skipped (not terminal / no jobId).`
  );
  if (!APPLY && changed > 0) {
    console.log('This was a dry run - re-run with --apply to actually write these corrections.');
  }
})().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
