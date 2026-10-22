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

- Cada `TrackDefinition.intro` suma `RACE.introMs / 1000` ± 0.5 s; `buildTrack` falla si no.
- `defaultIntro(track)` en `shared/cinematic.ts` genera tres planos para cualquier circuito
  sin planos propios (recibe el `Track` ya construido; `buildTrack` lo llama cuando la
  definición no trae `intro`): barrido aéreo alto por la primera mitad de la línea de carrera, pasada
  baja sobre la feature mayor (salto, techo o hueco), y retroceso hasta la parrilla mirando
  a los coches. Sirve de plantilla para los planos hechos a mano.

## Cliente (`scene/src/cinematic.ts`)

- `playIntro(track, elapsedMs)` cada fotograma mientras la fase es `intro`:
  `elapsedMs = RACE.introMs - race.phaseMs`, así quien entra a mitad se incorpora donde va.
  Coloca la cámara virtual de `camera.ts` (misma entidad; `camera.ts` ya expone `rig()`), con
  `fov` del plano. Mientras no exista la fase `intro` en el servidor, un flag de desarrollo
  en `cinematic.ts` permite lanzarla a mano desde el lobby para probarla.
- `skipIntro()`: tecla espacio o toque en móvil. Deja la cámara de persecución en la parrilla
  hasta `countdown`. El salto es por jugador; la fase sigue en el servidor.
- HUD oculto durante la cinemática salvo el nombre del circuito y el aviso de saltar.
- Espectadores también la ven. Al terminar la fase, vuelve la cámara de persecución sin corte
  brusco (`VirtualCamera` con transición de 0.35 s, como hoy).

## Servidor

- Fase `intro` según `docs/contracts/protocol.md`. Nada más: el servidor no sabe de planos.
