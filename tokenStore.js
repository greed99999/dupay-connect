// Shared in-memory store for active access tokens.
// Tokens are also written to Zoho for persistence across restarts.
// This cache handles the window between issuance and Zoho indexing.

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

const store = new Map(); // token -> { accountId, accountData, expiresAt }

export function setToken(token, accountId, accountData = {}, expiresAt = Date.now() + TOKEN_TTL_MS) {
  store.set(token, { accountId, accountData, expiresAt });
}

export function getToken(token) {
  const entry = store.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(token);
    return null;
  }
  return entry;
}

export function deleteToken(token) {
  store.delete(token);
}
