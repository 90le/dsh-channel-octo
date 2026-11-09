Title: Preserve live messages when an older history snapshot completes

When a file is already visible and history synchronization is in flight, a newly received text message can appear and then disappear as the older history response replaces the message list. This change reconciles arrivals from the active request window while keeping explicit historical windows bounded.

The patch guards overlapping requests and delayed render/page callbacks, preserves deletion and revocation state, and avoids merging distinct server messages that share a client message number. It does not change Markdown rendering, bot folding or the transport protocol.

Validated against `7ace0e96df36a2c03657178564c182fc23af6e25`: all 6 reproduced loss cases are fixed, 26 original controls are unchanged, and 32 additional actual-source scenarios pass. The patch includes 26 passing unit tests; its helper passes strict TypeScript checking. It applies cleanly to the pinned revision.

Full monorepo CI, complete VM type checking and production browser acceptance have not been run. The actual-source harness replaces service and some UI dependencies. The reproduction uses synthetic messages only and does not establish the exact cause of any specific production incident.
