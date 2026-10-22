# Contrato: circuitos

## Módulos

```
shared/tracks/index.ts      TrackId, TRACKS, DEFAULT_TRACK, trackById()
shared/tracks/generator.ts  buildTrack(def) y los helpers que hoy viven en track.ts
shared/tracks/city.ts       CITY: TrackDefinition  (el circuito actual, SHAPE y features)
shared/tracks/skyline.ts    SKYLINE: TrackDefinition
shared/tracks/types.ts      TrackDefinition, Track, Surface, Trigger, Spawn, Shot, ...
```

`shared/track.ts` desaparece. Ningún módulo importa un circuito concreto salvo `index.ts`;
todo lo demás recibe un `Track` por parámetro (sala, CarSim, físicas, bots, render, HUD).

## Tipos

```ts
export type TrackId = 'city' | 'skyline'          // se amplía al añadir circuitos
export type Theme = 'city' | 'neon'               // kit de estilo, ver kit.md

export type Vertex = { x: number; z: number; r: number; name: string; y?: number }
// `y` es la altura del vértice (perfil de altura del trazado); 0 si falta. Entre vértices
// la altura se interpola suavemente a lo largo de la línea de carrera.

export type FeatureKind =
  | 'start' | 'start-jump' | 'jump' | 'ceiling'   // existentes
  | 'gap' | 'tunnel' | 'corkscrew' | 'bigramp'    // nuevas (Mapa 2)

export type TrackDefinition = {
  id: TrackId
  name: string                 // nombre visible en menú y votación
  theme: Theme
  laps: number
  shape: Vertex[]              // sentido de marcha; se escala y centra como hoy
  /**
   * Features que el circuito quiere, en orden de prioridad. El generador las asigna a las
   * rectas más largas que las admitan (cada feature declara el `span` que necesita) y
   * falla ruidosamente si alguna no cabe. Si falta, se aplica la regla actual.
   */
  features?: FeatureKind[]
  intro: Shot[]                // cinemática, ver cinematic.md
}

export type Track = {          // lo de hoy más:
  id: string                   // `${definition.id}-${fingerprint}`
  base: TrackId
  name: string
  theme: Theme
  laps: number
  intro: Shot[]
  centreline: PathPoint[]      // antes Vec3[]; ahora { pos, dir, hint? }
  // surfaces, obstacles, triggers, spawns, checkpointCount, extent, lapLength: sin cambios
}

export type PathPoint = { pos: Vec3; dir: Vec3; hint?: 'boost' | 'thrust' | 'brake' }
// `hint` es lo que un bot debería hacer al pasar por ahí: 'thrust' antes de un hueco, etc.
```

## Reglas del generador

- Determinista: sin `Math.random`; el generador de edificios sigue siendo xorshift con semilla.
- `fillet()` y la asignación de features fallan con excepción si la geometría no cabe. Un
  circuito roto no se construye en silencio.
- `fingerprint(track)` cubre superficies, obstáculos, triggers y spawns; servidor y cliente
  comparan los fingerprints de **todos** los circuitos en el `welcome` (ver protocol.md).
- Edificios: tamaños cuantizados al catálogo `BUILDING_CATALOG` de `shared/constants.ts`
  (ver kit.md), para que la caja física y la pieza visual midan lo mismo.
- Features nuevas (Mapa 2):
  - `gap`: tramo de calzada ausente de longitud configurable (por defecto 18 m) con rampa
    corta de despegue; cruzable a fondo con turbo, o a media velocidad con propulsores. Placa
    de carga obligatoria 60 m antes.
  - `tunnel`: carrera invertida larga (losa de 120 m) con entrada y salida como el techo actual.
  - `corkscrew`: hélice con base de Frenet y desplazamiento lateral, documentada en el README
    como el único loop viable. Entrada y salida alineadas con la recta.
  - `bigramp`: rampa de 22° para toneles, con zona de aterrizaje llana.
  Cada una declara `span` (metros de recta que necesita, márgenes incluidos).
- `respawnFor(track, cp)` y `lineOffset(track, pos, hint)` toman el circuito por parámetro.

## Pruebas

- `server/src/feature-tests.ts` acepta un id de circuito (`npm run test:features -- skyline`)
  y carga los escenarios de `server/src/scenarios/<id>.ts`. Cada circuito nuevo trae los
  suyos: salto, huecos, túnel, sacacorchos, y aterrizar sobre las ruedas.
- `npm run harness -- <id>`: el piloto automático completa 3 vueltas pasando por todos los
  controles. Los bots (`bot-driver.ts`) siguen `centreline` y obedecen `hint`.
- `npm run typecheck` en verde.

## Cliente

- `scene/src/track-render.ts`: `buildTrack(track)` y `clearTrack()`. Al cambiar el circuito
  de la sala (ver protocol.md) se limpia y reconstruye; el kit de decoración (`decor.ts`) se
  engancha en los mismos dos puntos.
- HUD: minimapa y cuenta de controles leen el circuito activo, no una constante.
