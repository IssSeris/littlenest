# Authenticated browser regressions

Run against the **development** Little Nest and API workflows:

```sh
pnpm --filter @workspace/little-nest test:browser
```

`REPLIT_DEV_DOMAIN` supplies the default URL. Alternatively set
`PASTE_BROWSER_BASE_URL` to a localhost or `.replit.dev` development URL.
Production URLs and `NODE_ENV=production` are refused. Both workflows must
already be running; the runner does not replace their managed configuration.

Playwright's Chromium, Firefox and WebKit binaries and their system libraries
must be installed in the execution environment. Missing engines are failures,
not skipped tests. Select one engine for debugging with `--project=firefox`.
The default command runs the entire three-engine matrix, with one worker and
no retries so timing regressions are not hidden.

On Replit/Nix, the configuration resolves the installed `.replit` packages'
library outputs and passes them to the browser subprocesses through
`LD_LIBRARY_PATH`. It does not hardcode store hashes or alias incompatible
library versions. The configured `icu74` and `libjpeg8` provide WebKit's exact
ABI versions. The downloaded WebKit engine also needs an installed JPEG XL
0.8 compatibility output. The runner discovers that exact version in Replit's
shared Nix store and fails explicitly if it is absent; the current libjxl
package is not ABI-compatible and must not be symlinked to impersonate it.
Playwright's Debian `ldconfig` precheck cannot see these Nix library paths.
The Nix-only setup checks its dynamically loaded library requirements directly
and disables that incompatible precheck; actual engine launch/runtime failures
still fail the run, and no browser project is skipped.
The Nix-only WebKit launch shim runs the unchanged downloaded engine with its
normal bundle variables while preserving the host library paths. The upstream
MiniBrowser shell wrapper otherwise overwrites `LD_LIBRARY_PATH`, hiding even
libraries that were successfully resolved by the test configuration.
The headless renderer also receives Mesa's resolved vendor/driver locations
and uses software surfaceless EGL; it does not depend on a GPU or desktop.
GLib's networking module directory is resolved explicitly so WebKit's network
process has TLS support when loading the HTTPS development app.
On non-Nix hosts, use the standard Playwright host dependencies.

## GitHub Actions

`.github/workflows/little-nest-browser.yml` runs the complete Chromium, Firefox
and WebKit Playwright configuration after each push to `main` and, for eligible
pull requests targeting `main`, before merge. It builds the Little Nest app and
API server locally on the runner. A manual `workflow_dispatch` run is reserved
for recovering fixtures from a completed push-to-main browser run.

The final **Chromium, Firefox and WebKit** check is the merge-gate status. It
passes only when the PR authorization succeeds and the browser suite succeeds.
Forked, untrusted, and draft PRs fail this check rather than receiving a skipped
status that could satisfy a required check; drafts run again when marked ready.
The main-branch ruleset must require this exact check name. The browser suite
itself runs only after the credential-free authorization step succeeds.

Pull requests use `pull_request_target` so the workflow definition and its
authorization check come from `main`, not from the proposed changes. The
credential-free check rejects forks and authors who are not repository
owners, members, or collaborators. Drafts wait until marked ready. The browser
job then waits for approval in the separate `browser-regressions-pr`
environment before checking out the exact merge candidate. Checkout does not
persist the GitHub token. Do not approve the environment deployment until a
reviewer has reviewed that exact PR merge candidate: after approval, the
browser build and tests execute code from it using the dedicated test
credentials.

The authorization step exercises forked, untrusted, trusted, draft, and
ready-for-review cases before it can produce an eligible result. The
`Verify the browser pull request authorization boundary` step also runs
`.github/workflows/little-nest-browser.test.mjs` on every browser job. It
executes the workflow's actual inline authorization script against those cases
and checks that the protected PR job is gated, checks out the exact merge SHA,
and does not persist checkout credentials. Its structural checks also fail if
checkout, a protected environment, or secret access moves into the
credential-free authorization job.

Configure `browser-regressions-pr` to allow deployments only from `main`, add
required reviewers who review PR code, and enable prevention of self-review.
Copy the browser-test environment secrets listed below into this environment.
If the environment or its secrets are missing, the run fails rather than
falling back to another credential source. Forked and otherwise ineligible PRs
fail at the credential-free authorization check without opening either
secret-bearing environment.

The main-branch ruleset must require the **Chromium, Firefox and WebKit** check
in the repository's branch protection or ruleset for `main`. The environment
approval is a separate gate that controls access to test credentials; it does
not replace required status checks.

Create the existing GitHub environment named `browser-regressions`, restrict
it to the `main` branch, and add these environment secrets:

- `BROWSER_TEST_CLERK_SECRET_KEY`: a dedicated Clerk test-instance secret key
  beginning with `sk_test_`.
