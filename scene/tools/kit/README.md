# Kit de escenario

Piezas GLB low-poly que decoran los circuitos, generadas por script con `bpy` (nada se edita a
mano ni se descarga). Contrato: `docs/contracts/kit.md`.

## Regenerar

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P scene/tools/kit/build.py -- --theme city
```

Unos 30 s en un M1 Pro (`--no-renders` lo deja en unos 10 s). Sale con código distinto de 0 si
alguna pieza incumple el contrato: medidas, pivote, triángulos, materiales o transparencias.

Salida:

- `scene/models/kit/<tema>/<pieza>.glb` y `manifest.json` (`{ pieza: { size: {x,y,z}, tris, materials } }`,
  medido leyendo cada GLB ya exportado).
- `scene/tools/kit/renders/<tema>/`: una vista por pieza, `lineup.jpg`, `lineup-buildings.jpg`,
  `compo-chase.jpg` y `compo-overview.jpg` (30 m de recta decorados), más los dos atlas en PNG.
  Los renders se hacen importando los GLB exportados, así que también prueban la ida y vuelta.

`python3 scene/tools/kit/glb.py scene/models/kit/city/*.glb` revisa los GLB sin Blender.

## Archivos

| Archivo | Qué hace |
|---|---|
| `build.py` | Entrada: construye las piezas, empaqueta y pinta el atlas, exporta, comprueba y renderiza |
| `pieces.py` | Geometría de cada pieza y los pintores de sus texturas; `SPEC` guarda las medidas del contrato |
| `geo.py` | Primitivas (caja biselada, prisma de perfil, cilindro, copa facetada) y la proyección UV al atlas |
| `atlas.py` | Atlas de 2048 px: empaquetador, lienzo numpy, fuente de trazos para los rótulos |
| `themes.py` | Paletas por tema: color de cada rol y, en `glow`, su emisivo |
| `glb.py` | Lector de GLB: triángulos, materiales, caja, alfa |
| `render.py` | Renders de comprobación (Eevee, luz de día) |

## Convenciones

- Metros, pivote en el suelo y centrado en X y Z, +Z al frente, +X a la derecha de la pieza.
  En Blender eso es frente = −Y y derecha = −X; sin `MIRROR_X` (igual que el coche).
- Un único material por tema (`kit_city`) con atlas de color y atlas emisivo, opaco y de una cara.
  Todas las piezas comparten atlas y material.
- Los colores planos muestrean el centro de una muestra de 64 px y los rótulos (cuadros, franjas,
  ventanas, público) se proyectan en su baldosa con borde replicado, para que el mipmapping no
  mezcle vecinos.

## Notas para la colocación (`decor.ts`)

- `barrier`, `kerb`: simétricas; el eje largo es X. Encadenadas cada 4 m (o 6 m) alternan bien
  los colores.
- `chevron`: las flechas apuntan a +X local **en las dos caras**. Colócala con +X en el sentido de
  la marcha: la cara que mire al coche señala el giro, sea a izquierda o derecha.
- `gate-start`, `gate-checkpoint`: luz libre de 16,2 m y 17,8 m entre pilares, y de 4,88 m y
  5,0 m bajo la viga. Los rótulos se leen bien desde las dos caras.
- `lamp`: brazo hacia +Z; el poste queda 0,5 m detrás del pivote (−Z). Para que la luz caiga
  sobre la calzada, +Z debe mirar a la pista.
- `banner`: la bandera está en el plano YZ y se lee desde ±X; colocada sin girar junto a una recta
  que corre en Z, mira a la pista.
- `stand`: el público mira a +Z.
- `building-*`: la caja de la pieza es exactamente w × h × d (el ático de escaleras marca la altura).

## Presupuesto actual (city)

21 piezas, 2592 triángulos en total (máximo 172 por pieza), 1 material. Cada GLB pesa unos
480 KB porque lleva dentro el atlas (JPEG); el kit entero pesa unos 9,8 MB.

## Tema neon (T7)

La paleta y los emisivos ya están en `themes.py` (`NEON`): los pintores piden roles y el tema
decide si brillan. Faltan los constructores de `palm` y `hologram`; hasta entonces
`--theme neon` se para con un aviso y no escribe nada.
