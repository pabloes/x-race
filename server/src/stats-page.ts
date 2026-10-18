/**
 * The admin page, rendered as one HTML string.
 *
 * No framework, no client-side code beyond a meta refresh: it is a page that is read, not
 * used, and anything heavier would be a second thing to deploy and keep working. There is
 * no authentication here on purpose — it is expected to sit behind CapRover's own basic
 * auth, which is where a password belongs rather than in the game server.
 */

import type { Stats } from './stats'

const STYLE = `
  :root { color-scheme: dark }
  body { margin: 0; padding: 32px; background: #0b0e14; color: #e8ecf4;
         font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .02em }
  h2 { font-size: 15px; margin: 32px 0 10px; color: #7f8da8; text-transform: uppercase;
       letter-spacing: .08em; font-weight: 600 }
  .sub { color: #7f8da8; margin: 0 0 26px }
  .cards { display: flex; gap: 14px; flex-wrap: wrap }
  .card { background: #141a26; border: 1px solid #1f2836; border-radius: 10px;
          padding: 16px 20px; min-width: 150px }
  .n { font-size: 30px; font-weight: 650; color: #19d3ff }
  .l { color: #7f8da8; font-size: 13px; text-transform: uppercase; letter-spacing: .06em }
  table { border-collapse: collapse; width: 100%; margin-top: 4px }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
       color: #7f8da8; border-bottom: 1px solid #1f2836; padding: 8px 10px 8px 0 }
  td { padding: 8px 10px 8px 0; border-bottom: 1px solid #141a26; vertical-align: top }
  .addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #c7d2e4 }
  .muted { color: #6b7a93 } .guest { color: #7f8da8; font-style: italic }
  .win { color: #ffd84d } .empty { color: #7f8da8; padding: 14px 0 }
`

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

function when(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function lap(ms: number): string {
  if (!ms) return '—'
  return `${(ms / 1000).toFixed(2)}s`
}

export function statsPage(stats: Stats, engine: string, rooms: number, players: number): string {
  const s = stats.summary()
  const visitors = s.visitors
    .map(
      (v) => `<tr>
        <td>${escape(v.name)}</td>
        <td class="addr">${escape(v.address ?? '')}</td>
        <td>${v.visits}</td>
        <td>${v.races}</td>
        <td class="muted">${when(v.firstSeenAt)}</td>
        <td class="muted">${when(v.lastSeenAt)}</td>
      </tr>`
    )
    .join('')

  const races = s.recent
    .map((r) => {
      const field = [...r.participants]
        .sort((a, b) => a.rank - b.rank)
        .map((p) => {
          const who = p.address
            ? `<span class="addr">${escape(p.address)}</span>`
            : `<span class="guest">guest</span>`
          const tag = p.bot ? ' <span class="muted">(bot)</span>' : ''
          const name = `${escape(p.name)}${tag}`
          const place = p.rank === 1 ? `<span class="win">1.</span>` : `${p.rank}.`
          return `<div>${place} ${name} — ${who} · ${p.laps} lap(s) · best ${lap(p.bestLapMs)} · ${p.score} pts${
            p.finished ? '' : ' · <span class="muted">unfinished</span>'
          }</div>`
        })
        .join('')
      return `<tr>
        <td class="muted">${when(r.startedAt)}</td>
        <td>${escape(r.mode)} · ${r.laps} lap(s) · ${Math.round((r.endedAt - r.startedAt) / 1000)}s</td>
        <td>${field}</td>
      </tr>`
    })
    .join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>ELON ROADSTER RACE — stats</title>
<style>${STYLE}</style></head>
<body>
  <h1>ELON ROADSTER RACE</h1>
  <p class="sub">${escape(engine)} · ${rooms} room(s) · ${players} online · up since ${when(s.startedAt)}</p>
  <div class="cards">
    <div class="card"><div class="n">${s.uniqueVisitors}</div><div class="l">unique wallets</div></div>
    <div class="card"><div class="n">${s.guestVisits}</div><div class="l">guest joins</div></div>
    <div class="card"><div class="n">${s.races}</div><div class="l">races logged</div></div>
  </div>

  <h2>Visitors</h2>
  ${
    visitors
      ? `<table><tr><th>Name</th><th>Address</th><th>Joins</th><th>Races</th><th>First seen</th><th>Last seen</th></tr>${visitors}</table>`
      : '<p class="empty">No signed-in visitors yet.</p>'
  }

  <h2>Races</h2>
  ${
    races
      ? `<table><tr><th>When</th><th>Race</th><th>Field</th></tr>${races}</table>`
      : '<p class="empty">No races finished yet.</p>'
  }
</body></html>`
}
