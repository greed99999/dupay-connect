# DUPAY Connect

Create professional invoices from Claude, ChatGPT, and other AI assistants — powered by your DUPAY account.

## What it does

DUPAY Connect is an MCP server that lets you create invoices conversationally through any AI assistant that supports MCP. Just describe what you need and the AI collects the details, confirms with you, and fires the invoice — generating a PDF, saving it to your DUPAY dashboard, and emailing it to you ready to forward to your client.

**Example:**
> "Make an invoice for Acme Corp, $1,500 for brand strategy consulting, due in 2 weeks, payment by Zelle 310-555-0100"

The AI confirms the details, you say go, and the invoice is created.

## Requirements

- An active [DUPAY](https://dupayme.com) account (Tools, Tools + Protection, Legacy, or Business plan)
- Claude.ai (Pro or higher) or ChatGPT (Pro or Plus with Developer Mode enabled)

## Connect to Claude.ai

1. Go to **Claude.ai → Settings → Connectors → Add custom connector**
2. Enter server URL: `https://connect.dupay.me`
3. Enter any value in the OAuth credential fields (e.g. `dupay-connect`)
4. Click Connect — you'll be prompted to enter your DUPAY email
5. Check your email for a magic link and click it to authorize

## Connect to ChatGPT

1. Go to **Settings → Apps & Connectors → Advanced settings → Enable Developer Mode**
2. Create a new connector with URL: `https://connect.dupay.me`
3. Click Connect — you'll be prompted to enter your DUPAY email
4. Check your email for a magic link and click it to authorize

## What you can do

- **Create invoices** — up to 3 line items, custom due dates, payment instructions, additional notes
- **View invoice** — a formatted HTML copy is linked in the success message (expires 30 min)
- Invoice PDF is generated and emailed to you within ~1 minute, ready to forward to your client

## How authorization works

DUPAY Connect uses OAuth 2.0 with a magic link flow — no passwords, no client credentials. When you connect:

1. The AI assistant redirects you to a DUPAY-hosted authorization page
2. You enter your DUPAY account email
3. A one-time magic link is emailed to you (expires in 15 minutes)
4. Clicking the link issues a Bearer token valid for 90 days
5. The AI assistant uses that token on all subsequent requests

Your DUPAY credentials are never shared with the AI assistant.

## Security

- Tokens expire after 90 days
- Rate limited to 10 tool calls per account per minute
- Request body capped at 32kb
- Per-request ID logging for auditability
- Subscription status checked on every tool call

## Support

Questions? Contact [info@dupay.me](mailto:info@dupay.me) or visit [dupayme.com](https://dupayme.com).
