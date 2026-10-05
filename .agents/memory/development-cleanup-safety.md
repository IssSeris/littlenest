---
name: Development cleanup safety
description: Environment identity pitfalls when authorizing destructive development-only test cleanup
---

Do not treat `REPLIT_ENVIRONMENT` as a reliable workspace-versus-deployment indicator.

**Why:** It reported `production` in this development workspace even though development Clerk credentials and the trusted development database were active. Official documentation identifies `REPLIT_DEPLOYMENT` as the published-app indicator.

**How to apply:** Refuse `NODE_ENV=production` and published-app indicators, but independently verify the database against an explicitly enrolled development identity before destructive test operations. Bind both cluster/database identity and the connection endpoint: physical clones can retain a PostgreSQL cluster identifier. Obtain enrollment authorization through trusted development database tooling, never by automatically trusting the cleanup target.