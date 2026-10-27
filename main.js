const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { parseLhm } = require('./lhm');

// Rendimiento: se dejan los valores por defecto de Chromium (igual que en el navegador); forzar flags de GPU empeora en varios drivers.
// En portátiles con dos GPU pide la potente, para que Windows no mande el launcher a la integrada.

// ---------- Modo gráfico ----------
// Forzar la GPU dedicada (lo que había antes) en portátiles con dos GPU suele dar ~20 fps: cada fotograma se copia de una GPU a otra.
// Ahora arranca con los valores por defecto de Chromium y, la primera vez, el launcher MIDE sus fps y prueba otros modos
// (integrada, OpenGL, sin GPU, dedicada) hasta quedarse con el que da 60 fps. El modo elegido se guarda en config.json.
const GPU_MODES = [
  { id: 'auto' },                                         // valores por defecto de Chromium
  { id: 'low',  sw: ['force_low_power_gpu'] },            // GPU integrada
  { id: 'gl',   sw: ['use-angle', 'gl'] },                // ANGLE sobre OpenGL
  { id: 'soft', soft: true },                             // sin aceleración por GPU
  { id: 'high', sw: ['force_high_performance_gpu'] }      // GPU dedicada
];
const earlyCfgFile = path.join(app.getPath('userData'), 'config.json');
let early = {};
try { early = JSON.parse(fs.readFileSync(earlyCfgFile, 'utf8')); } catch {}
(function pickGpuMode() {
  const t = early.tune = early.tune || { done: false, tried: {} };
  let id = GPU_MODES.some(m => m.id === early.gpuMode) ? early.gpuMode : 'auto';
  if (t.pending) {          // el arranque anterior con este modo no llegó a cargar la interfaz: se descarta y se pasa al siguiente
    t.tried[id] = 0; t.pending = false;
    const next = GPU_MODES.find(m => !(m.id in t.tried));
    if (next) id = next.id; else { id = Object.entries(t.tried).sort((a, b) => b[1] - a[1])[0][0]; t.done = true; }
    early.gpuMode = id;
    try { fs.writeFileSync(earlyCfgFile, JSON.stringify(early, null, 2)); } catch {}
  }
  const m = GPU_MODES.find(x => x.id === id);
  if (m.soft) app.disableHardwareAcceleration(); else if (m.sw) app.commandLine.appendSwitch(...m.sw);
})();
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win, tray, cfg;
const userDir = () => app.getPath('userData');
const coversDir = () => path.join(userDir(), 'covers');
const cfgFile = () => path.join(userDir(), 'config.json');
const DEFAULTS = { custom: [], apiKey: '', hotkey: 'Control+Alt+P', layout: 'ps4', recent: {}, bg: true, autostart: false, minimized: false, hideTaskbar: true, padMaps: {}, gpuMode: 'auto', tune: { done: false, tried: {} } };

function loadCfg() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveCfg() { fs.mkdirSync(userDir(), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); }

const norm = p => path.resolve(p).toLowerCase();
const nkey = s => (s.toLowerCase().replace(/[^a-z0-9]/g, '') || s.toLowerCase());
// id estable por ruta: importar una carpeta crea muchos juegos en el mismo milisegundo, Date.now() chocaría
const customId = exe => 'custom:' + crypto.createHash('sha1').update(norm(exe)).digest('hex').slice(0, 12);

// ---------- Importar una carpeta ----------
// Busca .exe hasta 3 niveles de profundidad y descarta lo que no es un juego (desinstaladores, redistribuibles, crash handlers...)
const JUNK_EXE = [/^unins/, /uninstall/, /^setup/, /^install/, /redist/, /^vc_?red/, /^dxsetup/, /^dxwebsetup/, /^dotnet/, /^ndp\d/,
  /^oalinst/, /physx/, /crash/, /^updater?$/, /updater$/, /^cef/, /^ue4?prereq/, /easyanticheat/, /^eac/, /^beservice/, /battleye/,
  /^notification_helper/, /^helper$/, /^7z/, /^webview/, /^msedgewebview/, /^dxdiag/, /^vulkan/, /^launcherhelper/];
const JUNK_DIR = /^(_?commonredist|redist\w*|directx|vcredist|dotnet\w*|engine|\$recycle\.bin|system volume information|__macosx|\.git|node_modules|crashreport\w*|_?installer|prereq\w*)$/i;
const MAX_EXES = 500;

async function findExes(dir, depth, out) {
  let ents = [];
  try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  ents.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of ents) {
    if (out.length >= MAX_EXES) break;
    const full = path.join(dir, e.name);
    if (e.isFile() && /\.exe$/i.test(e.name)) {
      const base = e.name.replace(/\.exe$/i, '').toLowerCase();
      if (!JUNK_EXE.some(re => re.test(base))) out.push(full);
    } else if (e.isDirectory() && depth < 3 && !JUNK_DIR.test(e.name)) {   // los enlaces simbólicos no cuentan como directorio: sin bucles
      await findExes(full, depth + 1, out);
    }
  }
  return out;
}

// Nombre del juego a partir del .exe; si el nombre es genérico ("game.exe", "launcher.exe") usa el de la carpeta
function nameFromExe(exe) {
  const base = path.basename(exe).replace(/\.[^.]+$/, '');
  const parent = path.basename(path.dirname(exe));
  return /^(game|launcher|start|run|play|main|app|client|win\d*|bin)$/i.test(base) && parent ? parent : base;
}

// ---------- Escaneo de juegos ----------
function steamPath() {
  return new Promise(res => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (e, out) => {
      const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(out || '');
      res(m ? m[1].trim().replace(/\//g, '\\') : null);
    });
  });
}

async function scanSteam() {
  const sp = await steamPath();
  if (!sp) return [];
  // Bibliotecas normalizadas: evita contar dos veces la misma carpeta (c:/ vs C:\)
  const libs = new Map([[norm(sp), sp]]);
  try {
    const vdf = await fs.promises.readFile(path.join(sp, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
      const p = m[1].replace(/\\\\/g, '\\');
      libs.set(norm(p), p);
    }
  } catch {}
  const apps = new Map();
  for (const lib of libs.values()) {
    const dir = path.join(lib, 'steamapps');
    let files = [];
    try { files = (await fs.promises.readdir(dir)).filter(f => /^appmanifest_\d+\.acf$/.test(f)); } catch { continue; }
    for (const f of files) {
      try {
        const t = await fs.promises.readFile(path.join(dir, f), 'utf8');
        const id = /"appid"\s+"(\d+)"/.exec(t)?.[1];
        const name = /"name"\s+"([^"]+)"/.exec(t)?.[1];
        const inst = /"installdir"\s+"([^"]+)"/.exec(t)?.[1];
        if (!id || !name || id === '228980' || /^(Proton|Steam Linux Runtime|Steamworks)/i.test(name)) continue;
        if (!apps.has(id)) apps.set(id, { id: 'steam:' + id, type: 'steam', name, appid: id, dir: inst ? path.join(dir, 'common', inst) : '', start: 'steam://rungameid/' + id });
      } catch {}
    }
  }
  return [...apps.values()];
}

