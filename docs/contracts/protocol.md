# Contrato: protocolo (cambios sobre `shared/protocol.ts`)

Se incrementa la versión de protocolo (`v` del `join`). El servidor rechaza clientes con
otra versión, como hoy.

## Fases

```ts
export type RacePhase = 'lobby' | 'countdown' | 'racing' | 'finished'
```

No hay fase de cinemática: el vuelo por el circuito es cosa del cliente y se ve en `lobby`
(ver `cinematic.md`). Transición: `lobby` → (recuento de votos, cambio de circuito si procede,
coches en parrilla) → `countdown` → `racing`, sin pausa entre START y la cuenta atrás.
La versión de protocolo sube a 3 porque desaparece un valor de `RacePhase`.

## Estado de sala

```ts
export type RaceState = {
  // ...lo de hoy...
  track: TrackId                               // circuito actual de la sala
  votes: Partial<Record<TrackId, number>>      // recuento; vacío fuera del lobby
}
```

## Mensajes del cliente

```ts
| { t: 'vote'; track: TrackId }
```

- Un voto por jugador (incluidos espectadores), sustituye al anterior, solo en `lobby`.
- Un id desconocido se ignora. En SOLO el único voto decide directamente.
- El servidor no manda confirmación: el cliente ve su efecto en `votes` de la siguiente instantánea.

## Mensajes del servidor

`welcome` añade:

```ts
tracks: { id: TrackId; fingerprint: string }[]   // todos los circuitos que conoce el servidor
```

El cliente compara con sus `TRACKS`; si alguno no coincide, `trackMismatch` como hoy. `trackId`
sigue siendo el circuito actual.

Evento nuevo:

```ts
| { t: 'track'; track: TrackId; votes: Partial<Record<TrackId, number>>; tie: boolean }
```

Se emite al resolver la votación, antes de `countdown`, para el aviso en pantalla ("SKYLINE, por
sorteo"). El sorteo usa `Math.random` **solo en el servidor** (`room.ts`), nunca en `shared/`.

## Reglas de recuento

1. Se cuentan los votos presentes al abrir la puerta (`start`).
2. Sin votos: se repite el circuito actual.
3. Más votado gana; empate entre los más votados: sorteo uniforme entre ellos.
4. Si el ganador es distinto del actual, la sala reconstruye su mundo físico y recoloca a
   todos los corredores en la parrilla nueva antes de entrar en `countdown`.
5. Al volver a `lobby` los votos se vacían.
