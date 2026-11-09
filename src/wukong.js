// Adapted from Mininglamp-OSS/octo-channel-gateway (Apache-2.0),
// ec4ac3ed01a3385cf8077c6b3d02c8c7b9b17ad1, packages/gateway/src/transport/wukong.ts.
// Changed: JavaScript port, registration handled separately, removed position and rules hooks.
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomUUID } from "node:crypto";
import WebSocket from "ws";
const LIMIT = 1 << 20;
const md5 = (value) => createHash("md5").update(value).digest("hex");
class ImConnectionError extends Error {
  constructor(code, retryable) {
    super(code);
    this.retryable = retryable;
  }
}
function wukongConnectionFailure(phase, reason) {
  const terminal = [2, 4, 8, 9, 11, 13, 19, 20, 21, 23, 27].includes(reason);
  return new ImConnectionError("IM_" + phase + "_" + reason, !terminal);
}
class Writer {
  chunks = [];
  byte(n) {
    this.chunks.push(Buffer.from([n]));
    return this;
  }
  u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    this.chunks.push(b);
    return this;
  }
  u64(n) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(n);
    this.chunks.push(b);
    return this;
  }
  string(s) {
    const b = Buffer.from(s);
    if (b.length > 65535) throw new Error("IM_FIELD_TOO_LARGE");
    const h = Buffer.alloc(2);
    h.writeUInt16BE(b.length);
    this.chunks.push(h, b);
    return this;
  }
  finish() {
    return Buffer.concat(this.chunks);
  }
}
class Reader {
  constructor(data) {
    this.data = data;
  }
  offset = 0;
  take(n) {
    if (this.offset + n > this.data.length)
      throw new Error("IM_FRAME_TRUNCATED");
    const value = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }
  byte() {
    return this.take(1)[0];
  }
  u32() {
    return this.take(4).readUInt32BE();
  }
  u64() {
    return this.take(8).readBigUInt64BE();
  }
  string() {
    return this.take(this.take(2).readUInt16BE()).toString();
  }
  rest() {
    return this.take(this.data.length - this.offset);
  }
}
function frame(kind, body, flags = 0) {
  const length = [];
  let n = body.length;
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    length.push(b);
  } while (n);
  return Buffer.concat([Buffer.from([kind << 4 | flags, ...length]), body]);
}
class WukongConnection {
  constructor(onMessage, onDisconnect = () => {
  }) {
    this.onMessage = onMessage;
    this.onDisconnect = onDisconnect;
  }
  #socket;
  #closing;
  #key;
  #iv;
  #version = 0;
  #buffer = Buffer.alloc(0);
  #heartbeat;
  #awaitingPong = false;
  #closed = false;
  #ready = false;
  get connected() {
    return this.#ready && this.#socket?.readyState === WebSocket.OPEN;
  }
  async connect(registration) {
    if (this.#socket) throw new Error("IM_ALREADY_CONNECTED");
    const keys = generateKeyPairSync("x25519");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const socket = new WebSocket(registration.ws_url, {
      maxPayload: LIMIT,
      handshakeTimeout: 15e3,
      followRedirects: false
    });
    this.#socket = socket;
    let failure;
    await new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        failure = new ImConnectionError("IM_CONNECT_TIMEOUT", true);
        socket.terminate();
        reject(failure);
      }, 15e3);
      socket.on(
        "open",
        () => socket.send(
          frame(
            1,
            new Writer().byte(4).byte(0).string(`${randomUUID()}W`).string(registration.robot_id).string(registration.im_token).u64(BigInt(Date.now())).string(publicKey).finish()
          )
        )
      );
      socket.on("error", () => {
        failure ??= new ImConnectionError("IM_WS_ERROR", true);
        if (!ready) {
          clearTimeout(timeout);
          reject(failure);
        }
      });
      socket.on("close", () => {
        this.#ready = false;
        clearTimeout(timeout);
        if (this.#heartbeat) clearInterval(this.#heartbeat);
        const error = failure ?? new ImConnectionError("IM_DISCONNECTED", true);
        if (!ready) reject(error);
        else if (!this.#closed) this.onDisconnect(error);
      });
      socket.on("message", (data, binary) => {
        try {
          if (!binary) throw new Error("IM_BINARY_REQUIRED");
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
          this.#buffer = Buffer.concat([this.#buffer, bytes]);
          if (this.#buffer.length > LIMIT)
            throw new Error("IM_FRAME_TOO_LARGE");
          while (this.#buffer.length) {
            const header = this.#buffer[0], kind = header >> 4;
            if (kind === 7 || kind === 8) {
              this.#buffer = this.#buffer.subarray(1);
              if (kind === 7) socket.send(Buffer.from([8 << 4]));
              else this.#awaitingPong = false;
              continue;
            }
            let length = 0, multiplier = 1, offset = 1, complete = false;
            for (; offset < this.#buffer.length && offset <= 4; offset++) {
              const n = this.#buffer[offset];
              length += (n & 127) * multiplier;
              multiplier *= 128;
              if (!(n & 128)) {
                offset++;
                complete = true;
                break;
              }
            }
            if (!complete) {
              if (offset > 4) throw new Error("IM_LENGTH_INVALID");
              break;
            }
            if (length > LIMIT) throw new Error("IM_FRAME_TOO_LARGE");
            if (this.#buffer.length < offset + length) break;
            const reader = new Reader(
              this.#buffer.subarray(offset, offset + length)
            );
            this.#buffer = this.#buffer.subarray(offset + length);
            if (kind === 2 && !ready) {
              if (header & 1) this.#version = reader.byte();
              reader.u64();
              const reason = reader.byte();
              if (reason !== 1)
                throw wukongConnectionFailure("CONNECT_REJECTED", reason);
              const remoteKey = reader.string();
              const salt = reader.string();
              if (this.#version >= 4) reader.u64();
              const raw = Buffer.from(remoteKey, "base64");
              if (raw.length !== 32 || Buffer.byteLength(salt) < 16)
                throw new Error("IM_KEY_INVALID");
              const serverKey = createPublicKey({
                format: "der",
                type: "spki",
                key: Buffer.concat([
                  Buffer.from("302a300506032b656e032100", "hex"),
                  raw
                ])
              });
              this.#key = Buffer.from(
                md5(
                  diffieHellman({
                    privateKey: keys.privateKey,
                    publicKey: serverKey
                  }).toString("base64")
                ).slice(0, 16)
              );
              this.#iv = Buffer.from(salt).subarray(0, 16);
              ready = true;
              this.#ready = true;
              clearTimeout(timeout);
              this.#heartbeat = setInterval(() => {
                if (this.#awaitingPong) {
                  this.#ready = false;
                  clearInterval(this.#heartbeat);
                  failure = new ImConnectionError("IM_HEARTBEAT_TIMEOUT", true);
                  socket.terminate();
                } else if (socket.readyState === WebSocket.OPEN) {
                  this.#awaitingPong = true;
                  socket.send(Buffer.from([7 << 4]));
                }
              }, 1e4);
              this.#heartbeat.unref();
              resolve();
            } else if (kind === 9) {
              throw wukongConnectionFailure(
                "SERVER_DISCONNECTED",
                reader.byte()
              );
            } else if (!ready) throw new Error("IM_HANDSHAKE_REQUIRED");
            else if (kind === 5) this.#receive(reader, registration.robot_id);
          }
        } catch (error) {
          this.#ready = false;
          failure = error instanceof Error ? error : new Error("IM_PROTOCOL_ERROR");
          clearTimeout(timeout);
          if (!ready) reject(failure);
          socket.terminate();
        }
      });
    });
    if (!this.connected)
      throw failure ?? new ImConnectionError("IM_DISCONNECTED", true);
  }
  #encrypt(value) {
    if (!this.#key || !this.#iv) throw new Error("IM_NOT_READY");
    const cipher = createCipheriv("aes-128-cbc", this.#key, this.#iv);
    return Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final()
    ]).toString("base64");
  }
  #receive(reader, ownUid) {
    const setting = reader.byte(), msgKey = reader.string(), fromUid = reader.string(), channelId = reader.string(), channelType = reader.byte();
    if (this.#version >= 3) reader.u32();
    const clientNo = reader.string(), messageId = reader.u64(), messageSeq = reader.u32(), timestamp = reader.u32();
    if (setting & 8) reader.string();
    const encrypted = reader.rest().toString();
    if (md5(
      this.#encrypt(
        `${messageId}${messageSeq}${clientNo}${timestamp}${fromUid}${channelId}${channelType}${encrypted}`
      )
    ) !== msgKey)
      throw new Error("IM_MESSAGE_KEY_INVALID");
    const decipher = createDecipheriv("aes-128-cbc", this.#key, this.#iv);
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64")),
      decipher.final()
    ]);
    const payload = JSON.parse(plain.toString());
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("IM_PAYLOAD_INVALID");
    const message = {
      messageId: messageId.toString(),
      messageSeq,
      fromUid,
      channelId: channelType === 1 ? fromUid : channelId,
      channelType,
      timestamp,
      payload
    };
    if (fromUid !== ownUid)
      this.onMessage(message);
    this.#socket?.send(
      frame(6, new Writer().u64(messageId).u32(messageSeq).finish())
    );
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#ready = false;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    const socket = this.#socket;
    this.#closing = !socket || socket.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise((resolve) => {
      socket.once("close", resolve);
      socket.terminate();
    });
    return this.#closing;
  }
}
export {
  WukongConnection
};
