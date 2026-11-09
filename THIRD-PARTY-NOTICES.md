# Third-party code

`src/wukong.js` adapts the WuKong wire client from [Mininglamp-OSS/octo-channel-gateway](https://github.com/Mininglamp-OSS/octo-channel-gateway/blob/ec4ac3ed01a3385cf8077c6b3d02c8c7b9b17ad1/packages/gateway/src/transport/wukong.ts), under the [Apache License, Version 2.0](LICENSE-OCTO-APACHE-2.0). Changes include the JavaScript port, separate HTTP registration, and removal of the original app-specific message-position and rules hooks. The client calls this plugin's synchronous queue handler before acknowledging receipt.
