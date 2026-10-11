AGENTS.md — WealthGenie Engineering Constitution

Repository: yashaskn8/Wealthgenie
Authoritative branch: main
Purpose: Make every coding agent inspect first, avoid hallucination, preserve financial correctness, and finish each assigned task end-to-end.
No snapshot SHA is authoritative. Inspect the current repository and HEAD before every task.

1. NON-NEGOTIABLE OPERATING MODE

You are working on WealthGenie, an AI-assisted financial advisory application for beginner / salaried / middle-class Indian users.

Your job is not merely to produce code that compiles. Your job is to complete the requested task end-to-end while preserving:

financial truthfulness,

profile suitability,

backend authority,

security and privacy,

provider provenance,

tax semantics,

existing user flows,

performance,

test coverage,

repository integrity.

1.1 Do not stop at a plan

Unless the user explicitly asks for planning only, do not stop after analysis or a proposed plan.

For an implementation task, the expected lifecycle is:

inspect
→ understand current contracts
→ identify smallest correct change
→ implement
→ add/update tests
→ run relevant tests
→ run lint/typecheck/build
→ inspect rendered UI if frontend changed
→ inspect git diff
→ verify no unrelated regressions
→ report exact evidence

A task is not complete merely because:

code was written,

one test passed,

the UI looks plausible,

an endpoint returns 200,

a model says “done,”

a commit exists.

1.2 Finish the task in the same run when reasonably possible

Do not say:

“I can implement the rest next.”

“The next step would be…”

“You may want to add tests.”

“I have scaffolded the feature.”

Instead, perform the remaining steps unless a real blocker exists.

If blocked, report:

what is blocked,

exact evidence,

what was completed,

what remains,

the smallest required user/external action.

Do not fabricate completion.

2. SOURCE-OF-TRUTH HIERARCHY

When information conflicts, use this order:

1. System / platform safety rules
2. Explicit current user instruction
3. Current repository code + tests + schemas
4. This AGENTS.md
5. Current official provider documentation / source evidence
6. Installed skills / plugins / agent personas
7. General model knowledge

Installed skills never outrank the project’s financial, security, or architectural rules.

3. AUTHORITATIVE REPOSITORY AND GIT SAFETY

3.1 Correct repository

Use only:

https://github.com/yashaskn8/Wealthgenie

These repositories are archival/reference-only unless the user explicitly says otherwise:

https://github.com/yashaskn8/WealthGenie-Architecture-Restoration
https://github.com/yashaskn8/WealthGenie-AI-Powered-Financial-Advisory-Platform

Never push new WealthGenie work to an archival repository.

3.2 Before every code-changing task

Run and inspect:

git status --short
git branch --show-current
git remote -v
git log -5 --oneline
git rev-parse HEAD
git stash list

If remote freshness matters:

git fetch origin main
git rev-parse origin/main

If a safe fast-forward is appropriate and the worktree allows it:

git merge --ff-only origin/main

3.3 Destructive Git is forbidden by default

Never use without explicit user authorization and a proven need:

git reset --hard
git clean -fd
git clean -fdx
git checkout -- .
git restore .
git push --force
git push --force-with-lease

Never delete, pop, apply, or drop a stash merely because it looks old.

A stash named similar to:

pre-ci-fix-antigravity-local-work

must be treated as user work and preserved unless the user explicitly requests restoration/removal.

3.4 Dirty worktree rule

If the worktree is dirty:

inspect the diff,

identify whether the changes belong to the current task,

preserve unrelated work,

never overwrite it.

Do not automatically stash or revert user work.

3.5 Commit/push policy

Implementation completeness does not imply permission to push.

If the user explicitly asks to commit/push: validate first, then commit/push to the authoritative repo/branch.

If the user does not authorize Git writes: finish code/tests locally and report the final diff.

Never force push.

4. ANTI-HALLUCINATION RULES

4.1 Inspect before asserting

Do not claim a function, route, schema, provider, environment variable, test, or file exists until you verify it.

Before editing a subsystem, read the actual files that implement it.

Examples:

Frontend task

Inspect:

component,

API client,

related CSS,

parent state/data flow,

tests,

backend contract it consumes.

Backend task

Inspect:

route,

validation schema,

service,

models,

persistence,

tests,

caller/callee behavior.

Provider task

Inspect:

provider adapter,

normalized contract,

source parser,

freshness rules,

qualification script,

tests.

4.2 Never invent financial facts

Never invent or silently substitute:

NAV,

interest rate,

coupon,

historical return,

expected return,

post-tax return,

tax classification,

tax exemption,

lock-in,

