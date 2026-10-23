# Obligation Firewall — free responsive cash monitoring (CSV-first)

## Scope and truthful claim

This design uses the existing React frontend, Express API and MongoDB. It does **not** connect to banks, scrape internet banking, acquire live financial data, buy a data feed, send paid notifications or depend on LLM APIs. "Responsive" means saved ledger changes propagate between open browser tabs and visible sessions recheck periodically (about 45 seconds). It is not bank streaming or guaranteed background delivery.

The authoritative calculation is the existing 90-day exact integer-paise backend engine. A locally uploaded CSV never directly mutates the ledger.

## End-to-end data path

1. A user explicitly selects a .csv in their browser (at most 512 KiB); PDFs/Excel are unsupported. There is no CSV upload endpoint.
2. The client validates CSV quoting, at most 1,500 rows, exact INR decimals, unique column meaning, day-first India or ISO calendar dates and non-future transactions.
3. The UI shows a bounded report: the first and last transaction dates, source freshness, optional file-reported balance, a maximum of 20 recent same-day debits for double-count review, and up to 20 candidate recurring future payments. A file-reported balance is never called verified live bank cash.
4. Recurrence candidates require at least three consecutive monthly debits (with a consistent description, exact amount and day) or four exact weekly debits. Only recent observations are considered. Credits do not become guaranteed future income.
5. The user explicitly classifies each proposal, clicks to add an unsaved draft entry, checks for duplicates, and reconfirms the complete obligations declaration. Historical debits are not silently copied as future bills; no payment, transfer, SIP cancellation or investment order is performed.
6. An explicit save goes through the existing authenticated, CSRF-protected PUT /api/coverage/ledger API, using revision If-Match and a stable idempotency key. Only the backend calculates and atomically persists the ledger/result.
7. Successful saves or deletions publish only a nonsensitive revision-changed signal through BroadcastChannel. Tabs refetch their own authenticated records and preserve unsaved edits with a conflict review. Other visible sessions poll every 45 seconds and check on tab refocus. No identities, balances, narrations or raw CSV rows are published in messages.
8. Existing private history export, delete, historical policy and no-store protections remain in force. Discarding an import review or leaving the component disposes its suggestions; the full raw transaction list is not retained in application state.

## Supported sample file

Date,Description,Debit,Credit,Balance
2026-08-15,Apartment rent,18000.00,,82000.00
2026-09-15,Apartment rent,18000.00,,64000.00
2026-10-15,Apartment rent,18000.00,,46000.00

Dates use YYYY-MM-DD or DD/MM/YYYY only (slash dates always day-first). Each row has exactly one positive debit or credit; absent direction is blank. Exact decimal rupees accept at most two fractional digits and correctly grouped thousands. Quoted descriptions and CRLF are supported. Ambiguous formats, invalid dates, duplicate transaction references, future completed movements and overlong content fail closed.

An on-date debit may already be reflected in the opening cash. The UI warns the user about possible double counting but cannot reliably infer bank settlement order, so it never automatically adjusts balances or removes future entries.

## Free dependencies and honest limits

- The parser and browser notification signal need no paid external API. Domain, cloud, Mongo/Redis hosting, backups and operational resources may still have costs.
- There is no Account Aggregator or FIU integration. Free AA sandboxes are not licenses to retrieve real customer financial data.
- The app does not observe a transfer that happens while the user is offline and cannot promise instant bank data, bill-fetch integration, SMS alerts, mobile push, or 24-hour automatic monitoring.
- Three matching debits are evidence of past activity, not proof of future liability. Users must still confirm next due date, type, and affordability assumptions.
- Raw CSV rows are parsed in browser memory only. A bounded selection of narration/amount suggestions may remain in React state during an active review; no raw file or transaction history is uploaded or sent to an LLM.
- Deleting saved entries does not certify that separately managed backups are erased immediately. Validate deployment retention/backup policies and applicable privacy regulations before any public launch.

## Required release gates

- Strict malformed-data, date, decimal, duplicate and resource-cap tests.
- React tests that import never writes to the server before an explicit user save, proposal classification is required, and all future amounts remain exact paise.
- Desktop and narrow-mobile Chromium browser tests for local import, review, save, export, deletion and layout.
- Backend Mongo replica-set CAS, idempotency, ownership, rollback and policy upgrade tests.
- Run all three targeted coverage CI jobs plus the complete five-job repository CI on the final commit.
- Perform an independent privacy, accessibility, security, operational performance, backup and legal review before enabling production feature flags.

## Later qualified live data (not included)

Future permitted AA/FIU integration requires a separate verified onboarding, purpose-specific consent and revocation, refresh-frequency contract, evidence timestamps, signed callbacks, deduplication, source reconciliation, rights qualification and retention controls. Do not substitute an LLM or a scraped banking website for regulated access.

## Red-team safety rules for statement balances and session expiry

The unverified file-reported balance may only be displayed when all rows include numeric balances and chronological row-to-row debit/credit deltas reconcile (or there is only one row). Both ascending and descending date order are supported, but ambiguous or inconsistent files suppress any balance number. Duplicated same-signature debits on the same date cannot establish recurrence. Possible bank references (runs of six or more digits) and email addresses are redacted from candidate labels before they can be saved. The 20 earliest prospective due dates are selected after globally ranking all proposals, rather than from statement row order. Session loss (401/403) during refresh clears private saved values, imported review, and calculated outcomes. Other network errors hide positive cash results until revalidation.
