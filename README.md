# ELON ROADSTER RACE — Decentraland

Carreras multijugador con **físicas autoritativas en servidor**: Rapier a paso fijo de 60 Hz
en Node, instantáneas a 30 Hz por WebSocket, e interpolación en el cliente de Decentraland.
El escenario tiene rampas, obstáculos que hay que sobrevolar, barra de carga y una
**carrera por el techo boca abajo**, el truco que Tesla enseñó con el Roadster.

```
shared/    protocolo, constantes y trazado: la única fuente de verdad para ambos lados
server/    simulación autoritativa (Node + Rapier) + banco de pruebas y bots
scene/     cliente Decentraland SDK7: solo dibuja lo que el servidor le dice
```

## Arrancar

```bash
npm run install:all      # instala server/ y scene/
npm run server           # físicas en ws://localhost:8787  (terminal 1, déjala abierta)
npm run scene            # preview en :8000 y abre el explorador de escritorio (terminal 2)
```

`npm run scene` compila, sirve la escena y lanza Decentraland.app solo. Si cierras el
explorador y quieres volver a entrar sin reiniciar la preview:

```bash
open 'decentraland://realm=http%3A%2F%2Flocalhost%3A8000&position=15,3'
```

`15,3` es la parcela de la parrilla. En Windows es `start` en lugar de `open`.

**Contra qué servidor juega la escena.** No hay que tocar nada: `scene/src/config.ts`
pregunta a `getRealm()` si está en preview y elige `LOCAL_SERVER_URL` o
`REMOTE_SERVER_URL`. En preview, el de localhost; publicada, el de CapRover. Solo hay que
editar ese fichero cuando el servidor *remoto* cambie de dominio. La consola del explorador
imprime cuál ha elegido, y el HUD lo muestra en la esquina inferior derecha.

Para **probar el servidor desplegado desde la preview** (la única forma de sentir la
latencia real sin publicar), pon `PREVIEW_AGAINST_REMOTE = true` en ese mismo fichero.

Controles:

| Tecla | Acción |
|---|---|
| **WASD** | conducir (W/S también son morro abajo/arriba en el aire) |
| **W W** | doble toque y mantener: turbo de velocidad, gasta carga |
| **Espacio** | propulsores de gas frío: eleva el coche en vertical, gasta carga rápido |
| **Shift** | freno de mano, para derrapar en curva |
| **E** | tonel asistido en el aire |
| **F** | reaparecer en el último control |

Sonido: el motor eléctrico sube de tono con la velocidad, las ruedas chirrían al frenar en
marcha, el turbo y los propulsores tienen su propio bucle (más agudo boca abajo, que ahí
tiran los chorros de actitud) y una pirueta se lleva una ovación. Los clips no son muestras
grabadas: los sintetiza `python3 tools/make-sounds.py` en `scene/sounds/`, 87 KB en total.

Herramientas de desarrollo, sin explorador de por medio:

```bash
npm run test:features    # 13 escenarios dirigidos: salto, propulsores, techo invertido
npm run harness          # una vuelta completa con piloto automático y telemetría
npm run bot -- 4 60      # 4 clientes headless contra el servidor, con métricas de red
```

## El modelo de tiempo

Esta es la parte que condiciona todo lo demás.

**Servidor.** Avanza la física con `dt` constante (1/60 s) y nunca con el tiempo real del
frame. El bucle corrige deriva: compara los ticks que *deberían* haber pasado contra un
reloj monótono y ejecuta esa diferencia, con un tope de 8 para que un parón no se convierta
en un pico de cien ticks. Cada 2 ticks serializa el mundo y lo difunde.

**Entrada.** El cliente no simula nada, así que no hay nada que reconciliar. Sella cada
muestra de entrada con el tick de servidor al que va destinada, adelantándose medio RTT más
un colchón de 50 ms, y reenvía las últimas muestras en cada paquete. El servidor consume
una por tick de una cola pequeña; si llega tarde, repite la última en vez de cortar el gas,
y devuelve en cada instantánea el último tick consumido para que el cliente ajuste su
adelanto. En pruebas locales la cola nunca se queda vacía (mediana de espera: 0 ticks).