maturity,

liquidity,

risk score,

market regime,

product ranking,

provider availability,

source date,

freshness,

confidence.

Unknown must remain unknown/null/unavailable.

Never convert unavailable financial data to 0.

4.3 No fake fallbacks

A provider failure must not silently become:

hardcoded data,

stale catalog values presented as live,

model assumptions presented as provider data,

another provider substituted without an explicit contract.

Fail closed.

4.4 Do not infer structured product facts from names unless the current qualified contract explicitly permits it

Product names are presentation text, not a reliable schema.

Do not infer:

Direct vs Regular,

Growth vs IDCW,

tax class,

guarantee,

benchmark,

lock-in,

eligibility,

maturity,

product type,

from name substrings unless the existing validated provider parser has an explicit source-backed rule.

If touching legacy heuristics, do not expand them. Prefer source-qualified metadata.

5. CORE WEALTHGENIE ARCHITECTURE

The intended authority flow is:

Financial Profile
→ hard suitability gate
→ eligible investment universe
→ verified provider / market facts
→ provider-specific adapters
→ normalized provider-neutral facts
→ product comparison/ranking
→ deterministic market feature engine
→ deterministic market-context policy
→ hysteresis
→ bounded profile-safe adjustment
→ post-adjustment suitability validation
→ concentration validation
→ authoritative backend recommendation
→ frontend presentation/evidence

Supporting flows:

AMFI
→ mutual-fund product/NAV/history evidence

NSE
→ current market context evidence

India Post / DEA
→ small-savings official facts

SBI
→ qualified comparable FD facts

RBI
→ Floating Rate Savings Bond rule/current coupon semantics

Tax engine
→ explicit user inputs + fiscal-year-versioned calculation

Projection engine
→ MODEL_ASSUMPTION / SIMULATION

NVIDIA NIM / Gemini / Groq
→ grounded explanation only

6. GLOBAL FINANCIAL INVARIANTS

These invariants must survive every feature/refactor.

LIVE MARKET DATA
may change relative score/weight/context
but NEVER bypasses profile suitability.

Never implement:

if market crashes → force FD
if VIX > X → sell stocks
LLM → recommendation authority
LLM → allocation weights
frontend → direct provider calls
HMM → portfolio allocation
historical return → expected return
provider rate → projection assumption

6.1 Semantic distinctions

Always preserve:

current price
≠ historical return

historical return
≠ expected return

expected-return assumption
≠ official scheme rate

yield
≠ post-tax return

NAV
≠ expected return

current coupon
≠ guaranteed lifetime return

historical post-tax return
≠ future post-tax return

MODEL_ASSUMPTION
≠ provider fact

7. PROVIDER AUTHORITY

7.1 AMFI

AMFI is the qualified authority for supported mutual-fund:

product identity,

current NAV,

historical NAV evidence.

Current ranking behavior must preserve:

max 5 results,

no forced padding,

exact qualified AMFI category mapping,

source-established Direct plan,

source-established Growth where required by the evidence-ranked set,

fresh positive NAV,

approximately one-year verified historical NAV pair,

trailing historical return ranking.

Do not call trailing return “expected return.”

7.2 NSE

NSE is the default market-context provider using qualified official NSE-hosted website JSON endpoints.

Important:

schema is validated,

endpoints are official NSE-hosted,

they are not guaranteed/versioned public APIs,

adapters must remain isolated,

validation must fail closed.

Market context remains deterministic policy authority.

7.3 Upstox

Upstox is optional.

Do not make core WealthGenie depend on Upstox.

Do not use another person’s PAN/account/credentials.

7.4 India Post / DEA

Use official government source evidence for small-savings facts.

These are generally interval/quarterly official rates, not live market quotes.

7.5 SBI

Only the specifically qualified SBI retail domestic term-deposit source is authoritative for current SBI FD card-rate comparisons.

Do not imply:

“best FD in India,”

broad bank-market ranking,

unsupported tenure equivalence.

7.6 RBI Floating Rate Savings Bond

Canonical product:

government:rbi:frsb-2020-taxable

Required semantics:

Government of India / RBI bond,

7-year maturity,

interest paid semiannually,

coupon linked to applicable NSC reference rate + 35 bps,

reset on Jan 1 and Jul 1,

current coupon is not a fixed 7-year guaranteed rate.

Do not continuously mutate the coupon from every quarterly NSC change if the FRSB reset period has not changed.

If reset-date NSC evidence is unavailable:
fail closed.

8. MARKET-CONTEXT POLICY

Current deterministic policy version lineage includes:

market-context-policy-1.0.0

