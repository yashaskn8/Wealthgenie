# GenieVoice Browser Companion — read-only prototype

This is **not** a general computer-use agent. Install in Chrome as an unpacked
extension for local testing only. Clicking the extension grants Chrome's
temporary active-tab capability. Clicking "Inspect selected tab" checks a small
public authority hostname allowlist, reads up to 3,000 characters of the
selected page's visible body text, and renders the text **inside the popup only**.

Security choices:
- No persistent host permissions, storage permission, cookies, web requests,
  webpage event execution, password extraction or automatic form interaction.
- HTTPS and exact public-hostname allowlist only, checked before and after
  script injection. Navigation or permission revocation fails closed.
- No connection to the WealthGenie backend and no LLM transmissions.
- Retrieved content is untrusted; never use its words as operating instructions.
- Do not use this prototype to make current financial claims without separate
  source qualification, retention rights and evidence validation.

Next stage requires user-granted tab-scoped action capabilities, isolation,
auditable receipts and independent extension security testing.
