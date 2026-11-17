// Lifecycle entrypoint for the git forge.
//
// Contract (unchanged): bind an ephemeral port, register it with the env, then
// poll /done until the env says the trial is over, and exit 0. This rewrite
// keeps that contract while adding: a client-side wall budget deadline, retry
// of register on transient network errors with deterministic exponential
// backoff, 409 treated as "already registered", validation of the bound port,
// and clean shutdown on SIGTERM.

import { createApp } from './app.ts';

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_ORIGIN.length === 0) {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 2_000;
const MAX_RETRY_EXPONENT = 8;

function parseWallBudgetSeconds(raw: string | undefined): number {
  // The trial's stated wall budget is 900 s; default to it so the entry never
  // gives up before the trial itself ends. (An earlier 300 s default could
  // self-terminate a slow grading run and score 0.)
  if (raw === undefined) return 900;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 900;
  return parsed;
}

const WALL_BUDGET_SEC = parseWallBudgetSeconds(process.env.MAKEFUN_TRIAL_WALL_BUDGET_SEC);
const WALL_BUDGET_NS = BigInt(Math.round(WALL_BUDGET_SEC * 1_000_000_000));
const START_NS = process.hrtime.bigint();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoffDelay(attempt: number): number {
  const exponent = attempt < MAX_RETRY_EXPONENT ? attempt : MAX_RETRY_EXPONENT;
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** exponent);
}

function wallBudgetExceeded(): boolean {
  return process.hrtime.bigint() - START_NS >= WALL_BUDGET_NS;
}

/**
 * POST the bound port until the env accepts it. 200 is success; 409 means a
 * first register already won, which is not this process's to fix and is treated
 * as "already registered, keep polling". 400/405 are contract errors. Network
 * errors and other statuses are retried with deterministic exponential backoff.
 */
async function register(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`refusing to register an invalid port: ${port}`);
  }
  for (let attempt = 0; ; attempt += 1) {
    if (wallBudgetExceeded()) throw new Error('wall budget exhausted while registering');
    try {
      const response = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200) return;
      if (response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register rejected with HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register rejected with HTTP ')) throw error;
    }
    await sleep(backoffDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    // No wall-budget exit here on purpose: only the env may end the trial, and
    // the platform enforces the 900 s wall budget from outside. Exiting early
    // would forfeit the trial even though the env might still say done.
    try {
      const response = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, retry.
    }
    await sleep(backoffDelay(attempt));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  const port = address.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`bound port is not a usable TCP port: ${port}`);
  }
  process.stdout.write(`[forge] listening on port ${port}\n`);

  await register(port);
  process.stdout.write('[forge] registered; waiting for the env to say done\n');

  await waitForDone();
  process.stdout.write('[forge] env reports done\n');

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.off('SIGTERM', shutdown);
  process.off('SIGINT', shutdown);
  process.stdout.write('[forge] server closed cleanly\n');
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[forge] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
