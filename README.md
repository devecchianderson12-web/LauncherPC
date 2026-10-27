# PS Launcher

Launcher estilo PS4 para Windows. Detecta juegos de Steam (todas las bibliotecas y discos) y Epic,
y permite añadir cualquier .exe con portada automática.

- `npm install` y `npm start` para probar. `npm run dist` genera **`dist/PS-Launcher.exe`**: un único .exe portable, sin instalador. Cópialo donde quieras y ábrelo.
- Atajo global: Ctrl+Alt+P. Teclado: flechas, Enter, **S (buscar juegos nuevos)**, C (portada), P (portada en HD), L (diseño PS4/centrado), Supr (quitar), F (contador de fps), Esc.
- **Mando (Xbox, PlayStation, Nintendo y cualquier mando estándar)**: se detecta solo y la ayuda de arriba muestra los botones del último
  dispositivo que uses (✕ ○ □ △ / L1 R1 en PlayStation, A B X Y / LB RB en Xbox, A B X Y / L R en Nintendo, donde A es el botón derecho).
  Aceptar jugar, atrás cerrar, cuadrado/X quitar, triángulo/Y portada, L1/LB buscar juegos, R1/RB cambia de diseño; cruceta o stick izquierdo para moverte.
  Dentro de **Ajustes** también se maneja con el mando (cruceta para moverte, aceptar pulsa, atrás cierra).
  Los mandos DirectInput genéricos (o PlayStation/8BitDo en modo D) también vienen predefinidos (□ ✕ ○ △ L1 R1 L2 R2, cruceta en el eje 9)
  y la ayuda muestra el nombre real de cada botón, también si lo configuraste a mano.
  Si un mando raro no encaja: **Ajustes > Configurar botones** te pide cada botón y lo guarda para ese mando (**Restablecer** lo borra).
- **L1 + R1 + L2 + R2 a la vez** (LB RB LT RT en Xbox, L R ZL ZR en Nintendo): abre/oculta el launcher como Ctrl+Alt+P, **también con un juego delante**.
  Lo lee el ayudante de Windows (XInput + winmm); cada 3 s busca mandos y solo lee mientras haya alguno conectado.
  Con el launcher delante, L1/R1/L2 esperan 180 ms antes de actuar para no disparar sus acciones al hacer la combinación.
- Estadísticas arriba a la derecha: CPU/RAM del sistema; GPU NVIDIA con nvidia-smi.
  (Uso/temperatura de GPU AMD/Intel: LibreHardwareMonitor con Options > "Remote Web Server" > Run, puerto 8085.)
- **F** muestra los fps, el modo gráfico, el estado de la GPU y **qué dibuja el fondo** (la GPU real o software) y a qué resolución (para diagnosticar lentitud).

## Rendimiento (60 fps)
- **La GPU dibuja dentro del proceso principal** (`in-process-gpu`). Electron normalmente dibuja desde un proceso aparte; el driver de
  NVIDIA lo trata como una app en segundo plano y, con "Velocidad máxima de fotogramas de aplicación en segundo plano" activada, lo
  limita. Medido en una GTX 1660 Super con monitor de 200 Hz: **20 fps** con el proceso aparte, **200 fps** dentro (y 156 sin GPU).
  Por eso antes la optimización terminaba eligiendo "sin GPU". La 1.13.0 repite la prueba una vez.
- Antes se forzaba la GPU dedicada; en portátiles con dos GPU eso puede dejar la interfaz a ~20 fps. Ahora arranca con los valores por defecto
  y **la primera vez el launcher mide sus fps** moviendo la selección ~3 s ("Optimizando gráficos…"). Si no llega a ~85 % de la frecuencia
  del monitor (tope 52 fps) prueba solo otro modo (integrada, OpenGL, dedicada), se reinicia y se queda con el mejor. El resultado se guarda
  en `config.json` (`gpuMode`, `tune`).
