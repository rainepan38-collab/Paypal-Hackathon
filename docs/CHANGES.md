# Authentication and identity update — file manifest

34 source/configuration/documentation files were added or changed. `.env`, `src/paypal.js`, `src/split.js`, the existing parser/split unit tests, PWA icons and manifest were not changed. The existing SQLite file was migrated in place after a consistent private backup; no database files belong in a source commit.

## Application backend

| File | Change |
| --- | --- |
| `src/auth.js` (new) | bcrypt password hashing, opaque HMAC-indexed SQLite sessions, cookie settings, expiry, rotation, logout, CSRF, login rate limits and password-setting helper |
| `src/migrations.js` (new) | Backup-first, versioned, transactional identity/schema migration and canonical demo user/group definitions |
| `src/participants.js` (new) | Group-aware participant resolution, contextual legacy alias handling, duplicate and self-reimbursement checks |
| `src/db.js` | Run migration, preserve existing expense/payment records and use stable account/participant IDs in new expenses and confirmations |
| `src/chat-db.js` | Dynamic authorized group membership, migrated sender IDs and viewer-specific checkout-token access |
| `src/server.js` | Auth endpoints/middleware, authenticated identity instead of client actor, membership/organizer/payer authorization, protected checkout pages and unchanged verified Sandbox merchant flow |
| `src/ai.js` | Send authenticated organizer and current members to Gemini; validate returned participants against that context |
| `src/parser.js` | Apply the same participant rules to the openly labeled local fallback |

## Interface

| File | Change |
| --- | --- |
| `public/login.html` (new) | Responsive username/password login form |
| `public/login.css` (new) | Desktop and mobile login layout |
| `public/login.js` (new) | Session/CSRF bootstrap, password submission, generic errors and safe return to a payment link |
| `public/index.html` | Replace account selector with authenticated account/logout controls, dynamic group members and current account header |
| `public/app.js` | Use server session identity/CSRF, render member IDs and permissions, remove localStorage identity switching, generate organizer-aware examples and revalidate sessions |
| `public/app.css` | Account controls and avatar styling; hide private UI until session verification |
| `public/pay.html` | Display authenticated payer and expense organizer separately |
| `public/pay.js` | Authenticated checkout and CSRF headers; organizer view-only messaging |
| `public/service-worker.js` | Refresh old caches and restrict offline caching to static assets |

## Commands, configuration and documentation

| File | Change |
| --- | --- |
| `scripts/accounts.js` (new) | Hidden interactive password provisioning/reset, or private stdin JSON input; never print supplied passwords |
| `scripts/db-admin.js` (new) | Manual consistent backup and repeatable migration commands |
| `scripts/check.js` (new) | JavaScript/MJS syntax checks |
| `scripts/live-check.js` (new) | Actual Gemini sample extraction and read-only PayPal Sandbox OAuth check; no payment orders/captures |
| `package.json` | Add `bcryptjs` and setup/check/migration/live-test commands |
| `package-lock.json` | Lock the new bcryptjs dependency |
| `.env.example` (new) | Document settings without including credentials; never replaces existing `.env` |
| `.gitignore` | Exclude SQLite/custom database files, backups and credential export files |
| `README.md` | Account setup, security behavior, exact split examples, data migration and tests |
| `docs/RAILWAY.md` (new) | Existing-volume deployment, secrets, private account provisioning, hosted checklist, safe Git review and rollback |
| `docs/CHANGES.md` (new) | This complete file manifest and validation results |

## Regression tests

| File | Change |
| --- | --- |
| `tests/server.test.js` | Authenticated three-user API flow, forgery/CSRF/session tests, membership/confirmation permissions, exact-cent splits, legacy references, payment authorization and verified webhook tracking |
| `tests/ai.test.js` | Preserve SDK request/response tests and adapt the self-participant error assertion |
| `tests/participants.test.js` (new) | Local extraction for all three organizers and contextual aliases |
| `tests/migrations.test.js` (new) | WAL-aware backups, preserved record/payment identities, idempotency, reopen and full rollback on malformed legacy data |
| `tests/accounts.test.js` (new) | Password provisioning, hash-only storage, input rejection and production-secret requirements |
| `tests/ui-smoke.mjs` (new) | Optional standalone Chrome UI regression with Playwright installed outside the project |

## Executed validation

- `npm run check`: passed for all project JavaScript and MJS files.
- `npm test`: 47 tests passed, zero failures. External API calls mocked; databases and passwords isolated from existing user data.
- Optional Playwright/Chrome check: passed desktop/mobile login, all three organizers, authorized/disabled confirmation buttons, localStorage spoof rejection, password-verified switching, session-expiry redirect, current-account labels and checkout-page identities. Browser traffic outside localhost was blocked; screenshots were inspected. The local fallback was used for these UI splits.
- `npm run dev`: started on a temporary unused port/database; `/health` and `/login` returned 200, unauthenticated `/api/chats` returned 401. Only that temporary process was stopped afterward.
- `npm run db:migrate`: rerun against the existing local database; reported already current.
- Real Gemini calls with the current configured model: Jimmy $96, Alex $32 and Sarah $60 samples all passed with correct totals and named peers.
- Real PayPal Sandbox OAuth: passed. No real or Sandbox order/capture was created during live checks. Actual browser checkout remains on the hosted end-to-end checklist.
- Existing local data comparison: all 15 expenses, 7 shares, 73 messages, 15 chat-expense links and 7 webhook records preserved. IDs, amounts, statuses, tokens, PayPal references and human message contents retained. SQLite integrity check returned `ok`, with zero foreign-key errors.
- `.env` SHA-256 matched the pre-change snapshot. API credentials/settings were not rewritten.

New account rows start locked until passwords are provisioned privately. Test passwords exist only in isolated test databases/memory. No Git repository exists in this local folder; no commit, push, Railway deployment or remote database operation was performed.
