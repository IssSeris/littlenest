---
name: Interrupted browser fixture recovery
description: Safety constraints for recovering exact synthetic browser-test identities after CI runner state is lost.
---

For local manual cleanup, keep the explicit development-database fingerprint and endpoint pin, and require test-only Clerk credentials. Hosted GitHub browser runs use a new loopback-only PostgreSQL service per run; verify the exact service endpoint and empty schema before applying the app schema. Bind each CI marker HMAC to the source run, attempt, browser project, exact test ID, ephemeral database fingerprint, synthetic identity, and creation window. If the runner disappears, its database and household rows are already gone; manual recovery may remove only the exact Clerk test identity after validating the completed main-branch run and private HMAC. Never connect a replacement database or scan account-name prefixes.

**Why:** Replit development PostgreSQL is not reachable from GitHub-hosted runners. An ephemeral service avoids persistent external database credentials and data, while the Clerk test account can outlive its runner and still needs narrowly scoped recovery.

**How to apply:** local cleanup remains bound to an explicitly enrolled development database. CI cleanup targets only its verified per-run service; after that service is discarded, recovery relies on the exact source run/test scope and HMAC-marked synthetic Clerk identity, never a replacement database. A run ID or synthetic name alone is never authorization.