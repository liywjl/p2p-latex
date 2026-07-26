import { ipcMain, BrowserWindow } from 'electron'
import * as nodeCrypto from 'crypto'
import Hyperswarm from 'hyperswarm'
import z32 from 'z32'
import b4a from 'b4a'

/**
 * Topology: everyone with the invite key joins the same DHT topic and forms
 * a mesh. The topic is a hash of the key, so announcing on the DHT never
 * reveals the key itself. Connections are end-to-end encrypted by Hyperswarm
 * (Noise); on top of that, the first frame each side sends must prove
 * knowledge of the invite key, otherwise the connection is dropped —
 * the DHT topic alone is not enough to get in.
 *
 * The main process treats peer traffic as opaque frames and relays them to
 * the renderer, where the Yjs CRDT layer lives.
 */

interface Peer {
  id: string
  socket: any
  authed: boolean
  buffer: Buffer
}

let swarm: any = null
let peers = new Map<string, Peer>()
let authToken: Buffer | null = null
let mode: 'none' | 'hosting' | 'joined' = 'none'
let inviteKeyStr = ''
let requeryTimer: ReturnType<typeof setInterval> | null = null

function sha256(...parts: Buffer[]): Buffer {
  const h = nodeCrypto.createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest()
}

function frame(data: Uint8Array): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(data.byteLength, 0)
  return Buffer.concat([header, Buffer.from(data)])
}

function sendStatus(): void {
  const status =
    mode === 'none'
      ? { mode: 'none' as const }
      : { mode, inviteKey: inviteKeyStr, peers: [...peers.keys()] }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('p2p:status', status)
  }
}

function emit(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

function handleConnection(socket: any): void {
  const id = b4a.toString(socket.remotePublicKey, 'hex').slice(0, 16)
  const peer: Peer = { id, socket, authed: false, buffer: Buffer.alloc(0) }
  peers.set(id, peer)

  // prove we know the invite key
  socket.write(frame(authToken!))

  socket.on('data', (chunk: Buffer) => {
    peer.buffer = Buffer.concat([peer.buffer, chunk])
    while (peer.buffer.length >= 4) {
      const len = peer.buffer.readUInt32LE(0)
      if (len > 64 * 1024 * 1024) {
        socket.destroy()
        return
      }
      if (peer.buffer.length < 4 + len) break
      const payload = peer.buffer.subarray(4, 4 + len)
      peer.buffer = peer.buffer.subarray(4 + len)
      if (!peer.authed) {
        if (authToken && b4a.equals(payload, authToken)) {
          peer.authed = true
          emit('p2p:peer-joined', id)
          sendStatus()
        } else {
          socket.destroy()
          return
        }
      } else {
        emit('p2p:data', id, new Uint8Array(payload))
      }
    }
  })

  const drop = (): void => {
    if (peers.delete(id)) {
      if (peer.authed) emit('p2p:peer-left', id)
      sendStatus()
    }
  }
  socket.on('close', drop)
  socket.on('error', drop)
}

async function startSwarm(keyBuf: Buffer, asHost: boolean): Promise<void> {
  await destroySwarm()
  authToken = sha256(keyBuf, Buffer.from('p2p-latex-auth-v1'))
  const topic = sha256(keyBuf, Buffer.from('p2p-latex-topic-v1'))
  swarm = new Hyperswarm()
  swarm.on('connection', handleConnection)
  const discovery = swarm.join(topic, { server: true, client: true })
  mode = asHost ? 'hosting' : 'joined'
  inviteKeyStr = z32.encode(keyBuf)
  sendStatus()
  await discovery.flushed()
  // While we have no peers, re-query the DHT periodically. Two sides that
  // (re)join at the same time can otherwise miss each other's announces and
  // sit idle until hyperswarm's own slow refresh.
  const s = swarm
  requeryTimer = setInterval(() => {
    if (!swarm || swarm !== s) return
    if (peers.size === 0) {
      discovery.refresh({ server: true, client: true }).catch(() => {})
      s.flush().catch(() => {})
    }
  }, 15_000)
}

export async function destroySwarm(): Promise<void> {
  if (requeryTimer) {
    clearInterval(requeryTimer)
    requeryTimer = null
  }
  if (swarm) {
    const s = swarm
    swarm = null
    peers.clear()
    mode = 'none'
    inviteKeyStr = ''
    try {
      await s.destroy()
    } catch {
      /* already gone */
    }
  }
}

export function registerP2pIpc(): void {
  ipcMain.handle('p2p:host', async (_e, existingKey?: string) => {
    let keyBuf: Buffer
    if (existingKey) {
      try {
        keyBuf = Buffer.from(z32.decode(existingKey.trim()))
        if (keyBuf.length !== 32) throw new Error('bad length')
      } catch {
        throw new Error('Invalid saved session key')
      }
    } else {
      keyBuf = nodeCrypto.randomBytes(32)
    }
    await startSwarm(keyBuf, true)
    return z32.encode(keyBuf)
  })

  ipcMain.handle('p2p:join', async (_e, inviteKey: string) => {
    let keyBuf: Buffer
    try {
      keyBuf = Buffer.from(z32.decode(inviteKey.trim()))
      if (keyBuf.length !== 32) throw new Error('bad length')
    } catch {
      throw new Error('Invalid invite key')
    }
    await startSwarm(keyBuf, false)
  })

  ipcMain.handle('p2p:leave', async () => {
    await destroySwarm()
    sendStatus()
  })

  ipcMain.handle('p2p:send', (_e, peerId: string, data: Uint8Array) => {
    const peer = peers.get(peerId)
    if (peer?.authed) peer.socket.write(frame(data))
  })

  ipcMain.handle('p2p:broadcast', (_e, data: Uint8Array, exceptPeerId?: string) => {
    const framed = frame(data)
    for (const peer of peers.values()) {
      if (peer.authed && peer.id !== exceptPeerId) peer.socket.write(framed)
    }
  })
}
