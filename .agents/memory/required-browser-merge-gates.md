---
name: Required browser merge gates
description: How to make protected browser-test workflows fail closed when GitHub treats skipped jobs as successful required checks.
---

Keep the repository-required status context on a small final workflow job that aggregates authorization and test results. Run that job for every pull request with `always()`, do not attach a secret-bearing environment to it, and fail it when authorization is ineligible or the protected browser suite did not succeed.

**Why:** A required workflow job that is skipped can be treated as successful by GitHub. Requiring only the protected browser job can therefore let an ineligible PR satisfy the check by skipping that job.

**How to apply:** Name the final gate exactly as the status context configured in the branch ruleset. Keep secret access and source checkout confined to the separately gated browser job; have the final job inspect both its result and the authorization result.