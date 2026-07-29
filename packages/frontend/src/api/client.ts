import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../stores/auth.store';
import { noteApiReachable, probeIdpRedirect } from './idp-reload';
import { refreshAccessToken } from './token-refresh';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** The access token a request actually went out with, read back off its own config. */
function sentAccessToken(config: InternalAxiosRequestConfig): string | null {
  const header = config.headers?.Authorization;
  return typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : null;
}

api.interceptors.response.use(
  (response) => {
    noteApiReachable();
    return response;
  },
  async (error: AxiosError) => {
    const original = error.config as
      | (InternalAxiosRequestConfig & { _retry?: boolean })
      | undefined;

    // No HTTP response: unreachable backend or a swallowed cross-origin IdP redirect.
    // Probe without awaiting so the original rejection is not delayed.
    if (!error.response) {
      if (!axios.isCancel(error)) probeIdpRedirect();
      return Promise.reject(error);
    }

    if (error.response.status !== 401 || !original || original._retry) {
      return Promise.reject(error);
    }
    original._retry = true;

    const { accessToken, refreshToken, logout } = useAuthStore.getState();

    // A straggler: this request left with a token that a refresh has since replaced, so
    // its 401 is already stale. Retrying costs nothing, whereas rotating again would spend
    // a second refresh token and eat into the 15-per-15-minutes that /auth/refresh shares
    // with /auth/login.
    const sent = sentAccessToken(original);
    if (accessToken && sent && sent !== accessToken) {
      original.headers.Authorization = `Bearer ${accessToken}`;
      return api(original);
    }

    if (!refreshToken) {
      logout();
      return Promise.reject(error);
    }

    const outcome = await refreshAccessToken(refreshToken);
    switch (outcome.status) {
      case 'refreshed':
        original.headers.Authorization = `Bearer ${outcome.accessToken}`;
        return api(original);
      case 'invalid':
        // 401/403 from /auth/refresh with no newer token in storage: the credential is
        // genuinely gone and this is the only case that may end the session.
        logout();
        break;
      case 'unreachable':
        // No HTTP response at all — the IdP-redirect case again. The session may still be
        // valid, so reload rather than discard the tokens.
        probeIdpRedirect();
        break;
      case 'transient':
        // A real response that does not mean "credential revoked" (429 from the shared
        // limiter, 502 mid-deploy). Keep the tokens; let the caller see the failure.
        break;
    }
    return Promise.reject(error);
  },
);

export default api;
