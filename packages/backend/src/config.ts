import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'file:./data/ts6webui.db',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me-in-production',
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  tsAllowSelfSigned: process.env.TS_ALLOW_SELF_SIGNED === 'true' || process.env.TS_ALLOW_SELF_SIGNED === '1',
  // Reverse-proxy (Authentik forward-auth) trusted-header SSO. Only enable when the
  // app sits behind a proxy that authenticates the user and sets/overwrites these
  // headers, and the backend port is not otherwise reachable.
  trustProxyAuth: process.env.TRUST_PROXY_AUTH === 'true' || process.env.TRUST_PROXY_AUTH === '1',
  proxyAuthHeaderUser: (process.env.PROXY_AUTH_HEADER_USER || 'x-authentik-username').toLowerCase(),
  proxyAuthHeaderName: (process.env.PROXY_AUTH_HEADER_NAME || 'x-authentik-name').toLowerCase(),
  proxyAuthHeaderUid: (process.env.PROXY_AUTH_HEADER_UID || 'x-authentik-uid').toLowerCase(),
  proxyAuthDefaultRole: process.env.PROXY_AUTH_DEFAULT_ROLE === 'admin' ? 'admin' : 'viewer',
};
