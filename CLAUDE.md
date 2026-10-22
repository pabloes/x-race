# ELON ROADSTER RACE: reglas del proyecto

Lee `README.md` para entender el juego; `docs/architecture.md` para la estructura actual y la
que viene; `docs/contracts/` para las interfaces entre módulos; `docs/tasks.md` para saber
quién hace qué. Los contratos mandan: si el código y el contrato discrepan, se corrige el
contrato primero (avisando al coordinador) y el código después.

## Convenciones

- `shared/` es la única fuente de verdad de protocolo, constantes y trazados. El servidor
  es autoritativo; el cliente solo dibuja lo que recibe. Nada en `shared/` usa
  `Math.random` ni estado global mutable: servidor y cliente deben construir la misma
  geometría al metro.
- El runtime de escenas es QuickJS sin WASM ni APIs de Node; la red es `WebSocket.send(string)`.
- Cada escritura de componente en la escena viaja al renderer: se escribe solo cuando cambia.
- Comentarios de código en inglés, explicando el porqué, en el estilo de los ficheros
  existentes. Documentación y README en español. Sin guiones largos en textos que publique Pablo.
- Modelos 3D: siempre generados por un script (Blender headless o Python), nunca editados a mano.
  El coche viene de `~/dev/ZeroxWork/tesla-roadster-dcl/v2/scripts`; los kits de escenario,
  de `scene/tools/kit/`.
- Cambio mínimo y completo. Sin abstracciones especulativas ni refactors ajenos a la tarea.

## Verificación

- `npm run typecheck` (servidor y escena) y `npm run test:features` tienen que pasar antes de
  dar algo por hecho. `npm run harness` da una vuelta completa con piloto automático.
- Lo visual lo comprueba Pablo en el explorador de Decentraland; entrégale una lista corta de
  qué mirar. No pidas control de pantalla.

## Git y despliegue

- Nunca commit, push, merge, deploy ni publicación sin que Pablo lo pida. Una sesión en su
  propio worktree solo commitea en su rama cuando su brief lo autoriza.
- Despliegue: ver `docs/architecture.md`, sección Despliegue.
