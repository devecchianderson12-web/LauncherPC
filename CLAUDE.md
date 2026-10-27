# PS Launcher (LauncherPC)

Launcher de juegos de PC para Windows, hecho por el usuario (proyecto propio). Electron, pantalla completa, pensado para usarse con mando o teclado.
Se distribuye como **un único .exe portable** (sin instalador). El usuario habla español (rioplatense): responde y comenta el código en español.

## Archivos
- `main.js`: proceso principal. Biblioteca de juegos (Steam, Epic, personalizados, carpetas), portadas (SteamGridDB / Steam / icono del .exe), escaneo con caché, ventana, bandeja, atajo Ctrl+Alt+P, autoarranque, ocultar barra de tareas, estadísticas de CPU/RAM/GPU, optimización gráfica, **configuración** (`cfg`, `getCfg`/`setCfg`) y **actualizaciones** (`updCheck`/`updInstall`).
- `index.html`: toda la interfaz (CSS + JS en un solo archivo, sin framework).
- `preload.js`: puente `window.api` (contextIsolation). Cada IPC nuevo se añade aquí y en `main.js`.
- `lhm.js`: lectura de LibreHardwareMonitor. `package.json`: versión, `updateRepo`, config de electron-builder. `.github/workflows/build.yml`: compila y publica la release.

## Diseños (se cambian con L / botón del mando / Ajustes)
- `ps4`: baldosas en fila + recientes. `center`: baldosas centradas. `ps3`: XMB (categorías Juegos, Recientes, Herramientas, Ajustes en horizontal; lista en vertical).
- Coordenadas en unidades de 1920x1080 (`u` = escala, CSS `--u`). PS4/Centrado usan `L`, `place()`; el XMB usa `XM`, `xmbPlace()`, `xmbSwitch()`, `xmbEnter()`.
- Cambio de diseño animado: `setLayout` → `morphTiles` (PS4↔Centrado, técnica FLIP) o `morphViaXmb` (salida/entrada con PS3). `applyLayout` coloca sin animar (arranque).
- Fondo: shader WebGL (`Wave`) a baja resolución y 30 fps; `Tint` controla el color (Original / Color elegido / Arcoíris con velocidad). Sin fondo animado se usa un color liso en `#bg`.

## Reglas importantes
- **Rendimiento ante todo**: animar solo `transform`/`opacity`, sin layout por fotograma, sin trabajo en bucle si no hace falta. Las baldosas fuera de ±`VIS` se ocultan. Todo se pausa con `body.paused`.
- **Nada de instalador**: solo `dist/PS-Launcher.exe` portable. En portable, `process.execPath` es una carpeta temporal; el .exe real es `process.env.PORTABLE_EXECUTABLE_FILE`.
- Ajustes: añadir una opción = HTML en `#settings` + función `setX(valor, save)` + `setCfg` (lista blanca en `main.js`) + `getCfg` + carga en el bloque de inicio al final de `index.html`. Debe poder manejarse con el mando (`padFocus` recorre los `button` visibles de `#settings`).
- Seguridad de la actualización: solo se descarga desde `https://github.com/<updateRepo>/releases/download/…`, se comprueba tamaño y cabecera `MZ`, y un `.bat` en temp reemplaza el .exe cuando el programa se cierra.

## Funciones ya hechas
Escaneo al pulsar S con caché de portadas · demo · Ajustes (fondo, iniciar con Windows, iniciar minimizado, ocultar barra de tareas, mando configurable, carpeta completa como juegos, clave SteamGridDB) · animaciones fluidas entre juegos/baldosas · animación al cambiar de diseño y entre categorías del XMB · color del fondo + arcoíris · aviso de actualización + botón "Buscar actualizaciones" en Ajustes · (1.5.0) portada de fondo tras 1 s · difuminado de la portada ajustable (`artBlur`, canvas `#bgart` de 640x360) · "Mejorar portadas" con P / LT (`upgradeCovers` en `main.js`; respeta `cfg.manualCovers`, las elegidas con C).

## Pendiente / ojo
- Repo: `devecchianderson12-web/LauncherPC` (ya puesto en `updateRepo`). En GitHub había una release vieja `1.3` hecha a mano: por eso la versión pasó a `1.4.0` (solo local, nunca publicada) y la primera publicada con actualizador es `1.5.0`; toda versión nueva debe ser mayor.
- La actualización automática y las animaciones nuevas se probaron solo con comprobación de sintaxis y pruebas de lógica, **no en una ventana real de Windows**: verificar a mano.
- Para publicar: subir `version` en `package.json` y hacer push a `main` (el workflow crea la release `v<version>` con `PS-Launcher.exe`). La primera vez desde una versión sin actualizador hay que pasar al .exe nuevo a mano.
- El color del fondo se aplica a los tres diseños; si se prefiere solo en PS3, es un cambio pequeño en `Tint`/`applyBgStyle`.

## Comandos
`npm install` · `npm start` (probar) · `npm run dist` (genera `dist/PS-Launcher.exe`, en Windows).
