// Behind Authentik forward-auth, an expired IdP session answers /api/* XHRs with a 302
// to the login host — never a 401, regardless of X-Requested-With / Accept / Sec-Fetch-Mode.
// The browser follows it cross-origin, CORS eats the result, and axios reports a bodyless
// network error indistinguishable from "backend is down". Only a *document* request goes
// through Authentik's interactive login, so the SPA has to reload itself; without this the
// tab shows a generic "connection failed" card forever.

const MARKER_KEY = 'ts6-idp-reload';
const WRITE_PROBE_KEY = 'ts6-idp-reload-probe';
const RELOAD_COOLDOWN_MS = 30_000;
// Reloading only helps while the 302 is something a fresh document can clear. A half-down
// outpost, or a forward-auth rule that lets documents through but still 302s /api/*, is not
// fixable that way — and every cycle costs the user whatever was unsaved on the page.
const MAX_CONSECUTIVE_RELOADS = 3;

interface ReloadMarker {
  /** When the last auto-reload decision was taken — throttles the cycle. */
  at: number;
  /** Consecutive auto-reloads that did not get the API answering again. */
  count: number;
}

let probePending = false;
let markerRetired = false;

/**
 * sessionStorage, but only if it can actually be read *and* written: the object exists
 * yet throws on access in some privacy modes and partitioned contexts.
 */
function markerStore(): Storage | null {
  try {
    const store = window.sessionStorage;
    store.setItem(WRITE_PROBE_KEY, '1');
    store.removeItem(WRITE_PROBE_KEY);
    return store;
  } catch {
    return null;
  }
}

function readMarker(store: Storage): ReloadMarker {
  try {
    const raw = store.getItem(MARKER_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ReloadMarker>) : null;
    if (typeof parsed?.at === 'number' && typeof parsed?.count === 'number') {
      return { at: parsed.at, count: parsed.count };
    }
  } catch {
    // Corrupt or written by an older build — start the budget over.
  }
  return { at: 0, count: 0 };
}

function writeMarker(store: Storage, marker: ReloadMarker): void {
  try {
    store.setItem(MARKER_KEY, JSON.stringify(marker));
  } catch {
    // markerStore() already proved writes land; a quota blip here only costs one cooldown.
  }
}

function clearMarker(store: Storage): void {
  try {
    store.removeItem(MARKER_KEY);
  } catch {
    // As above — a stale marker delays the next reload by one cooldown at worst.
  }
}

/**
 * A successful API response proves the proxy is letting us through again — the very outcome
 * an auto-reload aims for. The consecutive-reload budget exists to bound a *failing* cycle,
 * so retire the marker here: nothing else does it on the happy path, and a long-lived tab
 * that recovered cleanly three times would otherwise refuse to reload on its fourth, real
 * IdP expiry. Once per document is enough — a reload starts the flag over anyway.
 */
export function noteApiReachable(): void {
  if (markerRetired) return;
  markerRetired = true;
  const store = markerStore();
  if (store) clearMarker(store);
}

export function probeIdpRedirect(): void {
  if (probePending) return;

  // The marker is the only loop guard that survives window.location.reload(); the
  // in-memory flag above is wiped along with the document. Without durable storage the
  // loop would be as tight as boot-and-fail, so refuse to auto-reload at all and degrade
  // to the pre-fix behaviour — the error card renders, nothing cycles.
  const store = markerStore();
  if (!store) return;

  const marker = readMarker(store);
  if (Date.now() - marker.at < RELOAD_COOLDOWN_MS) return;

  probePending = true;
  // A same-origin `redirect: 'manual'` fetch that hits the proxy's 302 resolves to an
  // opaque-redirect response — the one unambiguous signal that we are being sent to the
  // IdP rather than talking to a dead backend. /api/health is the right target: it is
  // unauthenticated, and it is registered ahead of the rate limiters, so probing during an
  // outage cannot itself consume anyone's request budget.
  fetch('/api/health', { redirect: 'manual', cache: 'no-store' })
    .then((res) => {
      if (res.type !== 'opaqueredirect') {
        // Backend answered: a genuine error, not an IdP redirect. We are reaching the API
        // again, so the session recovered and the consecutive-reload budget resets.
        clearMarker(store);
        probePending = false;
        return;
      }
      if (marker.count >= MAX_CONSECUTIVE_RELOADS) {
        // Reloading has failed to fix this often enough. Stop cycling and let the
        // request's own error surface; re-stamp `at` so we keep probing for recovery at
        // the cooldown rate instead of on every failed request.
        writeMarker(store, { at: Date.now(), count: marker.count });
        probePending = false;
        return;
      }
      writeMarker(store, { at: Date.now(), count: marker.count + 1 });
      // probePending stays set on purpose: this document is on its way out.
      window.location.reload();
    })
    .catch(() => {
      // The network really is unreachable; leave the error surfaced to the user.
      probePending = false;
    });
}
