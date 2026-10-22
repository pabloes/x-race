import type { Vec3 } from './math'

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
