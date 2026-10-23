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
  gapLength?: number           // metros sin calzada en cada `gap`; 18 si falta
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
- Perfil de altura: `Vertex.y` son metros (no se escalan con la forma). Las curvas son llanas
  a la altura de su vértice; la recta entre dos vértices de distinta altura es una subida con
  smoothstep y no admite features. Todas las features piden recta llana; `gap`, además, recta
  en azotea (y ≥ 3 m): más abajo el hueco sería un foso bajo una grava que el cliente dibuja.
- Bajo cualquier calzada a más de 3 m (y 14 m a cada lado), bajo cada hueco y bajo el
  sacacorchos no hay suelo de parcela: quien cae, cae fuera del mundo y reaparece. El suelo
  sigue siendo `kind: 'ground'`, ahora en varias cajas; sin huecos, la caja única de siempre.
- Controles: si el circuito tiene piezas nuevas, los 12 se reparten por la calzada que queda
  fuera de ellas (ni en el sacacorchos ni sobre un hueco, donde la reaparición 10 m atrás
  quedaría en el aire), más uno a mitad de cada tramo invertido. Los pórticos se apoyan en la
  calzada a la altura que tenga.
- `respawnFor(track, cp)` y `lineOffset(track, pos, hint)` toman el circuito por parámetro.
  `spawnHeightAt(track, x, z)` da la altura a la que poner un coche: sobre la calzada más alta
  en ese punto (las losas de techo no cuentan, así que bajo el túnel es la calzada de abajo).

## Pruebas

- `server/src/feature-tests.ts` acepta un id de circuito (`npm run test:features -- skyline`)
  y carga los escenarios de `server/src/scenarios/<id>.ts`. Cada circuito nuevo trae los
  suyos: salto, huecos, túnel, sacacorchos, y aterrizar sobre las ruedas.
- `npm run harness -- <id>`: el piloto automático completa 3 vueltas pasando por todos los
  controles. Los bots (`bot-driver.ts`) siguen `centreline` y obedecen `hint`:
  - `thrust`: de 6 m antes del borde a 8 m pasado, un impulso de propulsores; con un hueco en
    los próximos 150 m el bot no gasta carga en turbo.
  - `boost`: acelerador y turbo, y esa parte de la línea no se frena (la proyección del
    sacacorchos en el suelo es una horquilla falsa).
  - En el aire el bot suelta todo menos los propulsores, y si pasa 1,5 s más de 6 m por debajo
    de su punto de mira (bajo una azotea, bajo una losa) pide reaparecer.
- `npm run typecheck` en verde.

## Cliente

- `scene/src/track-render.ts`: `buildTrack(track)` y `clearTrack()`. Al cambiar el circuito
  de la sala (ver protocol.md) se limpia y reconstruye; el kit de decoración (`decor.ts`) se
  engancha en los mismos dos puntos.
- HUD: minimapa y cuenta de controles leen el circuito activo, no una constante.
- Suelo visual: un plano de grava por caja `ground` y un plano oscuro en cada hueco del suelo,
  así que quien cae de una azotea cae por un pozo y no atraviesa la grava. Las placas, pórticos
  y pilares son piezas del kit (`decor.ts`) a la altura de su trigger.
- Minimapa por circuito: `scene/tools/make-minimap.py <salida>` y la entrada en `MINIMAPS` de
  `ui.tsx` (`images/minimap-skyline.png`).
