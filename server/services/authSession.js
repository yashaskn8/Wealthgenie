import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

export const AUTH_COOKIE_NAME = 'wg_session';
export const CSRF_COOKIE_NAME = 'wg_csrf';

function cookieMaxAge(env) {
  const parsed = Number(env.AUTH_COOKIE_MAX_AGE_MS);
  return Number.isInteger(parsed) && parsed >= 60000 && parsed <= 30 * 24 * 60 * 60 * 1000
    ? parsed
    : 7 * 24 * 60 * 60 * 1000;
}

export function createSessionToken(user, env = process.env) {
  return jwt.sign(
    {
      userId: user._id,
      email: user.email,
      role: user.role || 'user',
      token_use: 'session',
      jti: crypto.randomUUID(),
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN || '7d', algorithm: 'HS256' },
  );
}

export function sessionCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE === 'true' || env.NODE_ENV === 'production',
    sameSite: env.AUTH_COOKIE_SAME_SITE || 'strict',
    path: '/',
    maxAge: cookieMaxAge(env),
  };
}

export function csrfCookieOptions(env = process.env) {
  const { httpOnly: _httpOnly, ...options } = sessionCookieOptions(env);
  return { ...options, httpOnly: false };
}

export function createCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function setSessionCookie(res, token, env = process.env) {
  res.cookie(AUTH_COOKIE_NAME, token, sessionCookieOptions(env));
}

export function clearSessionCookie(res, env = process.env) {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions(env);
  res.clearCookie(AUTH_COOKIE_NAME, options);
}

export function setCsrfCookie(res, token, env = process.env) {
  res.cookie(CSRF_COOKIE_NAME, token, csrfCookieOptions(env));
}

export function clearCsrfCookie(res, env = process.env) {
  const { maxAge: _maxAge, ...options } = csrfCookieOptions(env);
  res.clearCookie(CSRF_COOKIE_NAME, options);
}

export function setAuthCookies(res, sessionToken, env = process.env) {
  const csrfToken = createCsrfToken();
  setSessionCookie(res, sessionToken, env);
  setCsrfCookie(res, csrfToken, env);
  return csrfToken;
}

export function clearAuthCookies(res, env = process.env) {
  clearSessionCookie(res, env);
  clearCsrfCookie(res, env);
}

export function readCookie(req, cookieName) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (name !== cookieName) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function readSessionCookie(req) {
  return readCookie(req, AUTH_COOKIE_NAME);
}

export function readCsrfCookie(req) {
  return readCookie(req, CSRF_COOKIE_NAME);
}

export function ensureCsrfCookie(req, res, env = process.env) {
  const existingCsrfToken = readCsrfCookie(req);
  if (existingCsrfToken) return existingCsrfToken;
  const csrfToken = createCsrfToken();
  setCsrfCookie(res, csrfToken, env);
  return csrfToken;
}

export function shouldExposeBearerToken(env = process.env) {
  if (env.NODE_ENV === 'production') return false;
  if (env.EXPOSE_AUTH_TOKEN === 'true') return true;
  if (env.EXPOSE_AUTH_TOKEN === 'false') return false;
  return true;
}