**Render.** El cliente dibuja el instante `relojDelServidor - 100 ms`, deliberadamente en el
pasado: a esa altura ya tiene dos instantáneas que lo rodean, así que **interpola entre dos
estados conocidos** en vez de adivinar. Si una instantánea se pierde, extrapola con la
última velocidad conocida, pero solo 250 ms; pasado eso el mundo se queda quieto en lugar de
irse a un sitio inventado. Los relojes se alinean con ping/pong: el servidor devuelve la
marca de tiempo del propio cliente, así que el RTT no depende de confiar en el reloj ajeno.

## La miniatura

`display.navmapThumbnail` apunta a `images/key-art.png`, el cartel del juego, a 1920 x 1080
como pide Decentraland. Places recorta el cuadrado central de 1080, y ahí caben enteros el
título y el coche; lo que se pierde por los lados es el logo de la esquina y parte del
fondo.

`scene/tools/make-thumbnail.py` sigue en el repo y genera una alternativa isométrica a
partir del trazado real (`images/elon-roadster-race.png`), útil si alguna vez interesa que
la miniatura muestre el circuito que se conduce en lugar de un cartel.

## El coche

El modelo es **"Tesla Roadster"** de [Y M C](https://sketchfab.com/YMCCars), publicado en
[Sketchfab](https://sketchfab.com/3d-models/tesla-roadster-e918af22247d45859696187ce3756baf)
bajo [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/). La licencia exige el crédito
y permite el uso comercial.

Tal como viene no se puede conducir, así que `scene/tools/import-car.py` lo prepara:

- **Quita el decorado**: es una escena de Sketchfab y trae un plano de suelo de 12.8 m.
- **Separa las ruedas**: vienen modeladas por ejes, con los dos lados en las mismas mallas.
  Se cortan por el signo del centro de cada triángulo y cada mitad se recentra en su buje,
  que es lo que permite que giren y se orienten con su propio transform. El eje de giro en
  X sale del neumático y no de la caja englobante del conjunto, porque el disco de freno
  tira del centro hacia dentro y la dirección pivotaría torcida.
- **Escala y asienta**: el modelo mide 4.52 m y su suelo está en y = -0.64; el coche
  simulado mide 4.4 m con el centro del chasis a 0.65 m del punto de contacto.
- **Conserva `doubleSided`**: todos los materiales del original lo llevan, los paneles son
  superficies abiertas, y perder esa bandera es lo que abría agujeros en la carrocería.
- **Enciende las luces**: `Tail_Light` y `Front_Light_Glass` pasan a emisivos.

Ocho libreas (el material `Body` recoloreado) porque un glTF lleva sus materiales dentro y
la escena no puede sobreescribirlos.

## El circuito

512 × 512 m (32 × 32 parcelas), sentido antihorario, **14 curvas**, **12 controles obligatorios**
y 3 vueltas. Vuelta de **1.530 m**, trazado al estilo del Circuit Ricardo Tormo de Cheste:
una recta larga de meta, dos curvas rápidas de entrada y un sector final de curvas enlazadas
que se dobla sobre sí mismo.

**El trazado se genera, no se escribe a mano.** `shared/track.ts` guarda un polígono cerrado
de 14 vértices con el radio de cada uno, y redondea cada vértice con un arco tangente a las
dos rectas que lo alimentan, como se dibuja un circuito de verdad. De ahí salen dos cosas
gratis: la línea de carrera (la que siguen los bots y la que mide la vuelta) y las piezas de
asfalto, que son la misma curva troceada. `fillet()` falla ruidosamente si un radio no cabe
entre sus rectas, así que mover un vértice no puede dejar un circuito roto en silencio.

| | |
|---|---|
| Asfalto | 15 m en recta, 19 m en curva, 128 piezas |
| Radios | de 22 m (T10, la horquilla) a 46 m (T1 y T3, de las de no levantar) |
| Salto | rampa de 15° en la recta de meta, dos pilares que sobrevolar y aterrizaje llano |
| Techo invertido | rampa de 19°, losa de 32 m a 10 m de altura y rampa de bajada |
| Carga | 3 placas repartidas por las rectas largas |
| Edificios | 67, sembrados con ruido determinista fuera de la trazada |

Las **características se reparten solas**: se ordenan las rectas por longitud, la más larga
se queda la parrilla y el salto, y la primera que da para la maniobra del techo se queda el
techo. Cambiar el polígono cambia dónde están, sin tocar nada más.

**Los controles son obligatorios y en orden.** El servidor solo acepta el siguiente de la
secuencia, así que saltarse uno no cuenta la vuelta; el HUD muestra `CP n/12`.

**Edificios.** No son decorado: con 1,5 km de cuerda, dos tramos de la vuelta se acercan
hasta 57 m, y sin nada en medio un coche cruza de uno a otro y se salta medio circuito.
`scatterBuildings()` los siembra con un generador pseudoaleatorio de semilla fija (hace falta
determinismo: servidor y cliente construyen la geometría cada uno por su lado) y descarta
cualquiera que invada la trazada.

El truco del Roadster está en la recta larga del este y funciona así: al entrar en la zona de
inversión en el aire, el servidor ejecuta un giro guiado de 180° sobre el eje longitudinal y
pone la escala de gravedad del coche a **−1**. Las ruedas del vehículo de Rapier trazan
rayos siguiendo el *eje «abajo» local del chasis*, así que boca abajo encuentran el techo
sin ningún caso especial: el coche conduce pegado a la cara inferior de la losa, acelerando,
y la sigue cuando esa losa desciende. Al salir de la zona la gravedad vuelve a +1 y un giro
de recuperación lo deja de pie para aterrizar.

Traza real de la maniobra (tick a tick, `up.y` es la vertical del coche):

```
 t=0.75  z=181.8 y=1.7  up.y= 0.92  wheels=4   ← sube la rampa
 t=1.25  z=198.5 y=7.6  up.y= 0.80  wheels=0   ← en el aire, empieza el tonel
 t=1.50  z=205.6 y=8.8  up.y=-0.97  wheels=2   ← ya está boca abajo, tocando losa
 t=2.00  z=221.8 y=9.2  up.y=-1.00  wheels=4   ← 4 ruedas en el techo, 40 m/s
 t=2.50  z=241.2 y=6.2  up.y=-0.97  wheels=2   ← la losa baja y el coche la sigue
 t=3.00  z=259.9 y=2.3  up.y= 0.97  wheels=0   ← fuera de la zona, giro de recuperación
 t=3.25  z=268.8 y=0.7  up.y= 1.00  wheels=4   ← aterriza sobre las ruedas
```

### Propulsores y auto-enderezada

Dos ayudas que cambian mucho el tacto:

- **Propulsores (espacio)**: empuje recto hacia arriba en el eje del mundo, 2,2 g netos,
  suficiente para levantar el coche desde parado. Sirven para alargar un salto, corregir
  una caída o salir de un sitio malo. Gastan carga más rápido que el turbo.
- **Auto-enderezada**: en el aire y sin tocar nada, el coche rota solo hacia la posición
  normal, así que un despegue mal dado no condena a caer de techo. Se desactiva mientras
  el jugador dirige en el aire (puede querer el tonel), durante los trucos guiados y en la
  carrera invertida, donde ir boca abajo es justo lo que toca.

### Por qué no hay loop de 360°

Lo intenté y es **geométricamente imposible** como superficie continua. En un loop plano las
ramas ascendente y descendente son tangentes en la base: un coche que llega por la carretera
se sube por la que debería bajar y da vueltas para siempre. Y cualquier rampa de acceso que
llegue a la entrada cruza la rama descendente exactamente una vez, porque ambas recorren el
mismo tramo en sentidos opuestos, independientemente de cómo inclines el loop. Los loops
reales de acrobacias son helicoidales; un sacacorchos sí funciona, pero necesita orientar
cada segmento con una base de Frenet (los ángulos de Euler no bastan) más 10 m de
desplazamiento lateral para no cruzarse consigo mismo, y entonces el acceso ya no encaja con
la recta. Está documentado en `shared/track.ts` por si quieres retomarlo; el momento «boca
abajo» lo da el techo invertido, que además es el truco que pediste.

## Salas

Hay **una sala multijugador**, compartida por todos: es la carrera que se puede mirar y lo
único que está sincronizado entre jugadores. Quien elige SOLO se lleva **una sala propia**,
con su mundo de físicas aparte, así que sus bots y sus reinicios no son asunto de nadie
más, y empezar una carrera en solitario nunca espera ni interrumpe a la sala compartida.

Cambiar de modo es **mudarse de sala**, no un ajuste: la conexión sale de una y entra en la
otra, y recibe un `welcome` nuevo con otro id. Antes el modo era una propiedad de la única
sala que había, de forma que un jugador se lo cambiaba a todos.

Por eso el número de tick lo reparte el bucle en vez de contarlo cada sala: el cliente
estampa sus entradas contra el *reloj* (`relojDelServidor / TICK_MS`), así que una sala
recién creada que empezara a contar en cero vería todas esas entradas decenas de miles de
ticks en el futuro y las tiraría.

`GET /health` informa de `rooms` además de `players`.

## Motor de físicas

Rapier (`@dimforge/rapier3d-compat`) con su `DynamicRayCastVehicleController`. La costura con
el motor está en `server/src/physics/types.ts`: una interfaz pequeña (chasis, ruedas,
fuerzas) que `rapier.ts` implementa y detrás de la cual cabe un backend de cannon-es sin
tocar `car-sim.ts` ni `room.ts`.

**Rapier no puede correr en el cliente.** El runtime de escenas de Decentraland es QuickJS
sin WebAssembly, y `rapier3d-compat` es WASM. Esa restricción es la que empuja a físicas en
servidor, que de todos modos es lo que quieres para competir.

Tres trampas que costaron depuración y están documentadas en el código:

1. **`RigidBodyDesc.setAdditionalMassProperties` se ignora** en silencio (0.14): el cuerpo
   queda con masa 0 y masa inversa 0, así que las fuerzas no hacen nada. La masa va en el
   collider con `ColliderDesc.setMassProperties`.
2. **`RigidBody.addForce` es persistente** entre pasos, no se limpia cada tick. Llamarlo una
   vez por tick lo integra: la carga aerodinámica crecía hasta cientos de kN, aplastaba la
   suspensión y frenaba el coche en seco. Las fuerzas por tick se aplican como impulsos
   (`fuerza × dt`), exacto con paso fijo.
3. **`maxSuspensionTravel` corto** (0,18 m) clava el muelle contra el tope en cada bache y
   el controlador inyecta energía: el coche salía disparado en recta llana.

## Qué está verificado y qué no

Verificado automáticamente:

- **Física**: 18/18 escenarios dirigidos (`npm run test:features`) cubriendo los dos saltos,
  los propulsores, la auto-enderezada y la carrera invertida, con velocidades de entrada de
  14 a 30 m/s. La prueba del techo exige además **aterrizar sobre las ruedas**.
- **Vuelta completa**: el piloto automático del banco de pruebas da 3 vueltas enteras
  pasando por los 8 controles, incluido el techo invertido.
- **Rendimiento**: 0,06 ms por tick y coche. Un tick de 8 coches ocupa ~3 % de un núcleo.
- **Bucle del servidor**: 0 ticks perdidos en sesiones de minutos.
- **Red**: 1000 instantáneas en 50 s por cliente (20 Hz exactos), separación media 50,0 ms,
  espera de entrada mediana 0 ticks, 4 clientes simultáneos.
- **Escena**: compila y pasa el typecheck con el toolchain real; el explorador de escritorio
  de Decentraland la carga, se conecta por WebSocket, entra en la sala, envía entradas y
  recibe instantáneas, sin ningún error de JS en su log.

No verificado, hace falta alguien delante del explorador:

- Que **pulsar WASD** produzca bits de entrada mientras `InputModifier` tiene desactivado el
  movimiento del avatar. Es el uso documentado de ese componente y es exactamente para esto.
  Si alguna tecla no respondiera, la alternativa es desactivar solo
  `disableWalk/disableJog/disableRun` en `scene/src/camera.ts` en vez de `disableAll`.
- El aspecto visual y el tacto de la cámara.

(El explorador web de Bevy, en `decentraland.zone/bevy-web`, carga pero no puede alcanzar un
realm de previsualización local: Chrome bloquea las peticiones de una página pública HTTPS
hacia la red privada, y el build WASM necesita aislamiento COOP/COEP, que exige cabeceras
que el servidor de previsualización no envía. Para pulsar teclas hay que usar el cliente de
escritorio, que sí carga la escena sin problemas.)

El piloto automático en red (`npm run bot`) conduce desde instantáneas de 120 ms de
antigüedad, lo que a 22 m/s son casi 4 m de retraso de dirección, así que va bastante peor
que el del banco de pruebas offline. Es una limitación de ese piloto, no del juego.

## Decisiones que conviene conocer

- **Sin conversión de sistema de coordenadas.** Decentraland es zurdo y Rapier diestro, pero
  sus matrices de rotación son numéricamente idénticas para el mismo cuaternión y el mismo
  orden de Euler, y el mundo se define una sola vez en un espacio numérico común. Posiciones
  y cuaterniones viajan sin convertir. `shared/math.ts` incluye un port exacto de
  `Quaternion.fromEulerDegrees` de Decentraland para que el collider que simula el servidor y
  la caja que dibuja el cliente coincidan siempre.
- **JSON, no binario.** El runtime de escenas solo expone `WebSocket.send(string)`. El estado
  de los coches viaja como array de números de formato fijo con los flotantes redondeados;
  el resto son objetos legibles.
- **Curvas planas y sin quitamiedos.** Un arco ancho peraltado no se puede aproximar con
  cajas: cada caja se peralta sobre su propio eje y dos segmentos vecinos discrepan más de
  10 cm en altura a 9 m del centro, con esquinas que enganchan el chasis. Las barreras de
  arco tienen el mismo problema en cada junta. Salirse se resuelve con curvas más anchas,
  reaparición, y edificios y muros rectos que sí son cajas sin juntas problemáticas.
- **El avatar no se mueve con el coche.** Teletransportarlo a 30 Hz se ve como un tartamudeo;
  la cámara virtual enganchada al coche es lo que vende la conducción.

## Despliegue

Son dos despliegues independientes: el servidor a un VPS y la escena a un World. La escena
desplegada necesita una URL `wss://` porque los navegadores rechazan `ws://` desde una página
HTTPS y el explorador no es excepción. El permiso `USE_WEBSOCKET` ya está en `scene.json`.

### 1. El servidor, en CapRover

`Dockerfile` y `captain-definition` están en la raíz del repo, no en `server/`, porque el
servidor importa `shared/` y el contexto de build tiene que incluir ambos. La imagen compila
en dos etapas: la primera comprueba tipos y empaqueta todo en un único ESM con esbuild, la
segunda instala solo `ws` y Rapier. Al contenedor no llega ni el compilador ni el código
fuente; pesa unos 140 MB.

1. Crea la app en CapRover (por ejemplo `roadster-server`). No necesita volumen persistente:
   el estado de la carrera vive en memoria y se reconstruye en cada arranque.
2. En **App Configs → HTTP Settings**:
   - **Container HTTP Port: `8787`** (es el `EXPOSE`/`PORT` de la imagen).
   - **Enable HTTPS** y **Force HTTPS**, que es lo que convierte la URL en `wss://`.
   - **Websocket Support: ON**. Sin esto NGINX no reenvía las cabeceras `Upgrade` y la
     conexión muere con un 400 antes de llegar al servidor.
   - **Instance Count: 1**, y no lo subas. La simulación es autoritativa y está en memoria:
     dos instancias son dos carreras distintas detrás de la misma URL, y el balanceador
     repartiría a los jugadores entre ellas.
3. Despliega desde la raíz del repo. La imagen la construye el servidor de CapRover, así
   que aquí no hace falta Docker:

   ```bash
   caprover login                 # una vez: URL de la máquina y contraseña
   npm run pack:server            # deja caprover.tar en la raíz
   caprover deploy -a roadster-server -t caprover.tar
   ```

   `caprover deploy -b <rama>` es la otra vía, pero necesita que esto sea un repositorio git
   con remoto; mientras no lo sea, el tarball es el camino.
4. Comprueba que vive: `curl https://roadster-server.TU-DOMINIO/health` devuelve
   `{"ok":true,"engine":"rapier3d","players":0,"tick":…}`. El `HEALTHCHECK` de la imagen pega
   a ese mismo endpoint cada 30 s y Swarm reinicia el contenedor si deja de responder.
5. Apunta la escena ahí: `scene/src/config.ts` → `wss://roadster-server.TU-DOMINIO`, y vuelve
   a publicar la escena.

Lo que conviene saber antes de abrirlo al público: no hay autenticación, cualquiera con la
URL entra, y la sala admite `RACE.maxPlayers` (8) a la vez. El tráfico nunca está ocioso
—20 instantáneas por segundo por jugador— así que los timeouts de NGINX no cortan nada.
`caprover logs -a roadster-server` enseña las uniones, salidas y ticks perdidos.

### 2. La escena, en un World

Ocupa 1024 parcelas (32 x 32, 512 x 512 m), así que el destino es un **World**: en Genesis
City no hay un bloque libre de ese tamaño, y un World no limita el número de parcelas.
`scene.json` ya lleva `worldConfiguration: { "name": "lowpol.dcl.eth" }` y el bloque
`0,0 → 31,31`, que contiene el `0,0` por el que entra el mundo.

```bash
cd scene
npm run deploy -- --multi-scene --target-content https://worlds-content-server.decentraland.org
```

**Hay 5 minutos para firmar.** El reloj arranca cuando el CLI crea la entidad, antes de
abrir la pestaña de firma, y el servidor rechaza la subida entera con
`Deployment was created N secs ago. Max allowed: 300 secs`. Como el empaquetado se come parte
de esa ventana, conviene construir antes y desplegar con `--skip-build`.

**`--multi-scene` evita el borrado, pero hoy no sirve para tener dos escenas a la vez.** Sin
el flag, el CLI borra las demás escenas del World aunque las coordenadas no se solapen. Con
el flag no borra nada: `GET /world/<nombre>/scenes` sigue listando todas como `DEPLOYED`.
Pero el explorador no lee esa lista, lee `/about`, y en `worlds-content-server`
`getMetadataForWorld()` pide las escenas con `{ limit: 1, orderBy: CreatedAt, desc }` y
`extractWorldRuntimeMetadata()` devuelve `entityIds: [entity.id]`: **un World sirve solo la
última escena desplegada**. Las demás quedan guardadas y se pueden recuperar redesplegándolas,
pero no conviven.

**El spawn del World es un ajuste del servidor, no del `scene.json`.** Un World te deja en su
`spawnCoordinates`, que por defecto es `0,0`; si el bloque de parcelas no contiene esa
parcela, apareces en el vacío y no se carga ninguna escena. Por eso el bloque empieza en
`0,0` en vez de donde cuadre: una vez dentro de la escena, ya mandan los `spawnPoints` del
`scene.json` y apareces en la parrilla. La alternativa es cambiar el spawn del World con un
`PUT /world/<nombre>/settings` firmado desde sus ajustes.
