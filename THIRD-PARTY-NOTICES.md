# Third-party code

`src/wukong.js` adapts the WuKong wire client from [Mininglamp-OSS/octo-channel-gateway](https://github.com/Mininglamp-OSS/octo-channel-gateway/blob/ec4ac3ed01a3385cf8077c6b3d02c8c7b9b17ad1/packages/gateway/src/transport/wukong.ts), under the [Apache License, Version 2.0](LICENSE-OCTO-APACHE-2.0). Changes include the JavaScript port, separate HTTP registration, and removal of the original app-specific message-position and rules hooks. The client calls this plugin's synchronous queue handler before acknowledging receipt.

`src/outbound-text.js` adapts final-prose mention extraction and UTF-16 entity offsets from the same Gateway revision's `transport/mentions.ts`, under Apache-2.0. It uses this plugin's current-channel member data and excludes links from notification parsing. Markdown block segmentation is local code. `mdast-util-from-markdown` is used under its MIT license.

`src/display-card.js` adapts controlled display blocks, capability negotiation and card limits from [Mininglamp-OSS/openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo/tree/3cdb7e794ba40ae617fb0215177d1493dd26460a), files `src/card-display-tool.ts`, `card-blocks.ts`, `card-caps.ts`, `card-limits.ts` and `card-render.ts`, under the included Apache-2.0 license. Changes include a bounded JavaScript implementation, strict schemas, HTTPS navigation links, current-conversation transport and receipt handling, with no callback actions or raw reasoning. The pinned upstream has no separate NOTICE file.

`src/card-inputs.js` and the expanded question/form bridge follow the same upstream revision's `card-author.ts`, `card-caps.ts` and `card-action.ts` input contracts. They use local bounded validation, request-scoped waiting and persistent callback receipts instead of upstream session dispatch.

`compat/octo-web/history-sync.patch` contains modifications and context from Apache-2.0 [Mininglamp-OSS/octo-web](https://github.com/Mininglamp-OSS/octo-web/tree/7ace0e96df36a2c03657178564c182fc23af6e25). It adds request-scoped history reconciliation and tests. This review artifact is not part of the installed plugin and has not been merged or deployed upstream.

`src/progress.js` and `test/fixtures/octo-approved-progress-icons.json` use the exact approved chevron icon bytes from [Mininglamp-OSS/octo-server](https://github.com/Mininglamp-OSS/octo-server/blob/f984d40549f66d56b1e90a048d28315eb12c92df/pkg/cardmsg/inline_image.go), under Apache-2.0. The two approved images are stacked for the bulk disclosure control; no custom inline SVG is sent.
