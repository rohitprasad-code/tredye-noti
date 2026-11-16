'use strict';

/**
 * Strips an optional leading "Bearer " prefix and surrounding whitespace from an API token.
 */
function normalizeBearerToken(raw) {
  return String(raw || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .trim();
}

/**
 * Decodes unverified JWT payload claims (exp, iat, sub) for local lifetime detection.
 */
function decodeJwtClaims(token) {
  const clean = normalizeBearerToken(token);
  const parts = clean.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const normalizedB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalizedB64.length % 4)) % 4;
    const jsonStr = Buffer.from(normalizedB64 + '='.repeat(padLen), 'base64').toString('utf8');
    const payload = JSON.parse(jsonStr);
    if (!payload || typeof payload !== 'object') return null;
    const expNum = Number(payload.exp);
    const iatNum = Number(payload.iat);
    return {
      expMs: Number.isFinite(expNum) && expNum > 0 ? expNum * 1000 : null,
      iatMs: Number.isFinite(iatNum) && iatNum > 0 ? iatNum * 1000 : null,
      sub: payload.sub ? String(payload.sub) : '',
      payload,
    };
  } catch {
    return null;
  }
}

function isJwtExpired(token) {
  const claims = decodeJwtClaims(token);
  return Boolean(claims?.expMs && Date.now() >= claims.expMs);
}

module.exports = { normalizeBearerToken, decodeJwtClaims, isJwtExpired };
