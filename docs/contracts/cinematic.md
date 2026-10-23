# Contrato: cinemática de presentación

## Datos (en `shared/cinematic.ts`, que `shared/tracks/types.ts` importa)

```ts
export type Shot = {
  /** Ruta de la cámara en metros de mundo, mínimo 2 puntos; Catmull-Rom entre ellos. */
  path: Vec3[]
  /**
   * A qué mira: un punto fijo, una ruta con tantos puntos como `path`, o 'cars' (el
   * centro de la parrilla, para el plano final).
   */
  look: Vec3 | Vec3[] | 'cars'
  seconds: number
  /** Campo de visión, 60 por defecto. */
  fov?: number
  /** Transición al entrar en este plano: 'cut' (por defecto) o 'fade'. */
  transition?: 'cut' | 'fade'
}
```

- `TrackDefinition.intro` puede durar lo que quiera: el vuelo se repite en bucle, así que
  `validateIntro(shots)` solo comprueba que cada plano sea reproducible.
- `defaultIntro(track)` en `shared/cinematic.ts` genera tres planos para cualquier circuito
  sin planos propios (recibe el `Track` ya construido; `buildTrack` lo llama cuando la
  definición no trae `intro`): barrido aéreo alto por la primera mitad de la línea de carrera, pasada
  baja sobre la feature mayor (salto, techo o hueco), y retroceso hasta la parrilla mirando
  a los coches. Sirve de plantilla para los planos hechos a mano.

## Cliente (`scene/src/cinematic.ts`)

- El vuelo se ve **en el lobby, antes de START**, mientras el menú está desplegado y el
  jugador no es espectador. Recorre en bucle `activeTrack().intro` (corte entre planos) sobre
  una entidad `VirtualCamera` propia, distinta del `rig()` de `camera.ts`; el menú sigue encima.
  Quien entra a mitad de carrera o es espectador no lo ve.
- `updateFlyover(eligible, menuOpen, track, dt)` cada fotograma: coloca la cámara y devuelve si
  el vuelo manda. Espacio lo descarta (la cámara vuelve al avatar); plegar y volver a
  desplegar el menú lo reactiva.
- Al dar START la sala pasa directo a `countdown` (no hay fase `intro`). En cuanto hay coche
  propio, `follow()` pasa `MainCamera` al `rig()` de persecución, y como es otra entidad el
  `VirtualCamera` hace una transición de 1 s desde el vuelo.
- Sin rótulo de intro en el HUD: el menú ya dice el circuito.

## Servidor

- Nada: no hay fase de cinemática y el servidor no sabe de planos (`protocol.md`).
