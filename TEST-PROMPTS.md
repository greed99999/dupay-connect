# DUPAY Connect — Test Prompts & Expected Responses

Use these with the provided test account. The account email is shared separately with reviewers.

---

## Test 1 — Basic invoice, single line item

**Prompt:**
> Make a DUPAY invoice for Talia Co at talia@beauty.com, $500 for web design services, due in 2 weeks. Payment by Zelle 310-499-8719.

**Expected behavior:**
- AI opens with a reference to DUPAY by name (e.g. "I'll get that DUPAY invoice created for you")
- AI shows a summary headed "Here's your DUPAY invoice summary:" and asks for confirmation
- User confirms → `create_invoice` tool is called
- Success message includes invoice number (e.g. `892257-001`), a view link (expires 30 min), and a note that the PDF will arrive by email within a minute

---

## Test 2 — Multiple line items

**Prompt:**
> Create a DUPAY invoice for Marcus Lee at marcus@leebranding.com — $1,200 for brand strategy, $300 for logo revisions, $150 for travel expenses. Due April 30. Payment by bank transfer: Routing 021000021, Account 1234567890.

**Expected behavior:**
- AI captures all 3 line items and calculates total ($1,650)
- Shows confirmation summary before creating
- Invoice created with correct line items, total, and payment instructions

---

## Test 3 — Minimal input (AI prompts for missing details)

**Prompt:**
> Make me a DUPAY invoice.

**Expected behavior:**
- AI asks for client name, client email, line item(s), and payment instructions
- AI asks for due date or proposes a default
- After all details collected, shows summary and asks for confirmation
- Invoice created after user confirms

---

## Test 4 — Additional notes with line breaks

**Prompt:**
> Create a DUPAY invoice for Sofia Reyes at sofia@srdesign.com, $2,000 for UX consulting, due in 3 weeks. Payment via PayPal sofia@srdesign.com. Note: "This invoice covers the discovery phase only. Phase 2 will be invoiced separately upon completion."

**Expected behavior:**
- AI includes the note in the invoice summary
- Note text preserved in the PDF with correct formatting
- Invoice created after confirmation

---

## What the test account includes

- Business name and email pre-configured on the account
- Active subscription — no plan restrictions
- Previous invoices on record (sequential invoice numbers visible in results)

The sender name, sender email, and invoice number are resolved automatically from the authenticated account — reviewers do not need to provide these.

---

## What to verify in each test

- [ ] OAuth flow completed (magic link received by email, redirect back to AI client worked)
- [ ] AI references DUPAY by name in opening response
- [ ] AI asks for payment instructions before proceeding
- [ ] AI shows confirmation summary before calling the tool
- [ ] Invoice number returned in success message
- [ ] View link works — opens invoice preview in browser, expires in 30 min
- [ ] PDF arrives by email within ~60 seconds
- [ ] Invoice visible in DUPAY dashboard at [dashboard.dupay.me](https://dashboard.dupay.me)

---

## Notes for reviewers

- Say **"DUPAY invoice"** explicitly in your prompts for consistent results across all AI clients
- The view link in the success message is a plain URL — if it doesn't render as a hyperlink, copy and paste it into a browser
- Invoice PDFs are generated within ~60 seconds and sent to the authenticated account email