Do not change thresholds casually.

The current conceptual states are:

NORMAL
CAUTIOUS
HIGH_VOLATILITY
RISK_OFF
MARKET_CONTEXT_UNAVAILABLE

Market context is deterministic policy, not ML confidence.

Do not fabricate “confidence.”

Hysteresis matters:

worsening requires repeated distinct observations,

recovery requires repeated distinct observations,

duplicate observations do not advance state,

unavailable data must not mutate stable state.

Any policy change requires:

explicit task scope,

tests for boundary cases,

tests for hysteresis,

explanation of why behavior changed.

9. HMM / ML MARKET REGIME

The HMM market-regime model is shadow-only diagnostic.

It must not:

select products,

alter allocation,

override deterministic market policy,

create semantic bull/bear claims unless separately qualified.

XGBoost supervised regime labels were not qualified in the established architecture.

Do not silently promote a shadow model to production authority.

10. PROJECTION / MONTE CARLO SEMANTICS

Projection assumptions are planning/model policy.

They are not:

official rates,

provider forecasts,

expected product returns,

guarantees.

Maintain clear provenance such as:

MODEL_ASSUMPTION
WEALTHGENIE_MODEL_POLICY
SIMULATION

Provider data must not silently rewrite projection assumptions.

11. TAX AUTHORITY

Backend tax logic is authoritative.

Frontend tax math is forbidden.

Tax calculations must be:

fiscal-year versioned,

explicit-input driven,

deterministic,

covered by tests.

Current supported fiscal-year lineage includes:

FY2025-26,

FY2026-27.

Always inspect the current tax engine before assuming slab rules.

11.1 Incremental-tax method

For taxable product income, prefer the authoritative incremental-tax method when applicable:

baselineTax =
tax(existing income/context)

taxWithProductIncome =
tax(existing income/context + taxable product income)

incrementalTax =
taxWithProductIncome - baselineTax

netGain =
grossGain - incrementalTax

Do not replace this with:

grossGain × marginalRate

unless the exact product-specific tax contract explicitly requires a different verified rule.

11.2 Product tax classification is a high-risk area

The current repository contains server/services/productPostTaxCalculator.js.

Treat tax classification as financial authority, not presentation logic.

Important:

do not expand name/id heuristic tax classification,

do not assume product tax treatment from naming,

do not hardcode new tax rates from memory,

verify fiscal-year applicability and product category,

prefer explicit source-qualified tax metadata,

if evidence is insufficient, return a non-calculated status rather than guess.

Any change involving:

Section 112A,

Section 50AA,

80C,

EEE treatment,

cess,

exemptions,

holding-period rules,

must be verified against the current project tax policy/source requirements before release.

11.3 Mutual funds

Never show an “exact future post-tax mutual-fund return.”

Permitted:

verified historical return,

historical post-tax illustration when tax treatment and assumptions are defensible.

Label clearly:

HISTORICAL
NOT A FORECAST

11.4 Floating/periodically reset rates

For FRSB or any revisable official rate:

Never label:

exact 7-year return
guaranteed maturity return

unless the contract truly fixes it.

Prefer:

Current coupon
Current after-tax rate
Current-period calculation

with reset disclosure.

12. LLM / ADVISORY BOUNDARY

The LLM is explanation-only.

Preferred provider:

NVIDIA NIM.

Fallback lineage:

Gemini,

Groq,

deterministic evidence template.

The LLM must never determine:

suitability,

product ranking,

allocation,

tax result,

provider fact,

market context,

HMM state authority,

projection assumption.

Evidence is assembled server-side.

LLM output must be validated against the evidence packet.

No external LLM should receive unnecessary:

raw financial profile details,

sensitive tax details,

secrets,

provider credentials.

13. RECOMMENDATION LATENCY / ADVISORY DECOUPLING

The authoritative dashboard recommendation must not wait for LLM advisory generation.

Current architecture intentionally separates:

core authoritative recommendation
→ return promptly

deferred advisory generation
→ secondary asynchronous request

Do not reconnect the LLM to the synchronous financial path.

Do not lower timeouts merely to “make it faster.”

Optimize the slow stage instead.

13.1 Advisory concurrency

Deferred advisory generation has a concurrency/idempotency guard.

Expected behavior:

409 caused by an already-GENERATING advisory is not a terminal failure,

frontend must not mark it FAILED,

bounded retry/polling is allowed,

abort/profile change must not create stale updates.

Do not weaken duplicate-generation prevention.

14. PERSISTENCE / MONGODB

Backend recommendation persistence requires MongoDB transaction support.

Do not introduce a standalone-Mongo fallback for flows that require transactions.

