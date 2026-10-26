# PS Launcher

Launcher estilo PS4 para Windows. Detecta juegos de Steam (todas las bibliotecas y discos) y Epic,
y permite añadir cualquier .exe con portada automática.

- `npm install` y `npm start` para probar. `npm run dist` genera **`dist/PS-Launcher.exe`**: un único .exe portable, sin instalador. Cópialo donde quieras y ábrelo.
- Atajo global: Ctrl+Alt+P. Teclado: flechas, Enter, **S (buscar juegos nuevos)**, C (portada), L (diseño PS4/centrado), Supr (quitar), F (contador de fps), Esc.
- **Mando (Xbox, PlayStation, Nintendo y cualquier mando estándar)**: se detecta solo y la ayuda de arriba muestra los botones del último
  dispositivo que uses (✕ ○ □ △ / L1 R1 en PlayStation, A B X Y / LB RB en Xbox, A B X Y / L R en Nintendo, donde A es el botón derecho).
  Aceptar jugar, atrás cerrar, cuadrado/X quitar, triángulo/Y portada, L1/LB buscar juegos, R1/RB cambia de diseño; cruceta o stick izquierdo para moverte.
  Dentro de **Ajustes** también se maneja con el mando (cruceta para moverte, aceptar pulsa, atrás cierra).
  Con un mando que no sea estándar: **Ajustes > Configurar botones** te pide cada botón y lo guarda para ese mando (**Restablecer** lo borra).
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
Si un juego o aplicación queda seleccionado más de **3 segundos**, su portada aparece difuminada de fondo (con fundido suave);
al moverte, vuelve el fondo de cintas.

## Ajustes
- Diseño PS4 / Centrado.
- **Iniciar con Windows Sí/No**: registra el .exe actual en el inicio de Windows (se vuelve a registrar solo si lo mueves de carpeta).
- **Iniciar minimizado Sí/No**: al arrancar con Windows queda en la bandeja y se abre con Ctrl+Alt+P. Un doble clic normal siempre lo muestra.
- **Juegos desde una carpeta**: (la lista de carpetas añadidas aparece debajo, cada una con **Quitar**, que borra sus juegos y portadas)
   elige un directorio y cada .exe (hasta 3 subcarpetas) se añade como juego. Se omiten desinstaladores, redistribuibles,
  crash handlers y similares, y lo que ya estaba en la lista. Portada: imagen `cover`/`portada`/`poster`/`folder` junto al .exe → SteamGridDB (si hay clave)
  → portada de Steam si el nombre coincide exactamente → icono del .exe.
- **Fondo animado Sí/No**: cintas de seda estilo XMB de PS3; en "No" se quita el fondo (color liso, menos GPU).
- Clave de SteamGridDB para portadas de juegos que no son de Steam.
