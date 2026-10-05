---
name: Browser test environment
description: Non-obvious Replit/Nix browser-loader and capability-simulation constraints
---

Downloaded Playwright engines are not Nix-wrapped. Installing system packages alone does not give these ELF binaries the library search paths they need. Exact ABI compatibility matters; never alias a newer ICU, JPEG, or JPEG XL library to an older soname.

**Why:** Chromium and Firefox initially could not launch despite available packages, and WebKit needed older ABI outputs in addition to current packages. A successful package installation did not establish browser launchability.

**How to apply:** Resolve configured Nix library outputs for browser subprocesses, verify actual engine launch, and report an unavailable compatible output explicitly. Do not interpret a missing-engine setup failure as a passed or skipped behavioral test.

Use old-style Nix evaluation for library-path discovery in this environment.

**Why:** `nix eval` produced the complete library-path string but remained running until timeout. `nix-instantiate` returned the same kind of result and exited promptly.

**How to apply:** If a modern evaluator hangs after producing output, change the evaluator rather than extending timeouts or accepting partial output.

Avoid Node's synchronous glob walker when looking up compatible outputs in the shared Nix store.

**Why:** A glob over a narrowly named library directory stalled for minutes in the very large store. Reading the store's flat entry names and filtering them returned the same compatible output promptly.

**How to apply:** Enumerate only the store's top-level names, then inspect the small set of matching outputs. Do not recursively search the store.

WebKit's downloaded MiniBrowser wrapper replaces `LD_LIBRARY_PATH` rather than extending it.

**Why:** The exact missing `libatomic` was already in the resolved host paths; the wrapper removed those paths before starting the actual engine. More package installations would not fix that.

**How to apply:** Inspect the engine's launch wrapper when a library exists in the parent environment but the browser cannot load it. Preserve its required bundle variables and the host paths when launching the unchanged binary.

Nix's headless EGL setup needs explicit Mesa vendor/driver locations.

**Why:** After all linked libraries resolved, WebKit still exited on page creation because GLVND could not discover a supported EGL platform in its usual filesystem locations.

**How to apply:** Resolve Mesa's real vendor and driver files for a software surfaceless renderer before attributing a page-creation closure to application code.

GLib networking modules must also be discoverable by WebKit's network process.

**Why:** A successfully launched browser could create a page but rejected HTTPS navigation with “TLS support is not available”; this was a missing GLib TLS plugin search path, not a website certificate problem.

**How to apply:** Resolve the installed networking modules for `GIO_EXTRA_MODULES`. Do not disable TLS or treat certificate-ignore settings as a solution to absent TLS support.

Simulate an absent browser capability by removing its property, not by shadowing it with `undefined`.

**Why:** Third-party startup code used property-presence detection and then attempted to use an undefined value. That artificial inconsistency produced an unrelated development error overlay instead of testing the app's unsupported-browser guard.

**How to apply:** Make both value checks and property-presence checks agree with a genuinely unsupported browser. Keep the simulation confined to disposable test pages.