Typical local URI shape:

mongodb://localhost:27017/wealthgenie?replicaSet=rs0

Before modifying transaction-sensitive code, inspect:

session usage,

commit/abort behavior,

idempotency,

audit writes,

failure semantics,

tests.

Audit records must not be silently mutated after a committed authoritative event unless the current explicit audit contract permits it.

15. REDIS

Redis is a performance/caching dependency, not financial authority.

Never let:

stale cache,

cache miss,

Redis outage,

invent or overwrite financial facts.

Cache behavior must preserve:

ownership/auth,

data versioning where relevant,

invalidation correctness,

fail-safe behavior.

16. BACKEND INSTRUCTIONS

The backend consists primarily of:

server/      Node.js / Express
ml-service/  Python / FastAPI / ML

16.1 Node/Express responsibilities

Backend owns:

authentication/authorization,

Financial Profile validation,

suitability,

recommendation orchestration,

provider access,

tax authority,

projection authority,

persistence/audit,

recommendation API contracts,

grounded advisory evidence,

rate limiting/security controls.

16.2 Before changing a backend endpoint

Inspect, in order:

route
→ validation schema
→ auth middleware
→ service/orchestrator
→ model/persistence
→ external provider dependencies
→ caller/frontend
→ tests
→ OpenAPI

Do not change route behavior without checking all downstream consumers.

16.3 Validation

All user input must be validated server-side.

Never trust:

frontend types,

client dropdown values,

hidden inputs,

IDs sent by the browser,

provider payloads.

External provider payloads also require strict validation.

16.4 Authorization

Authentication is not authorization.

For user-owned resources:

load the resource,

verify ownership,

enforce role/permission where applicable.

Do not trust a client-supplied user ID/header as authority.

16.5 Errors

User-visible errors should be clear and safe.

Do not expose:

stack traces,

credentials,

provider secrets,

internal connection strings.

Do preserve machine-readable error codes where the existing API contract uses them.

16.6 API changes

For every API contract change:

update validation,

update route/service,

update frontend/API client,

update tests,

update server/openapi.yaml when externally documented.

16.7 Backend performance

For latency work:

measure before changing,

use Server-Timing or equivalent evidence where appropriate,

identify actual slow stages,

avoid request waterfalls,

avoid duplicate provider calls,

preserve correctness under caching/concurrency.

Do not trade correctness for benchmark numbers.

17. ML-SERVICE INSTRUCTIONS

The ML service is Python/FastAPI.

Current dependencies include:

FastAPI,

scikit-learn,

hmmlearn,

PyTorch,

SHAP,

pandas/numpy,

sentence-transformers,

FAISS,

OpenTelemetry.

17.1 ML failure behavior

If ML recommendation inference fails or times out, use only an already-established deterministic fallback.

Do not invent another model or rule ad hoc.

17.2 Model changes

Any model change requires:

reproducible data preparation,

leakage check,

deterministic/random seed handling,

evaluation evidence,

backward compatibility decision,

tests,

model/version provenance.

Do not report accuracy without:

dataset description,

test split definition,

metric definition.

17.3 SHAP / explanations

Explanations are not recommendation authority.

Do not confuse feature attribution with causal reasoning.

18. FRONTEND INSTRUCTIONS

Frontend:

reactapp/
React 19
Vite
JavaScript/JSX
React Router
Recharts
Framer Motion
Vitest
Playwright

The frontend is presentation + interaction.

The frontend is not financial authority.

18.1 Frontend must never

Never:

fetch AMFI/NSE/RBI/SBI directly,

calculate authoritative tax,

determine suitability,

invent expected returns,

calculate provider rates from memory,

override backend ranking,

infer product financial facts from labels,

use stale financial data after profile change.

18.2 Beginner-first UX

Primary audience:

beginner,

salaried,

middle-class Indian investor.

Default UI should answer:

1. What are my suitable choices?
2. Why does this fit me?
3. What return/rate is actually known?
4. What is the after-tax result when defensible?
5. How risky / liquid / locked-in is it?

Engineering evidence belongs behind progressive disclosure.

Do not expose raw constants as primary copy:

DETERMINISTIC_POLICY_HEURISTIC,

EVIDENCE_RANKED,

OFFICIAL_BANK_PUBLISHED_RATE,

raw reason codes,

policy IDs,

data-class constants.

Translate only for presentation; do not rename backend constants merely for UI aesthetics.

18.3 Market-context presentation

Default beginner view should communicate:

market state,

plain-English meaning,

effect on the user.

Technical details may include:

NIFTY,

VIX,

