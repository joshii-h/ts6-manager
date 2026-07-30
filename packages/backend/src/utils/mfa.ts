import { authenticator } from 'otplib';
import crypto from 'crypto';

// Tolerate one 30s step of clock drift either way.
authenticator.options = { window: 1 };

const RECOVERY_CODE_COUNT = 10;

export function generateMfaSecret(): string {
  return authenticator.generateSecret();
}

/** otpauth:// URI for QR-code enrollment. */
export function buildOtpAuthUrl(secret: string, account: string, issuer = 'TS6 Manager'): string {
  return authenticator.keyuri(account, issuer, secret);
}

export function verifyTotp(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token: token.replace(/\s+/g, ''), secret });
  } catch {
    return false;
  }
}

function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(code.toLowerCase()).digest('hex');
}

/**
 * Generate plaintext recovery codes (shown once) plus their hashes (stored).
 * Codes look like "a1b2-c3d4-e5f6-a7b8" (64 bits of crypto-random entropy).
 */
export function generateRecoveryCodes(): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const raw = crypto.randomBytes(8).toString('hex'); // 16 hex chars = 64 bits
    plain.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`);
  }
  return { plain, hashed: plain.map(hashRecoveryCode) };
}

/**
 * Consume a recovery code: if it matches one of the stored hashes, return the
 * remaining hashes (the used one removed); otherwise null.
 */
export function consumeRecoveryCode(code: string, storedHashes: string[]): string[] | null {
  const target = hashRecoveryCode(code.trim());
  const idx = storedHashes.indexOf(target);
  if (idx === -1) return null;
  return storedHashes.filter((_, i) => i !== idx);
}