async function scanEpic() {
  const dir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
  const out = new Map();
  try {
    for (const f of (await fs.promises.readdir(dir)).filter(f => f.endsWith('.item'))) {
      try {
        const j = JSON.parse(await fs.promises.readFile(path.join(dir, f), 'utf8'));
        if (!j.DisplayName || !j.LaunchExecutable || !j.AppName) continue;
        if (!out.has(j.AppName)) { const exe = path.join(j.InstallLocation, j.LaunchExecutable); out.set(j.AppName, { id: 'epic:' + j.AppName, type: 'epic', name: j.DisplayName, dir: j.InstallLocation, exe, start: exe }); }
      } catch {}
    }
  } catch {}
  return [...out.values()];
}

// ---------- Biblioteca en caché ----------
// library.json guarda, por juego, su ruta de inicio (start) y su portada (cover). Se escanea al arrancar
// y con la tecla S; lo que no cambió se queda como está (no se vuelve a tocar ni a descargar su portada).
const libFile = () => path.join(userDir(), 'library.json');
let lib = { scannedAt: 0, games: [] };
function loadLib() {
  try {
    const j = JSON.parse(fs.readFileSync(libFile(), 'utf8'));
    if (Array.isArray(j.games)) return { scannedAt: j.scannedAt || 0, games: j.games };
  } catch {}
  return { scannedAt: 0, games: [] };
}
let saveLibT = null;
function saveLib() {
  clearTimeout(saveLibT);
  saveLibT = setTimeout(() => {
    try { fs.mkdirSync(userDir(), { recursive: true }); fs.writeFileSync(libFile(), JSON.stringify(lib, null, 1)); } catch {}
  }, 800);
}
const sigOf = g => [g.id, g.name, g.start || '', g.dir || ''].join('|');

let scanP = null;
const scan = () => scanP || (scanP = doScan().finally(() => { scanP = null; }));

async function doScan() {
  const found = [...await scanSteam(), ...await scanEpic()];
  const old = new Map(lib.games.map(g => [g.id, g]));
  const now = new Set(found.map(g => g.id));
  let added = 0, changed = 0, removed = 0;
  for (const g of found) {
    const o = old.get(g.id);
    if (!o) added++;
    else {
      if (sigOf(o) !== sigOf(g)) changed++;
      if (o.cover) g.cover = o.cover;            // conserva la portada ya guardada
    }
  }
  for (const id of old.keys()) if (!now.has(id)) removed++;
  lib = { scannedAt: Date.now(), games: found };
  if (added || changed || removed || !fs.existsSync(libFile())) saveLib();
  coverFail.clear();
  prefetchCovers([...found, ...cfg.custom.map(c => ({ ...c, type: 'custom' }))]);   // solo tras pulsar S: las portadas que faltan
  return { added, changed, removed, total: found.length };
}

async function prefetchCovers(list) {
  for (const g of list) {
    if (fs.existsSync(coverFile(g.id))) continue;
    const url = await getCover(g).catch(() => null);
    if (url && win && !win.isDestroyed()) win.webContents.send('cover', { id: g.id, url });
  }
}
// La interfaz pide portadas solo de la caché del disco: nunca descarga nada por su cuenta
const cachedCover = item => { const f = coverFile(item.id); return fs.existsSync(f) ? coverUrl(f) : null; };

function listGames() {
  const all = [...lib.games, ...cfg.custom.map(c => ({ ...c, type: 'custom', dir: path.dirname(c.exe), start: c.exe }))];
  const seen = new Set(), out = [];
  for (const g of all) {
    const keys = ['n:' + nkey(g.name)];
    if (g.exe) keys.push('e:' + norm(g.exe));
    if (keys.some(k => seen.has(k))) continue;   // mismo nombre o mismo .exe = duplicado
    keys.forEach(k => seen.add(k));
    out.push({ ...g, last: cfg.recent[g.id] || 0 });
  }
  return out.sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
}

// ---------- Portadas ----------
const safe = id => id.replace(/[^a-z0-9_-]/gi, '_');
const coverFile = id => path.join(coversDir(), safe(id) + '.jpg');
const fileUrl = f => 'file:///' + f.replace(/\\/g, '/');
// La fecha del archivo va en la URL: si una portada se reemplaza (tecla P), la interfaz no muestra la vieja desde su caché
const coverUrl = f => { try { return fileUrl(f) + '?v=' + Math.round(fs.statSync(f).mtimeMs); } catch { return fileUrl(f); } };

// Las portadas se guardan como mucho a 600x900: una imagen enorme pesa en la GPU aunque se vea pequeña
function shrink(buf) {
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return buf;
    const { width, height } = img.getSize();
    if (width <= 600 && height <= 900 && buf.length < 300e3) return buf;
    const k = Math.min(1, 600 / width, 900 / height);
    const out = k < 1 ? img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' }) : img;
    const jpg = out.toJPEG(88);
    return jpg.length < buf.length ? jpg : buf;
  } catch { return buf; }
}
async function download(url, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(r.status);
  return Buffer.from(await r.arrayBuffer());
}

// Con appid (juegos de Steam) se busca directamente por su id de Steam; si no, por nombre
async function steamGridCover(name, appid) {
  if (!cfg.apiKey) return null;
  const h = { Authorization: 'Bearer ' + cfg.apiKey };
  const grid = async p => { const g = await (await fetch(`https://www.steamgriddb.com/api/v2/grids/${p}?dimensions=600x900`, { headers: h, signal: AbortSignal.timeout(8000) })).json(); return g?.data?.[0]?.url || null; };
  let url = null;
  if (appid) { try { url = await grid('steam/' + appid); } catch {} }
  if (!url) {
    const s = await (await fetch('https://www.steamgriddb.com/api/v2/search/autocomplete/' + encodeURIComponent(name), { headers: h, signal: AbortSignal.timeout(8000) })).json();
    const gid = s?.data?.[0]?.id;
    if (gid) url = await grid('game/' + gid);
  }
  return url ? download(url) : null;
}

// Tienda de Steam (sin clave): solo se acepta si el nombre coincide exactamente, para no poner portadas equivocadas
async function steamStoreCover(name, names = ['library_600x900.jpg', 'header.jpg']) {
  const r = await (await fetch('https://store.steampowered.com/api/storesearch/?l=english&cc=us&term=' + encodeURIComponent(name), { signal: AbortSignal.timeout(6000) })).json();
  const hit = (r.items || []).find(x => x.type === 'app' && nkey(x.name) === nkey(name));
  if (!hit) return null;
  const base = `https://cdn.cloudflare.steamstatic.com/steam/apps/${hit.id}/`;
  for (const n of names) { try { return await download(base + n); } catch {} }
  return null;
}

// Imagen junto al .exe: cover / portada / poster / folder / boxart...
function localCover(exe) {
  const dir = path.dirname(exe), names = ['cover', 'portada', 'poster', 'folder', 'boxart', 'capsule', 'library_600x900'];
  try {
    const files = fs.readdirSync(dir);
    for (const n of names) {
      const f = files.find(x => { const e = path.extname(x).toLowerCase(); return ['.jpg', '.jpeg', '.png', '.webp'].includes(e) && path.basename(x, e).toLowerCase() === n; });
      if (f) return fs.readFileSync(path.join(dir, f));
    }
  } catch {}
  return null;
}

