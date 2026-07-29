import axios from 'axios';
import { useAuthStore } from '../stores/auth.store';

/**
 * What a refresh attempt means for the caller. Only `invalid` may end the session: a 429
 * from the auth limiter (15 per 15 min, shared between /auth/login and /auth/refresh and
 * keyed on an IP the proxy currently collapses across all users) or a 502 during a rolling
 * deploy says nothing about whether the refresh token is still good — and in both cases
 * the server never consumed it.
 */
export type RefreshOutcome =
  | { status: 'refreshed'; accessToken: string }
  | { status: 'invalid' }
  | { status: 'unreachable' }
  | { status: 'transient' };

const REFRESH_LOCK = 'ts6-auth-refresh';
// The `api` instance's timeout does not cover this POST (it deliberately uses raw axios),
// and axios defaults to no timeout at all. An unbounded POST would leave `refreshInFlight`
// unsettled forever: every later 401 awaits it, no query ever errors, the IdP probe never
// fires, and the app sits frozen on spinners. Matches the `api` instance's 15s.
const REFRESH_TIMEOUT_MS = 15_000;
// A transient failure must not be retried at the polling rate. /auth/refresh shares a fixed
// 15-per-15-minutes window with /auth/login, and every POST counts whether it succeeds or is
// itself rejected — so a tab that keeps refreshing on each 10s poll pins the counter above the
// cap for the rest of the window and takes login down for everyone behind the same proxy IP.
// Backing off turns a self-sustaining outage into one attempt per window.
const TRANSIENT_COOLDOWN_MS = 30_000;
// express-rate-limit's Retry-After is the seconds left in the window, so honouring it lands
// the next attempt exactly at the reset. Capped so a bogus header cannot wedge the client.
const MAX_TRANSIENT_COOLDOWN_MS = 15 * 60 * 1000;

/** Epoch ms before which rotating again would only feed the limiter. */
let transientUntil = 0;

// Refresh tokens are rotated single-use: /auth/refresh deletes the token it was given.
// When the 15-minute access token expires, every in-flight query 401s at once, and a naive
// per-request refresh sends the *same* token several times — the first call wins, the rest
// get 401 and used to log the user out of a session that had just been refreshed. One
// shared in-flight promise means the token is spent exactly once *per tab*; the Web Lock
// below extends that guarantee across tabs.
let refreshInFlight: Promise<RefreshOutcome> | null = null;

export function refreshAccessToken(refreshToken: string): Promise<RefreshOutcome> {
  // Still inside the back-off from a previous transient failure: answer without a POST.
  if (Date.now() < transientUntil) return Promise.resolve({ status: 'transient' });
  if (!refreshInFlight) {
    refreshInFlight = serializedRotate(refreshToken).finally(() => {
      // Cleared on settle so a later expiry starts a fresh refresh.
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Available only in secure contexts and recent browsers, despite lib.dom typing it as required. */
function lockManager(): LockManager | undefined {
  return (navigator as Navigator & { locks?: LockManager }).locks;
}

async function serializedRotate(spentToken: string): Promise<RefreshOutcome> {
  const locks = lockManager();
  if (!locks) {
    // No Web Locks: fall back to in-tab-only serialization. The 401 handling in
    // `classify` still catches a token another tab rotated out from under us.
    return rotate(spentToken);
  }
  try {
    return await locks.request(REFRESH_LOCK, () => rotateUnderLock(spentToken));
  } catch {
    // The lock could not be held (aborted or stolen). Losing the session over lock
    // plumbing would be worse than the double-spend risk we are hedging against.
    return rotate(spentToken);
  }
}

async function rotateUnderLock(spentToken: string): Promise<RefreshOutcome> {
  // Whoever held the lock before us may already have rotated this exact token. zustand's
  // persist middleware writes localStorage on every set but does not push in-memory state
  // into other tabs, so re-read storage before spending anything.
  const adopted = await adoptStoredTokens(spentToken);
  return adopted ?? rotate(spentToken);
}

/**
 * Re-reads what other tabs persisted. Returns null when the stored refresh token is still
 * the one the caller was about to spend, i.e. nothing happened elsewhere and it is ours.
 */
async function adoptStoredTokens(spentToken: string): Promise<RefreshOutcome | null> {
  await useAuthStore.persist.rehydrate();
  const { accessToken, refreshToken } = useAuthStore.getState();
  if (refreshToken === spentToken) return null;
  // Another tab logged out; follow it rather than resurrecting a dismissed session.
  if (!refreshToken) return { status: 'invalid' };
  // Another tab rotated: its access token is fresh, so ours would be a wasted rotation
  // whose 401 used to log this tab out and overwrite the winner's tokens with nulls.
  if (accessToken) return { status: 'refreshed', accessToken };
  // Storage proves our token was replaced but left no access token to adopt. Spending a
  // replaced token is precisely what trips the server's reuse detection and wipes the whole
  // family, so fail closed. Unreachable today — the store always writes both fields together
  // — but this is the one branch where a future store change would turn odd persisted state
  // into every session dying at once.
  return { status: 'invalid' };
}

async function rotate(spentToken: string): Promise<RefreshOutcome> {
  try {
    // Raw axios, not `api`: a 401 from the refresh endpoint itself must not re-enter the
    // response interceptor and recurse.
    const res = await axios.post(
      '/api/auth/refresh',
      { refreshToken: spentToken },
      { timeout: REFRESH_TIMEOUT_MS },
    );
    useAuthStore.getState().setTokens(res.data.accessToken, res.data.refreshToken);
    transientUntil = 0;
    return { status: 'refreshed', accessToken: res.data.accessToken as string };
  } catch (error) {
    return classify(error, spentToken);
  }
}

async function classify(error: unknown, spentToken: string): Promise<RefreshOutcome> {
  if (!axios.isAxiosError(error) || !error.response) {
    // Timeout, dead backend, or the cross-origin IdP redirect the browser swallowed.
    // Nothing consumed the refresh token, so it stays and the caller probes instead.
    return { status: 'unreachable' };
  }
  const { status } = error.response;
  if (status === 401 || status === 403) {
    // Belt and braces for the lock-less path, and for a token spent between our rehydrate
    // and this POST: if storage has moved on, someone else's rotation succeeded — adopt it
    // and retry instead of destroying a session that is very much alive.
    return (await adoptStoredTokens(spentToken)) ?? { status: 'invalid' };
  }
  // Any other real response (429, 5xx, ...) means the credential was never accepted *or*
  // rejected. Surface the failure, leave the tokens exactly as they are, and stop retrying
  // for a while so the client does not keep the limiter's window pinned.
  transientUntil = Date.now() + backOffMs(error.response.headers?.['retry-after']);
  return { status: 'transient' };
}

/** Honour Retry-After when the server sends a usable one, otherwise a flat back-off. */
function backOffMs(retryAfter: unknown): number {
  const seconds = typeof retryAfter === 'string' || typeof retryAfter === 'number'
    ? Number(retryAfter)
    : NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_TRANSIENT_COOLDOWN_MS)
    : TRANSIENT_COOLDOWN_MS;
}
