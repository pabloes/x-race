# Tareas

Estado: `pendiente` · `en curso` · `en revisión` · `hecho` · `bloqueado`. Actualiza tu fila
al empezar y al terminar; el coordinador integra.

| Id | Tarea | Sesión | Modelo | Depende de | Estado | Rama |
|---|---|---|---|---|---|---|
| T0 | Contratos y docs de coordinación | Coordinador | Fable 5.1 | — | hecho | main |
| T1 | `shared/tracks/`: generador + definición `city`, `TRACKS`, todos los consumidores reciben el `Track` por parámetro; fingerprints múltiples en `welcome` | Núcleo | Opus 5.5 | T0 | en curso | tracks-core |
| T2 | Votación: mensaje `vote`, recuento, sorteo, reconstrucción del mundo físico, fase `intro` en la sala, menú de propuesta y voto | Núcleo | Opus 5.5 | T1 | en curso | tracks-core |
| T3 | Reconstrucción del escenario en cliente al cambiar de circuito; minimapa y HUD por circuito | Núcleo | Opus 5.5 | T1 | en curso | tracks-core |
| T4 | Features nuevas del generador: `gap`, `tunnel`, `corkscrew`, `bigramp`, perfil de altura | Mapa 2 | Opus 5.5 | T1 (separación generador/definición) | en revisión | sad-benz-980eca |
| T5 | Definición `skyline`, escenarios de físicas, vuelta completa del harness, bots con `hint` | Mapa 2 | Opus 5.5 | T4 | en revisión | sad-benz-980eca |
| T6 | Kit `city`: scripts bpy, atlas, piezas de la tabla, manifest, renders | Kit Blender | Opus 5.5 | T0 | en curso | kit-blender |
| T7 | Kit `neon` | Kit Blender | Opus 5.5 | T6 | pendiente | |
| T8 | `decor.ts`: colocación determinista por circuito y streaming de visibilidad | Colocación | Sonnet 5.5 | T1, T6 (primeras piezas) | pendiente | |
| T9 | `shared/cinematic.ts`, `scene/src/cinematic.ts`, `defaultIntro`, planos de `city`, salto | Cinemáticas | Sonnet 5.5 | T0 (fase `intro` la añade Núcleo en T2) | en curso | cinematics |
| T10 | Dosier de diseño del circuito Ready Player One | rpo-circuit | Opus 5.5 | — | en curso | rpo-circuit-dossier |
| T11 | Cámara: retraso solo del desplazamiento en el marco del coche (tirones) | Coordinador | Fable 5.1 | — | pendiente | |
| T12 | Integración, typecheck, tests, bots, tamaño del deploy, README | Coordinador + Verificación | Haiku 5.5 | todo | pendiente | |

## Decisiones tomadas (22/10/2026)

- Hora del día: la que toque; nada de `skyboxConfig.fixedTime`. Los dos kits deben verse bien
  de día y de noche (el neón apoya en emisivos).
- Mapa 2 "Skyline": azoteas con huecos, túnel invertido largo, rampas de tonel y un
  sacacorchos. Loop plano descartado (README).
- Kit low-poly; decoración por sectores que se enciende y apaga según distancia y mirada.
- Votación: un voto por jugador, cambiable, abstenciones no cuentan, empate al azar.
- Cinemática: 12 s, saltable por jugador, sincronizada por fase de sala.
