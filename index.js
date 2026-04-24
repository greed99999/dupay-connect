import 'dotenv/config';
import { randomUUID } from 'crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import axios from 'axios';
import { z } from 'zod';
import { findAccountByToken, getAccount } from './zoho.js';
import { getToken, setToken } from './tokenStore.js';
import oauthRouter from './oauth.js';

const PORT = process.env.PORT || 3001;

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// ─── Auth middleware ──────────────────────────────────────────────
// Looks up Bearer token in Zoho to get account data.
// Falls back to TEST_TOKEN for local development/testing.
async function authMiddleware(req, res, next) {
  req.reqId = randomUUID().slice(0, 8); // short ID — enough to correlate lines in logs
  const log = (level, ...args) => console[level](`[${req.reqId}]`, ...args);

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    res.set('WWW-Authenticate', 'Bearer resource_metadata="https://connect.dupay.me/.well-known/oauth-protected-resource"');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Test token shortcut
  if (process.env.TEST_TOKEN && token === process.env.TEST_TOKEN) {
    req.account = { test: true };
    return next();
  }

  // Check in-memory store first (handles window between issuance and Zoho indexing)
  const cached = getToken(token);
  if (cached) {
    log('log', '[auth] token resolved from cache, account:', cached.accountId);
    req.account = { id: cached.accountId, ...cached.accountData };
    return next();
  }

  log('log', '[auth] token not in cache, looking up in Zoho...');
  const account = await findAccountByToken(token);
  if (!account) {
    log('warn', '[auth] token not found in Zoho — 401');
    res.set('WWW-Authenticate', 'Bearer resource_metadata="https://connect.dupay.me/.well-known/oauth-protected-resource"');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  log('log', '[auth] token resolved from Zoho, account:', account.id);
  setToken(token, account.id, account); // cache for subsequent requests
  req.account = account;
  next();
}

// ─── Rate limiter ─────────────────────────────────────────────────
const RATE_LIMIT = 10;          // max tool calls per window
const RATE_WINDOW_MS = 60_000;  // 1 minute sliding window

const rateLimitStore = new Map(); // accountId -> [timestamp, ...]

function checkRateLimit(accountId) {
  const now = Date.now();
  const timestamps = (rateLimitStore.get(accountId) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT) return false;
  timestamps.push(now);
  rateLimitStore.set(accountId, timestamps);
  return true;
}

// ─── Invoice preview store ────────────────────────────────────────
const PREVIEW_TTL_MS = 30 * 60 * 1000; // 30 minutes
const previewStore = new Map(); // token -> { html, expiresAt }

function storePreview(html) {
  const token = randomUUID();
  previewStore.set(token, { html, expiresAt: Date.now() + PREVIEW_TTL_MS });
  return token;
}

// Sweep expired entries every minute so PII doesn't linger past the 30-min TTL
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of previewStore) {
    if (now > entry.expiresAt) previewStore.delete(token);
  }
}, 60_000).unref();