returns,

drawdown,

moving averages,

timestamps,

freshness,

source,

policy version,

reason codes.

Keep technical detail available but collapsed by default.

18.4 Product cards

Prioritize:

product name,

why it fits,

risk,

access/lock-in when verified,

verified metric,

after-tax result when defensible,

source.

Do not call a historically top-ranked fund:

Best Fund
Guaranteed Winner
Highest Future Return

18.5 Loading states

Financial 0 is a real value.

Never display ₹0, 0%, or “Unavailable” merely because data is still loading.

Use explicit states:

loading,

pending,

generating,

unavailable,

failed,

ready.

18.6 Stale-state prevention

On profile change:

clear/replace stale recommendation state correctly,

abort obsolete requests where supported,

prevent old advisory/product data from being merged into a new profile.

18.7 Accessibility

For any frontend change verify:

semantic button/link roles,

keyboard operation,

visible focus,

labels,

aria where appropriate,

sufficient contrast,

no hover-only essential information,

prefers-reduced-motion.

18.8 Responsive behavior

Inspect rendered UI at multiple widths.

Do not judge frontend quality only from JSX/CSS source.

19. FRONTEND DESIGN PRESERVATION

Preserve the established WealthGenie identity unless the user explicitly requests a redesign.

Preserve:

dark theme,

cyan/blue identity,

sidebar/navigation,

major page architecture,

existing workflows,

existing typography family unless there is a strong verified reason to change it.

Avoid generic AI-dashboard “slop”:

excessive nested cards,

gratuitous gradients,

glowing everything,

uncontrolled glassmorphism,

random icon tiles,

huge decorative blobs,

animations on every element.

Motion should communicate:

state change,

hierarchy,

continuity,

interaction feedback.

20. INSTALLED FRONTEND SKILLS — USE AS SPECIALISTS, NOT AUTHORITIES

If installed and verified, the preferred frontend skill sequence is:

1. UI/UX Pro Max
   information architecture / fintech UX / design-system decisions

2. Leon Taste
   composition / density / anti-generic visual direction

3. Impeccable
   hierarchy / accessibility / polish / UX writing / audit

4. Emil Kowalski skills
   motion / easing / micro-interactions

5. Vercel Web Interface Guidelines
   interaction correctness / accessibility

6. Vercel React Best Practices
   rendering / waterfall / bundle / runtime performance

7. fixing-motion-performance
   jank / layout thrash / animation cost

Skill precedence:

financial correctness
>
security/suitability/tax semantics
>
backend contracts
>
beginner comprehension
>
existing WealthGenie identity
>
design skills

Never claim a skill/plugin is installed until you verify it.

If unavailable, proceed using repository rules; do not invent skill output.

21. BACKEND SKILL/PLUGIN ROUTING

If installed and verified, use only the smallest relevant subset.

Preferred backend toolbox includes:

backend-development
javascript-typescript
python-development
database-design
backend-api-security
security-scanning
unit-testing
debugging-toolkit
application-performance
observability-monitoring
distributed-debugging
data-validation-suite
comprehensive-review
documentation-generation
llm-application-dev
cicd-automation
api-testing-observability
dependency-management

Additional specialist layers when available:

Superpowers: debugging/TDD discipline,

Trail of Bits skills: security review,

A Team: orchestration.

Do not load every plugin for every task.

One lead owns integration.

22. MULTI-AGENT RULES

Multi-agent operation must reduce error, not multiply edits.

Recommended squad:

Lead Orchestrator
├── Frontend Engineer
├── Backend Architect
├── Python/ML Reviewer
├── Database Reviewer
├── Security Reviewer
├── QA/Test Engineer
└── Performance Reviewer

22.1 Single-writer principle

For a given file/subsystem, prefer one implementation owner.

Reviewers may comment/propose changes.

Do not have multiple agents independently rewriting the same component.

22.2 Delegation order

When dependencies exist:

requirements / architecture
→ backend contract
→ frontend implementation
→ security review
→ tests/E2E
→ performance review
→ final integration

Parallel work is acceptable only when file ownership and dependencies are clear.

23. TESTING — CURRENT COMMANDS

Always inspect current package.json/config before assuming commands.

At the current repository snapshot:

23.1 Backend

npm test --prefix server
npm run lint --prefix server
npm run typecheck --prefix server

Useful qualification commands:

npm run qualify:nse --prefix server
npm run qualify:fixed-income --prefix server
npm run qualify:nim --prefix server

Additional backend scripts exist for:

coverage,

load testing,

seed/catalog sync,

market-regime dataset export,

evaluation,

profile migration.

