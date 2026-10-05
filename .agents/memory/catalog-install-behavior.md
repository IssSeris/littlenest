---
name: Catalog installation behavior
description: pnpm catalog shorthand can rewrite shared ranges and remove policy comments
---

When adding a dependency with pnpm's catalog shorthand, review the shared workspace manifest afterward and preserve its existing version ranges, policy comments, and intentional React pins.

**Why:** In this workspace, `pnpm add package@catalog:` normalized the catalog's range to the installed exact version and rewrote the YAML, removing security-policy and Expo compatibility comments. This was not an intentional catalog upgrade.

**How to apply:** For future dependency additions, prefer a targeted package.json edit using `catalog:` followed by the workspace install workflow; inspect the manifest and lockfile diff for unintended central changes.