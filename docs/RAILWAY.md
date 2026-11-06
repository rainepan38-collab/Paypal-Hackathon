# Update the existing Railway service

These instructions preserve the existing project, GitHub connection, volume and SQLite file. Do not create a replacement volume or upload the local database over the hosted one. No deploy, push or remote migration is performed by the local code changes.

## 1. Prepare and back up

1. Record the currently deployed Git commit, service/environment, existing volume mount path, `DB_PATH`, start command and PayPal webhook ID. Confirm that `DB_PATH` points to the current SQLite file inside that volume. Keep a single app replica.
2. In Railway's service Backups tab, create a manual backup of the existing volume before updating. Store any downloaded backup privately. The [Railway backup documentation](https://docs.railway.com/volumes/backups) covers schedules and restore behavior.
3. Plan a short maintenance window. Stop chat/checkout activity and ensure older application processes stop before the new version writes identities. Preserve a list of in-flight Sandbox orders for reconciliation if needed.
4. Disable automatic deployments temporarily while preparing and reviewing changes if a push to the connected branch would deploy prematurely. Pushing to that branch is itself a deployment trigger when enabled; [Railway's autodeploy guide](https://docs.railway.com/deployments/github-autodeploys) explains branch selection and controls.

## 2. Set private Railway variables

Preserve all current Gemini and PayPal variables. Add/configure:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | A private random value of at least 32 bytes; preferably generate 48 random bytes as shown in README |
| `SESSION_TTL_HOURS` | `8`, or another positive value up to `168` |
| `PUBLIC_BASE_URL` | The exact public HTTPS origin, e.g. `https://your-existing-service.up.railway.app` |
| `DB_PATH` | Keep the existing volume-backed path; e.g. `/app/data/splitmate.sqlite` only if that is already the correct path |

Railway supplies `PORT`. Do not replace existing API credentials or set real passwords as public build variables. No password environment variables are required. Passwords are provisioned into the persistent database through the private account command after the new code is running.

Production requires the session secret and uses Secure, HttpOnly, SameSite=Lax cookies. A wrong `PUBLIC_BASE_URL` causes CSRF failures; match the URL users actually use. The code trusts one reverse proxy hop, suitable for the intended single Railway proxy configuration. If you add another proxy/CDN, review this setting before exposure.

Saving Railway variables may stage a new deployment. Review the staged changes and deploy only when ready.

## 3. Commit safely in the existing GitHub checkout

The working folder supplied for this task has no `.git` directory. No repository was initialized and no remote was inferred. If your GitHub-linked checkout lives elsewhere, transfer only the files listed in `docs/CHANGES.md` into that existing checkout. Do not transfer `.env`, `node_modules`, `data`, SQLite files, backups or any credential exports. Keep the existing remote and history.

From that existing checkout:

```bash
git status --short
git remote -v
npm ci
npm run check
npm test
# Stage source explicitly; never stage all local files blindly:
git add package.json package-lock.json .gitignore .env.example README.md src public scripts tests docs
git diff --cached --stat
git diff --cached --name-only
# These should produce no tracked secrets/database paths:
git ls-files -- .env 'data/*' '*.sqlite*' '*.db' '*passwords*.json'
```

Review the staged diff privately for credentials. `.gitignore` does not untrack files already committed. If secrets/data are already tracked, remove them from the index in that checkout while preserving local copies, rotate exposed credentials, and address repository history before pushing. Never paste secret-containing diffs into a public review.

When you approve the reviewed source changes:

```bash
git commit -m "Add authenticated group accounts and organizer-aware expense splits"
git push origin HEAD:YOUR_REVIEW_BRANCH
```

Open/review a PR if that is your workflow. After approval, merge/push to the Railway-connected branch. Replace the placeholder branch with the actual branch; do not run it literally. This project needs `bcryptjs` in addition to the existing dependencies; it has no new native build requirement.

## 4. Deploy and migrate the current volume

1. Keep the service start command `npm start` and the existing volume attachment. Retain Node.js 22+ and use `npm ci` for dependency installation. Configure `/health` as the healthcheck path.
2. Once you approve deployment, enable autodeploy for the correct GitHub branch or use Railway's **Deploy Latest Commit** action. Check that the deployment references the reviewed commit SHA.
3. Migration runs automatically at application startup, before listening. It backs up the current configured database to `backups/splitmate-*.sqlite` beside that file, then applies schema/identity changes atomically. It never copies the local development database into Railway. Keep enough free volume space for a full database backup.
4. Do **not** move migration to a build or pre-deploy command: Railway [mounts volumes at runtime, not during build or pre-deploy](https://docs.railway.com/volumes#volume-availability). The startup path has the mounted volume. A manual `npm run db:migrate` in an SSH session inside the deployed container is safe to rerun if desired.
5. Confirm startup logs report the migration backup and normal listening message, without credentials. `/health` should return HTTP 200. Schema errors must fail startup and retain the backup; do not delete tables to force success.
6. Through Railway SSH into this existing service/environment (not a local `railway run` process), run `npm run accounts` in the application directory. Use the hidden password prompts to set Jimmy, Alex and Sarah independently. If your SSH connection lacks a TTY, use `npm run accounts -- --stdin` with a private secret-manager stream; never put plaintext passwords in command arguments or repository files. `railway run` runs locally and cannot initialize the remote volume.
7. Keep account passwords in a private password manager and provide each tester only their intended account's password. To reset one, run `npm run accounts -- Alex` in that same container. This revokes Alex's existing sessions.
8. Verify all three can sign in. They stay locked until passwords are provisioned. Passwords and sessions then persist on the volume across restarts. Keep `SESSION_SECRET` stable to preserve active sessions.

## 5. Hosted end-to-end checklist

- [ ] Root redirects to login while signed out; direct chat/payment API requests return 401.
- [ ] Sign in as Jimmy. Group headers/members show Jimmy, Alex and Sarah; no default `You` identity appears. Original historical message text may still contain that word.
- [ ] Send a normal group message; view it as another signed-in account in a separate browser/profile.
- [ ] Jimmy sends the $96 dinner example: three $32 shares, only Jimmy can confirm.
- [ ] Alex sends $32 with Jimmy and Sarah: Alex $10.67, Jimmy $10.67, Sarah $10.66; owed total plus organizer share equals $32.
- [ ] Sarah sends $60 with Jimmy and Alex: three $20 shares.
- [ ] Alex's old-style `with You and Sarah` request resolves to Jimmy and Sarah. Jimmy's ambiguous `You` request asks for clarification.
- [ ] Unknown names, duplicate aliases and self-reimbursement fail without creating requests.
- [ ] Other users' confirm buttons are disabled; forged `actor` fields do not change backend identity.
- [ ] Switch/sign out returns to login. Old sessions stop working, and another account requires its password. Wrong passwords produce a generic error.
- [ ] Cookie has Secure, HttpOnly and SameSite=Lax over HTTPS; session APIs have Cache-Control: no-store. Test expiration in an isolated staging environment with a shorter `SESSION_TTL_HOURS`, then restore the production value.
- [ ] Missing/wrong CSRF headers and a foreign Origin are rejected; eight failed login attempts per account per 15-minute window trigger rate limiting. Test rate limiting on staging so judges are not locked out.
- [ ] Organizer can copy/open a payment link; only the named payer can initiate checkout. The link opens login when signed out, then returns to the named share after login.
- [ ] As the named payer, complete one genuine PayPal Sandbox checkout using a separate Sandbox Personal buyer. Confirm paid status in chat and SQLite. Test funds credit the configured Sandbox merchant, regardless of displayed organizer.
- [ ] Send a genuine verified `PAYMENT.CAPTURE.COMPLETED` event through the configured PayPal webhook; invalid signatures fail, repeated deliveries do not duplicate paid updates.
- [ ] Use a real Gemini request to verify model access; the enabled label alone is not proof of a successful model call. Choose an accessible `GEMINI_MODEL` if Google rejects the requested default.
- [ ] Refresh, restart/redeploy the service, and confirm old messages, payment tokens, paid flags and account passwords persist on the existing volume.
- [ ] Test desktop, a narrow mobile viewport and installed PWA. After updating an existing installation, reload/reopen once to activate the new service worker; no private chat is available offline or after logout.

Local automated tests mock Gemini, PayPal OAuth/orders/capture/signature APIs. They do not replace these hosted live API checks. `npm run test:live` performs small real Gemini requests and read-only Sandbox OAuth only; it never creates or captures an order.

## 6. Rollback

1. Stop new activity and disable autodeploy. Preserve the failed deployment logs and take another private consistent backup before changing any data. Record any payments/messages created after the migration backup.
2. Prefer a forward fix while keeping the current database. The added columns/tables preserve old records; no down migration drops data. Do not expose the older unauthenticated code publicly as a security rollback.
3. If reverting code is necessary, put the service in maintenance first and redeploy the recorded previous commit using Railway deployment controls. The prior code can write stale name-only records, so do not resume ordinary traffic against a migrated database until compatibility is resolved.
4. If data restoration is necessary, stop **all** processes using that SQLite file. Preserve the current main file and WAL/SHM sidecars together in a separate private recovery directory. Use a consistent pre-migration backup (or Railway's volume restore workflow) and restore with the matching code version. Do not overlay a backup onto an open database or leave old WAL files beside a restored main file. Have the project owner approve the concrete restore operation before performing it.
5. Railway's [backup restore workflow](https://docs.railway.com/volumes/backups#how-to-restore-a-backup) stages a restored volume and retains the original unmounted volume. Review those staged changes before deploying; do not delete the original or accept a volume replacement casually.
6. Restoring an older snapshot removes later local records from the active copy. Reconcile all later PayPal orders/captures and chat history from the retained current backup before resuming. Do not rerun a checkout just because an older restored database says unpaid.
7. Clear/revoke sessions after a recovery and recheck users, memberships, `/health`, SQLite integrity, payment status and login. Deploy the corrected authenticated version before reopening access.