// Máximo 4 portadas a la vez: al importar una carpeta grande no se lanzan cientos de peticiones juntas
let coverActive = 0; const coverQ = [];
const coverSlot = () => new Promise(res => { if (coverActive < 4) { coverActive++; res(); } else coverQ.push(res); });
const coverFree = () => { const n = coverQ.shift(); if (n) n(); else coverActive--; };

const coverFail = new Set(), coverBusy = new Map();
function getCover(item) {
  const f = coverFile(item.id);
  if (fs.existsSync(f)) return Promise.resolve(coverUrl(f));
  if (coverFail.has(item.id)) return Promise.resolve(null);     // ya falló en esta sesión; S lo reintenta
  if (!coverBusy.has(item.id)) coverBusy.set(item.id, fetchCover(item, f).finally(() => coverBusy.delete(item.id)));
  return coverBusy.get(item.id);
}

async function fetchCover(item, f) {
  await coverSlot();
  try {
    fs.mkdirSync(coversDir(), { recursive: true });
    let buf = null;
    try {
      if (item.type === 'steam') {
        const base = `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appid}/`;
        for (const n of ['library_600x900.jpg', 'header.jpg']) {
          try { buf = await download(base + n); break; } catch {}
        }
      }
      if (!buf && item.type === 'custom' && item.exe) buf = localCover(item.exe);
      if (!buf) { try { buf = await steamGridCover(item.name); } catch {} }
      if (!buf && item.type === 'custom') { try { buf = await steamStoreCover(item.name); } catch {} }
      if (!buf && item.exe) {
        const icon = await app.getFileIcon(item.exe, { size: 'large' });
        if (!icon.isEmpty()) buf = icon.toPNG();
      }
    } catch {}
    if (!buf) { coverFail.add(item.id); return null; }
    fs.writeFileSync(f, shrink(buf));
    const g = lib.games.find(x => x.id === item.id);
    if (g && g.cover !== f) { g.cover = f; saveLib(); }
    return coverUrl(f);
  } finally { coverFree(); }
}

// ---------- Mejorar portadas (tecla P / gatillo izquierdo) ----------
// Una portada "se ve mal" si falta, es chica o no es vertical (icono del .exe, cabecera apaisada de Steam...).
// Solo se buscan portadas verticales (600x900) y solo se reemplaza si la nueva es mejor. Las elegidas a mano con C no se tocan.
const GOOD_COVER = 300;                                   // puntos: ~ancho en px de una portada vertical
function coverScore(buf) {
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return 0;
    const { width: w, height: h } = img.getSize();
    return h >= w * 1.2 ? Math.min(w, h / 1.5) : Math.min(w, h) / 4;   // apaisada o cuadrada: cuenta muy poco
  } catch { return 0; }
}
async function betterCover(item) {
  const cands = [];
  if (item.type === 'steam') cands.push(() => download(`https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appid}/library_600x900.jpg`));
  cands.push(() => steamGridCover(item.name, item.type === 'steam' ? item.appid : null));
  if (item.type !== 'steam') cands.push(() => steamStoreCover(item.name, ['library_600x900.jpg']));
  for (const c of cands) {
    try { const buf = await c(); if (buf && coverScore(buf) >= GOOD_COVER) return buf; } catch {}
  }
  return null;
}
async function upgradeCovers() {
  const manual = cfg.manualCovers || {};
  const low = listGames().filter(g => {
    if (manual[g.id]) return false;
    try { return coverScore(fs.readFileSync(coverFile(g.id))) < GOOD_COVER; } catch { return true; }   // sin portada también cuenta
  });
  let improved = 0;
  await Promise.all(low.map(async g => {
    await coverSlot();
    try {
      const buf = await betterCover(g);
      if (!buf) return;
      const f = coverFile(g.id);
      let cur = 0; try { cur = coverScore(fs.readFileSync(f)); } catch {}
      if (coverScore(buf) <= cur) return;
      fs.mkdirSync(coversDir(), { recursive: true });
      fs.writeFileSync(f, shrink(buf));
      coverFail.delete(g.id);
      const lg = lib.games.find(x => x.id === g.id);
      if (lg && lg.cover !== f) { lg.cover = f; saveLib(); }
      improved++;
      if (win && !win.isDestroyed()) win.webContents.send('cover', { id: g.id, url: coverUrl(f) });
    } catch {} finally { coverFree(); }
  }));
  return { low: low.length, improved, noKey: !cfg.apiKey };
}

// ---------- Estadísticas del sistema (solo mientras el launcher está visible) ----------
const run = (cmd, args, t = 2500) => new Promise(r => execFile(cmd, args, { timeout: t, windowsHide: true }, (e, o) => r(e ? null : String(o))));
let prevCpu = os.cpus().map(c => ({ ...c.times }));
let statsTimer = null, busy = false, nv, lhmDown = 0;

function cpuUse() {
  const cur = os.cpus();
  let idle = 0, total = 0;
  cur.forEach((c, i) => {
    const p = prevCpu[i] || c.times;
    const sum = o => o.user + o.nice + o.sys + o.idle + o.irq;
    total += sum(c.times) - sum(p);
    idle += c.times.idle - p.idle;
  });
  prevCpu = cur.map(c => ({ ...c.times }));
  return total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
}

let nvAt = 0, nvLast = null;
async function nvidia() {
  if (nv === false) return null;
  if (Date.now() - nvAt < 5000) return nvLast;        // nvidia-smi es un proceso externo: como mucho cada 5 s, para no provocar tirones
  nvAt = Date.now();
  const o = await run('nvidia-smi', ['--query-gpu=utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits']);
  if (!o) { nv = false; return null; }
  const [use, temp] = o.trim().split(/\r?\n/)[0].split(',').map(s => parseFloat(s));
  nv = true;
  return (nvLast = { use: isFinite(use) ? use : null, temp: isFinite(temp) ? temp : null });
}

const num = v => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : null; };

// LibreHardwareMonitor / OpenHardwareMonitor con "Remote Web Server" (puerto 8085).
// Se usa 127.0.0.1 y no "localhost": en Node/Electron nuevos "localhost" puede resolver a ::1 y no conectar.
async function lhm() {
  if (Date.now() < lhmDown) return null;
  try {
    const j = await (await fetch('http://127.0.0.1:8085/data.json', { signal: AbortSignal.timeout(1200) })).json();
    return parseLhm(j);
  } catch { lhmDown = Date.now() + 15000; return null; }
}

async function tick() {
  if (busy || paused || !win || !win.isVisible()) return;
  busy = true;
  try {
    const cpu = { use: cpuUse() };
    const total = os.totalmem();
    const ram = { used: total - os.freemem(), total };
    let gpu = { use: null, temp: null };
    const [n, l] = await Promise.all([nvidia(), lhm()]);   // en paralelo, no uno tras otro
    if (n) gpu = n;
    if (l) {
      if (gpu.use == null) gpu.use = l.gpuUse;
      if (gpu.temp == null) gpu.temp = l.gpuTemp;
    }
    if (win && win.isVisible()) win.webContents.send('stats', { cpu, ram, gpu });
  } finally { busy = false; }
}
function startStats() { if (!statsTimer && !paused) { tick(); statsTimer = setInterval(tick, 2000); } }
function stopStats() { clearInterval(statsTimer); statsTimer = null; }

