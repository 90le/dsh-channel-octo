import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'

const md5 = x => createHash('md5').update(x).digest('hex')
const byte = n => Buffer.from([n])
const num = (n, len) => {
  const b = Buffer.alloc(len)
  if (len === 8) b.writeBigUInt64BE(BigInt(n))
  else b.writeUIntBE(n, 0, len)
  return b
}
const str = s => Buffer.concat([num(Buffer.byteLength(s), 2), Buffer.from(s)])
const packet = (type, parts, flags = 0) => {
  const body = Buffer.concat(parts)
  const length = []
  for (let n = body.length; ; n >>>= 7) {
    length.push(n > 127 ? (n & 127) | 128 : n)
    if (n <= 127) break
  }
  return Buffer.concat([Buffer.from([(type << 4) | flags, ...length]), body])
}
function connectData(frame) {
  let i = 1
  while (frame[i++] & 128) {}
  i += 2
  const read = () => {
    const len = frame.readUInt16BE(i)
    i += 2
    const out = frame.subarray(i, i + len).toString()
    i += len
    return out
  }
  read()
  const bot = read(), token = read()
  i += 8
  const key = read()
  return { bot, token, key }
}

export async function wirePeer({ bot = 'fixture-bot', token = 'fixture-im-secret' } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const peer = { wsUrl: 'ws://127.0.0.1:' + server.address().port, connections: 0, pings: 0, acked: [], send: null }
  server.on('connection', socket => {
    peer.connections++
    let encrypt
    socket.on('message', frame => {
      const type = frame[0] >> 4
      if (type === 1) {
        const from = connectData(frame)
        if (from.bot !== bot || from.token !== token) return socket.close()
        const pair = generateKeyPairSync('x25519')
        const pub = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
        const theirPub = createPublicKey({
          format: 'der', type: 'spki',
          key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(from.key, 'base64')]),
        })
        const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: theirPub }).toString('base64')
        const salt = '1234567890abcdef'
        encrypt = content => {
          const cipher = createCipheriv('aes-128-cbc', Buffer.from(md5(shared).slice(0, 16)), Buffer.from(salt))
          return Buffer.concat([cipher.update(content), cipher.final()]).toString('base64')
        }
        peer.send = ({ messageId, channelId, channelType, sender, payload, seq = 1 }) => {
          const timestamp = Math.floor(Date.now() / 1000), client = 'fixture-client'
          const body = encrypt(JSON.stringify(payload))
          const key = md5(encrypt('' + messageId + seq + client + timestamp + sender + channelId + channelType + body))
          socket.send(packet(5, [
            byte(0), str(key), str(sender), str(channelId), byte(channelType), num(0, 4),
            str(client), num(messageId, 8), num(seq, 4), num(timestamp, 4), Buffer.from(body),
          ]))
        }
        socket.send(packet(2, [byte(4), num(0, 8), byte(1), str(pub.toString('base64')), str(salt), num(0, 8)], 1))
      } else if (type === 6) {
        peer.acked.push(frame.subarray(-12).readBigUInt64BE(0).toString())
      } else if (type === 7) {
        peer.pings++
        socket.send(byte(8 << 4))
      }
    })
    socket.on('close', () => { peer.send = null })
  })
  peer.disconnect = () => { for (const socket of server.clients) socket.terminate() }
  peer.close = async () => {
    peer.disconnect()
    await new Promise(resolve => server.close(resolve))
  }
  return peer
}
