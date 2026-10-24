/**
 * WebSocket entry point.
 *
 * The tick loop is driven by a drift-corrected timer rather than setInterval: it tracks
 * how many fixed ticks *should* have elapsed against a monotonic clock and runs that
 * many, so the simulation keeps real time even when the event loop is briefly late. A
 * burst is capped so a long stall cannot turn into a hundred-tick catch-up spike.
 */

import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { NET, TICK_MS } from '../../shared/constants'
import { parseClientMessage, type ServerMessage } from '../../shared/protocol'
import { engineName, initPhysics } from './physics'
import type { Connection } from './room'
import { Rooms } from './rooms'
import { Stats } from './stats'
import { statsPage } from './stats-page'

const PORT = Number(process.env.PORT ?? NET.defaultPort)
/** Never run more than this many ticks in one catch-up pass. */
const MAX_CATCHUP_TICKS = 8

async function main(): Promise<void> {
  await initPhysics()

  const stats = new Stats()
  const rooms = new Rooms((record) => stats.recordRace(record))
  const started = performance.now()
  const now = () => performance.now() - started

  // A plain HTTP server underneath the WebSocket one. Two reasons: a reverse proxy wants
  // something that answers a GET before it will route traffic, and `curl .../health` is
  // the quickest way to tell a live server from a crashed container behind that proxy.
  const httpServer = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          engine: engineName(),
          players: rooms.playerCount,
          rooms: rooms.roomCount,
          tick: rooms.sharedTick,
          uptimeMs: Math.round(now())
        })
      )
      return
    }
    // The admin page. No authentication here on purpose: it belongs in front of this
    // server, where CapRover can put a password on the route without the game knowing.
    const [path, search] = (req.url ?? '').split('?')
    if (req.method === 'GET' && path === '/stats') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(statsPage(stats, engineName(), rooms.roomCount, rooms.playerCount, new URLSearchParams(search ?? '')))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  const wss = new WebSocketServer({ server: httpServer })
  httpServer.listen(PORT, () => {
    console.log(`[server] ${engineName()} physics on port ${PORT} — websocket + GET /health`)
  })

  wss.on('connection', (socket: WebSocket) => {
    let playerId: number | null = null
    let inputPackets = 0
    let alive = true
    let lastSeen = now()

    const connection: Connection = {
      send(message: ServerMessage) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
      },
      close(reason: string) {
        connection.send({ t: 'error', message: reason })
        socket.close()
      }
    }

    socket.on('message', (data) => {
      lastSeen = now()
      const message = parseClientMessage(data.toString())
      if (!message) return

      if (message.t === 'join') {
        if (playerId !== null) return
        if (message.v !== NET.protocolVersion) {
          connection.close(`protocol version mismatch: server ${NET.protocolVersion}, client ${message.v}`)
          return
        }
        const name = String(message.name ?? 'driver').slice(0, 20) || 'driver'
        // Only an address that looks like one is kept: this is reported by the client,
        // so it is treated as a claim about identity, not as proof of it.
        const claimed = typeof message.address === 'string' ? message.address.trim() : ''
        const address = /^0x[0-9a-fA-F]{40}$/.test(claimed) ? claimed : undefined
        const seat = rooms.join(name, connection, now(), address)
        if (!seat) {
          connection.close('room is full')
          return
        }
        playerId = seat.playerId
        stats.sawVisitor(name, address)
        console.log(`[server] ${name} joined as #${seat.playerId} (${rooms.playerCount} across ${rooms.roomCount} room(s))`)
        return
      }

      if (playerId === null) return
      const seat = rooms.seatOf(connection)
      if (!seat) return
      const room = seat.room
      playerId = seat.playerId
      switch (message.t) {
        case 'in':
          if (process.env.LOG_INPUT === '1' && inputPackets++ % 30 === 0) {
            const first = Array.isArray(message.i) && message.i.length > 0 ? message.i[0] : null
            console.log(
              `[in] #${playerId} packets=${inputPackets} samples=${Array.isArray(message.i) ? message.i.length : 'NOT-ARRAY'} ` +
                `firstTick=${first ? first[0] : '-'} serverTick=${room.currentTick} ` +
                `delta=${first ? first[0] - room.currentTick : '-'}`
            )
          }
          if (Array.isArray(message.i)) room.onInputs(playerId, message.i)
          break
        case 'ready':
          room.onReady(playerId, Boolean(message.ready))
          break
        case 'respawn':
          room.onRespawnRequest(playerId)
          break
        case 'start':
          room.onStartRequest(now())
          break
        case 'leave-race':
          room.onLeaveRace(playerId, now())
          break
        case 'spectate':
          room.onSpectate(playerId, Boolean(message.on), now())
          break
        case 'mode': {
          // A move between rooms, not a setting: solo is a room of your own.
          const moved = rooms.setMode(connection, message.mode, now())
          if (moved) playerId = moved.playerId
          break
        }
        case 'bots':
          room.onBotCount(Number(message.count))
          break
        case 'laps':
          room.onLaps(Number(message.laps))
          break
        case 'vote':
          room.onVote(playerId, message.track)
          break
        case 'ping':
          // Clock sync: echo the client's timestamp back with the server clock.
          connection.send({ t: 'pong', id: message.id, clientTime: message.clientTime, serverNow: now() })
          break
      }
    })

    // Liveness only: clients send inputs at 30 Hz, so silence means the socket is gone.
    // Clock sync is client-driven via ping/pong, not from here.
    const heartbeat = setInterval(() => {
      if (!alive) return
      if (now() - lastSeen > NET.clientTimeoutMs) socket.terminate()
    }, NET.heartbeatMs)

    const drop = () => {
      if (!alive) return
      alive = false
      clearInterval(heartbeat)
      if (playerId !== null) {
        rooms.leave(connection)
        console.log(`[server] #${playerId} left (${rooms.playerCount} across ${rooms.roomCount} room(s))`)
      }
    }
    socket.on('close', drop)
    socket.on('error', drop)
  })

  // Drift-corrected fixed-step loop.
  let ticksRun = 0
  const loop = () => {
    const due = Math.floor(now() / TICK_MS)
    const behind = due - ticksRun
    const toRun = Math.min(behind, MAX_CATCHUP_TICKS)
    if (behind > MAX_CATCHUP_TICKS) {
      // Give up on the backlog instead of spiking: drop the skipped ticks.
      console.warn(`[server] dropped ${behind - MAX_CATCHUP_TICKS} tick(s) after a stall`)
      ticksRun = due - MAX_CATCHUP_TICKS
    }
    for (let i = 0; i < toRun; i++) {
      ticksRun++
      rooms.step(now(), ticksRun)
    }
  }
  setInterval(loop, Math.max(1, Math.floor(TICK_MS / 2)))

  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    console.log('\n[server] shutting down')
    // 1012 is "service restart": it tells the client this close was expected, so it
    // reconnects quietly instead of reporting the race server as down.
    for (const client of wss.clients) client.close(1012, 'server restarting')
    wss.close()
    httpServer.close(() => process.exit(0))
    // A half-open socket must not hold the container past the orchestrator's stop timeout.
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
