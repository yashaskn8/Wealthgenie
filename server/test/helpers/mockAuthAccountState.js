import mongoose from 'mongoose';
import User from '../../models/User.js';

/**
 * Provide only the account-state dependency used by verifyJWT for HTTP tests
 * whose route persistence is already mocked. The auth middleware still checks
 * a signed token and calls User.findById; this fixture represents a connected
 * test database without opening a real Mongo connection.
 *
 * Set preserveUserLookup when the suite already stubs User.findById for route
 * behavior beyond authentication.
 */
export async function withMockAuthAccountState(run, { preserveUserLookup = false } = {}) {
  const previousReadyState = mongoose.connection.readyState;
  const originalFindById = User.findById;

  if (!preserveUserLookup) {
    User.findById = () => ({
      select() { return this; },
      lean: async () => ({ role: 'user' }),
    });
  }

  mongoose.connection.readyState = 1;
  try {
    return await run();
  } finally {
    User.findById = originalFindById;
    mongoose.connection.readyState = previousReadyState;
  }
}