// ---------- Ventana ----------
function createWin() {
  win = new BrowserWindow({
    show: false, fullscreen: true, frame: false, backgroundColor: '#0a2a86',
    skipTaskbar: true, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true }
  });
  win.loadFile('index.html');
  win.on('close', e => { if (!app.isQuitting) { e.preventDefault(); hideLauncher(); } });
}
// Al ocultar se espera ~190 ms para que la interfaz haga su animación de salida antes de esconder la ventana
let hideT = null;
function showLauncher() {
  if (!win) return;
  clearTimeout(hideT); hideT = null;
  if (paused) { resumeLauncher(true); return; }     // ya estaba visible detrás de otro programa: solo estaba congelado
  win.show(); win.focus();
  win.webContents.send('enter');
  startStats();
  syncTaskbar();
}
function hideLauncher() {
  if (!win || !win.isVisible() || hideT) return;
  if (paused) resumeLauncher(false);
  stopStats(); clearTimeout(launchT); launchT = null;
  win.webContents.send('leave');
  hideT = setTimeout(() => { hideT = null; if (win && !win.isDestroyed()) win.hide(); }, 190);
  syncTaskbar();                                    // el launcher se oculta a propósito (Esc): la barra de tareas vuelve para usar el escritorio
}

// ---------- Pausa del launcher y barra de tareas ----------
// Un único PowerShell vive toda la sesión y hace dos cosas:
//  1) Avisa de quién tiene el primer plano (SELF = el launcher, OTHER = otro programa, NONE = escritorio/nadie).
//     Es por eventos (SetWinEventHook): no sondea, así que en reposo gasta 0. Un temporizador de seguridad cada 2 s lo revalida, y la barra se vuelve a ocultar al instante si el Explorador la muestra.
//  2) Mantiene oculta la barra de tareas de Windows mientras el launcher está en pantalla, y la restaura siempre al salir
//     (también si el launcher se cierra a la fuerza: al cerrarse la tubería de entrada el ayudante la vuelve a mostrar).
// Mientras otro programa está delante, el launcher queda PAUSADO: la ventana sigue ahí detrás con su último fotograma
// (por eso reaparece al instante al cerrar el programa) pero sin fondo animado, sin mando, sin reloj, sin estadísticas y con prioridad mínima.
const SHELL_PS = `param([int]$self)
Add-Type -TypeDefinition @\"
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class SH {
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObj, int idChild, uint thread, uint time);
  delegate void TimerProc(IntPtr hwnd, uint msg, UIntPtr id, uint time);
  [DllImport(\"user32.dll\")] static extern IntPtr SetWinEventHook(uint a, uint b, IntPtr mod, WinEventProc p, uint pid, uint tid, uint flags);
  [DllImport(\"user32.dll\")] static extern UIntPtr SetTimer(IntPtr h, UIntPtr id, uint ms, TimerProc p);
  [DllImport(\"user32.dll\")] static extern bool KillTimer(IntPtr h, UIntPtr id);
  [DllImport(\"user32.dll\")] static extern bool UnhookWinEvent(IntPtr h);
  [DllImport(\"user32.dll\")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport(\"user32.dll\")] static extern bool TranslateMessage(ref MSG m);
  [DllImport(\"user32.dll\")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport(\"user32.dll\")] static extern IntPtr GetForegroundWindow();
  [DllImport(\"user32.dll\")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string c, string t);
  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport(\"user32.dll\")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport(\"user32.dll\")] static extern bool IsWindowVisible(IntPtr h);

  // ----- Mando: L1+R1+L2+R2 a la vez = abrir/ocultar el launcher (tambien con un juego delante) -----
  // XInput (Xbox y compatibles) + winmm (PlayStation, Nintendo y mandos DirectInput: botones 5-8 = L1 R1 L2 R2).
  // Cada 3 s se buscan mandos y solo si hay alguno se leen 20 veces por segundo: sin mando conectado no gasta nada.
  [StructLayout(LayoutKind.Sequential)] struct XGP { public ushort buttons; public byte lt; public byte rt; public short lx, ly, rx, ry; }
  [StructLayout(LayoutKind.Sequential)] struct XST { public uint packet; public XGP pad; }
  [StructLayout(LayoutKind.Sequential)] struct JOYEX { public uint size, flags, x, y, z, r, u, v, buttons, buttonNumber, pov, res1, res2; }
  [DllImport(\"xinput1_4.dll\")] static extern uint XInputGetState(uint i, out XST s);
  [DllImport(\"winmm.dll\")] static extern uint joyGetPosEx(uint id, ref JOYEX j);
  [DllImport(\"winmm.dll\")] static extern uint joyGetNumDevs();
  [DllImport(\"winmm.dll\")] static extern uint joyGetDevCapsW(UIntPtr id, byte[] caps, uint size);
  static TimerProc padScanTp, padPollTp;
  static bool[] xOn = new bool[4]; static System.Collections.Generic.List<uint> joys = new System.Collections.Generic.List<uint>();
  static UIntPtr padPollId; static bool comboDown, xinputOk = true;

  static JOYEX NewJoy() { JOYEX j = new JOYEX(); j.size = (uint)Marshal.SizeOf(typeof(JOYEX)); j.flags = 0x80; return j; }   // JOY_RETURNBUTTONS
  static bool XCombo(uint i) {
    XST s; if (XInputGetState(i, out s) != 0) { xOn[i] = false; return false; }
    return (s.pad.buttons & 0x0300) == 0x0300 && s.pad.lt > 100 && s.pad.rt > 100;     // LB + RB + LT + RT
  }
  static bool JCombo(uint id) { JOYEX j = NewJoy(); return joyGetPosEx(id, ref j) == 0 && (j.buttons & 0xF0) == 0xF0; }
  static void PadScan(IntPtr hwnd, uint msg, UIntPtr id, uint time) {
    if (xinputOk) {
      try { for (uint i = 0; i < 4; i++) { XST s; xOn[i] = XInputGetState(i, out s) == 0; } }
      catch { xinputOk = false; }                           // Windows sin xinput1_4.dll
    }
    try {
      joys.Clear();
      uint n = Math.Min(joyGetNumDevs(), 16u); byte[] caps = new byte[728];
      for (uint j = 0; j < n; j++) {
        JOYEX st = NewJoy();
        if (joyGetPosEx(j, ref st) != 0) continue;
        if (joyGetDevCapsW((UIntPtr)j, caps, 728) == 0 && BitConverter.ToUInt16(caps, 0) == 0x045E) continue;   // Xbox: ya se lee por XInput
        joys.Add(j);
      }
    } catch {}
    bool any = joys.Count > 0; for (int i = 0; i < 4; i++) any |= xOn[i];
    if (any && padPollId == UIntPtr.Zero) padPollId = SetTimer(IntPtr.Zero, UIntPtr.Zero, 50, padPollTp);
    else if (!any && padPollId != UIntPtr.Zero) { KillTimer(IntPtr.Zero, padPollId); padPollId = UIntPtr.Zero; comboDown = false; }
  }
  static void PadPoll(IntPtr hwnd, uint msg, UIntPtr id, uint time) {
    bool c = false;
    try {
      if (xinputOk) for (uint i = 0; i < 4; i++) if (xOn[i] && XCombo(i)) c = true;
      foreach (uint j in joys) if (JCombo(j)) c = true;
    } catch {}
    if (c && !comboDown) { Console.WriteLine(\"PAD\"); Console.Out.Flush(); }   // una vez por pulsacion: hay que soltar para repetir
    comboDown = c;
  }

  static uint self; static string last = \"\"; static volatile bool tb;
  static WinEventProc wep; static TimerProc tp, bp;
  static IntPtr showHook; static uint hookPid; static UIntPtr burstId; static int burstLeft, hideWin, hideCnt;

  static string Classify() {
    IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) return \"NONE\";
    StringBuilder sb = new StringBuilder(64); GetClassName(h, sb, 64);
    string c = sb.ToString();
    if (c == \"Progman\" || c == \"WorkerW\" || c == \"Shell_TrayWnd\" || c == \"Shell_SecondaryTrayWnd\") return \"NONE\";
    uint pid; GetWindowThreadProcessId(h, out pid);
    return pid == self ? \"SELF\" : \"OTHER\";
  }
  // show=false oculta la barra (y las de los demas monitores); show=true la devuelve
  static void Tb(bool show) {
    IntPtr h = FindWindow(\"Shell_TrayWnd\", null);
    if (h != IntPtr.Zero && IsWindowVisible(h) != show) ShowWindow(h, show ? 5 : 0);
    IntPtr s = IntPtr.Zero;
    while ((s = FindWindowEx(IntPtr.Zero, s, \"Shell_SecondaryTrayWnd\", null)) != IntPtr.Zero)
      if (IsWindowVisible(s) != show) ShowWindow(s, show ? 5 : 0);
  }
  static void Check() {
    try {
      if (tb) Tb(false);                                   // si Windows la vuelve a mostrar, se oculta de nuevo
      string s = Classify();
      if (s != last) { last = s; Console.WriteLine(s); Console.Out.Flush(); }
    } catch {}
  }
  // El Explorador vuelve a mostrar la barra DESPUES del cambio de ventana, asi que no basta con ocultarla en ese aviso:
  //  - EVENT_OBJECT_SHOW de explorer.exe: si la barra se muestra, se oculta en el acto (por eventos, gasta 0 en reposo)
  //  - tras cada cambio de ventana, una rafaga de comprobaciones (10 x 80 ms) por si reaparece sin evento
  static uint ExplorerPid() {
    IntPtr h = FindWindow(\"Shell_TrayWnd\", null); uint pid = 0;
    if (h != IntPtr.Zero) GetWindowThreadProcessId(h, out pid);
    return pid;
  }
  static void Rehook() {
    try {
      uint ep = ExplorerPid();
      if (ep == 0 || ep == hookPid) return;                 // sin explorer aun, o ya enganchado
      if (showHook != IntPtr.Zero) UnhookWinEvent(showHook);
      showHook = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, wep, ep, 0, 0);   // EVENT_OBJECT_SHOW solo de explorer
      hookPid = showHook != IntPtr.Zero ? ep : 0;
    } catch {}
  }
  static void OnShow(IntPtr hwnd, int idObj) {
    if (!tb || idObj != 0 || hwnd == IntPtr.Zero) return;
    try {
      StringBuilder sb = new StringBuilder(32); GetClassName(hwnd, sb, 32);
      string c = sb.ToString();
      if (c != \"Shell_TrayWnd\" && c != \"Shell_SecondaryTrayWnd\") return;
      int now = Environment.TickCount;                       // freno: si Windows insiste en mostrarla sin parar, no se entra en bucle
      if (now - hideWin > 1000) { hideWin = now; hideCnt = 0; }
      if (++hideCnt > 40) return;
      ShowWindow(hwnd, 0);
    } catch {}
  }
  static void StartBurst() {
    if (!tb) return;
    burstLeft = 10;
    if (burstId == UIntPtr.Zero) burstId = SetTimer(IntPtr.Zero, UIntPtr.Zero, 80, bp);
  }
  static void OnBurst(IntPtr hwnd, uint msg, UIntPtr id, uint time) {
    try { if (tb) Tb(false); } catch {}
    if (--burstLeft <= 0 || !tb) { KillTimer(IntPtr.Zero, burstId); burstId = UIntPtr.Zero; }
  }
  static void OnEvt(IntPtr hook, uint ev, IntPtr hwnd, int idObj, int idChild, uint thread, uint time) {
    if (ev == 3) { Check(); StartBurst(); }
    else OnShow(hwnd, idObj);
  }
  static void OnTimer(IntPtr hwnd, uint msg, UIntPtr id, uint time) {
    try { System.Diagnostics.Process.GetProcessById((int)self); }
    catch (ArgumentException) { Restore(); Environment.Exit(0); }
    Rehook();                                              // por si explorer.exe se reinicio
    Check();
  }
  static void ReadCmds() {
    try {
      string l;
      while ((l = Console.In.ReadLine()) != null) {
        l = l.Trim();
        if (l == \"TB 1\") { tb = true; Tb(false); StartBurst(); }
        else if (l == \"TB 0\") { tb = false; Tb(true); }
        else if (l == \"QUIT\") break;
      }
    } catch {}
    Restore();                                             // fin de la tuberia = el launcher termino: la barra de tareas vuelve
    Environment.Exit(0);
  }
  public static void Restore() { try { tb = false; Tb(true); } catch {} }
  public static void Run(uint selfPid) {
    self = selfPid;
    wep = new WinEventProc(OnEvt); tp = new TimerProc(OnTimer); bp = new TimerProc(OnBurst);
    AppDomain.CurrentDomain.ProcessExit += (a, b) => Restore();
    Thread t = new Thread(ReadCmds); t.IsBackground = true; t.Start();
    SetWinEventHook(3, 3, IntPtr.Zero, wep, 0, 0, 0);       // EVENT_SYSTEM_FOREGROUND, fuera de proceso
    SetTimer(IntPtr.Zero, UIntPtr.Zero, 2000, tp);
    padScanTp = new TimerProc(PadScan); padPollTp = new TimerProc(PadPoll);
    SetTimer(IntPtr.Zero, UIntPtr.Zero, 3000, padScanTp);
    PadScan(IntPtr.Zero, 0, UIntPtr.Zero, 0);
    Rehook();
    Check();
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessage(ref m); }
  }
}
\"@
try { [SH]::Run([uint32]$self) } finally { [SH]::Restore() }
`;

