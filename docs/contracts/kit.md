# Contrato: kit de escenario

Piezas GLB low-poly que decoran los circuitos. Referencia visual: ciudad estilizada de día
(banderolas RACE, pórticos a cuadros, chevrones amarillos, barreras rojiblancas, árboles,
gradas) y variante ciberpunk de neón (hologramas, carteles emisivos, palmeras, drones). Son
inspiración, no objetivo de fidelidad: esto es Decentraland y es low-poly.

## Generación

- Scripts `bpy` en `scene/tools/kit/` (entrada: `build.py`; se ejecuta con
  `/Applications/Blender.app/Contents/MacOS/Blender -b -P scene/tools/kit/build.py -- --theme city`).
- Salida: `scene/models/kit/<theme>/<pieza>.glb` y `scene/models/kit/<theme>/manifest.json`
  con `{ piece: { size: {x,y,z}, tris, materials } }` leído por la colocación.
- Renders de comprobación en `scene/tools/kit/renders/<theme>/` (fuera del deploy: `.dclignore`).
- Convenciones GLB: metros, escala 1, pivote en el suelo (y = 0) y centrado en X y Z, +Z es el
  frente de la pieza, +X su derecha. Sin `MIRROR_X` (el explorador niega X al importar).
- Presupuesto por tema: un atlas de 2048 px (color + emisivo + ORM si hace falta), como mucho
  3 materiales, y por pieza ≤ 600 triángulos (lo normal ≤ 200). Edificios ≤ 400.
- Sin transparencias salvo cristal de hologramas; `doubleSided` solo donde haga falta.

## Piezas (nombres fijos, los usa la colocación)

| Pieza | Medidas (x · y · z, m) | Notas |
|---|---|---|
| `barrier` | 4 · 1 · 0.4 | rojiblanca; neón: franjas emisivas |
| `kerb` | 6 · 0.15 · 0.8 | piano rojiblanco para bordes de curva |
| `chevron` | 2.4 · 2 · 0.3 | panel con flechas; apunta al frente (+Z) en el sentido de giro |
| `gate-start` | 19 · 7 · 1.5 | pórtico de meta a cuadros con banda RACE |
| `gate-checkpoint` | 19 · 6 · 1 | pórtico ligero, luz del tema |
| `lamp` | 0.6 · 8 · 1.6 | farola, brazo hacia +Z |
| `banner` | 0.4 · 6 · 1.2 | mástil con banderola vertical |
| `stand` | 12 · 6 · 6 | módulo de grada con público en textura |
| `tree-a`, `tree-b` | ≈ 5 · 7 · 5 | neón: `palm` sustituye a `tree-b` |
| `pad` | 6 · 0.1 · 6 | placa de carga, emisiva |
| `pillar` | 2 · 6 · 2 | obstáculo de salto |
| `building-<w>x<d>x<h>` | catálogo | ver abajo |
| `hologram` | 8 · 12 · 0.5 | solo neón; clip opcional `loop` |

Catálogo de edificios (`BUILDING_CATALOG` en `shared/constants.ts`, lo consume también el
generador): plantas 20, 28 y 36 m (cuadradas) × alturas 12, 24 y 36 m = 9 piezas por tema,
nombradas `building-20x20x12`, etc. El generador elige la pieza más grande que cabe en el
hueco que hoy calcula, de modo que la caja física mide exactamente lo que la pieza.

## Colocación (`scene/src/decor.ts`)

- Determinista a partir del `Track` (mismo xorshift con semilla que los edificios).
- Barreras a `ROAD_W/2 + 1` m de cada borde de calzada, cada 4 m, en rectas y curvas; pianos
  en los bordes interiores de curva; chevrones en el exterior de cada curva cada 12 m, mirando
  en el sentido de giro; pórticos en la meta y en cada control; farolas cada 30 m en rectas,
  alternando lado; gradas y banderolas en el exterior de la recta principal; árboles en la
  franja libre entre calzada y edificios. Nada a menos de 2 m de una caja de calzada, nada
  sobre rampas, huecos ni losas de techo.
- Calzada en altura (su cara superior a más de 0,5 m): sin barreras, pianos, chevrones ni
  farolas en el borde, que quedarían en el suelo o colgando; en su lugar un `pillar` escalado
  hasta la losa cada 20 m donde la caja es llana (no bajo el sacacorchos). Pórticos de meta y
  de control a la altura de la calzada. Nada de decoración sobre los huecos del suelo.
- Sin colisionadores en la decoración (la física es del servidor; el avatar solo choca con
  edificios y calzada, como hoy).

## Streaming de visibilidad

La decoración se agrupa por sector (cada 30 m de línea de carrera). Cada 250 ms el cliente
muestra los sectores a menos de 160 m del coche local (o del avatar si no conduce) y dentro
de ±110° del frente de la cámara (todo alrededor si está parado), y oculta el resto. Solo se
escribe `VisibilityComponent` cuando cambia. Objetivo: ≤ 400 entidades de decoración
visibles y ≤ 150 k triángulos visibles a la vez. Lo que ve el coche al mirar adelante es lo
que importa; lo que queda atrás se apaga.

Implementado en `scene/src/decor-layout.ts` (colocación y selección, puras) y `scene/src/decor.ts`
(entidades y sistema de 250 ms). Una desviación: barreras, pianos y chevrones se apagan a 90 m en
lugar de 160 m, porque la vuelta de city se pliega sobre sí misma y solo las barreras sumaban 390
entidades. `npm run test:decor` recorre la línea de carrera y comprueba distancias y presupuestos
(city: máx. 339 entidades y 37 k triángulos visibles al conducir; parado con todo alrededor, 460).
