# PS Launcher

Launcher estilo PS4 para Windows. Detecta juegos de Steam (todas las bibliotecas y discos) y Epic,
y permite añadir cualquier .exe con portada automática.

- `npm install` y `npm start` para probar. `npm run dist` genera el instalador en `dist/`.
- Atajo global: Ctrl+Alt+P. Teclado: flechas, Enter, C (portada), L (diseño PS4/centrado), Supr (quitar), F (contador de fps), Esc.
- Mando: A jugar, B cerrar, Y portada, X quitar, RB cambia de diseño.
- Fondo animado estilo XMB de PS3 (shader WebGL; se detiene solo cuando el launcher está oculto).
- Estadísticas arriba a la derecha: CPU/RAM del sistema; GPU NVIDIA con nvidia-smi.
  Temperatura de CPU: abre LibreHardwareMonitor (como administrador) con Options > "Remote Web Server" > Run (puerto 8085).
  Sin él, el launcher intenta las zonas térmicas de Windows (WMI), que solo existen en algunos equipos.
