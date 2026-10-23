# Tareas

Estado: `pendiente` · `en curso` · `en revisión` · `hecho` · `bloqueado`. Actualiza tu fila
al empezar y al terminar; el coordinador integra.

| Id | Tarea | Sesión | Modelo | Depende de | Estado | Rama |
|---|---|---|---|---|---|---|
| T0 | Contratos y docs de coordinación | Coordinador | Fable 5.1 | — | hecho | main |
| T1 | `shared/tracks/`: generador + definición `city`, `TRACKS`, todos los consumidores reciben el `Track` por parámetro; fingerprints múltiples en `welcome` | Núcleo | Opus 5.5 | T0 | en revisión (5398783, verificado por el coordinador: 13/13, build) | claude/tracks-core-811152 |
| T2 | Votación: mensaje `vote`, recuento, sorteo, reconstrucción del mundo físico, fase `intro` en la sala, menú de propuesta y voto | Núcleo | Opus 5.5 | T1 | en revisión (8451b14) | claude/tracks-core-811152 |
| T3 | Reconstrucción del escenario en cliente al cambiar de circuito; minimapa y HUD por circuito | Núcleo | Opus 5.5 | T1 | en revisión (955c3cf) | claude/tracks-core-811152 |
| T4 | Features nuevas del generador: `gap`, `tunnel`, `corkscrew`, `bigramp`, perfil de altura | Mapa 2 | Opus 5.5 | T1 (separación generador/definición) | en revisión (617357f) | claude/sad-benz-980eca |
| T5 | Definición `skyline`, escenarios de físicas, vuelta completa del harness, bots con `hint` | Mapa 2 | Opus 5.5 | T4 | hecho salvo visual (b15f01d integra cool-colden + skyline: 17/17, 3 vueltas, test:decor ok). Rama de integración actual | claude/sad-benz-980eca |
| T6 | Kit `city`: scripts bpy, atlas, piezas de la tabla, manifest, renders | Kit Blender | Opus 5.5 | T0 | hecho (f36c5d9 piezas, 3247a2a texturas por pieza, 0,48 MB); pendiente verlo en el explorador | claude/kit-blender-f880a5 |
| T7 | Kit `neon` | Kit Blender | Opus 5.5 | T6 | hecho (5c06cbb: 21 piezas, 2.674 tris, 0,52 MB; palm y hologram) | claude/kit-blender-f880a5 |
| T8 | `decor.ts`: colocación determinista por circuito y streaming de visibilidad | Colocación | Sonnet 5.5 | T1, T6 (primeras piezas) | hecho salvo visual (cff7eff; verificado por el coordinador: build, 13/13, test:decor; 1.274 piezas, máx 339 entidades y 37 k tris visibles) | claude/cool-colden-660a83 |
| T9 | `shared/cinematic.ts`, `scene/src/cinematic.ts`, `defaultIntro`, planos de `city`, salto | Cinemáticas | Sonnet 5.5 | T0 (fase `intro` la añade Núcleo en T2) | en revisión; integrada y adaptada por Núcleo en claude/tracks-core-811152 (edd3e03): al mergear, usar esa rama, no la de cinematics | claude/cinematics-df5088 |
| T10 | Dosier de diseño del circuito Ready Player One | rpo-circuit | Opus 5.5 | — | en revisión (sin commit, en `.claude/worktrees/rpo-circuit-dossier-020bdd/docs/design/`) | claude/rpo-circuit-dossier-020bdd |
| T11 | Cámara: retraso solo del desplazamiento en el marco del coche (tirones) | Coordinador | Fable 5.1 | — | en revisión (Pablo en preview) | main |
| T12 | Integración, typecheck, tests, bots, tamaño del deploy, README | Coordinador + Verificación | Haiku 5.5 | todo | pendiente | |
| T13 | UI nueva según `docs/design/ui/mockup/`: logo PNG fiel a la referencia, paneles 9-slice, lobby lateral con carrusel de voto, HUD por fase, controles plegables (sin rótulo de intro) | UI | Opus 5.5 | T3, T9 | hecho salvo visual (79a2310 lobby y HUD, b3f472d assets; 5867515 integra sad-benz y cinematics; ajustes de Pablo: zonas seguras d3e7e81, HUD mínimo 95b7714, cuenta atrás 10 s 93d671e, paddock al norte 5c57692; textos en inglés en curso). Rama de integración actual | claude/ui-restyle-b5faed |
| T15 | Físicas: turbo en el aire (impulso longitudinal con gasto de carga) y barreras sólidas generadas en `shared/` con collider en servidor, con solape en juntas y escenarios de roce | Mapa 2 | Opus 5.5 | T13 | en curso | claude/sad-benz-980eca |
| T14 | Flujo nuevo de cámara: vuelo en bucle por el circuito mientras el lobby está abierto, START transiciona 1 s al coche y arranca el countdown; se elimina la fase `intro` del servidor. Causa raíz del fallo: `scene/src/cinematic.ts` no se integró en edd3e03 | Cinemáticas | Sonnet 5.5 | T9, T5 | hecho salvo visual (7d9f040 servidor y shared, 6385490 cliente; verificado por el coordinador: build y 13/13). Rama de integración actual | claude/cinematics-df5088 |

## Decisiones tomadas (22/10/2026)

- Hora del día: la que toque; nada de `skyboxConfig.fixedTime`. Los dos kits deben verse bien
  de día y de noche (el neón apoya en emisivos).
- Mapa 2 "Skyline": azoteas con huecos, túnel invertido largo, rampas de tonel y un
  sacacorchos. Loop plano descartado (README).
- Kit low-poly; decoración por sectores que se enciende y apaga según distancia y mirada.
- Votación: un voto por jugador, cambiable, abstenciones no cuentan, empate al azar.
- Cinemática: 12 s, saltable por jugador, sincronizada por fase de sala.