Use only when relevant.

23.2 Frontend

npm test --prefix reactapp
npm run lint --prefix reactapp
npm run typecheck --prefix reactapp
npm run build --prefix reactapp

E2E when the environment is available:

npm run test:e2e --prefix reactapp

23.3 ML service

Inspect the current test configuration.

Typical:

python -m pytest ml-service

or run from the service directory as required by current repository setup.

Do not claim ML tests passed unless they were actually executed.

24. TEST SELECTION RULES

24.1 Small surgical change

Run:

directly affected test(s),

relevant regression suite,

lint/typecheck for affected package.

Then run broader suite if the change touches shared financial authority.

24.2 Financial logic change

Must include:

unit tests,

boundary cases,

negative/unavailable cases,

regression tests,

full relevant backend suite.

24.3 Frontend financial presentation change

Must include:

component tests,

API-contract tests if changed,

build/typecheck,

rendered manual/E2E verification if feasible.

24.4 Provider change

Must include:

parser/contract tests,

malformed source tests,

stale/fresh tests,

unavailable/fail-closed tests,

qualification script where appropriate.

24.5 Auth/security change

Must include:

unauthenticated,

wrong-owner,

wrong-role,

malformed input,

normal authorized path.

25. CI / WINDOWS CONTRACT

Do not “fix” Windows CI by removing important Linux integration coverage.

A historical CI failure came from a Windows no-Mongo job accidentally executing Mongo transaction integration tests.

Correct principle:

Windows no-Mongo job
→ skip only tests that genuinely require transaction-capable Mongo

Linux Mongo jobs
→ preserve real Mongo integration coverage

Never globally disable transaction tests just to make one matrix cell green.

26. OBSERVABILITY

Use observability to explain behavior, not expose secrets.

When instrumenting:

use structured logs,

avoid raw sensitive financial data,

avoid tokens/keys,

preserve request correlation,

use timings for latency diagnosis,

keep metrics labels bounded.

OpenTelemetry exists in both backend and ML dependency lineages.

Do not add duplicate telemetry frameworks without need.

27. SECURITY

27.1 Secrets

Never:

hardcode API keys,

commit .env,

print credentials,

expose keys to frontend bundles.

NVIDIA/Gemini/Groq keys are server-only.

If a key was ever exposed, recommend rotation; never repeat it.

27.2 Financial data

Treat:

income,

deductions,

financial profile,

recommendation history,

as sensitive.

Do not put sensitive tax details:

in URLs,

in analytics labels,

in logs,

into unrelated LLM prompts.

27.3 Input/security controls

Preserve/use:

JWT verification,

strict validation,

Helmet,

Mongo sanitization,

rate limiting,

CORS policy,

ownership checks.

Do not weaken controls to make a test/demo pass.

28. EXTERNAL SOURCE CHANGES

Provider/source integrations are brittle.

Before changing a provider:

inspect current source URL,

inspect parser,

inspect normalized contract,

inspect freshness semantics,

inspect qualification test/script,

capture representative valid/invalid cases.

If the remote site changes:

adapt parser conservatively,

do not scrape unrelated pages,

do not bypass protections with brittle browser hacks unless explicitly approved,

fail closed if semantic identity cannot be verified.

29. CURRENT HIGH-RISK AREAS

Treat these as “extra review required.”

29.1 productPostTaxCalculator.js

This is newly introduced and financially sensitive.

When touching it:

verify tax classification,

verify fiscal year,

verify exemptions/holding periods,

do not expand string-name heuristics,

do not hardcode tax rules from model memory,

preserve historical-vs-future semantics.

29.2 WTI product ranking

Do not accidentally:

rank unsupported products,

force five results,

rank fixed-income products as “best” without a defensible comparable universe,

treat historical mutual-fund returns as expected returns.

29.3 Deferred advisory

Do not re-block core recommendation on external LLM latency.

29.4 Provider freshness

Observed time, effective date, fetched time, and freshness are distinct.

Do not collapse them.

30. FRONTEND/BACKEND SEPARATION

30.1 Frontend owns

presentation
interaction
loading/error states
formatting
progressive disclosure
accessibility
responsive behavior

30.2 Backend owns

financial profile authority
suitability
provider access
financial fact normalization
ranking/comparison authority
market-context policy
tax
projection assumptions
security/ownership
persistence/audit
LLM grounding/evidence

30.3 ML service owns

qualified ML inference
model artifacts
model evaluation
shadow HMM diagnostics

Never move financial authority into React for convenience.

31. API CONTRACT CHANGE CHECKLIST

Before declaring an API change complete:

