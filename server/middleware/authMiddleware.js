import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { isTokenBlacklisted, TokenRevocationUnavailableError } from '../config/redis.js';
import { readSessionCookie } from '../services/authSession.js';
import { sendError } from './errorHandler.js';

/**
 * JWT verification middleware.
 * Attaches decoded token payload to req.user.
 */
export function verifyJWTWithRevocationAvailability(req, res, next) {
  return verifyJWT(req, res, next, { revocationUnavailableStatus: 503 });
}

export async function verifyJWT(req, res, next, {
  revocationUnavailableStatus = 503,
  getCurrentUser = userId => User.findById(userId).select('role').lean(),
  isDatabaseReady = () => mongoose.connection.readyState === 1,
} = {}) {
  const authHeader = req.headers.authorization;
  if (authHeader && !authHeader.startsWith('Bearer ')) {
    return sendError(req, res, 401, 'Access denied. Invalid authorization scheme.', 'AUTH_SCHEME_INVALID');
  }

  // Authentication failures must not mutate browser cookies. A delayed 401
  // can arrive after a newer login and its Set-Cookie deletion would erase
  // that valid session; rejected tokens remain unusable on the server.
  const cookieToken = authHeader ? null : readSessionCookie(req);
  const token = authHeader?.slice('Bearer '.length).trim() || cookieToken;
  if (!token || token === 'null' || token === 'undefined') {
    return sendError(req, res, 401, 'Access denied. No token or valid session provided.', 'AUTH_REQUIRED');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const validJti = typeof decoded.jti === 'string'
      && decoded.jti.length >= 1
      && decoded.jti.length <= 128
      && /^[A-Za-z0-9._:-]+$/.test(decoded.jti);
    const missingJti = decoded.jti === undefined || decoded.jti === null;
    const revocationRequired = process.env.NODE_ENV === 'production' || process.env.REQUIRE_REDIS === 'true';
    if (!decoded.userId || (!validJti && (!missingJti || revocationRequired))
        || (decoded.token_use && decoded.token_use !== 'session')) {
      return sendError(req, res, 401, 'Invalid token payload.', 'AUTH_TOKEN_INVALID');
    }

    if (decoded.jti) {
      const blacklisted = await isTokenBlacklisted(decoded.jti);
      if (blacklisted) {
        return sendError(req, res, 401, 'Token has been revoked. Please log in again.', 'AUTH_TOKEN_REVOKED');
      }
    }

    // Backward compatibility: tokens issued before the role field was added
    // will not contain a role claim — default them to 'user'.
    if (!decoded.role) {
      decoded.role = 'user';
    }

    // A valid signature does not prove the account still exists. Check current
    // account state for every session token so deleted users lose access
    // immediately. Keep elevated-role demotion behavior for admin-claim tokens.
    if (!isValidObjectId(decoded.userId)) {
      return sendError(req, res, 401, 'Invalid token payload.', 'AUTH_TOKEN_INVALID');
    }
    const adminClaim = decoded.role === 'admin';
    const unavailableCode = adminClaim ? 'AUTH_ROLE_STATE_UNAVAILABLE' : 'AUTH_ACCOUNT_STATE_UNAVAILABLE';
    const unavailableMessage = adminClaim
      ? 'Administrator access could not be verified right now.'
      : 'Account access could not be verified right now.';
    if (!isDatabaseReady()) {
      return sendError(req, res, 503, unavailableMessage, unavailableCode);
    }
    let currentUser;
    try {
      currentUser = await getCurrentUser(decoded.userId);
    } catch {
      return sendError(req, res, 503, unavailableMessage, unavailableCode);
    }
    if (!currentUser) {
      return sendError(req, res, 401, 'Invalid or expired token.', 'AUTH_TOKEN_INVALID');
    }
    if (adminClaim) {
      decoded.role = currentUser.role === 'admin' ? 'admin' : 'user';
    }

    req.user = decoded;
    next();
  } catch (err) {
    if (err instanceof TokenRevocationUnavailableError || err?.code === 'TOKEN_REVOCATION_UNAVAILABLE') {
      if (revocationUnavailableStatus === 503) {
        return sendError(
          req,
          res,
          503,
          'Authentication session status is temporarily unavailable.',
          'TOKEN_REVOCATION_UNAVAILABLE',
        );
      }
      return sendError(req, res, 401, 'Invalid or expired token.', 'AUTH_TOKEN_INVALID');
    }
    if (err.name === 'TokenExpiredError') {
      return sendError(req, res, 401, 'Token expired. Please log in again.', 'AUTH_TOKEN_EXPIRED');
    }
    return sendError(req, res, 401, 'Invalid or expired token.', 'AUTH_TOKEN_INVALID');
  }
}

/**
 * Role-gating middleware factory.
 * Usage: router.post('/admin-only', verifyJWT, requireRole('admin'), handler)
 *
 * @param {string} role - Required role (e.g. 'admin')
 * @returns {Function} Express middleware
 */
export function requireRole(role, { findCurrentRole } = {}) {
  const loadCurrentRole = findCurrentRole || (async userId => {
    const user = await User.findById(userId).select('role').lean();
    return user?.role || null;
  });

  return async (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return sendError(req, res, 403, `Access denied. Requires ${role} role.`, 'AUTH_ROLE_REQUIRED');
    }

    let currentRole;
    try {
      currentRole = await loadCurrentRole(req.user.userId);
    } catch {
      return sendError(req, res, 503, 'Privileged access is temporarily unavailable.', 'AUTH_ROLE_STATE_UNAVAILABLE');
    }
    if (currentRole !== role) {
      return sendError(req, res, 403, 'Access denied. Account privileges have changed.', 'AUTH_ROLE_REQUIRED');
    }
    return next();
  };
}

/**
 * Validate a string as a valid MongoDB ObjectId.
 * Returns true if valid, false otherwise.
 */
export function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(id);
}

/**
 * Verify that a document belongs to the requesting user.
 * Used to prevent users from accessing other users' profiles, goals, etc.
 *
 * @param {Object} document - Mongoose document or lean object
 * @param {string} requestingUserId - req.user.userId
 * @returns {boolean}
 */
export function isOwner(document, requestingUserId) {
  if (!document || !requestingUserId) return false;
  const docUserId = document.userId?.toString?.() || document.userId;
  return docUserId === requestingUserId.toString();
}