let shellProc = null, shellBuf = '', shellRestarts = 0, tbWanted = false;
let paused = false, launchT = null, noneT = null;

const shellSend = line => { try { if (shellProc) shellProc.stdin.write(line + '\n'); } catch {} };
function startShell() {
  if (process.platform !== 'win32' || shellProc) return;
  const f = path.join(os.tmpdir(), 'pslauncher-shell.ps1');
  try { fs.writeFileSync(f, SHELL_PS); } catch { return; }
  let p;
  try {
    p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f, '-self', String(process.pid)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch { return; }
  shellProc = p; shellBuf = '';
  p.stdin.on('error', () => {});
  p.on('error', () => { if (shellProc === p) shellDown(); });
  p.on('exit', () => { if (shellProc === p) shellDown(); });
  p.stdout.on('data', d => {
    shellBuf += d;
    let i;
    while ((i = shellBuf.indexOf('\n')) >= 0) {
      const l = shellBuf.slice(0, i).trim(); shellBuf = shellBuf.slice(i + 1);
      if (l === 'SELF' || l === 'OTHER' || l === 'NONE') onForeground(l);
      else if (l === 'PAD') padCombo();
    }
  });
  shellSend('TB ' + (tbWanted ? 1 : 0));
}
// Si el ayudante muere, el launcher nunca se queda congelado sin nadie que lo despierte
function shellDown() {
  shellProc = null;
  if (paused) resumeLauncher(true);
  if (!app.isQuitting && ++shellRestarts <= 3) setTimeout(startShell, 3000);
}
function stopShell() {
  shellSend('QUIT');                                   // el ayudante restaura la barra de tareas por su cuenta aunque este proceso ya haya terminado
  try { if (shellProc) shellProc.stdin.end(); } catch {}
  shellProc = null;
}
// La barra de tareas solo se oculta mientras el launcher esté en pantalla (y la opción esté activada)
function syncTaskbar() {
  const want = process.platform === 'win32' && cfg.hideTaskbar !== false && !!win && !win.isDestroyed() && win.isVisible() && !hideT;
  if (want === tbWanted) return;
  tbWanted = want;
  shellSend('TB ' + (want ? 1 : 0));
}

// Solo bajan de prioridad los procesos de la interfaz y la GPU; el principal no, para que el atajo y el ayudante respondan siempre
function lowPrio(on) {
  try {
    const p = on ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_NORMAL;
    for (const m of app.getAppMetrics()) if (m.type !== 'Browser') { try { os.setPriority(m.pid, p); } catch {} }
  } catch {}
}
function pauseLauncher() {
  if (paused || !win || win.isDestroyed() || !win.isVisible() || hideT) return;
  paused = true;
  stopStats();
  clearTimeout(launchT); launchT = null;
  win.webContents.send('pause');
  lowPrio(true);
}
function resumeLauncher(front) {
  if (!paused) return;
  paused = false;
  clearTimeout(noneT); noneT = null;
  lowPrio(false);
  if (win && !win.isDestroyed()) {
    if (front) { win.show(); win.focus(); }
    win.webContents.send('resume');
  }
  startStats();
  syncTaskbar();
}
function onForeground(s) {
  clearTimeout(noneT); noneT = null;
  if (!win || win.isDestroyed() || !win.isVisible() || hideT) return;   // el launcher está oculto a propósito: no se toca
  if (s === 'OTHER') pauseLauncher();
  else if (s === 'SELF') resumeLauncher(false);
  // NONE: nadie tiene el foco (se acaba de cerrar el programa). Se espera 0,4 s por si Windows activa otra ventana; si no, el launcher pasa al frente
  else if (paused) noneT = setTimeout(() => { noneT = null; resumeLauncher(true); }, 400);
}
// L1+R1+L2+R2 en cualquier mando: igual que Ctrl+Alt+P (con freno para no alternar dos veces seguidas)
let padComboAt = 0;
function padCombo() {
  const now = Date.now();
  if (now - padComboAt < 700 || !win || win.isDestroyed()) return;
  padComboAt = now;
  toggle();
}
function toggle() {if (paused) showLauncher(); else win.isVisible() && !hideT ? hideLauncher() : showLauncher(); }
function notifyLibrary() { if (win && !win.isDestroyed()) win.webContents.send('library'); }
// Inicio con Windows. En la versión portable el .exe real es PORTABLE_EXECUTABLE_FILE (process.execPath apunta a una carpeta temporal).
// "Minimizado" solo aplica al arranque de Windows: se pasa --hidden en el registro, un doble clic normal siempre abre el launcher.
function applyAutostart() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!cfg.autostart, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: cfg.minimized ? ['--hidden'] : [] });
  } catch {}
}
function registerHotkey() {
  globalShortcut.unregisterAll();
  try { globalShortcut.register(cfg.hotkey, toggle); } catch {}
}

