import { Router } from 'express';
import { randomUUID } from 'crypto';
import { findAccountByEmail, updateAccount, getAccount } from './zoho.js';
import { sendEmail } from './gmail.js';
import { setToken } from './tokenStore.js';

const router = Router();

// In-memory auth code store — codes expire in 15 min and don't need to survive restarts
const authCodeStore = new Map(); // code -> { accountId, redirectUri, expiry }

// Per-email+platform cooldown — prevents duplicate emails if the client fires the form twice
const recentlySent = new Map(); // `${email}:${platform}` -> sentAt (ms)
const SEND_COOLDOWN_MS = 30_000;

// Allowed redirect_uri hostnames — prevents phishing via crafted redirect_uri
const ALLOWED_REDIRECT_HOSTS = new Set(['claude.ai', 'chatgpt.com', 'chat.openai.com']);

// Detect platform from redirect_uri using hostname — not substring match
function detectPlatform(redirectUri) {
  if (!redirectUri) return 'your AI assistant';
  try {
    const host = new URL(redirectUri).hostname;
    if (host === 'claude.ai') return 'Claude';
    if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'ChatGPT';
  } catch {}
  return 'your AI assistant';
}

function isAllowedRedirectUri(redirectUri) {
  try {
    return ALLOWED_REDIRECT_HOSTS.has(new URL(redirectUri).hostname);
  } catch {
    return false;
  }
}

