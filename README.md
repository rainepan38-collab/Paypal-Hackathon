# SplitMate AI — chat, split, settle

A mobile PWA for Jimmy, Alex and Sarah, with password-protected group chats, Gemini expense extraction, SQLite history and PayPal Sandbox checkout.

PayPal checkout credits the **configured Sandbox business merchant**. Displaying Alex or Sarah as the organizer does not change that merchant, and this app does not perform friend-to-friend transfers.

## Run locally

Requires Node.js 22+ and npm. Keep your existing `.env` and database.

```bash
npm install
# Only for a new installation; this never replaces an existing .env:
test -f .env || cp .env.example .env
npm run db:migrate
npm run accounts
npm run check
npm test
npm run dev
```

Open http://localhost:3000 (or your existing PORT). The migration creates the Jimmy, Alex and Sarah account records, initially locked. `npm run accounts` privately prompts for a separate password for each. Nothing echoes to the terminal. Choose 10–72 UTF-8 bytes per password; longer bcrypt passwords are rejected rather than silently truncated. There are no default passwords.

To reset one password:

```bash
npm run accounts -- Alex
```

Resetting a password invalidates that account's sessions. For a noninteractive private secret-manager workflow, `npm run accounts -- --stdin` accepts a JSON object mapping canonical usernames to passwords through standard input. Never put passwords in command arguments, source code, chat, GitHub, or a committed JSON file. Passwords are stored only as bcrypt hashes (cost 12).

Use **Switch / sign out**, then enter the next account's password. Identity comes from the server-side session; changing localStorage or a request's `actor` does not switch accounts. Login usernames are case-insensitive `jimmy`, `alex`, `sarah`. The old name `You` is a participant alias, not another login account.

## Configuration

See `.env.example`. Keep actual values in your existing local `.env` and Railway private variables.

| Variable | Purpose |
| --- | --- |
| `DB_PATH` | Existing SQLite file; on Railway it must point inside the current persistent volume |
| `SESSION_SECRET` | At least 32 random bytes; required in production; generate with the command below |
| `SESSION_TTL_HOURS` | Absolute authenticated-session lifetime, default 8 hours, maximum 168 |
| `NODE_ENV` | `production` on Railway; `development` for local HTTP |
| `PUBLIC_BASE_URL` | Exact public HTTPS origin on Railway, used for CSRF origin validation |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Official Google Gen AI SDK; default model `gemini-2.5-flash` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Existing Sandbox merchant credentials |
| `PAYPAL_WEBHOOK_ID` | Existing verified Sandbox webhook configuration |
| `PAYPAL_API_BASE` | Keep `https://api-m.sandbox.paypal.com` |
| `PORT` | Local port; Railway supplies its own value |

Generate a private session secret locally and paste it into the hosting variables without committing it:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

For local development only, an unset secret produces a random process-specific secret and a warning; sessions become invalid on restart. In production, startup refuses a missing or short secret. Keep the production secret stable across deployments. Production cookies are always Secure; local HTTP cookies are HttpOnly and SameSite=Lax, with Secure also enabled when HTTPS is detected behind the trusted single proxy hop.

## Gemini and split behavior

With a configured key, the interface says **Gemini enabled.** This means a key is present; a successful expense draft verifies API access. If Google says the default model is unavailable, set `GEMINI_MODEL` to a model available to your key. Empty key uses an explicitly labeled rule-based parser. API errors never silently become a local-parser success.

The authenticated organizer and actual group members are sent as extraction context. Model output is schema-constrained, then independently validated against backend membership. Self-reimbursement, duplicate aliases and unknown participants are rejected. All arithmetic uses integer cents. Remainder cents go in participant order: organizer first, followed by named participants.

| Signed in | Message | Shares in participant order |
| --- | --- | --- |
| Jimmy | `@SplitMate I paid $96 for dinner with Alex and Sarah. Split equally.` | Jimmy $32, Alex $32, Sarah $32 |
| Alex | `@SplitMate I paid $32 for dinner with Jimmy and Sarah. Split equally.` | Alex $10.67, Jimmy $10.67, Sarah $10.66 |
| Sarah | `@SplitMate I paid $60 for groceries with Jimmy and Alex. Split equally.` | Sarah $20, Jimmy $20, Alex $20 |

