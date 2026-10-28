# Pilot 1/250 — Bank Recurring Deposit (family `catalog_2026_bank_rd`)

**Research check:** 28 October 2026. **Decision: first-party issuer offering existence researched; production comparison NOT VERIFIED.** No provider grants, recommendation status, or user document was uploaded.

Two distinct banks publish 12-month retail recurring-deposit offerings. These are **issuer offering identities**, not exchange-traded ISIN-bearing securities or account-level IDs. Neither record has been opened, assigned a source-qualified instrument identity, licensed for commercial publication, approved for personalized advice, or registered as an actual product in WealthGenie PostgreSQL.

| Research dimension | State |
|---|---|
| Family catalog entry | Present: `catalog_2026_bank_rd` |
| Distinct issuer offering references | 2 researched (SBI; HDFC Bank) |
| Issuer product identity and terms | First-party web pages located; not an independently authorized product review |
| Published 12-month ordinary rates | SBI 6.25% p.a. (term-deposit bucket effective 15 Dec 2025); HDFC 6.25% p.a. (RD table effective 10 Jun 2025) |
| Monthly minimum | SBI ₹100; HDFC ₹500 |
| Current applicant eligibility | NOT VERIFIED (account-opening/identity checks outstanding) |
| Fees and withdrawal terms | Not fully reconciled; refer directly to current bank disclosures |
| DICGC | Relevant bank-deposit insurance, ₹5 lakh aggregate principal + interest per depositor/bank in same capacity, subject to conditions; not a per-product investment guarantee |
| Financial tax classification | Requires year-specific source-qualified tax evidence and investor context |
| Source rights for commercial processing/display/redistribution | **NOT INDEPENDENTLY VERIFIED** |
| Provider-signed entitlement (production) | **ABSENT** |
| Personalized suitability and regulated-advice clearance | **NOT VERIFIED** |
| Real products qualifying for production Top 3 | **0 established by this research**, not a live database count |

## Official first-party sources reviewed

- SBI RD product features and penalties: https://sbi.bank.in/web/personal-banking/investments-deposits/deposits/recurring-deposit
- SBI 1-year to under-2-year retail domestic term deposit rate: https://sbi.bank.in/web/interest-rates/deposit-rates/retail-domestic-term-deposits (the SBI RD product page states it uses term-deposit rates)
- HDFC RD product and tenure/minimum: https://www.hdfc.bank.in/recurring-deposit
- HDFC 12-month RD rate, resident ordinary: https://www.hdfc.bank.in/interest-rates
- HDFC RD contractual conditions: https://www.hdfc.bank.in/terms-and-conditions
- DICGC deposit insurance explanatory guide: https://www.dicgc.org.in/guide-to-deposit-insurance

A public issuer rate sheet is a research reference, **not authorization to harvest, store, commercially derive or redistribute its content**. SBI's published website terms reserve intellectual-property permissions and do not independently grant all WealthGenie operations: https://merchant.sbi.bank.in/sbijava/retail/html/Terms_of_Use.html . Obtain an independently authenticated, scope-matched, non-confidential provider grant (or an alternative independently licensed provider source); the user's confidential phone documents must not be accessed or fingerprinted.

The `server/data/qualificationPilots/bankRecurringDeposit2026-10-28.json` records evidence pointers and a manually checked published-rate snapshot **for research only**, not an operational rate feed or current quote. No source-data license is asserted. The validator fails closed on changed issuer domains, approval flags, inferred rights, or rate substitution. It will report `RECHECK_REQUIRED` after seven days.

## Stop/go decision

**STOP (28 October 2026).** Before the first family can count toward two qualified production recommendations:

1. Independently verify commercial access, extraction, storage, calculations, public display, redistribution and retention rights covering the exact selected source. A provider-signed receipt must bind source, scope, expiry and revocation. No mobile documents.
2. Confirm actual openable retail offerings and customer eligibility directly under current issuer terms. Resolve premature withdrawal/fees and account restrictions; deposits do not have ISINs by default.
3. Review the valid fiscal-year taxation, DICGC disclosures, risk and profile-dependent suitability without choosing products on the user's behalf.
4. Capture fresh authorized published-rate observations with retention controls, enforce the provider verification gate, register distinct actual products, and run the **live read-only production coverage audit** for this family.
5. Require two independent qualified products, no fake padding, successful CI/CD, and regulated advice authorization where necessary.

**Do not move to category 2 as a claimed fully verified success.** This is evidence progress, not a product-approval milestone.
