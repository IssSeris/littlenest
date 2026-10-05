---
name: GitHub workflow write permissions
description: GitHub permission needed to publish Actions workflow files through an authorized connection.
---

A GitHub connection can have repository push access and still be unable to write files under `.github/workflows`; those writes require the separate Workflows permission.

**Why:** The authorized repository connection could write ordinary files but received 404 responses for workflow paths.

**How to apply:** Before publishing Actions workflow changes, confirm the credential grants repository Contents write and Workflows write access. Do not weaken branch protections to compensate for a missing credential permission.