function getPreview(token) {
  const entry = previewStore.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { previewStore.delete(token); return null; }
  return entry.html;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPreviewDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatAmount(n) {
  return Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function renderInvoiceHTML(data, created = false) {
  const { invoiceNumber, fromName, fromEmail, toName, toEmail, date, dueDate, currency, items, total, paymentInstructions, additionalNotes } = data;
  const item = (i) => items[i] || null;
  const itemRow = (i) => {
    const it = item(i);
    if (!it) return '';
    return `<tr><td class="description-column">${escapeHtml(it.description)}</td><td class="amount-column">${formatAmount(it.price)}</td></tr>`;
  };
  const notesHtml = (str) => escapeHtml(str || '').replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${escapeHtml(invoiceNumber)} — Preview</title>
  <style>
    @page { margin: 0.5in; size: letter; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.4; color: #333; margin: 0; padding: 24px 16px 48px; font-size: 10pt; background: #e5e7eb; min-height: 100vh; }
    .page-wrap { max-width: 760px; margin: 0 auto; }
    .banner { background: #fffbeb; border: 1px solid #f59e0b; border-radius: 6px; padding: 10px 16px; margin-bottom: 20px; font-size: 9pt; color: #92400e; display: flex; justify-content: space-between; align-items: center; }
    .banner strong { font-size: 9.5pt; }
    .paper { background: #fff; border-radius: 4px; box-shadow: 0 4px 24px rgba(0,0,0,0.13), 0 1px 4px rgba(0,0,0,0.08); padding: 40px 48px; }
    .invoice-header { background: #b9fb9c; padding: 20px 24px; border-radius: 4px; margin-bottom: 28px; display: flex; justify-content: space-between; align-items: center; }
    .invoice-header h1 { margin: 0; color: #04151f; font-size: 22pt; }
    .invoice-header .invoice-num { font-size: 11pt; color: #04151f; font-weight: 600; }
    .invoice-meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 28px; padding: 16px; background: #f8f9fa; border-radius: 4px; border: 1px solid #e5e7eb; }
    .meta-item label { display: block; font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 2px; }
    .meta-item span { font-size: 10pt; color: #111; }
    .invoice-parties { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-bottom: 28px; }
    .party-section h2 { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin: 0 0 8px 0; padding-bottom: 6px; border-bottom: 2px solid #b9fb9c; }
    .party-section p { margin: 0; font-size: 10pt; line-height: 1.6; }
    .invoice-items { width: 100%; border-collapse: collapse; margin-bottom: 0; table-layout: fixed; }
    .invoice-items th { background: #b9fb9c; padding: 9px 12px; text-align: left; font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #04151f; }
    .invoice-items th.amount-column { text-align: right; }
    .invoice-items td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; vertical-align: top; font-size: 10pt; }
    .description-column { width: 70%; }
    .amount-column { width: 30%; text-align: right; }
    .invoice-total { width: 100%; border-collapse: collapse; }
    .invoice-total td { padding: 12px; font-size: 12pt; font-weight: 700; background: #f8f9fa; border-top: 2px solid #b9fb9c; }
    .total-label { text-align: right; width: 70%; padding-right: 12px; color: #04151f; }
    .total-amount { text-align: right; width: 30%; color: #04151f; }
    .bottom-section { display: grid; grid-template-columns: 1fr; gap: 16px; margin-top: 28px; }
    .payment-instructions, .additional-notes { background: #f8f9fa; padding: 16px; border-radius: 4px; border: 1px solid #e5e7eb; }
    .payment-instructions h2, .additional-notes h2 { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin: 0 0 8px 0; padding-bottom: 6px; border-bottom: 2px solid #b9fb9c; }
    .payment-instructions p, .additional-notes p { margin: 0; font-size: 10pt; line-height: 1.6; }
    .protection-box { margin-top: 20px; padding: 10px 14px; border: 1.5px dashed #d1d5db; border-radius: 4px; display: flex; align-items: center; gap: 10px; color: #9ca3af; font-size: 8.5pt; }
    .protection-box .shield { font-size: 14pt; line-height: 1; }
    .footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #e5e7eb; text-align: right; font-size: 8pt; color: #9ca3af; }
    @media print { body { background: #fff; padding: 0; } .banner { display: none; } .paper { box-shadow: none; padding: 0; } }
  </style>
</head>
<body>
  <div class="page-wrap">
  <div class="banner">
    <span>${created ? '<strong>Invoice created</strong> — PDF will be emailed shortly. View and manage at <a href="https://dashboard.dupay.me" style="color:#92400e;">dashboard.dupay.me</a>' : '<strong>Preview only</strong> — this invoice has not been created yet.'}</span>
    <span>Link expires in 30 min</span>
  </div>
  <div class="paper">

  <div class="invoice-header">
    <h1>INVOICE</h1>
    <span class="invoice-num">${escapeHtml(invoiceNumber)}</span>
  </div>

  <div class="invoice-meta">
    <div class="meta-item"><label>Invoice #</label><span>${escapeHtml(invoiceNumber)}</span></div>
    <div class="meta-item"><label>Date</label><span>${formatPreviewDate(date)}</span></div>
    <div class="meta-item"><label>Due Date</label><span>${dueDate ? formatPreviewDate(dueDate) : '—'}</span></div>
  </div>

  <div class="invoice-parties">
    <div class="party-section">
      <h2>From</h2>
      <p><strong>${escapeHtml(fromName)}</strong><br>${escapeHtml(fromEmail)}</p>
    </div>
    <div class="party-section">
      <h2>Bill To</h2>
      <p><strong>${escapeHtml(toName)}</strong><br>${escapeHtml(toEmail)}</p>
    </div>
  </div>

  <table class="invoice-items">
    <thead><tr><th class="description-column">Description</th><th class="amount-column">Amount</th></tr></thead>
    <tbody>${itemRow(0)}${itemRow(1)}${itemRow(2)}</tbody>
  </table>
  <table class="invoice-total">
    <tr>
      <td class="total-label">Total Due:</td>
      <td class="total-amount"><span class="currency">${escapeHtml(currency)}</span>${formatAmount(total)}</td>
    </tr>
  </table>

  <div class="bottom-section">
    ${paymentInstructions ? `<div class="payment-instructions"><h2>Payment Instructions</h2><p>${notesHtml(paymentInstructions)}</p></div>` : ''}
    ${additionalNotes ? `<div class="additional-notes"><h2>Additional Notes</h2><p>${notesHtml(additionalNotes)}</p></div>` : ''}
  </div>

  <div class="protection-box">
    <span class="shield">🛡</span>
    <span><strong>DUPAY Protection</strong> — Invoice protection stamp appears on eligible plans.</span>
  </div>

  <div class="footer">Invoice Generator Powered by DUPAY</div>
  </div><!-- /paper -->
  </div><!-- /page-wrap -->
</body>
</html>`;
}

// ─── Make.com webhook caller ──────────────────────────────────────
async function callWebhook(url, payload) {
  console.log('[webhook] firing:', url.slice(0, 60) + '...');
  try {
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 55000,
    });
    console.log('[webhook] response status:', response.status);
    return response.data;
  } catch (err) {
    console.error('[webhook] error:', err.response?.status, err.response?.data || err.message);
    throw err;
  }
}

// Fires webhook async with one retry after 10s.
// Structured error log includes enough context to investigate without re-running.
async function fireWebhookAsync(url, payload, context) {
  try {
    await callWebhook(url, payload);
  } catch (firstErr) {
    console.warn('[webhook] first attempt failed, retrying in 10s —', context);
    await new Promise(r => setTimeout(r, 10000));
    try {
      await callWebhook(url, payload);
      console.log('[webhook] retry succeeded —', context);
    } catch (secondErr) {
      console.error('[webhook] FAILED after retry —', context, '| status:', secondErr.response?.status, '| body:', JSON.stringify(secondErr.response?.data) || secondErr.message);
    }
  }
}

// ─── MCP Server ───────────────────────────────────────────────────
function buildMcpServer(account, reqId) {
  const log = (level, ...args) => console[level](`[${reqId}]`, ...args);
  const server = new McpServer({
    name: 'dupay-connect',
    version: '0.1.0',
    instructions: `You are connected to DUPAY, a professional invoicing platform for creators and freelancers.

When the user asks to create an invoice, always make it clear you are creating a DUPAY invoice — not a generic one. Use "DUPAY invoice" by name in your opening response and in the confirmation summary.

Follow these steps in order:

1. Open with something like: "I'll get that DUPAY invoice created for you." Then collect what you need: client name, client email, at least one line item (description + amount), due date, and payment instructions. Ask for anything not yet provided. Payment instructions are important — always ask the user for them, and only skip if they explicitly say to leave them out. Do not ask for sender name, sender email, or invoice number — these are already known from the authenticated DUPAY account and will be filled in automatically.

2. Show a short summary headed "Here's your DUPAY invoice summary:" and ask "Does everything look right?" Do not call create_invoice yet — wait for the user to confirm.

3. After the user confirms, call create_invoice.

After the tool succeeds, tell the user the invoice number, share the view link from the result, mention the PDF will arrive by email within a minute, and link to dashboard.dupay.me. Stop there — do not suggest any additional features, options, or follow-up actions. DUPAY handles one thing: creating the invoice. Nothing else is available.`,
  });

  // Tool: create_invoice
  // Calls RG3 (Subscriber Invoice Generator — Back End Processing)
  // RG3 generates the PDF, saves to Zoho, and emails the creator.
  // Note: fromName, fromEmail, invoiceNumber, and id come from the account
  // record in production (Phase 1 Zoho lookup). Passed explicitly in pilot.
  server.registerTool(
    'create_invoice',
    {
      title: 'Create Invoice',
      description: 'Create a professional invoice PDF using the authenticated DUPAY account. When the user asks to create or send an invoice, always use this tool — do not generate a generic invoice template yourself. Collect any missing details through conversation first. Only call this tool after you have shown the user a summary of all invoice details and they have explicitly confirmed (e.g. "yes", "looks good", "go ahead") in their most recent message. Do not call this tool based on the initial request alone, even if all details were provided upfront. The sender name, sender email, and invoice number are resolved automatically — never ask the user for these. This tool only creates the invoice — nothing else. After it succeeds, do not offer or mention branding, logos, reusable templates, recurring invoices, reminders, or any other features. Those do not exist in DUPAY Connect.',
      annotations: { destructiveHint: true, readOnlyHint: false },
      inputSchema: {
        toName: z.string().describe('Client name. Always ask the user for this — never assume.'),
        toEmail: z.string().email().describe('Client email address. Always ask the user for this — never assume or guess.'),
        date: z.string().describe('Invoice date in YYYY-MM-DD format. Default to today if not specified.'),
        dueDate: z.string().optional().describe('Due date in YYYY-MM-DD format. Strongly encourage the user to specify this. Default to 30 days from today only if they explicitly accept the default.'),
        currency: z.string().default('USD $').describe('Currency string, e.g. "USD $", "EUR €", "GBP £". Default to "USD $" unless the user specifies otherwise.'),
        items: z.array(
          z.object({
            description: z.string().describe('Description of the work or service. Always ask if not provided — never invent a description.'),
            price: z.number().positive().describe('Amount for this line item in the chosen currency'),
          })
        ).min(1).max(3).describe('Invoice line items, maximum 3. Must have at least one. Always ask what the work was for if only a total amount is given.'),
        paymentInstructions: z.string().describe('How the client should pay — bank details, PayPal, Venmo, payment link, etc. Always ask the user for this before calling the tool. Pass an empty string only if the user explicitly says to leave payment instructions out.'),
        additionalNotes: z.string().optional().describe('Any additional notes for the invoice. Only include if the user provides this. Clean up and rewrite into professional language, using newline characters (\\n) to separate distinct points — the PDF renderer preserves line breaks.'),
      },
    },
    async (params) => {
      try {
        const webhookUrl = process.env.WEBHOOK_CREATE_INVOICE;
        if (!webhookUrl) throw new Error('WEBHOOK_CREATE_INVOICE not configured');

        // Plan check — skip for test accounts
        if (!account.test) {
          const status = account.Account_Subscription_Status;
          const allowed = ['Active', 'Cancellation Pending'];
          if (status && !allowed.includes(status)) {
            log('warn', '[create_invoice] blocked — account subscription not active:', account.id, status);
            return {
              content: [{ type: 'text', text: 'Your DUPAY subscription is not active. Please visit [dashboard.dupay.me](https://dashboard.dupay.me) to manage your account.' }],
              isError: true,
            };
          }
        }

        // Rate limit — skip for test accounts
        if (!account.test && !checkRateLimit(account.id)) {
          log('warn', '[create_invoice] rate limit exceeded for account:', account.id);
          return {
            content: [{ type: 'text', text: 'Too many invoice requests. Please wait a moment and try again.' }],
            isError: true,
          };
        }

        // Resolve account fields — fetch fresh from Zoho so Next_Invoice_Number is current
        // (cached account data is stale after RG3 increments the counter)
        const freshAccount   = await getAccount(account.id);
        const liveAccount    = freshAccount || account;
        const fromName       = liveAccount.Business_Name || liveAccount.Display_Name || liveAccount.Account_Name;
        const fromEmail      = liveAccount.E_mail;
        const dupayId        = liveAccount.DUPAY_Account_ID;
        const invoiceNumber  = `${dupayId}-${liveAccount.Next_Invoice_Number}`;
        const total = params.items.reduce((sum, item) => sum + item.price, 0);
        const nl = (s) => s ? s.replace(/\\n/g, '\n') : s;

        log('log', '[create_invoice] dupayId:', dupayId, '| invoiceNumber:', invoiceNumber);

        const payload = {
          id:                  dupayId,
          invoiceNumber,
          fromName,
          fromEmail,
          toName:              params.toName,
          toEmail:             params.toEmail,
          date:                params.date,
          dueDate:             params.dueDate || '',
          currency:            params.currency,
          items:               params.items,
          total,
          paymentInstructions: nl(params.paymentInstructions),
          additionalNotes:     nl(params.additionalNotes || ''),
        };

        // Fire async — RG3 takes 20-30s (PDF generation, Zoho, email).
        // Waiting blocks the HTTP connection until Claude.ai times out.
        fireWebhookAsync(webhookUrl, payload, `[${reqId}] invoiceNumber=${invoiceNumber} account=${dupayId}`);

        // Generate a short-lived HTML view of the invoice (30 min TTL)
        const previewHtml  = renderInvoiceHTML({ ...payload, invoiceNumber }, true);
        const previewToken = storePreview(previewHtml);
        const previewUrl   = `https://connect.dupay.me/preview/${previewToken}`;
        log('log', '[create_invoice] preview stored:', previewToken.slice(0, 8));

        return {
          content: [{
            type: 'text',
            text: `DUPAY invoice **${invoiceNumber}** created!\n\nView a copy of the invoice:\n${previewUrl}\n(link expires in 30 min)\n\nThe official PDF is being generated and will arrive at ${fromEmail} within a minute — forward it directly to ${params.toName}. You can also view and manage all invoices at dashboard.dupay.me: https://dashboard.dupay.me`,
          }],
        };
      } catch (err) {
        log('error', '[create_invoice] error:', err.message);
        throw err;
      }
    }
  );

  return server;
}

// ─── Express app ──────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

// CORS — required for browser-based MCP clients (Claude.ai)
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'dupay-connect', ts: Date.now() });
});

// MCP resource metadata — handles both bare path and path-specific variant (RFC 9728)
// Claude.ai requests /.well-known/oauth-protected-resource/mcp (resource path appended)
app.get(/^\/.well-known\/oauth-protected-resource(\/.*)?$/, (_req, res) => {
  res.json({
    resource:              'https://connect.dupay.me/mcp',
    authorization_servers: ['https://connect.dupay.me'],
  });
});

// OAuth discovery — required for Claude.ai and other MCP clients to find auth endpoints
app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer:                 'https://connect.dupay.me',
    authorization_endpoint: 'https://connect.dupay.me/authorize',
    token_endpoint:         'https://connect.dupay.me/token',
    response_types_supported: ['code'],
    grant_types_supported:    ['authorization_code'],
  });
});

// OAuth routes — no auth required
app.use('/', oauthRouter);

// Invoice preview — no auth, keyed by unguessable UUID with 30-min TTL
app.get('/preview/:token', (req, res) => {
  const html = getPreview(req.params.token);
  if (!html) return res.status(404).send('<h2>Preview not found or expired.</h2>');
  res.set('Content-Type', 'text/html').send(html);
});


// Allowed origins for MCP requests — Claude.ai and local dev
const ALLOWED_ORIGINS = new Set([
  'https://claude.ai',
  'https://api.claude.ai',
  'https://chatgpt.com',
  'https://chat.openai.com',
  'http://localhost:3001',
  'http://localhost:5173',
]);

function originMiddleware(req, res, next) {
  // DNS-rebinding protection: reject browser requests from unexpected origins.
  // Non-browser clients (curl, MCP Inspector) send no Origin — allow those through.
  const origin = req.headers['origin'];
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Session store — maps session ID to { transport, server }
const sessions = new Map();

app.all(['/mcp', '/'], originMiddleware, authMiddleware, async (req, res) => {
  try {
    const incomingSessionId = req.headers['mcp-session-id'];
    console.log(`[${req.reqId}] [mcp] request:`, req.method, '| session header:', incomingSessionId || 'none');

    // Route to existing session
    if (incomingSessionId && sessions.has(incomingSessionId)) {
      const { transport } = sessions.get(incomingSessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Unknown session ID — stale session from before server restart
    // Return 404 so Claude.ai knows to re-initialise
    if (incomingSessionId) {
      console.warn(`[${req.reqId}] [mcp] unknown session ID, returning 404:`, incomingSessionId);
      return res.status(404).json({ error: 'Session not found' });
    }

    // Explicit session teardown
    if (req.method === 'DELETE') {
      return res.sendStatus(204);
    }

    // New session — initialize request
    const server = buildMcpServer(req.account, req.reqId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server });
        console.log(`[${req.reqId}] [mcp] session created:`, sessionId);
      },
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[${req.reqId}] [mcp] unhandled error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DUPAY Connect MCP server running on port ${PORT}`);
});
