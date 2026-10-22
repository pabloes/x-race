# Arquitectura

El detalle del modelo de tiempo, la física y el circuito actual está en `README.md`. Este
documento resume la estructura y describe la que se está construyendo (octubre 2026).

## Hoy

```
shared/     protocolo (protocol.ts), constantes (constants.ts), trazado (track.ts), math.ts
server/     bucle a 60 Hz, salas (rooms.ts, room.ts), simulación por coche (car-sim.ts),
            backend físico (physics/rapier.ts tras physics/types.ts), bots, tests y stats
scene/      cliente SDK7: red (net/), coche (car.ts), cámara (camera.ts), circuito
            (track-render.ts), HUD y menú (ui.tsx), audio, derrapes, entrada
```

- Una sala multijugador compartida y una sala propia por jugador en SOLO. Fases de sala:
  `lobby` → `countdown` → `racing` → `finished`.
- `TRACK` es hoy un singleton construido desde un polígono (`SHAPE`) con radio por vértice;
  las features (meta, salto, techo invertido) se reparten por longitud de recta.
- El circuito visible son cajas con textura; el coche y sus chorros son GLB generados en Blender.

## Lo que viene

### Varios circuitos (contrato: `docs/contracts/tracks.md`)

`shared/tracks/` sustituye a `shared/track.ts`: un generador (`generator.ts`) y una
definición por circuito (`city.ts`, `skyline.ts`, más adelante el de Ready Player One).
`TRACKS` los indexa por id. La sala guarda su circuito, el mundo físico se construye por
circuito y el cliente destruye y reconstruye el escenario cuando el circuito de la sala cambia.

### Votación y fase de presentación (contrato: `docs/contracts/protocol.md`)

En el lobby cada jugador vota un circuito (`vote`). Al arrancar, el servidor cuenta, resuelve
el empate al azar, cambia de circuito si hace falta y pasa por una fase nueva `intro`
(cinemática sincronizada) antes de `countdown`.

### Mapa 2, "Skyline"

Azoteas con huecos que exigen velocidad y propulsores, túnel invertido largo, rampas de
tonel, un sacacorchos (el loop plano es imposible, ver README) y placas de carga antes de
cada hueco. Nuevas piezas del generador con su longitud de recta declarada, para que la
asignación por longitud siga valiendo.

### Kit de estilo (contrato: `docs/contracts/kit.md`)

Piezas GLB low-poly generadas con Blender headless en `scene/tools/kit/`, dos temas (`city`,
`neon`). La escena las coloca a partir de los datos del circuito; las cajas físicas no
cambian. Los edificios se cuantizan a un catálogo para que física y visual coincidan. La
decoración se muestra y oculta por sectores según la distancia y la mirada del coche.

### Cinemáticas (contrato: `docs/contracts/cinematic.md`)

Cada circuito lleva una lista de planos; `scene/src/cinematic.ts` mueve la cámara virtual por
splines durante la fase `intro`. Saltable por jugador.

## Propiedad de ficheros durante el trabajo en paralelo

| Área | Sesión |
|---|---|
| `shared/tracks/*` (generador, city, index), `server/src/*`, `scene/src/net/*`, `scene/src/track-render.ts`, menú de voto en `ui.tsx` | Núcleo de circuitos |
| `shared/tracks/skyline.ts`, piezas nuevas del generador, `server/src/feature-tests.ts`, `bot-driver.ts` (huecos) | Mapa 2 |
| `scene/tools/kit/*`, `scene/models/kit/*` | Kit Blender |
| `scene/src/decor.ts` (colocación y streaming) | Colocación del kit |
| `shared/cinematic.ts`, `scene/src/cinematic.ts`, planos `intro` de cada circuito | Cinemáticas (la fase `intro` en `room.ts` la añade Núcleo) |
| `docs/design/*` | Dosier RPO |
| `scene/src/camera.ts`, integración, docs | Coordinador |

## Despliegue

Servidor: `npm run pack:server` y `caprover deploy -n captain-01 -a elon-roadster-race -t caprover.tar`
desde la raíz, en un terminal interactivo (la CLI se cae sin TTY). Escena:
`cd scene && npm run build && npm run deploy -- --multi-scene --target-content https://worlds-content-server.decentraland.org --skip-build`,
firma con la wallet de Pablo en 5 minutos. Solo cuando Pablo lo pide.
