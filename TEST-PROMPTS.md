# DUPAY Connect — Test Prompts & Expected Responses

Use these with the provided test account credentials. The account email is shared separately with reviewers.

---

## Test 1 — Basic invoice, single line item

**Prompt:**
> Make an invoice for Talia Co at talia@beauty.com, $500 for web design services, due in 2 weeks, payment by Zelle 310-499-8719

**Expected behavior:**
- AI confirms details in a text summary (client, amount, due date, payment method)
- AI asks "Does everything look right?"
- User confirms → `create_invoice` tool is called
- Success message includes invoice number (e.g. `892257-001`), a "View a copy here" link, and a note that the PDF will arrive by email within a minute

---

## Test 2 — Multiple line items

**Prompt:**
> Create an invoice for Marcus Lee, marcus@leebranding.com — $1,200 for brand strategy, $300 for logo revisions, $150 for travel expenses. Due April 30.

**Expected behavior:**
- AI captures all 3 line items and calculates total ($1,650)
- Confirms before creating
- Invoice created with correct line items and total

---

## Test 3 — Minimal input, AI fills defaults

**Prompt:**
> Invoice Riverstone Media at hello@riverstone.co for $750 for copywriting

**Expected behavior:**
- AI notes missing due date and asks the user to confirm or accept default (30 days)
- Payment instructions: AI offers saved account default or asks user to provide
- Invoice created after confirmation

---

## Test 4 — Additional notes with formatting

**Prompt:**
> Make an invoice for Sofia Reyes at sofia@srdesign.com, $2,000 for UX consulting. Add a note: "This invoice covers the discovery phase only. Phase 2 will be invoiced separately upon completion."

**Expected behavior:**
- AI includes the note in the invoice, cleaned up into professional language
- Note preserves line break formatting in the PDF

---

## What the test account includes

- Business name and email pre-configured
- Saved payment instructions on file (AI will offer these as default)
- Previous invoices on record (sequential invoice numbers will be visible)
- Active subscription — no plan restrictions

---

## Notes for reviewers

- The sender name, email, and invoice number are resolved automatically from the authenticated account — reviewers do not need to provide these
- Invoice PDFs are generated within ~60 seconds and emailed to the account email
- The "View a copy here" link in the success message expires after 30 minutes
- The DUPAY dashboard at [dashboard.dupay.me](https://dashboard.dupay.me) shows all created invoices
