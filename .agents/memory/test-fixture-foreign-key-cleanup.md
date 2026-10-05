---
name: Test fixture foreign-key cleanup
description: Safe teardown order for household API tests as profile-bound relationships are added
---

When a test cleanup deletes household profiles, delete dependent rows first, including profile-bound invitations.

**Why:** A restrictive foreign key can make teardown fail after the test logic has run; the unclosed Express server and database pool can then make the runner appear to hang instead of showing a useful failure.

**How to apply:** Whenever schema adds a foreign key pointing to household membership, audit each test fixture that deletes members and add dependent tables in reverse dependency order.