- `BROWSER_TEST_CLERK_PUBLISHABLE_KEY`: that same instance's publishable key,
  beginning with `pk_test_`.

Add the same test-only secrets to `browser-regressions-pr`. Use only a
dedicated Clerk test instance in both environments; never use production
credentials.

The browser job starts a fresh PostgreSQL service inside its GitHub runner for
each run. Its fixed test-only connection is restricted in code to the local
service, the expected database/user, and the GitHub Actions environment. Before
the app schema is applied, setup verifies that the public schema is empty and
pins the service's cluster fingerprint and password-free endpoint in an ignored,
mode-0600 identity file. It then verifies that identity and applies the schema
only to that fresh service. The service and all household rows are discarded
when the run ends. No database URL, fingerprint, or endpoint secrets are
needed; never substitute a Replit or production database.

Each browser fixture creates fresh disposable users in the Clerk test instance
and an isolated synthetic household. The job removes only fixture runs owned by
that runner; it does not run the broad expired-fixture cleanup. CI fixture
identities are scoped to the source workflow run and attempt, Playwright project,
and exact test ID. Their private ownership proofs are HMACs made with the
test-only Clerk secret key. Secret values, proofs, sign-in tickets and cookies
are not printed or committed, and screenshots or other test-result artifacts
are not uploaded.

## Authentication and data isolation

The fixture uses the development `CLERK_SECRET_KEY` at runtime to create a
brand-new, disposable Clerk identity, and signs in with a short-lived ticket.
Both pages share the resulting real Clerk session cookies. No existing
account is selected, no app authentication bypass is added, and no existing
household is edited. The email is generated under `example.com`; no invitations
or verification emails are sent. Never print keys, tickets or cookies.

The household-settings regression also creates a second disposable Clerk
identity, signs it in through its own browser context, and links it to the
fixture's child profile. The parent removes that linked profile through the UI;
fixture teardown detaches it if needed, then uses the guarded cleanup command
to remove both test identities and the household.

Each test creates a separate household named `paste-browser-<UUID>` through
the authenticated API. An existing membership is an explicit setup failure.
The fixture closes its context and uses the guarded cleanup command to remove
its household and Clerk account. Cleanup failures fail the run and retain the
ownership record for retry; account deletion never runs after a refused
household check.

## Interrupted-run cleanup

Before creating an account, the fixture writes a mode-0600 ownership record to
the ignored workspace-root `.browser-auth/runs/` directory. Local runs use a
random proof. CI derives the exact fixture ID from the workflow run/attempt and
Playwright test scope. Its HMAC proof binds that ID to the enrolled database
identity, exact name and creation/expiry times using the test-only Clerk key.
The proof and credentials are never printed or committed. A lost account-create
response is recovered through the exact external ID plus matching Clerk
**private** metadata. A lost household-create response is recovered through
that verified account's exact membership, not a name search.

If a runner disappears before its local ownership records can be cleaned up,
its temporary PostgreSQL service and household rows disappear with the runner.
The Clerk test identities are external to that service, so open the completed
source run in GitHub Actions and note its run ID and attempt number. From
`main`, manually dispatch
`.github/workflows/little-nest-browser.yml` with those two values. Recovery
accepts only a completed push run from `main` in this repository, checks the
original revision's exact Playwright test IDs, and tries only the deterministic
IDs for those tests and their single supported linked-account fixture. With the
dedicated test-only Clerk credentials, it verifies each private HMAC marker,
exact external ID, email, creation window, run attempt, and test scope before
deleting only those synthetic Clerk identities. It does not search account-name
prefixes or depend on the lost runner's filesystem. The HMAC marker retains the
discarded service's fingerprint, bound to the exact fixture. Recovery can clean
completed-run accounts even after the normal 24-hour lease; the explicit source
run and marker still have to match.

Ownership expires after 24 hours. The cleanup command defaults to dry-run:

```sh
pnpm --filter @workspace/little-nest cleanup:browser
pnpm --filter @workspace/little-nest cleanup:browser --dry-run
# Review the report first. This permanently removes only validated expired fixtures.
pnpm --filter @workspace/little-nest cleanup:browser --apply
```

Reports distinguish `would-delete`, `deleted`, `skipped-active-or-unexpired`
and `refused`. Refusals produce a nonzero exit code without authorizing that
run's deletion. A still-running owner PID on the same host is skipped even
after expiry (PID reuse conservatively skips too). On another host, the
24-hour expiry is the lease; do not run fixtures for more than 24 hours.
The internal `--finish RUN_ID` option performs normal teardown of one owned
run without waiting for expiry. It does not bypass identity checks.
To report or clean just one expired run, add `--run RUN_ID`, followed by
`--dry-run` (default) or `--apply`; expiry and living-owner checks still apply.