// ---------- IPC ----------
// Sin escaneos automáticos: solo se lee la biblioteca guardada. Para buscar juegos nuevos: tecla S (o LB en el mando).
ipcMain.handle('games', () => listGames());
ipcMain.handle('rescan', async () => {
  const r = await scan();
  notifyLibrary();
  return r;
});
ipcMain.handle('cover', (e, item) => cachedCover(item));

ipcMain.handle('launch', (e, item) => {
  cfg.recent[item.id] = Date.now();
  saveCfg();
  if (item.type === 'steam') shell.openExternal('steam://rungameid/' + item.appid);
  else if (item.exe) spawn(item.exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(item.exe) }).unref();
  // El launcher sigue visible ("Iniciando…") hasta que otro programa pasa al primer plano: entonces se pausa solo.
  // Si en 2 min no aparece nada, la interfaz vuelve a la normalidad. Sin ayudante (no Windows / PowerShell bloqueado) se oculta como antes.
  clearTimeout(launchT);
  if (shellProc) launchT = setTimeout(() => { launchT = null; if (win && !win.isDestroyed()) win.webContents.send('launch-end'); }, 120000);
  else hideLauncher();
});
ipcMain.handle('cancelLaunch', () => { clearTimeout(launchT); launchT = null; });

ipcMain.handle('add', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Elige el juego o aplicación', properties: ['openFile'],
    filters: [{ name: 'Programas', extensions: ['exe', 'lnk', 'bat'] }]
  });
  if (r.canceled || !r.filePaths[0]) return { status: 'cancel' };
  const exe = r.filePaths[0];
  const name = path.basename(exe).replace(/\.[^.]+$/, '');
  if (cfg.custom.some(c => norm(c.exe) === norm(exe))) return { status: 'dup', name };
  const id = customId(exe);
  cfg.custom.push({ id, name, exe });
  // si coincide con un juego ya detectado, no se añade
  if (!listGames().some(g => g.id === id)) { cfg.custom.pop(); return { status: 'dup', name }; }
  saveCfg();
  prefetchCovers([{ id, type: 'custom', name, exe }]);
  return { status: 'added', id };
});

ipcMain.handle('addFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Elige la carpeta con tus juegos', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { status: 'cancel' };
  const root = r.filePaths[0];
  const exes = await findExes(root, 0, []);
  if (!exes.length) return { status: 'empty' };

  const have = new Set();                                     // lo que ya está en la lista (nombre o .exe)
  for (const g of listGames()) { have.add('n:' + nkey(g.name)); if (g.exe) have.add('e:' + norm(g.exe)); }
  const batch = new Set(), fresh = [];
  let added = 0, dup = 0, firstId = null;
  for (const exe of exes) {
    if (have.has('e:' + norm(exe))) { dup++; continue; }
    let name = nameFromExe(exe), k = 'n:' + nkey(name);
    if (batch.has(k)) { name = path.basename(path.dirname(exe)); k = 'n:' + nkey(name); }   // dos "game.exe": el segundo toma el nombre de su carpeta
    if (have.has(k) || batch.has(k)) { dup++; continue; }
    const id = customId(exe);
    cfg.custom.push({ id, name, exe, folder: root });
    fresh.push({ id, type: 'custom', name, exe });
    batch.add(k); have.add('e:' + norm(exe));
    firstId = firstId || id; added++;
  }
  if (added) { saveCfg(); prefetchCovers(fresh); }
  return { status: added ? 'added' : 'dup', added, dup, id: firstId };
});

