import api from './client';

export const authApi = {
  login: (username: string, password: string, trustDevice = false) =>
    api.post('/auth/login', { username, password, trustDevice }, { withCredentials: true }).then((r) => r.data),

  refresh: (refreshToken: string) =>
    api.post('/auth/refresh', { refreshToken }).then((r) => r.data),

  logout: (refreshToken: string) =>
    api.post('/auth/logout', { refreshToken }),

  me: () => api.get('/auth/me').then((r) => r.data),

  changePassword: (currentPassword: string, newPassword: string) =>
    api.put('/auth/password', { currentPassword, newPassword }),

  setLanguage: (language: string) =>
    api.put('/auth/language', { language }).then((r) => r.data),

  // MFA — login second step
  loginMfa: (mfaToken: string, code: string, trustDevice = false) =>
    api.post('/auth/login/mfa', { mfaToken, code, trustDevice }, { withCredentials: true }).then((r) => r.data),

  // Forced password change at login
  loginChangePassword: (changeToken: string, currentPassword: string, newPassword: string, trustDevice = false) =>
    api.post('/auth/login/change-password', { changeToken, currentPassword, newPassword, trustDevice }, { withCredentials: true }).then((r) => r.data),

  // MFA — enrollment. mfaToken is only needed during admin-forced setup at
  // login; from the Account tab the session cookie/header authorizes it.
  mfaSetup: (mfaToken?: string) =>
    api.post('/auth/mfa/setup', mfaToken ? { mfaToken } : {}).then((r) => r.data),
  mfaEnable: (code: string, mfaToken?: string) =>
    api.post('/auth/mfa/enable', mfaToken ? { code, mfaToken } : { code }).then((r) => r.data),
  mfaDisable: (password: string) =>
    api.post('/auth/mfa/disable', { password }),

  // Trusted device — cookie-based auto-login
  trustedPeek: () =>
    api.get('/auth/trusted/peek', { withCredentials: true }).then((r) => r.data),
  trustedSession: () =>
    api.post('/auth/trusted/session', {}, { withCredentials: true }).then((r) => r.data),
  trustedList: () =>
    api.get('/auth/trusted').then((r) => r.data),
  trustedRevoke: (id: number) =>
    api.delete(`/auth/trusted/${id}`),
  trustedRevokeAll: () =>
    api.delete('/auth/trusted'),

  // SAML SSO
  samlStatus: (): Promise<{ enabled: boolean }> =>
    api.get('/auth/saml/status').then((r) => r.data),
  samlExchange: (code: string) =>
    api.post('/auth/saml/exchange', { code }).then((r) => r.data),

  // Reverse-proxy (Authentik forward-auth) trusted-header SSO
  ssoStatus: (): Promise<{ enabled: boolean }> =>
    api.get('/auth/sso/status').then((r) => r.data),
  sso: () =>
    api.post('/auth/sso', {}, { withCredentials: true }).then((r) => r.data),
};