When Alex or Sarah explicitly names `You` as a participant and Jimmy is the unambiguous member, it maps to Jimmy. Jimmy's own use of `You`, missing Jimmy membership, and other ambiguities request clarification. Original human messages retain their text; identity migration does not rewrite ordinary English pronouns.

Only the organizer can confirm a draft. All group members see split status; checkout tokens are returned only to the organizer and named payer. Both can view and reshare the payment link, but only the authenticated named payer can create/capture its checkout order. An unauthenticated payment link redirects to login and returns to that link afterward.

## PayPal Sandbox and PWA

Keep the existing Sandbox merchant REST app and separate Sandbox Personal buyer. Sign in to SplitMate as the named participant, open **Pay now**, then use the Sandbox buyer in PayPal's checkout. Capture amount, currency, order ID and completion status are validated before updating SQLite and chat. Repeated captures/webhooks do not add repeated payment messages.

Register the existing HTTPS `/webhooks/paypal` endpoint for `PAYMENT.CAPTURE.COMPLETED` and keep its webhook ID. The route retains raw-body handling and PayPal signature verification; it is intentionally exempt from user sessions and CSRF because PayPal calls it directly.

Install the PWA through Safari's Add to Home Screen or Chrome's install action over HTTPS. The service worker caches static assets only. Chats, sessions, payment pages and API responses are not cached for offline access. Existing legacy caches are removed when the new worker activates. An offline authenticated chat is not supported.

## Tests

```bash
npm run check
npm test
# Optional: actual Gemini extraction + read-only PayPal Sandbox OAuth; no checkout/capture:
npm run test:live
```

Automated tests generate temporary passwords, use in-memory/temporary SQLite, and mock external APIs. They cover all three organizers, legacy aliases, exact-cent rounding, backend authorization, CSRF, cookies, session rotation/expiry, logout/switching, password reset, rate limiting, verified webhooks, payment tracking, backup integrity, migration rollback and repeated migration.

An optional browser regression uses a separate Playwright installation and local Chrome. It blocks external browser traffic and uses an in-memory database and the local parser:

```bash
npm install --prefix /tmp/splitmate-ui-tools playwright
PLAYWRIGHT_MODULE=/tmp/splitmate-ui-tools/node_modules/playwright/index.mjs node tests/ui-smoke.mjs
```

`CHROME_PATH` can select a Chrome executable. Browser screenshots are written to a private temporary directory, not the repository. The normal test suite does not require Playwright.

## Identity migration and data safety

On first startup (or `npm run db:migrate`), migration version 1 creates a consistent SQLite online backup under a `backups` directory beside the configured database. It includes committed WAL data, uses private file permissions, and must succeed before migration starts. Schema and identity updates then run in one transaction. Malformed legacy participant data aborts and rolls back the entire migration; the backup remains available.

New tables: `schema_migrations`, `users`, `user_aliases`, `chat_groups`, `group_members`, `expense_participants`, `sessions`, `login_limits`. New nullable identity columns: `expenses.organizer_user_id`, `shares.person_user_id`, `chat_messages.sender_user_id`. Existing records originally had name-based identities, so stable new user IDs associate those records with the three accounts. Existing expense/message/share IDs, tokens, financial fields, links and PayPal references are preserved. Structured `You` names become Jimmy; old human message contents are retained. No duplicate Jimmy/You account is created.

Migrations run once and are safe to rerun. New passwords are never assigned automatically. For an additional consistent backup at any time:

```bash
npm run db:backup
```

Stop older application processes before upgrading so old code cannot write name-only identities after migration. Back up before any password reset if you need a full credential rollback. Never copy just a live main SQLite file while ignoring its WAL. Database files, WAL files, backups and `.env` are ignored by Git.

## Deployment and rollback

See [the Railway update guide](docs/RAILWAY.md) for preserving the existing volume, staging a reviewable commit, variables, account setup, production tests and rollback. [The change manifest](docs/CHANGES.md) lists changed files and responsibilities. No deployment is required to run local checks.

SQLite uses one app replica and one mounted persistent volume. This remains a controlled three-account Sandbox MVP; it has no registration, email/SMS OTP, password recovery service, itemized splits, push notifications or production payment compliance workflow.
