# PS Launcher

Launcher estilo PS4 para Windows. Detecta juegos de Steam (todas las bibliotecas y discos) y Epic,
y permite añadir cualquier .exe con portada automática.

- `npm install` y `npm start` para probar. `npm run dist` genera **`dist/PS-Launcher.exe`**: un único .exe portable, sin instalador. Cópialo donde quieras y ábrelo.
- Atajo global: Ctrl+Alt+P. Teclado: flechas, Enter, **S (buscar juegos nuevos)**, C (portada), P (mejorar portadas), L (diseño PS4/centrado), Supr (quitar), F (contador de fps), Esc.
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
- **F** muestra los fps, el modo gráfico y el estado de la GPU (para diagnosticar lentitud).

## Rendimiento (60 fps)
- Antes se forzaba la GPU dedicada; en portátiles con dos GPU eso puede dejar la interfaz a ~20 fps. Ahora arranca con los valores por defecto
  y **la primera vez el launcher mide sus fps** moviendo la selección ~3 s ("Optimizando gráficos…"). Si no llega a ~52 fps prueba solo otro modo
  (integrada, OpenGL, sin GPU, dedicada), se reinicia y se queda con el mejor. El resultado se guarda en `config.json` (`gpuMode`, `tune`).
- **Ajustes > Gráficos > Optimizar** repite la prueba (por ejemplo, tras cambiar de GPU o de drivers).
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
al moverte, vuelve el fondo de cintas. **Ajustes > Difuminado de la portada** regula cuánto se difumina (0 = nítida); mientras movés la barra
se ve la portada del juego elegido para comparar.

## Tipo de fondo (Ajustes > Fondo)
- **Fondo clásico**: las cintas de seda de siempre.
- **Fondo original PS3**: recreación del fondo del XMB: degradado en diagonal, una ola fina de muchas hebras que se retuercen
  y destellos que titilan. Morado en el diseño PS3 y azul en PS4/Centrado; también sigue el **Color del fondo** (color elegido o arcoíris).
  Se dibuja a 60 % de resolución (las hebras son finas) y a 30 fps, y se detiene igual que el clásico.
- **Subir video**: elegís un video (mp4, webm, mkv, mov, m4v); se copia a la carpeta de datos (`bgvideo\`, solo se guarda el último)
  y se reproduce sin sonido y en bucle. Se pausa con la portada de fondo, esperando un juego, con el launcher oculto o pausado.
  Si cancelás el diálogo se vuelve al último video subido. Si el formato no se puede reproducir, vuelve al fondo clásico.
- Con **Fondo animado: No** siempre se ve un color liso, elijas el tipo que elijas.

## Botones de la ayuda (Ajustes > Botones de la ayuda)
La ayuda de arriba dibuja cada botón: **círculo** para los de cara (✕ ○ □ △ / A B X Y), **píldora** para L1, RB, ZL… y **tecla** para el teclado.
- **Minimalista**: contorno blanco.
- **Colores**: como el mando detectado. Xbox con A verde, B roja, X azul, Y amarilla; PlayStation con los símbolos de color sobre negro;
  Nintendo y genéricos en oscuro; las teclas en claro.

## Mejorar portadas (tecla P / LT · L2 · ZL)
Revisa todas las portadas y, las que se ven mal (faltan, son chicas, o son apaisadas como la cabecera de Steam o el icono del .exe),
las busca en internet en formato vertical 600x900: Steam (por appid), SteamGridDB (si hay clave en Ajustes) y la tienda de Steam
si el nombre coincide exactamente. Solo reemplaza si la nueva es mejor, y nunca toca las portadas que elegiste a mano con **C**.

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