Cleanup requires matching Clerk private metadata, exact account ID (when
recorded), external ID, sole synthetic email, creation time, household
ID/name/time, and only the known synthetic membership states. The browser
settings test may leave its synthetic child profile removed; recovery may also
find the exact linked test account still attached to that child profile. Any
other member, renamed profile, foreign membership or missing marker is refused.
Unrecorded accounts/households, including older prefix-only fixtures, are
never candidates. Never manually adopt an existing account into the registry.
The ledger is retained through partial database/Clerk failures so cleanup
can be retried. Household deletion is transactional; cascade-owned private
drafts and attachment metadata are removed with the household.

### Trusted development database setup

Obtain the fingerprint using the development database tooling, explicitly
selecting **development**:

```sql
SELECT md5(current_database() || ':' || system_identifier::text) AS fingerprint
FROM pg_control_system();
```

Then enroll that trusted fingerprint once:

```sh
pnpm --filter @workspace/api-server exec tsx test-support/enroll-browser-cleanup.ts <fingerprint>
```

This writes the ignored `.browser-auth/development-database.json`, pinning
both the database/cluster fingerprint and a password-free connection endpoint
hash. Endpoint pinning also rejects production clones retaining the cluster
identifier. Enrollment checks the supplied trusted fingerprint against the
target and never overwrites an existing enrollment. Never obtain authorization
automatically from the cleanup target's `DATABASE_URL`, and never enroll a
production database.
Missing identity, insufficient permission to read `pg_control_system()`,
a different database/cluster, production runtime/deployment indicators, or
non-test Clerk keys fail closed before any deletion. Re-enroll through trusted
development tooling if the development database is replaced; do not bypass
the check. Remove the old enrollment file only after confirming a development
database replacement. The fixture verifies this database before account creation.

Deterministic safety checks and an opt-in real development demonstration:

```sh
pnpm --filter @workspace/api-server exec tsx --test test-support/browser-fixture-ownership.test.ts
pnpm --filter @workspace/api-server exec tsx test-support/demonstrate-browser-cleanup.ts
```

The protected browser workflow also runs a cancellation simulation against its
dedicated Clerk test instance and fresh ephemeral database. It creates a
parent household and linked member, removes their local ownership ledgers,
then runs exact-scope recovery. Same-prefix and foreign-marker controls must
remain unchanged. The test is CI-only; it withholds its output and does not
upload logs, credentials, or ownership proofs.

The demonstration creates only new synthetic fixtures, verifies dry-run
changes nothing, removes an intentionally abandoned fixture, and confirms
active, marker-mismatched and prefix-only controls remain untouched. It then
removes its own controls; it never targets previously existing data.

For local runs, apply the project's existing development schema first
(`pnpm --filter @workspace/db push`); the full app also reads the private-draft
table even when testing browser-local mode. GitHub CI applies that schema only
to its fresh per-run PostgreSQL service. Development certificates are accepted
only inside these disposable test contexts. Public/production origins remain
refused by the configuration.

Traces and video are disabled to keep sign-in tickets out of recordings.
Failure screenshots contain synthetic fixture data only. Reports, screenshots
and any locally saved auth state are ignored by Git.

## Coverage

- Native `storage` events between two pages, stale-edit blocking, stale discard
  rejection, loading the latest revision, and a valid discard while the other
  page is in the background.
- Concurrent save clicks, exactly one record request, and a Web Lock held after
  the server commits but before the response reaches the component.
- Closing the owner while its response is held: the browser releases the lock,
  but the persisted checkpoint remains uncertain. Recovery never automatically
  resends, requires a saved-list check, and forgets that review after reload.
  Repeated item titles stay distinct.
- A saved draft reopened with `navigator.locks` unavailable: visible safe
  failure, unchanged checkpoint, and zero record requests.
- Parent household settings: last-parent controls, role persistence after
  refresh, revoked invitation codes, removal confirmation and cancellation,
  retained assignments, and access loss without deleting the linked sign-in
  account.
- The household-settings flow at 390 × 844: role and invitation controls have
  usable 44px touch targets, invitation status and confirmation remain usable,
  retained-assignment labels fit, and the page has no horizontal overflow.

Response barriers wrap the original browser fetch, holding delivery to the
component after the server response arrives. They do not replace the response,
forward the request, or alter authentication. This preserves the browser's
request path: forwarding through `route.fetch()` can return a misleading 401
in the proxied development environment, even with real Clerk session cookies.

This supplements the deterministic component tests. It covers browser-local
drafts only; it does not test or implement cross-device recovery, server
idempotency, or OS-level process crashes. Closing a page is the repeatable
cross-engine owner-termination case.
