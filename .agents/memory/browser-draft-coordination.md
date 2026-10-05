---
name: Browser draft coordination
description: Safety rationale for cross-tab paste draft coordination and unsupported browsers
---

Use atomic browser-wide coordination for a paste save's entire request/response lifecycle; do not substitute an expiring local-storage lease or an unchecked read-then-write lock.

**Why:** A background tab can freeze while its server request continues. Another tab taking an expired lease could then retry that same queue before the first result is known. Local storage has no atomic compare-and-swap, so simultaneous lease claims cannot guarantee a single saver either.

**How to apply:** Keep unsupported coordination an explicit, visible failure rather than silently reducing safety. A crashed or closed tab leaves its checkpoint uncertain, so recovery still requires a fresh saved-list review. Browser locks protect same-browser tabs only; they are not server idempotency and must not be treated as cross-device protection.