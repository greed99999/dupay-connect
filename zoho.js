import axios from 'axios';

let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;

  const res = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      grant_type:    'refresh_token',
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    },
  });

  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return accessToken;
}

async function zoho(method, path, data) {
  const token = await getAccessToken();
  const res = await axios({
    method,
    url: `https://www.zohoapis.com/crm/v2${path}`,
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    data,
  });
  return res.data;
}

// Find active account by email — returns null if not found or subscription is cancelled
export async function findAccountByEmail(email) {
  const res = await zoho('get', `/Accounts/search?criteria=(E_mail:equals:${encodeURIComponent(email)})`);
  const account = res.data?.[0] || null;
  if (!account) return null;
  const status = account.Account_Subscription_Status;
  const allowed = ['Active', 'Cancellation Pending'];
  if (status && !allowed.includes(status)) return null;
  return account;
}

// Find account by mcp_auth_code
export async function findAccountByAuthCode(code) {
  const res = await zoho('get', `/Accounts/search?criteria=(mcp_auth_code:equals:${encodeURIComponent(code)})`);
  return res.data?.[0] || null;
}

// Find account by mcp_access_token — returns null if not found or token is expired (90 days)
export async function findAccountByToken(token) {
  const res = await zoho('get', `/Accounts/search?criteria=(mcp_access_token:equals:${encodeURIComponent(token)})`);
  const account = res.data?.[0] || null;
  if (!account) return null;

  // Enforce 90-day expiry if mcp_token_issued_at field is present on the account
  const issuedAt = account.mcp_token_issued_at;
  if (issuedAt) {
    const age = Date.now() - new Date(issuedAt).getTime();
    if (age > 90 * 24 * 60 * 60 * 1000) {
      console.warn('[zoho] token expired for account:', account.id);
      return null;
    }
  }

  return account;
}

// Get full account record by Zoho ID
export async function getAccount(id) {
  const res = await zoho('get', `/Accounts/${id}`);
  return res.data?.[0] || null;
}

// Find the most recent invoice for a DUPAY account created after firedAt.
// RG3 owns invoice numbering, so we search by account ID + creation time.
export async function findInvoiceByNumber(dupayAccountId, firedAt) {
  const res = await zoho('get', `/Invoices_DUPAY/search?criteria=((DUPAY_Account_ID:equals:${encodeURIComponent(dupayAccountId)})and(Created_Time:greater_than:${encodeURIComponent(firedAt)}))&sort_by=Created_Time&sort_order=desc`);
  return res.data?.[0] || null;
}

// Update account fields
export async function updateAccount(id, fields) {
  await zoho('put', '/Accounts', { data: [{ id, ...fields }] });
}