// Carpetas importadas: se listan a partir de los juegos que trajeron; quitar una carpeta quita todos sus juegos
ipcMain.handle('folders', () => {
  const m = new Map();
  for (const c of cfg.custom) if (c.folder) m.set(c.folder, (m.get(c.folder) || 0) + 1);
  return [...m].map(([p, count]) => ({ path: p, count })).sort((a, b) => a.path.localeCompare(b.path));
});
ipcMain.handle('removeFolder', (e, folder) => {
  const gone = cfg.custom.filter(c => c.folder === folder);
  cfg.custom = cfg.custom.filter(c => c.folder !== folder);
  for (const c of gone) { delete cfg.recent[c.id]; try { fs.unlinkSync(coverFile(c.id)); } catch {} }
  saveCfg();
  return gone.length;
});
ipcMain.handle('gpuInfo', () => { try { const g = app.getGPUFeatureStatus(); return `modo ${cfg.gpuMode || 'auto'} · compositing ${g.gpu_compositing} · raster ${g.rasterization}`; } catch { return ''; } });

// ----- Optimización automática de gráficos -----
function relaunchApp() {
  app.isQuitting = true;
  stopShell();
  const args = process.argv.slice(1).filter(a => a !== '--hidden');
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;        // portable: el .exe real, no la carpeta temporal
  app.relaunch(exe ? { execPath: exe, args } : { args });
  setTimeout(() => app.exit(0), 150);
}
ipcMain.handle('tuneState', () => ({ done: !!cfg.tune?.done, mode: cfg.gpuMode || 'auto', tried: cfg.tune?.tried || {} }));
ipcMain.handle('perf', (e, p) => {
  const fps = Number(p && p.fps);
  const t = cfg.tune || (cfg.tune = { done: false, tried: {} });
  if (t.done || !isFinite(fps)) return { action: 'none' };
  const cur = cfg.gpuMode || 'auto';
  t.tried[cur] = Math.round(fps); t.pending = false;
  const next = GPU_MODES.find(m => !(m.id in t.tried));
  if (fps >= 52 || !next) {                                  // suficiente (o no quedan modos): se queda con el mejor
    const best = Object.entries(t.tried).sort((a, b) => b[1] - a[1])[0][0];
    t.done = true;
    if (best !== cur) { cfg.gpuMode = best; t.pending = true; saveCfg(); relaunchApp(); return { action: 'restart', mode: best }; }
    saveCfg();
    return { action: 'done', mode: cur, fps };
  }
  cfg.gpuMode = next.id; t.pending = true; saveCfg(); relaunchApp();
  return { action: 'restart', mode: next.id };
});
ipcMain.handle('retune', () => { cfg.tune = { done: false, tried: {}, pending: true }; cfg.gpuMode = 'auto'; saveCfg(); relaunchApp(); });

ipcMain.handle('remove', (e, id) => {
  cfg.custom = cfg.custom.filter(c => c.id !== id);
  delete cfg.recent[id]; if (cfg.manualCovers) delete cfg.manualCovers[id];
  saveCfg();
  try { fs.unlinkSync(coverFile(id)); } catch {}
});

ipcMain.handle('setCover', async (e, id) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Elige una portada', properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  fs.mkdirSync(coversDir(), { recursive: true });
  fs.writeFileSync(coverFile(id), shrink(fs.readFileSync(r.filePaths[0])));
  (cfg.manualCovers = cfg.manualCovers || {})[id] = 1; saveCfg();     // elegida a mano: "mejorar portadas" no la reemplaza
  return fileUrl(coverFile(id)) + '?t=' + Date.now();
});
ipcMain.handle('upgradeCovers', upgradeCovers);

// ---------- Video de fondo ----------
// Se elige en dos pasos para que la interfaz pueda avisar "Copiando…": el archivo se copia a la carpeta de datos
// (sigue funcionando aunque muevas o borres el original). Solo se copia la ruta que salió del diálogo, nunca una que mande la interfaz.
const vidDir = () => path.join(userDir(), 'bgvideo');
const VID_EXT = ['mp4', 'webm', 'mkv', 'mov', 'm4v'];
let pendingVideo = null;
function bgVideoUrl() {
  const f = cfg.bgVideo && path.join(vidDir(), path.basename(cfg.bgVideo));
  return f && fs.existsSync(f) ? coverUrl(f) : '';
}
ipcMain.handle('chooseVideo', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Elige un video para el fondo', properties: ['openFile'], filters: [{ name: 'Videos', extensions: VID_EXT }] });
  if (r.canceled || !r.filePaths[0]) return null;
  pendingVideo = r.filePaths[0];
  let size = 0; try { size = fs.statSync(pendingVideo).size; } catch {}
  return { name: path.basename(pendingVideo), size };
});
ipcMain.handle('useVideo', async () => {
  const src = pendingVideo; pendingVideo = null;
  if (!src) return { error: 'No hay ningún video elegido' };
  const ext = path.extname(src).slice(1).toLowerCase();
  if (!VID_EXT.includes(ext)) return { error: 'Formato de video no compatible' };
  try {
    fs.mkdirSync(vidDir(), { recursive: true });
    const name = 'fondo-' + Date.now() + '.' + ext, dst = path.join(vidDir(), name);
    await fs.promises.copyFile(src, dst);
    for (const f of fs.readdirSync(vidDir())) if (f !== name) { try { fs.unlinkSync(path.join(vidDir(), f)); } catch {} }   // solo se guarda el último
    cfg.bgVideo = name; cfg.bgType = 'video'; saveCfg();
    return { url: bgVideoUrl() };
  } catch (e) { return { error: 'No se pudo copiar el video (¿falta espacio?)' }; }
});

