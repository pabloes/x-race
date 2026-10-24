# Imágenes de la UI

Todo lo que hay en `scene/images/ui/` sale de `make-ui.py` (Pillow 12 y fuentes del sistema de
macOS); nada se retoca a mano.

```bash
python3 scene/tools/ui/make-ui.py
```

Tarda unos 10 s e imprime cada imagen con su tamaño, su peso y, en los marcos 9-slice, la
fracción que `ui.tsx` pasa en `textureSlices`. El conjunto pesa unos 250 KB (presupuesto: 600 KB).

## Qué genera

| Imagen | Uso |
|---|---|
| `logo.png` (1024 x 256) | Logo arriba a la izquierda en el lobby. SF Pro expandida y negra, en itálica sintética, con extrusión, contorno, brillo y bandera a cuadros, imitando `docs/design/reference/ui/logo-reference.png` |
| `panel-frame.png`, `panel-frame-tr.png` | Cristal azul oscuro con borde cian y brillo: tarjeta de lobby (chaflanes arriba a la derecha y abajo a la izquierda) y tarjetas del HUD (solo arriba a la derecha) |
| `panel-soft.png`, `panel-tag.png`, `panel-plain.png` | Paneles secundarios sin brillo: clasificación, botones pequeños, leyenda de controles |
| `card-on.png`, `card-off.png` | Tarjetas seleccionables (modo, vueltas, bots), con la misma geometría para que elegir una no mueva nada |
| `button-green.png`, `button-outline.png` | START RACE y SPECTATE |
| `key-cap.png` | Teclas de la leyenda de controles |
| `toast-frame.png` | Aviso de evento con puntas; se estira solo a lo ancho |
| `seg-on.png`, `seg-off.png`, `charge-fill.png`, `dot-*.png` | Barra segmentada de velocidad, relleno de carga, puntos del carrusel |
| `icon-*.png` (32 px) | Iconos con su color ya puesto (gas en la barra de carga, pedal y elevar en los controles táctiles) |
| `thumb-<circuito>.png` (512 x 128) | Miniatura del carrusel, dibujada a 356 x 100 y comprimida a potencia de dos; la UI la estira de vuelta |

## Reglas

- Los marcos se dibujan al tamaño al que se ven: el explorador pinta el borde de un 9-slice a
  los píxeles de la textura. Si cambias un chaflán o un margen, cambia también la constante
  que lo refleja en `ui.tsx` (`FRAME_GLOW`, `CARD_GLOW` y los `SLICE_*`).
- Los marcos con brillo llevan un margen transparente para él, y su pareja sin brillo lleva el
  mismo margen.
- Un circuito nuevo necesita su `thumb_<id>` aquí y su entrada en `TRACK_CARDS` de `ui.tsx`.