- **"soft" (sin GPU) es el último recurso**: solo se elige si ningún modo con GPU llega a 20 fps. Sin GPU el contador de fps no está atado
  al monitor y da números altísimos, así que antes podía "ganarle" a la GPU y dejar todo borroso y lento.
- Hasta la 1.10.0 la prueba daba por fallado cada modo nuevo **sin medirlo** (marcaba "pendiente" antes de reiniciar y el arranque
  siguiente lo leía como un cuelgue), así que casi siempre terminaba en "gl" o "soft". Ahora "pendiente" se marca al arrancar el modo
  y se borra cuando la interfaz carga. Al actualizar, la prueba se repite una vez desde el modo normal.
- **Ajustes > Gráficos > Optimizar** repite la prueba (por ejemplo, tras cambiar de GPU o de drivers). Arranca siempre por el modo normal.
- El fondo se dibuja con un shader a baja resolución y 30 fps, y se detiene con el fondo de portada, esperando un juego, con el launcher oculto o pausado.

## Biblioteca guardada
**No hay ningún escaneo automático**: ni al iniciar ni al abrir el launcher. Solo se lee `library.json` (carpeta de datos de la app,
`%APPDATA%\ps-launcher`), donde se guarda la ruta de inicio y la portada de cada juego. Las portadas están en `covers\`.
Pulsa **S** (o LB en el mando) para buscar juegos nuevos: ahí se escanea Steam/Epic y se descargan las portadas que falten
(también las de los juegos que añadas con **+** o desde una carpeta). La primera vez, pulsa S.

## Diseños: PS4, Centrado y PS3
La tecla **L** (o R1/RB en el mando) va rotando entre los tres, y también se elige en **Ajustes > Diseño**.
- **PS3 (XMB)**: fondo morado con las cintas de seda; categorías en horizontal (**Juegos**, **Recientes**, **Herramientas** con Añadir y Buscar juegos,
  y **Ajustes**) y la lista de la categoría elegida en vertical. **Izquierda/derecha** cambia de categoría y **arriba/abajo** de elemento (también con la
  cruceta, el stick o la rueda del ratón). Recientes se ordena por último jugado y las categorías vacías no se muestran. Cada categoría recuerda en qué fila
  te quedaste. El fondo con la portada difuminada no se usa en este diseño.

## Pausa automática con otro programa en primer plano
Mientras otro programa está delante (un juego, el navegador, lo que sea) el launcher queda **pausado**: la ventana sigue detrás con su
último fotograma, pero sin fondo animado, sin lectura del mando, sin reloj, sin estadísticas (ni nvidia-smi ni LibreHardwareMonitor)
y con los procesos de interfaz/GPU en prioridad mínima. Cuando el programa se cierra, el launcher **ya está ahí** y se reanuda tal cual
estaba, sin repetir la animación de entrada. Con **Ctrl+Alt+P** (o abriendo el .exe otra vez) lo traes al frente aunque haya algo delante.
- Al iniciar un juego, el launcher muestra "Iniciando…" y se pausa solo en cuanto otro programa pasa al primer plano. Puedes cancelar con
  **Esc** / B; si en 2 min no aparece nada, vuelve a la normalidad.
- Un único PowerShell dura toda la sesión y avisa del cambio de ventana **por eventos de Windows** (no sondea). Si ese ayudante falla,
  el launcher nunca se queda congelado: se reanuda y el ayudante se reinicia solo.
- Si ocultas el launcher a propósito (Esc), no se pausa ni reaparece por su cuenta: solo vuelve con el atajo, la bandeja o el .exe.
- Lo que sigue en memoria mientras está pausado es la propia ventana (RAM); no consume CPU ni GPU. Cerrar el proceso del todo lo evitaría,
  pero entonces la vuelta no sería instantánea.

## Barra de tareas siempre oculta
Mientras el launcher está en pantalla (incluso pausado) la barra de tareas de Windows se **oculta del todo** (también en otros monitores),
así que no asoma nunca. Al ocultar el launcher con Esc, o al cerrarlo, la barra vuelve. Se restaura siempre: al salir, al reiniciar por
la optimización de gráficos y también si el launcher se cierra a la fuerza (el ayudante lo detecta y la devuelve).
- **Ajustes > Ocultar barra de tareas Sí/No** (por defecto Sí).
- Como el icono de la bandeja queda inaccesible con la barra oculta, **Ajustes > Salir** cierra el launcher por completo.
- La tecla Windows sigue abriendo el menú Inicio (se vuelve a ocultar la barra al cerrarlo).
- Al abrir un programa, el Explorador de Windows intenta volver a mostrar la barra. El ayudante la oculta de nuevo en el acto (escucha el evento
  de "ventana mostrada" de explorer.exe, sin sondear), hace una ráfaga de comprobaciones tras cada cambio de ventana y mantiene un
  temporizador de seguridad de 2 s. Puede quedar un parpadeo de milisegundos; es el límite de ocultar la barra desde fuera de Windows.

## Fondo con la portada
Si un juego o aplicación queda seleccionado **1 segundo**, su portada aparece difuminada de fondo (con fundido suave);
al moverte, vuelve el fondo de cintas. (Su difuminado es fijo; el ajuste de difuminado ahora es del fondo animado, ver abajo.)

## Cambiar portada: explorador propio (C / △ / Y)
En vez del diálogo chico de Windows se abre un explorador **a pantalla completa con cuadros grandes** (miniatura de cada imagen), pensado para verse de lejos.
- Arriba, lugares rápidos: **Carpeta del juego**, Imágenes, Descargas, Escritorio, Documentos, los discos y **Explorador de Windows…** (el diálogo clásico, por si hace falta).
  Abre en la última carpeta usada.
- **Teclado**: flechas, Enter elige/abre, Retroceso sube de carpeta, Esc cierra, RePág/AvPág, Inicio/Fin.
- **Mouse**: clic elige/abre, rueda para desplazarse, clic derecho = atrás.
- **Mando**: cruceta/stick, aceptar elige/abre, atrás sube de carpeta (en la raíz cierra), △/Y cierra, L1/R1 pasan de página.
- Desde la primera fila, arriba pasa a los lugares rápidos. Las miniaturas salen de la caché de Windows y solo se piden las que entran en pantalla (4 a la vez).
- Si la imagen que elegís llega a 600x900, se guarda también en HD y **Portada en HD** (P) ya no la muestra como baja.

## Tipo de fondo (Ajustes > Fondo)
- **Fondo clásico**: las cintas de seda de siempre.
- **Fondo original PS3**, con **Ajustes > Fondo PS3**:
  - **Alta definición** (por defecto): la ola del XMB **dibujada en la GPU** a la resolución de la pantalla, calcada del video
    (fondo azul más oscuro y violáceo arriba, cinta translúcida con el borde de arriba como línea fina y brillante, pliegues, bokeh
    a la izquierda y polvo fino). Nítida en 1080p o más; sigue el color elegido y el arcoíris.
  - **Video original**: el video de abajo.
- El **video original de la ola del XMB** (`assets/xmb-wave.mp4`, 1080p, 16 s en bucle, sin sonido) viene
  dentro del .exe (fuera del .asar, ver `asarUnpack` en `package.json`). El video es un 720p estirado y muy comprimido (~1 Mbit/s),
  así que el shader lo **mejora** en la GPU: realza los bordes donde hay detalle (la ola, los pliegues, los destellos) y suaviza los
  bloques del fondo liso. Cada cuadro se sube a una textura y el shader lo **tiñe**:
  con **Color del fondo: Original** se ve tal cual (azul); con un color elegido o **Arcoíris** se cambia solo el tono (HSV), así el
  fondo toma el color y la ola sigue blanca. El video solo se reproduce mientras ese fondo se ve. Si no se puede leer, se usa la ola
  dibujada por el shader (láminas translúcidas, como antes).
  ⚠️ El video es material de Sony: queda incluido en el repositorio y en cada release (decisión del dueño del proyecto).
- **Ajustes > Difuminado del fondo** (0–100 %, por defecto 0): difumina todo el fondo animado (cintas, ola PS3, video) con un filtro
  de la GPU; el fondo se agranda apenas para que los bordes no queden oscuros.
- **Ajustes > Nitidez del fondo** (25–100 %, por defecto **100 %** = resolución de la pantalla): a qué resolución se dibuja el fondo
  animado (clásico y PS3). Si con 100 % se traba, se baja con − / + (de a 10). La tecla F muestra la resolución y la nitidez.
- **Subir video**: elegís un video (mp4, webm, mkv, mov, m4v); se copia a la carpeta de datos (`bgvideo\`, solo se guarda el último)
  y se reproduce sin sonido y en bucle. Se pausa con la portada de fondo, esperando un juego, con el launcher oculto o pausado.
  Si cancelás el diálogo se vuelve al último video subido. Si el formato no se puede reproducir, vuelve al fondo clásico.
- Con **Fondo animado: No** siempre se ve un color liso, elijas el tipo que elijas.

## Botones de la ayuda (Ajustes > Botones de la ayuda)
La ayuda de arriba dibuja cada botón: **círculo** para los de cara (✕ ○ □ △ / A B X Y), **píldora** para L1, RB, ZL… y **tecla** para el teclado.
- **Minimalista**: contorno blanco.
- **Colores**: como el mando detectado. Xbox con A verde, B roja, X azul, Y amarilla; PlayStation con los símbolos de color sobre negro;
  Nintendo y genéricos en oscuro; las teclas en claro.

## Portada en HD (tecla P / LT · L2 · ZL)
Sobre el juego seleccionado abre una **ventana mediana con bordes redondeados** (el launcher se ve detrás) con **hasta 50 portadas
de 600x900 o más** (nunca menos: 600 de ancho y 900 de alto como mínimo), en una cuadrícula de 5 columnas con scroll, con su resolución
y de dónde salen. Una portada actual por debajo de 600x900 cuenta como "baja". Solo busca para ese juego.
- **Flechas / cruceta**: izquierda-derecha de a una, arriba-abajo de a una fila (la cuadrícula se desplaza sola) · **Aceptar / Enter / clic**:
  aplica la marcada · **C / X·□ del mando / "buscar en mi PC"**: abre el explorador de portadas (el de la tecla C) para elegir una imagen
  propia · **Atrás / Esc / clic derecho / clic fuera**: cierra.
- Fuentes, en orden: portada vertical de Steam (600x900), arte principal de Steam (3840x1240), portadas y banners de **SteamGridDB**
  (con clave en Ajustes: es donde hay decenas de opciones por juego, también de juegos que no están en Steam), todas las capturas de
  Steam (1920x1080) e **imágenes grandes de la propia carpeta del juego** (primero las que se llaman cover, portada, poster, banner…).
  Sin clave de SteamGridDB suelen salir entre 5 y 15 (lo que tenga Steam).
- Se muestran **miniaturas**; el **tamaño real** de cada imagen se lee de su cabecera (los primeros KB, sin bajarla entera) y lo que no
  llega a 600x900 se descarta. La imagen completa se baja recién al elegirla y se vuelve a comprobar el tamaño.
  Ojo: en el CDN de Steam `library_600x900.jpg` mide 300x450; la de 600x900 es `library_600x900_2x.jpg` (también se usa primero para las
  portadas automáticas).
- **Google**: su API oficial de imágenes (Programmable Search / Custom Search JSON API) ya no acepta clientes nuevos y se apaga el
  1/1/2027, y leer la página de Google Imágenes va contra sus términos (y pide captcha), así que no hay opciones de Google.
- Si no hay ninguna, aceptar abre el explorador de portadas (**buscar en mi PC**).
- **Juegos sueltos** (portables, instalados a mano, carpetas importadas): primero se busca su **appid de Steam en la propia carpeta**
  (`steam_appid.txt`, `CPY.ini`, `steam_emu.ini`, `OnlineFix.ini`… con `AppID=`), que sirve aunque el juego ya no esté a la venta.
  Si no hay, se usa el nombre de producto guardado en el .exe
  ("PES2021.exe" → "eFootball PES 2021") y los nombres del .exe y sus carpetas limpios (sin "Play", "Launcher", "SteamRIP.com", versiones…),
  con búsqueda aproximada en Steam ("III" = 3, los números tienen que coincidir). Lo mismo vale para las portadas normales.
  Los juegos que **no están o ya no están en Steam** (God of War III, PES 2021 retirado de la tienda…) solo aparecen en **SteamGridDB**:
  hace falta una clave gratis (steamgriddb.com → Preferences → API, y pegarla en Ajustes).
- El original HD se guarda en `covers\hd\` y la baldosa usa una copia de hasta 1000x1500 (más liviana para la GPU).
  Si elegís una imagen HD propia con **C**, también se guarda así.
## Ajustes
- Diseño PS4 / Centrado.
- **Iniciar con Windows Sí/No**: registra el .exe actual en el inicio de Windows (se vuelve a registrar solo si lo mueves de carpeta).
- **Iniciar minimizado Sí/No**: al arrancar con Windows queda en la bandeja y se abre con Ctrl+Alt+P. Un doble clic normal siempre lo muestra.
- **Juegos desde una carpeta**: (la lista de carpetas añadidas aparece debajo, cada una con **Quitar**, que borra sus juegos y portadas)
   elige un directorio y cada .exe (hasta 3 subcarpetas) se añade como juego. Se omiten desinstaladores, redistribuibles,
  crash handlers y similares, y lo que ya estaba en la lista. Portada: imagen `cover`/`portada`/`poster`/`folder` junto al .exe → SteamGridDB (si hay clave)
  → portada de Steam si el nombre coincide exactamente → icono del .exe.
- **Actualizaciones**: el launcher mira la última *release* de GitHub unos segundos después de abrir y cada 6 h. Si hay una versión mayor
  aparece una tarjeta pequeña abajo a la derecha (**Actualizar** / **Ahora no**; una vez por versión). En Ajustes siempre se ve la versión y
  hay un botón **Buscar actualizaciones**. Al actualizar descarga el .exe junto al actual, se cierra, lo reemplaza y abre el nuevo.
  Configura `updateRepo` en `package.json` (`usuario/repositorio`). Para publicar una versión: sube `version` en `package.json` y haz push a `main`;
  el workflow compila y crea/actualiza la release `v<version>` con `PS-Launcher.exe`.
- **Fondo animado Sí/No**: cintas de seda estilo XMB de PS3; en "No" se quita el fondo (color liso, menos GPU).
- **Color del fondo**: *Original* (azul en PS4/Centrado, morado en PS3), *Color* (8 colores rápidos o cualquiera con el selector) o *Arcoíris*,
  que recorre todos los colores de forma suave; la barra **Velocidad** va de ~90 s por vuelta a ~6 s (con el mando, − y +). Se guarda y también
  funciona con "Fondo animado: No" (color liso).
- Al cambiar de diseño (**L** / botón del mando / Ajustes) todo se anima: PS4 ↔ Centrado las baldosas y el marco viajan a su nueva posición;
  con PS3 el diseño anterior sale y el nuevo entra escalonado. En el XMB, al pasar de Juegos a Recientes a Herramientas… las categorías se deslizan
  y la lista anterior sale hacia un lado mientras entra la nueva.
- Clave de SteamGridDB para portadas de juegos que no son de Steam.