ipcMain.handle('getCfg', () => ({ apiKey: cfg.apiKey, layout: cfg.layout, bg: cfg.bg !== false, autostart: !!cfg.autostart, minimized: !!cfg.minimized, hideTaskbar: cfg.hideTaskbar !== false, padMaps: cfg.padMaps || {}, version: app.getVersion(), updSkip: cfg.updSkip || '', bgMode: cfg.bgMode || 'default', bgColor: cfg.bgColor || '#6b4fa0', bgSpeed: Number.isFinite(cfg.bgSpeed) ? cfg.bgSpeed : 30, artBlur: Number.isFinite(cfg.artBlur) ? cfg.artBlur : 55, bgType: cfg.bgType || 'classic', bgVideo: bgVideoUrl(), btnStyle: cfg.btnStyle || 'min', user: os.userInfo().username }));
ipcMain.handle('setCfg', (e, patch) => {
  if (typeof patch.apiKey === 'string') cfg.apiKey = patch.apiKey.trim();
  if (patch.layout === 'ps4' || patch.layout === 'center' || patch.layout === 'ps3') cfg.layout = patch.layout;
  if (typeof patch.bg === 'boolean') cfg.bg = patch.bg;
  if (typeof patch.autostart === 'boolean') cfg.autostart = patch.autostart;
  if (typeof patch.minimized === 'boolean') cfg.minimized = patch.minimized;
  if (typeof patch.hideTaskbar === 'boolean') cfg.hideTaskbar = patch.hideTaskbar;
  if (patch.padMaps && typeof patch.padMaps === 'object') cfg.padMaps = patch.padMaps;
  if (typeof patch.updSkip === 'string') cfg.updSkip = patch.updSkip.slice(0, 32);
  if (['default', 'color', 'rainbow'].includes(patch.bgMode)) cfg.bgMode = patch.bgMode;
  if (typeof patch.bgColor === 'string' && /^#[0-9a-f]{6}$/i.test(patch.bgColor)) cfg.bgColor = patch.bgColor;
  if (Number.isFinite(patch.bgSpeed)) cfg.bgSpeed = Math.max(1, Math.min(100, Math.round(patch.bgSpeed)));
  if (['classic', 'ps3', 'video'].includes(patch.bgType)) cfg.bgType = patch.bgType;
  if (patch.btnStyle === 'min' || patch.btnStyle === 'color') cfg.btnStyle = patch.btnStyle;
  if (Number.isFinite(patch.artBlur))cfg.artBlur = Math.max(0, Math.min(100, Math.round(patch.artBlur)));
  saveCfg();
  if ('hideTaskbar' in patch) syncTaskbar();
  if ('autostart' in patch || 'minimized' in patch) applyAutostart();
});

// ---------- Actualizaciones (GitHub Releases) ----------
// Mira la última release del repositorio (package.json -> "updateRepo"). Si su versión es mayor y trae un .exe, ofrece actualizar:
// descarga el .exe junto al actual, cierra el programa y un script de Windows lo reemplaza y lo vuelve a abrir.
const UPD_REPO = String(require('./package.json').updateRepo || '');
const semver = v => String(v).replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
function isNewer(a, b) {                      // ¿a es mayor que b?
  const x = semver(a), y = semver(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
  return false;
}
let updInfo = null, updBusy = false;
async function updCheck() {
  const cur = app.getVersion();
  if (!/^[\w.-]+\/[\w.-]+$/.test(UPD_REPO)) return { ok: false, current: cur, error: 'Falta configurar el repositorio de GitHub (updateRepo en package.json)' };
  try {
    const r = await fetch(`https://api.github.com/repos/${UPD_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'PS-Launcher', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000)
    });
    if (r.status === 404) return { ok: true, current: cur, available: false };       // todavía no hay ninguna release
    if (!r.ok) return { ok: false, current: cur, error: 'GitHub respondió ' + r.status };
    const rel = await r.json();
    const version = String(rel.tag_name || '').replace(/^v/i, '');
    const exes = (rel.assets || []).filter(a => /\.exe$/i.test(a.name) && a.browser_download_url);
    const asset = exes.find(a => /^PS-Launcher\.exe$/i.test(a.name)) || exes[0];
    if (!version || !asset || !isNewer(version, cur)) { updInfo = null; return { ok: true, current: cur, available: false }; }
    updInfo = { version, url: asset.browser_download_url, size: asset.size || 0 };
    return { ok: true, current: cur, available: true, version };
  } catch (e) { return { ok: false, current: cur, error: 'No se pudo comprobar (¿sin conexión?)' }; }
}
async function updInstall() {
  if (updBusy) return { ok: false, error: 'Ya se está descargando' };
  if (!updInfo) return { ok: false, error: 'No hay ninguna actualización pendiente' };
  const target = process.env.PORTABLE_EXECUTABLE_FILE;
  if (process.platform !== 'win32' || !target) return { ok: false, error: 'Solo se puede actualizar solo desde el .exe portable' };
  if (!updInfo.url.startsWith(`https://github.com/${UPD_REPO}/releases/download/`)) return { ok: false, error: 'Dirección de descarga no válida' };
  updBusy = true;
  const tmp = path.join(path.dirname(target), 'PS-Launcher.update.exe');
  try {
    const r = await fetch(updInfo.url, { headers: { 'User-Agent': 'PS-Launcher' }, signal: AbortSignal.timeout(600000) });
    if (!r.ok || !r.body) throw new Error('Descarga rechazada (' + r.status + ')');
    const total = Number(r.headers.get('content-length')) || updInfo.size || 0;
    const out = fs.createWriteStream(tmp);
    let got = 0, last = 0;
    for await (const chunk of r.body) {
      if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
      got += chunk.length;
      const now = Date.now();
      if (total && now - last > 120 && win && !win.isDestroyed()) { last = now; win.webContents.send('upd-progress', Math.min(99, Math.floor(got / total * 100))); }
    }
    await new Promise((res, rej) => { out.once('error', rej); out.end(res); });
    const head = Buffer.alloc(2), fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
    if (got < 1e6 || head.toString('latin1') !== 'MZ' || (total && got !== total)) throw new Error('El archivo descargado está incompleto');
    // Script: espera a que este programa se cierre (el .exe deja de estar bloqueado), lo reemplaza y abre el nuevo
    const bat = path.join(os.tmpdir(), 'pslauncher-update.bat');
    fs.writeFileSync(bat, [
      '@echo off', 'chcp 65001 >nul', 'set n=0', ':retry',
      `move /Y "${tmp}" "${target}" >nul 2>&1`, 'if not errorlevel 1 goto ok',
      'set /a n+=1', 'if %n% GEQ 90 goto fail', 'ping -n 2 127.0.0.1 >nul', 'goto retry',
      ':ok', `start "" "${target}"`, 'del "%~f0"', 'exit',
      ':fail', 'del "%~f0"', 'exit', ''
    ].join('\r\n'), 'utf8');
    if (win && !win.isDestroyed()) win.webContents.send('upd-progress', 100);
    const env = { ...process.env }; for (const k of Object.keys(env)) if (k.startsWith('PORTABLE_EXECUTABLE')) delete env[k];
    spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
    app.isQuitting = true; stopShell();
    setTimeout(() => app.exit(0), 400);
    return { ok: true };
  } catch (e) {
    updBusy = false;
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  }
}
ipcMain.handle('updCheck', updCheck);
ipcMain.handle('updInstall', updInstall);
ipcMain.handle('hide', hideLauncher);
ipcMain.handle('quit', () => { app.isQuitting = true; app.quit(); });

// ---------- Arranque ----------
app.on('second-instance', showLauncher);
app.whenReady().then(() => {
  if (!gotLock) return;
  cfg = loadCfg();
  lib = loadLib();
  applyAutostart();     // vuelve a registrar la ruta actual por si moviste el .exe
  createWin();
  startShell();

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('PS Launcher');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: showLauncher },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', toggle);

  registerHotkey();
  win.webContents.once('did-finish-load', () => {
    if (cfg.tune && cfg.tune.pending) { cfg.tune.pending = false; saveCfg(); }       // este modo gráfico arrancó bien
    if (!process.argv.includes('--hidden')) showLauncher();
  });
  // Borra restos de una actualización fallida y comprueba si hay versión nueva (unos segundos después de abrir, y cada 6 h)
  try { if (process.env.PORTABLE_EXECUTABLE_FILE) fs.unlinkSync(path.join(path.dirname(process.env.PORTABLE_EXECUTABLE_FILE), 'PS-Launcher.update.exe')); } catch {}
  const autoCheck = async () => { if (updBusy || !win || win.isDestroyed()) return; const r = await updCheck(); if (r.available && !win.isDestroyed()) win.webContents.send('upd-available', { version: r.version }); };
  setTimeout(autoCheck, 12000); setInterval(autoCheck, 6 * 3600 * 1000);
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopShell(); });
app.on('window-all-closed', e => e.preventDefault());
