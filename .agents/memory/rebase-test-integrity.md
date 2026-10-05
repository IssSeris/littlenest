---
name: Rebase test integrity
description: Check structurally repetitive tests after automatic conflict resolution.
---

Do not treat a conflict-free rebase as proof that test changes were merged correctly. Context-based merges can move declarations and assertions into unrelated test blocks while leaving the working tree clean.

**Why:** A rebase merged two versions of the household API tests without reporting conflicts, but several new test fragments landed in the wrong scopes and broke runtime parsing and behavior.

**How to apply:** For test files changed on both sides, compare the resulting blocks with each parent and run the affected test suite and typecheck before accepting the rebase.