// ─── GET /authorize ───────────────────────────────────────────────
// AI client redirects here to start the OAuth flow.
// Serves a simple email entry form.
router.get('/authorize', (req, res) => {
  const { redirect_uri, state } = req.query;
  const platform = detectPlatform(redirect_uri);

  if (!redirect_uri || !state) {
    return res.status(400).send('Missing redirect_uri or state');
  }

  if (!isAllowedRedirectUri(redirect_uri)) {
    return res.status(400).send('Invalid redirect_uri');
  }

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect DUPAY to ${platform}</title>
  <link href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Red Hat Display', sans-serif; background: #f8fafc; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1rem; }
    .card { background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 2.5rem; max-width: 420px; width: 100%; }
    .logo { font-size: 1.5rem; font-weight: 700; color: #04151f; margin-bottom: 0.25rem; }
    .subtitle { font-size: 0.9rem; color: #6b7280; margin-bottom: 2rem; }
    label { display: block; font-size: 0.8rem; font-weight: 600; color: #374151; margin-bottom: 0.4rem; }
    input[type="email"] { width: 100%; padding: 0.65rem 0.85rem; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.95rem; font-family: inherit; outline: none; transition: border-color 0.15s; }
    input[type="email"]:focus { border-color: #b9fb9c; box-shadow: 0 0 0 3px rgba(185,251,156,0.3); }
    button { width: 100%; margin-top: 1.25rem; padding: 0.75rem; background: #b9fb9c; color: #04151f; border: none; border-radius: 8px; font-size: 1rem; font-weight: 700; font-family: inherit; cursor: pointer; transition: background 0.15s; }
    button:hover { background: #a3f07f; }
    .hint { font-size: 0.75rem; color: #9ca3af; margin-top: 1rem; text-align: center; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">DUPAY</div>
    <div class="subtitle">Connect your DUPAY account to ${platform}</div>
    <form method="POST" action="/authorize">
      <input type="hidden" name="redirect_uri" value="${encodeHTML(redirect_uri)}">
      <input type="hidden" name="state" value="${encodeHTML(state)}">
      <label for="email">Your DUPAY account email</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required autofocus>
      <button type="submit">Send magic link</button>
    </form>
    <p class="hint">We'll email you a one-time link to authorize ${platform}.<br>No password needed.</p>
  </div>
</body>
</html>`);
});

// ─── POST /authorize ──────────────────────────────────────────────
// Looks up the account, generates a one-time code, sends magic link.
router.post('/authorize', async (req, res) => {
  const { email, redirect_uri, state } = req.body;
  const platform = detectPlatform(redirect_uri);

  if (!email || !redirect_uri || !state) {
    return res.status(400).send('Missing required fields');
  }

  if (!isAllowedRedirectUri(redirect_uri)) {
    return res.status(400).send('Invalid redirect_uri');
  }

  let result;
  try {
    result = await findAccountByEmail(email);
  } catch (err) {
    console.error('[authorize] findAccountByEmail error:', err.response?.status, err.response?.data || err.message);
    return res.status(500).send('An error occurred. Please try again.');
  }
  console.log('[authorize] email:', email, '| found:', !!result, '| active:', result?.active);

  // Always show the same success page regardless of account status — no enumeration oracle.
  if (result && !result.active) {
    // Known contact with cancelled/inactive subscription — send a reactivation nudge
    const dedupKey = `${email}:cancelled`;
    const lastSent = recentlySent.get(dedupKey);
    if (!lastSent || Date.now() - lastSent >= SEND_COOLDOWN_MS) {
      recentlySent.set(dedupKey, Date.now());
      await sendEmail({
        to:      email,
        subject: 'Your DUPAY subscription is not active',
        html:    cancelledAccountEmail(platform),
      }).catch(err => console.error('[authorize] cancelled email send failed:', err.message));
    }
  }

  if (result?.active) {
    const { account } = result;
    // Deduplicate: keyed on email+platform so Claude and ChatGPT each get their own link
    const dedupKey = `${email}:${platform}`;
    const lastSent = recentlySent.get(dedupKey);
    if (lastSent && Date.now() - lastSent < SEND_COOLDOWN_MS) {
      console.log('[authorize] duplicate request suppressed for:', dedupKey);
    } else {
      recentlySent.set(dedupKey, Date.now());

      const code   = randomUUID();
      const expiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      // Bind the auth code to this redirect_uri — validated again at /token
      authCodeStore.set(code, { accountId: account.id, redirectUri: redirect_uri, expiry });
      console.log('[authorize] stored code in memory:', code);

      // Also write to Zoho for audit trail (non-blocking)
      updateAccount(account.id, {
        mcp_auth_code:        code,
        mcp_auth_code_expiry: expiry,
      }).catch(err => console.error('[authorize] Zoho update failed (non-fatal):', err.message));

      const magicLink = `https://connect.dupay.me/callback?code=${code}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirect_uri)}`;

      await sendEmail({
        to:      email,
        subject: `Connect DUPAY to ${platform} - your magic link`,
        html:    magicLinkEmail(magicLink, platform),
      });
    }
  }

  // Same response for registered and unregistered — no enumeration oracle
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Check your email — DUPAY</title>
  <link href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Red Hat Display', sans-serif; background: #f8fafc; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1rem; }
    .card { background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 2.5rem; max-width: 420px; width: 100%; text-align: center; }
    .icon { width: 56px; height: 56px; background: #b9fb9c; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.25rem; font-size: 1.5rem; }
    h2 { font-size: 1.2rem; font-weight: 700; color: #04151f; margin-bottom: 0.75rem; }
    p { font-size: 0.9rem; color: #6b7280; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✉</div>
    <h2>Check your email</h2>
    <p>If <strong>${encodeHTML(email)}</strong> is registered with DUPAY, you'll receive a magic link shortly.<br><br>Click the link to complete connecting ${platform} to your account. It expires in 15 minutes.</p>
  </div>
</body>
</html>`);
});

// ─── GET /callback ────────────────────────────────────────────────
// User clicks magic link. Validates code, redirects to the AI client.
router.get('/callback', async (req, res) => {
  const { code, state, redirect_uri } = req.query;

  if (!code || !state || !redirect_uri) {
    return res.status(400).send('Invalid or missing parameters');
  }

  const pending = authCodeStore.get(code);
  console.log('[callback] code:', code, '| found in store:', !!pending);

  if (!pending) {
    return res.status(400).send('This link is invalid or has already been used.');
  }

  if (new Date(pending.expiry) < new Date()) {
    authCodeStore.delete(code);
    return res.status(400).send('This link has expired. Please start again from your AI assistant.');
  }

  // Verify the redirect_uri matches what was stored at authorization time
  if (redirect_uri !== pending.redirectUri) {
    return res.status(400).send('redirect_uri mismatch.');
  }

  const redirectUrl = `${redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  res.redirect(redirectUrl);
});

// ─── POST /token ──────────────────────────────────────────────────
// AI client exchanges the auth code for a Bearer access token.
router.post('/token', async (req, res) => {
  const { grant_type, code, redirect_uri } = req.body;

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  const pending = authCodeStore.get(code);
  console.log('[token] code:', code, '| found in store:', !!pending);

  if (!pending) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  if (new Date(pending.expiry) < new Date()) {
    authCodeStore.delete(code);
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
  }

  // Validate redirect_uri matches what was bound at authorization time
  if (redirect_uri && redirect_uri !== pending.redirectUri) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  }

  authCodeStore.delete(code);

  const accessToken  = randomUUID();
  const issuedAt     = new Date().toISOString();
  const expiresAt    = Date.now() + 90 * 24 * 60 * 60 * 1000; // 90 days
  const fullAccount  = await getAccount(pending.accountId);

  // Cache immediately so authMiddleware can validate before Zoho indexes it
  setToken(accessToken, pending.accountId, fullAccount || {}, expiresAt);

  await updateAccount(pending.accountId, {
    mcp_access_token:      accessToken,
    mcp_token_issued_at:   issuedAt,
    mcp_auth_code:         null,
    mcp_auth_code_expiry:  null,
  });

  console.log('[token] issued access token for account:', pending.accountId);

  res.json({
    access_token: accessToken,
    token_type:   'Bearer',
  });
});

// ─── Helpers ──────────────────────────────────────────────────────
function encodeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cancelledAccountEmail(platform = 'your AI assistant') {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f8f9fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;line-height:1.6;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;margin:0 auto;padding:20px;">
    <tr><td>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
        <tr>
          <td style="padding:32px;">
            <div style="font-weight:700;font-size:24px;color:#0b1320;margin-bottom:20px;">DUPAY</div>
            <p style="color:#0b1320;font-size:16px;margin:0 0 16px 0;">Hi there,</p>
            <p style="color:#374151;font-size:15px;margin:0 0 16px 0;">You tried to connect your DUPAY account to ${platform}, but your subscription is no longer active.</p>
            <p style="color:#374151;font-size:15px;margin:0 0 24px 0;">To reconnect, you'll need to reactivate or upgrade your plan.</p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;">
              <tr>
                <td align="center" style="background-color:#16a34a;border-radius:8px;">
                  <a href="https://dupayme.com/pricing/" target="_blank" style="display:inline-block;color:#ffffff !important;text-decoration:none !important;padding:14px 28px;font-size:16px;font-weight:600;">
                    View Plans &amp; Pricing →
                  </a>
                </td>
              </tr>
            </table>
            <p style="color:#6b7280;font-size:13px;margin:0;">Questions? Contact us at info(at)dupay.me</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function magicLinkEmail(link, platform = 'your AI assistant') {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style type="text/css">
    @media only screen and (max-width: 600px) {
      .container { width: 100% !important; padding: 10px !important; }
      .section-padding { padding: 24px 20px !important; }
      .cta-button { padding: 16px 24px !important; font-size: 16px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f8f9fa;font-family:'Red Hat Display',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;line-height:1.6;">
  <table role="presentation" cellpadding="0" cellspacing="0" class="container" style="width:100%;max-width:600px;margin:0 auto;padding:20px;">
    <tr><td>

      <!-- Header -->
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background-color:#ffffff;border-bottom:1px solid #e5e7eb;border-radius:12px 12px 0 0;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
        <tr>
          <td class="section-padding" style="padding:24px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
              <tr>
                <td style="vertical-align:middle;">
                  <div style="font-weight:700;font-size:28px;color:#0b1320;margin:0;font-family:'Red Hat Display',Arial,sans-serif;">DUPAY</div>
                </td>
                <td style="vertical-align:middle;text-align:right;">
                  <div style="font-size:18px;font-weight:600;color:#6b7280;margin:0;font-family:'Red Hat Display',Arial,sans-serif;">Connect to ${platform}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <!-- Hero -->
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background-color:#ffffff;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
        <tr>
          <td style="padding:32px;text-align:center;background:linear-gradient(135deg,#f8fafc 0%,#ffffff 100%);">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 20px;">
              <tr>
                <td style="width:64px;height:64px;background:#b9fb9c;border-radius:32px;text-align:center;vertical-align:middle;font-size:28px;line-height:64px;">🔗</td>
              </tr>
            </table>
            <h1 style="color:#0b1320;font-size:26px;margin:0;font-weight:700;font-family:'Red Hat Display',Arial,sans-serif;">Your magic link</h1>
          </td>
        </tr>
      </table>

      <!-- CTA -->
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background-color:#ffffff;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
        <tr>
          <td style="padding:40px 32px;text-align:center;">
            <p style="color:#0b1320;font-size:17px;font-weight:400;margin:0 0 24px 0;font-family:'Red Hat Display',Arial,sans-serif;">Click below to connect your DUPAY account to ${platform}. This link expires in <strong>15 minutes</strong> and can only be used once.</p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td align="center" bgcolor="#16a34a" style="background-color:#16a34a;border-radius:12px;">
                  <a href="${link}" class="cta-button" target="_blank" style="display:inline-block;background-color:#16a34a !important;color:#ffffff !important;text-decoration:none !important;padding:18px 36px;font-size:18px;font-weight:600;border-radius:12px;font-family:'Red Hat Display',Arial,sans-serif;line-height:1.2;">
                    Connect to ${platform} →
                  </a>
                </td>
              </tr>
            </table>
            <p style="color:#6b7280;font-size:13px;margin:20px 0 0 0;line-height:1.5;">If you didn't request this, you can safely ignore this email.</p>
          </td>
        </tr>
      </table>

      <!-- Footer -->
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background-color:#ffffff;border-radius:0 0 12px 12px;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
        <tr>
          <td style="padding:32px;text-align:center;border-top:1px solid #e5e7eb;">
            <div style="margin-bottom:16px;">
              <img src="http://dupay.me/wp-content/uploads/2024/10/dupay-high-resolution-logo-black-on-transparent-background-1.png" alt="DUPAY" style="max-width:120px;height:auto;">
            </div>
            <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.4;">
              Questions? Contact us at <a href="mailto:info@dupay.me" style="color:#16a34a;text-decoration:none;font-weight:500;">info@dupay.me</a>
            </p>
          </td>
        </tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

export default router;
