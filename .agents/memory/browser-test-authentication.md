---
name: Browser test authentication
description: Why a forwarded browser-test request can produce a misleading Clerk 401
---

When testing with programmatic Clerk login claims, delay the original browser request and resume the existing route chain rather than forwarding it with a separate fetch.

**Why:** In a cross-tab save test, forwarding an intercepted authenticated request with `route.fetch()` returned 401 even though household creation and ordinary signed-in requests worked. Releasing the original request with `route.fallback()` succeeded; the fetch bypassed the test authentication route injection.

**How to apply:** For controlled network delays, hold before dispatch and release through `route.fallback()` so other test routes can still apply. Before attributing an intercepted-request 401 to application authentication, compare it with the original browser request. Do not weaken app authentication to accommodate test interception.

Forwarding can also return a misleading 401 in the proxied development app with real Clerk session cookies, not just with injected claims.

**Why:** Holding a response after commit tests an ambiguity that a pre-dispatch delay cannot reproduce, but forwarding changes the browser request path. Genuine cookie login alone did not make forwarding equivalent in this environment.

**How to apply:** For post-commit uncertainty, wrap the original browser fetch and hold delivery of its real response to the component. Preserve the native browser request rather than relying on a separately forwarded request to be authenticated identically.