[ ] route updated
[ ] strict validation updated
[ ] auth/ownership preserved
[ ] service updated
[ ] persistence behavior checked
[ ] frontend client updated
[ ] consumer updated
[ ] error states updated
[ ] tests updated
[ ] OpenAPI updated if relevant
[ ] backward compatibility considered
[ ] no sensitive fields leaked

32. FRONTEND CHANGE CHECKLIST

Before declaring a frontend task complete:

[ ] actual backend contract inspected
[ ] no financial math invented in React
[ ] loading state is truthful
[ ] zero is not used for unknown/loading
[ ] stale requests cannot overwrite newer profile data
[ ] keyboard/focus behavior works
[ ] reduced motion respected
[ ] desktop checked
[ ] narrower viewport checked
[ ] tests pass
[ ] typecheck passes
[ ] build passes
[ ] diff contains no unrelated redesign

33. BACKEND CHANGE CHECKLIST

Before declaring a backend task complete:

[ ] route/auth/schema inspected
[ ] existing service contracts inspected
[ ] financial invariants preserved
[ ] provider provenance preserved
[ ] null/unavailable semantics preserved
[ ] errors fail safely
[ ] concurrency/idempotency considered
[ ] transaction behavior considered
[ ] unit/regression tests added
[ ] backend tests pass
[ ] lint/typecheck pass
[ ] OpenAPI updated when needed
[ ] no secrets/sensitive logs

34. ML CHANGE CHECKLIST

[ ] dataset/provenance documented
[ ] leakage checked
[ ] split methodology correct
[ ] baseline comparison included
[ ] seeds/reproducibility handled
[ ] model version recorded
[ ] shadow/production authority explicit
[ ] tests pass
[ ] metrics not overstated
[ ] no model silently becomes financial authority

35. DEFINITION OF DONE

A coding task is DONE only when all applicable items are true:

1. The requested behavior exists.
2. The implementation uses the actual current architecture.
3. No financial fact was invented.
4. Security/ownership remain correct.
5. Tests for changed behavior exist.
6. Relevant existing tests pass.
7. Lint/typecheck/build pass where applicable.
8. Frontend changes were rendered/inspected when feasible.
9. Provider/qualification checks were run when relevant.
10. Git diff contains no unrelated changes.
11. No generated tooling/runtime artifacts are staged.
12. Documentation/OpenAPI was updated when contract changed.
13. Remaining limitations are explicitly stated.
14. Report includes exact commands/results, not “should pass.”

36. BLOCKER POLICY

A blocker is legitimate only if progress requires something unavailable, for example:

missing credential,

external provider outage,

unavailable transaction-capable Mongo,

unavailable browser dependency for E2E,

missing user decision on a truly ambiguous product requirement.

When blocked:

finish all unblocked work,

do not guess,

make failure truthful,

report the exact blocker.

Example:

Backend unit tests: PASS
Frontend build: PASS
NVIDIA live qualification: NOT RUN
Reason: NVIDIA_API_KEY not present
No fake qualification result generated.

37. DO NOT OVER-REFACTOR

Prefer the smallest change that fully solves the task.

Do not:

rename unrelated modules,

reformat entire files,

replace libraries without need,

redesign unrelated screens,

rewrite working providers,

migrate frameworks during a bug fix.

A “cleaner architecture” is not justification for unrelated scope expansion.

38. DEPENDENCY POLICY

Before adding a dependency:

prove current dependencies cannot reasonably solve the problem,

inspect maintenance/security implications,

avoid large UI/runtime libraries for a small effect,

update lockfile intentionally,

test bundle/runtime impact.

Agent skills/plugins are not application runtime dependencies.

Do not add agent tooling to:

reactapp/package.json,

server/package.json,

ml-service/requirements.txt.

39. GENERATED / LOCAL TOOLING

Local agent/tooling files such as:

.codex-runtime/
playwright-report/
test-results/
coverage/
temporary screenshots
traces
logs

must not be committed unless the project explicitly owns them.

If .codex-runtime/ exists:

treat it as local runtime state,

verify it is ignored/untracked,

do not expose or commit it.

40. REPORTING FORMAT FOR EVERY IMPLEMENTATION TASK

Final response/report should be concise but evidence-based.

Use:

TASK:
<what was requested>

INITIAL STATE:
HEAD:
BRANCH:
WORKTREE:

IMPLEMENTED:
- ...
- ...

FINANCIAL / SECURITY INVARIANTS:
- preserved ...
- preserved ...

FILES CHANGED:
- ...

TESTS:
<command> → PASS/FAIL (exact count when available)
<command> → PASS/FAIL

