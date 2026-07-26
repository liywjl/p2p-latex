// Integration test of the app's exact wire protocol over the real DHT:
// hyperswarm + 4-byte framing + auth token + y-protocols sync.
// Run with: npm run test:p2p   (needs internet; takes ~10-60s)
import { createRequire } from 'module'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../package.json'))
const Hyperswarm = require('hyperswarm')
const z32 = require('z32')
const b4a = require('b4a')
const Y = require('yjs')
const syncProtocol = require('y-protocols/dist/sync.cjs')
const encoding = require('lib0/dist/encoding.cjs')
const decoding = require('lib0/dist/decoding.cjs')

const sha256 = (...parts) => {
  const h = crypto.createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest()
}

const key = crypto.randomBytes(32)
const authToken = sha256(key, Buffer.from('p2p-latex-auth-v1'))
const topic = sha256(key, Buffer.from('p2p-latex-topic-v1'))
console.log('invite key:', z32.encode(key))

const frame = (data) => {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(data.byteLength, 0)
  return Buffer.concat([header, Buffer.from(data)])
}

function makePeer(name, seedContent) {
  const doc = new Y.Doc()
  const files = doc.getMap('files')
  if (seedContent) {
    doc.transact(() => files.set('main.tex', new Y.Text(seedContent)), 'seed')
  }
  const swarm = new Hyperswarm()
  const conns = new Map()
  let connCounter = 0

  doc.on('update', (update, origin) => {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0)
    syncProtocol.writeUpdate(enc, update)
    const msg = frame(encoding.toUint8Array(enc))
    for (const [id, c] of conns) if (id !== origin && c.authed) c.socket.write(msg)
  })

  swarm.on('connection', (socket) => {
    const id = `${name}-conn-${connCounter++}`
    const conn = { socket, authed: false, buffer: Buffer.alloc(0), id }
    conns.set(id, conn)
    socket.write(frame(authToken))
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      conn.buffer = Buffer.concat([conn.buffer, chunk])
      while (conn.buffer.length >= 4) {
        const len = conn.buffer.readUInt32LE(0)
        if (conn.buffer.length < 4 + len) break
        const payload = conn.buffer.subarray(4, 4 + len)
        conn.buffer = conn.buffer.subarray(4 + len)
        if (!conn.authed) {
          if (b4a.equals(payload, authToken)) {
            conn.authed = true
            console.log(`[${name}] peer authed`)
            const enc = encoding.createEncoder()
            encoding.writeVarUint(enc, 0)
            syncProtocol.writeSyncStep1(enc, doc)
            socket.write(frame(encoding.toUint8Array(enc)))
          } else {
            console.log(`[${name}] AUTH FAILED — dropping`)
            socket.destroy()
          }
          continue
        }
        const dec = decoding.createDecoder(new Uint8Array(payload))
        const type = decoding.readVarUint(dec)
        if (type === 0) {
          const enc = encoding.createEncoder()
          encoding.writeVarUint(enc, 0)
          syncProtocol.readSyncMessage(dec, enc, doc, id)
          if (encoding.length(enc) > 1) socket.write(frame(encoding.toUint8Array(enc)))
        }
      }
    })
  })
  const discovery = swarm.join(topic, { server: true, client: true })
  // same requery behaviour as the app: keep querying while no peers
  const requery = setInterval(() => {
    if (conns.size === 0) {
      discovery.refresh({ server: true, client: true }).catch(() => {})
      swarm.flush().catch(() => {})
    }
  }, 15000)
  return { name, doc, files, swarm, discovery, requery }
}

// mirror the app: host announces first (share → flushed → key handed out)
const host = makePeer('host', '\\documentclass{article}\\begin{document}Hello\\end{document}')
await host.discovery.flushed()
console.log('[host] announced')
const joiner = makePeer('joiner', null)

const deadline = Date.now() + 120000
const state = { edited: false, done: false }
const tick = setInterval(async () => {
  const hostText = host.files.get('main.tex')?.toString() ?? ''
  const joinText = joiner.files.get('main.tex')?.toString() ?? ''
  if (joinText && joinText === hostText && !state.edited) {
    console.log('PASS 1: joiner received seeded doc')
    state.edited = true
    host.doc.transact(() => host.files.get('main.tex').insert(0, '% host edit\n'))
    joiner.doc.transact(() =>
      joiner.files.get('main.tex').insert(joinText.length, '\n% joiner edit')
    )
  } else if (state.edited && !state.done) {
    const h = host.files.get('main.tex').toString()
    const j = joiner.files.get('main.tex').toString()
    if (h === j && h.includes('% host edit') && h.includes('% joiner edit')) {
      state.done = true
      console.log('PASS 2: concurrent edits converged on both peers')
      clearInterval(tick)
      clearInterval(host.requery)
      clearInterval(joiner.requery)
      await host.swarm.destroy()
      await joiner.swarm.destroy()
      process.exit(0)
    }
  }
  if (Date.now() > deadline) {
    console.log('FAIL: timeout')
    process.exit(1)
  }
}, 300)