QUALIFICATION / E2E:
<command> → PASS/FAIL/NOT RUN + reason

BUILD / TYPECHECK / LINT:
...

GIT DIFF REVIEW:
unrelated changes: YES/NO
secrets added: YES/NO
generated artifacts staged: YES/NO

FINAL STATE:
HEAD:
commit/push status:

REMAINING LIMITATIONS:
- none
or
- exact truthful limitation

Never use vague claims like:

“all good,”

“production ready,”

“100% correct,”

without evidence.

41. TASK-SPECIFIC COMPLETION RULES

Bug fix

Must:

reproduce/understand
→ identify root cause
→ add regression test
→ fix root cause
→ run regression + relevant suite

Do not patch only the visible symptom.

Feature

Must:

inspect contracts
→ implement backend authority first if needed
→ wire frontend
→ test happy/error/loading/unavailable paths
→ build
→ inspect UI

Performance

Must:

measure before
→ locate bottleneck
→ change
→ measure after
→ prove semantics unchanged

Security

Must:

identify trust boundary
→ prove exploit/weakness if safe
→ fix
→ negative tests
→ ownership/role tests
→ no sensitive logging

Provider/data

Must:

source evidence
→ parser validation
→ normalized fact
→ freshness/provenance
→ fail-closed path
→ qualification/regression tests

UI polish

Must:

preserve behavior
→ render
→ improve hierarchy
→ accessibility review
→ responsive review
→ performance/motion review

No financial logic changes merely for aesthetics.

42. CURRENT STACK REFERENCE

Verify actual files before relying on this snapshot.

Frontend

React 19

Vite

React Router

Recharts

Framer Motion

Vitest

Playwright

TypeScript compiler used for typecheck even though application source is primarily JS/JSX

Backend

Node.js

Express

Mongoose/MongoDB

Redis

Joi

JWT

Helmet

rate limiting

Winston

OpenTelemetry

ML

FastAPI

scikit-learn

hmmlearn

PyTorch

SHAP

sentence-transformers

FAISS

pandas/numpy

OpenTelemetry

43. ENVIRONMENT VARIABLES — NEVER GUESS VALUES

Relevant environment names may include:

PORT
NODE_ENV
MONGODB_URI
JWT_SECRET
REDIS_URL
ML_SERVICE_URL
ML_SERVICE_API_KEY
CORS_ORIGINS
METRICS_TOKEN
MARKET_DATA_PRIMARY_PROVIDER
GEMINI_API_KEY
GROQ_API_KEY
NVIDIA_API_KEY
NVIDIA_MODEL
NVIDIA_BASE_URL
LLM_PRIMARY_PROVIDER

Always inspect .env.example, config code, or environment-loading code for current truth.

Never:

commit real values,

invent values,

print secrets.

44. FINAL RULES TO REMEMBER

If you remember nothing else, remember these:

INSPECT BEFORE EDITING.

DO NOT HALLUCINATE FILES, CONTRACTS, OR FINANCIAL FACTS.

BACKEND IS FINANCIAL AUTHORITY.

FRONTEND IS PRESENTATION, NOT CALCULATION AUTHORITY.

SUITABILITY CAN NEVER BE BYPASSED.

HISTORICAL RETURN IS NOT EXPECTED RETURN.

OFFICIAL RATE IS NOT A GUARANTEED FUTURE RETURN.

LLM IS EXPLANATION-ONLY.

SHADOW HMM IS NOT ALLOCATION AUTHORITY.

UNKNOWN IS NULL/UNAVAILABLE, NEVER ZERO.

EXTERNAL SOURCE FAILURE MUST FAIL CLOSED.

DO NOT REINTRODUCE LLM LATENCY INTO CORE RECOMMENDATIONS.

PRESERVE USER WORK AND STASHES.

NO DESTRUCTIVE GIT.

DO NOT STOP AT A PLAN WHEN IMPLEMENTATION WAS REQUESTED.

TEST THE CHANGE.

BUILD THE CHANGE.

INSPECT THE DIFF.

REPORT EXACT EVIDENCE.

COMPLETE THE TASK END-TO-END OR STATE THE REAL BLOCKER.

45. FIRST ACTION FOR EVERY NEW PROMPT

Before making assumptions, answer these internally from the repository:

1. What exactly did the user ask to change?
2. Which subsystem owns that behavior?
3. What are the current files/contracts/tests?
4. What financial/security invariants apply?
5. Is the worktree safe?
6. What is the smallest complete implementation?
7. What tests prove it?
8. What commands must pass before I can say DONE?

Then execute the task completely.
