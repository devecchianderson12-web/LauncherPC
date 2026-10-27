const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, shell, nativeImage, screen } = require('electron');
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
// "soft" (sin GPU) va último y solo se elige si ningún modo con GPU funciona: sin GPU el contador de fps no está atado a la
// frecuencia del monitor y da números altísimos (100+) aunque se vea peor, así que no se puede comparar con los demás.
const GPU_MODES = [
  { id: 'auto' },                                         // valores por defecto de Chromium
  { id: 'low',  sw: ['force_low_power_gpu'] },            // GPU integrada
  { id: 'gl',   sw: ['use-angle', 'gl'] },                // ANGLE sobre OpenGL
  { id: 'high', sw: ['force_high_performance_gpu'] },     // GPU dedicada
  { id: 'soft', soft: true }                              // sin aceleración por GPU (último recurso)
];
// El mejor modo probado: el de más fps entre los que usan GPU (con al menos 20 fps); "soft" solo si ninguno sirve
function bestMode(tried) {
  const gpu = Object.entries(tried).filter(([m, f]) => m !== 'soft' && f >= 20).sort((a, b) => b[1] - a[1]);
  return gpu.length ? gpu[0][0] : ('soft' in tried && tried.soft > 0 ? 'soft' : 'auto');
}
const earlyCfgFile = path.join(app.getPath('userData'), 'config.json');
let early = {};
try { early = JSON.parse(fs.readFileSync(earlyCfgFile, 'utf8')); } catch {}
(function pickGpuMode() {
  early.tune = early.tune || { done: false, tried: {} };
  // Hasta la 1.10.0 la prueba daba por fallado cada modo nuevo sin medirlo (ver 'pending' abajo), así que casi todos
  // quedaron en un modo malo ("soft" o "gl"). Se vuelve a probar una vez desde el modo normal, con la prueba arreglada.
  // tuneVer 4: con 'in-process-gpu' (abajo) la GPU deja de estar limitada a 20 fps, así que se mide otra vez.
  if (early.tuneVer !== 4) {
    early.gpuMode = 'auto'; early.tune = { done: false, tried: {} }; early.tuneVer = 4;
    try { fs.writeFileSync(earlyCfgFile, JSON.stringify(early, null, 2)); } catch {}
  }
  const tt = early.tune;
  let id = GPU_MODES.some(m => m.id === early.gpuMode) ? early.gpuMode : 'auto';
  // 'pending' se marca AL ARRANCAR un modo en prueba y se borra cuando la interfaz carga (did-finish-load).
  // Si al arrancar sigue marcado para este mismo modo, el arranque anterior se colgó o se cerró: ese modo falla.
  // (Antes se marcaba justo antes de reiniciar, y el arranque siguiente lo leía como fallo sin probarlo.)
  if (tt.pending && tt.pendingMode === id) {
    tt.tried[id] = 0;
    const next = GPU_MODES.find(m => !(m.id in tt.tried));
    if (next) id = next.id; else { id = bestMode(tt.tried); tt.done = true; }
    early.gpuMode = id;
  }
  tt.pending = !tt.done; tt.pendingMode = tt.done ? undefined : id;
  try { fs.writeFileSync(earlyCfgFile, JSON.stringify(early, null, 2)); } catch {}
  const m = GPU_MODES.find(x => x.id === id);
  if (m.soft) app.disableHardwareAcceleration();
  else {
    if (m.sw) app.commandLine.appendSwitch(...m.sw);
    // La GPU dibuja dentro del proceso principal (el dueño de la ventana). Con el proceso de GPU aparte, el driver
    // de NVIDIA lo trata como app "en segundo plano" y, si está activado "Velocidad máxima de fotogramas de aplicación
    // en segundo plano", lo limita (medido en una GTX 1660 a 200 Hz: 20 fps aparte, 200 fps dentro).
    app.commandLine.appendSwitch('in-process-gpu');
  }
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

// ---------- Nombre real de un juego suelto (portable, instalado a mano, carpeta importada) ----------
// El nombre del .exe muchas veces no sirve para buscar ("PES2021", "ReSkateLauncher", "Play God of War III").
// Se prueban, en orden: el nombre de producto guardado en el .exe, el del .exe limpio y los de sus carpetas limpios.
const exeProductCache = new Map();
function exeProduct(exe) {
  if (!exe || process.platform !== 'win32') return Promise.resolve('');
  const c = cfg.custom.find(x => norm(x.exe) === norm(exe));
  if (c && typeof c.product === 'string') return Promise.resolve(c.product);       // ya se leyó otra vez: queda en config.json
  if (exeProductCache.has(exe)) return exeProductCache.get(exe);
  const p = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$v=(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo; if ($v.ProductName) { $v.ProductName } else { $v.FileDescription }`], 8000)
    .then(o => {
      const s = String(o || '').trim().split(/\r?\n/)[0].trim().slice(0, 80);
      const ok = s && !/^(launcher|game|application|unity|unreal|electron|bootstrap)/i.test(s) ? s : '';
      if (c) { c.product = ok; saveCfg(); }
      return ok;
    });
  exeProductCache.set(exe, p);
  return p;
}
// "eFootball-PES-2021-SteamRIP.com" → "eFootball PES 2021"; "ReSkateLauncher" → "ReSkate"; "gow3-windows" → "gow 3"
// (no se separan minúscula-mayúscula: rompería nombres como "eFootball")
function cleanName(s) {
  return String(s || '').replace(/\.(exe|lnk|bat)$/i, '').replace(/(?<=[a-z])(Launcher|Game|Win64|Shipping)$/, '')
    .replace(/[\[(][^\])]*[\])]/g, ' ')                                              // [FitGirl Repack], (x64)…
    .replace(/[-_. ]*(steam\s?rip(\.com)?|fitgirl|dodi|repack|gog|elamigos|codex|plaza|empress|skidrow|rune|tenoke)\b.*$/i, '')
    .replace(/[_.\-+]+/g, ' ')
    .replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/\b(v?\d+(\s\d+){1,3}|x64|x86|win(dows)?\s?\d*|64\s?bit|32\s?bit|launcher|play|portable|setup|build|update|com)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}
const GENERIC_DIR = /^(juegos?|games?|gaming|program ?files( \(x86\))?|programas|steam ?library|steamapps|common|desktop|escritorio|downloads?|descargas|documents|documentos|bin|binaries|win(32|64)|x64|x86|apps?|portable|[a-z])$/i;
async function gameNames(g) {
  const out = [], add = s => { s = String(s || '').trim(); if (s.length >= 3 && !GENERIC_DIR.test(s) && !out.some(x => nkey(x) === nkey(s))) out.push(s); };
  if (g.exe) add(await exeProduct(g.exe).catch(() => ''));
  add(cleanName(g.name));
  if (g.exe) { const d = path.dirname(g.exe); add(cleanName(path.basename(d))); add(cleanName(path.basename(path.dirname(d)))); }
  add(g.name);
  return out.slice(0, 4);
}
// Parecido entre lo buscado y un título: palabras en común, y los números tienen que coincidir ("III" cuenta como 3)
const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
const toks = s => String(s).toLowerCase().replace(/[™®©:]/g, ' ').split(/[^a-z0-9]+/).filter(Boolean).map(w => ROMAN[w] || w);
function nameScore(query, title) {
  const q = toks(query), t = new Set(toks(title));
  if (!q.length) return 0;
  if (q.filter(w => /^\d+$/.test(w)).some(n => !t.has(n))) return 0;                // "PES 2021" no es "PES 2020"
  let hit = q.filter(w => t.has(w)).length / q.length;
  if (nkey(title).includes(nkey(query))) hit = Math.max(hit, .9);
  return hit - Math.max(0, t.size - q.length) * .03;                                 // a igualdad, el título más corto
}
// Muchos juegos portables o "repacks" traen su appid de Steam en la carpeta: steam_appid.txt, CPY.ini, steam_emu.ini,
// OnlineFix.ini… ("AppID=1259970"). Sirve aunque el juego ya no esté a la venta (la búsqueda de la tienda no lo encuentra)
async function localSteamId(g) {
  const dir = g.exe ? path.dirname(g.exe) : g.dir;
  if (!dir || path.parse(path.resolve(dir)).root === path.resolve(dir)) return null;
  const files = [];
  const walk = async (d, depth) => {
    let ents = []; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isFile() && (/^steam_appid\.txt$/i.test(e.name) || /\.ini$/i.test(e.name))) files.push(f);
      else if (e.isDirectory() && depth < 2 && /^(steam_settings|bin|binaries|win64|x64)$/i.test(e.name)) await walk(f, depth + 1);
    }
  };
  await walk(dir, 0);
  for (const f of files.sort((a, b) => /steam_appid/i.test(b) - /steam_appid/i.test(a))) {
    try {
      const t = (await fs.promises.readFile(f, 'utf8')).slice(0, 20000);
      const m = /steam_appid\.txt$/i.test(f) ? /^\s*(\d{3,8})\s*$/m.exec(t) : /^\s*(?:real)?app_?id\s*=\s*(\d{3,8})\s*$/im.exec(t);
      if (m && +m[1] > 10 && +m[1] !== 480) return +m[1];                         // 480 = "Spacewar", el appid de prueba
    } catch {}
  }
  return null;
}
const steamFindCache = new Map();
async function steamFind(g) {
  const key = g.id || g.name;
  if (steamFindCache.has(key)) return steamFindCache.get(key);
  const p = (async () => {
    const own = await localSteamId(g).catch(() => null);
    if (own) return own;
    for (const q of await gameNames(g)) {
      try {
        const r = await (await fetch('https://store.steampowered.com/api/storesearch/?l=english&cc=us&term=' + encodeURIComponent(q), { signal: AbortSignal.timeout(6000) })).json();
        const best = (r.items || []).filter(x => x.type === 'app').map(x => ({ id: x.id, s: nameScore(q, x.name) })).sort((a, b) => b.s - a.s)[0];
        if (best && best.s >= .6) return best.id;
      } catch {}
    }
    return null;
  })();
  steamFindCache.set(key, p);
  return p;
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

// Tienda de Steam (sin clave): con los nombres posibles del juego y solo si el título se parece de verdad (steamFind)
async function steamStoreCover(g, names = ['library_600x900_2x.jpg', 'library_600x900.jpg', 'header.jpg']) {
  const id = await steamFind(g);
  if (!id) return null;
  const base = `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/`;
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
        for (const n of ['library_600x900_2x.jpg', 'library_600x900.jpg', 'header.jpg']) {   // la _2x es la de 600x900
          try { buf = await download(base + n); break; } catch {}
        }
      }
      if (!buf && item.type === 'custom' && item.exe) buf = localCover(item.exe);
      if (!buf) { try { buf = await steamGridCover(item.type === 'custom' ? (await gameNames(item))[0] || item.name : item.name); } catch {} }
      if (!buf && item.type === 'custom') { try { buf = await steamStoreCover(item); } catch {} }
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

// ---------- Portadas en HD (tecla P / gatillo izquierdo) ----------
// Mínimo de calidad: 600 de ancho y 900 de alto (una portada vertical de PS4). Una portada por debajo está "baja" y para
// ella se buscan imágenes que lleguen a ese mínimo o lo superen, nunca menos (también sirven las horizontales grandes,
// como una captura de 1920x1080). El original se guarda en covers\hd\ (lo que cuenta para la resolución) y la baldosa
// usa una copia de hasta 1000x1500.
const HD_W = 600, HD_H = 900;
const isHD = s => !!s && s.width >= HD_W && s.height >= HD_H;
const hdDir = () => path.join(coversDir(), 'hd');
const hdFile = id => path.join(hdDir(), safe(id) + '.jpg');
const imgSize = buf => { try { const i = nativeImage.createFromBuffer(buf); return i.isEmpty() ? null : i.getSize(); } catch { return null; } };
// Reduce a como mucho W x H (sin agrandar) y lo guarda como JPEG
function fitJpeg(buf, W, H, q = 90) {
  const img = nativeImage.createFromBuffer(buf);
  const { width, height } = img.getSize(), k = Math.min(1, W / width, H / height);
  return (k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' }) : img).toJPEG(q);
}
function coverRes(id) {
  for (const f of [hdFile(id), coverFile(id)]) { try { const s = imgSize(fs.readFileSync(f)); if (s) return s; } catch {} }
  return null;
}
// appid de Steam: el propio si es de Steam; si no, se busca con los nombres posibles del juego (ver gameNames)
async function steamAppFor(g) {
  return g.type === 'steam' ? g.appid : steamFind(g);
}
// Imágenes de la carpeta del juego que podrían servir de portada: primero las que se llaman cover/portada/poster/…
// y después las más pesadas (las chicas son iconos o texturas). Se descartan las de más de 30 MB.
async function localImages(dir) {
  if (!dir || path.parse(path.resolve(dir)).root === path.resolve(dir) || GENERIC_DIR.test(path.basename(dir))) return [];   // nunca un disco entero ni "Juegos"
  const found = [];
  const walk = async (d, depth) => {
    let ents = []; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (found.length > 200) return;
      const f = path.join(d, e.name);
      if (e.isFile() && /\.(jpe?g|png|webp)$/i.test(e.name)) { try { const st = await fs.promises.stat(f); if (st.size > 150e3 && st.size < 30e6) found.push({ f, size: st.size, named: /cover|portada|poster|boxart|key ?art|folder|banner|hero|wallpaper|background/i.test(e.name) }); } catch {} }
      else if (e.isDirectory() && depth < 2 && !JUNK_DIR.test(e.name)) await walk(f, depth + 1);
    }
  };
  await walk(dir, 0);
  return found.sort((a, b) => (b.named - a.named) || (b.size - a.size)).slice(0, 6).map(x => x.f);
}
// Tamaño de una imagen leyendo solo su cabecera (JPEG, PNG o WebP). Sirve para descartar lo que no llega a 600x900
// sin bajar enteras las 50 imágenes: alcanza con los primeros KB del archivo.
function headSize(b) {
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };          // PNG
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {                         // WebP
      const t = b.toString('ascii', 12, 16);
      if (t === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (t === 'VP8L') { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3FFF), height: 1 + ((v >> 14) & 0x3FFF) }; }
      if (t === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3FFF, height: b.readUInt16LE(28) & 0x3FFF };
    }
    if (b[0] === 0xFF && b[1] === 0xD8) {                                                                       // JPEG: busca el SOF
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xFF) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
}
async function probeSize(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-196607' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return headSize(Buffer.from(await r.arrayBuffer()));
  } catch { return null; }
}
// Hasta 50 imágenes de 600x900 o más (verticales tipo portada u horizontales grandes), nunca menos. Fuentes, en orden:
// portada vertical de Steam (600x900), arte principal de Steam (3840x1240), portadas y banners de SteamGridDB (con clave en
// Ajustes; es donde más opciones hay), todas las capturas de Steam (1920x1080) e imágenes grandes de la carpeta del juego.
// Se muestra una miniatura de cada una; el tamaño real se lee de la cabecera y la imagen entera se baja solo al elegirla.
const HD_MAX = 50;
async function hdCandidates(g) {
  const list = [];                                            // { url | file, preview, src, w?, h? }
  const appid = await steamAppFor(g).catch(() => null);
  if (appid) {
    const b = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/`;
    // ojo: en el CDN de Steam "library_600x900.jpg" mide 300x450; la de 600x900 es la "_2x"
    list.push({ url: b + 'library_600x900_2x.jpg', preview: b + 'library_600x900.jpg', src: 'Portada de Steam' });
    list.push({ url: b + 'library_hero_2x.jpg', preview: b + 'library_hero.jpg', src: 'Arte de Steam' });
  }
  if (cfg.apiKey) {
    try {
      const h = { Authorization: 'Bearer ' + cfg.apiKey }, get = async p => (await (await fetch('https://www.steamgriddb.com/api/v2/' + p, { headers: h, signal: AbortSignal.timeout(10000) })).json())?.data || [];
      let gid = null;
      if (appid) { try { gid = (await (await fetch(`https://www.steamgriddb.com/api/v2/games/steam/${appid}`, { headers: h, signal: AbortSignal.timeout(8000) })).json())?.data?.id; } catch {} }
      if (!gid) gid = (await get('search/autocomplete/' + encodeURIComponent((await gameNames(g))[0] || g.name)))[0]?.id;
      if (gid) {
        for (const x of await get(`grids/game/${gid}`)) if (isHD(x)) list.push({ url: x.url, preview: x.thumb || x.url, src: 'SteamGridDB', w: x.width, h: x.height });
        for (const x of await get(`heroes/game/${gid}`)) if (isHD(x)) list.push({ url: x.url, preview: x.thumb || x.url, src: 'SteamGridDB (banner)', w: x.width, h: x.height });
      }
    } catch {}
  }
  if (appid) {
    try {
      const d = (await (await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=screenshots`, { signal: AbortSignal.timeout(8000) })).json())?.[appid]?.data || {};
      for (const s of d.screenshots || []) list.push({ url: s.path_full, preview: s.path_thumbnail || s.path_full, src: 'Captura de Steam' });
    } catch {}
  }
  // Juegos portables o instalados a mano: imágenes grandes que vengan en su propia carpeta (hasta 2 subcarpetas)
  for (const f of await localImages(g.exe ? path.dirname(g.exe) : g.dir)) list.push({ file: f, src: 'Carpeta del juego' });
  // Tamaño real de cada una (de a 8): lo que no llega a 600x900 se descarta; de SteamGridDB ya viene en la respuesta
  const seen = new Set(), out = [];
  const todo = list.filter(c => { const k = c.url || c.file; if (seen.has(k)) return false; seen.add(k); return true; });
  for (let i = 0; i < todo.length && out.length < HD_MAX; i += 8) {
    const got = await Promise.all(todo.slice(i, i + 8).map(async c => {
      try {
        if (c.file) {
          const buf = await fs.promises.readFile(c.file), s = imgSize(buf);
          if (!isHD(s)) return null;
          return { ...c, w: s.width, h: s.height, preview: 'data:image/jpeg;base64,' + fitJpeg(buf, 480, 480, 80).toString('base64') };
        }
        const s = c.w && c.h ? { width: c.w, height: c.h } : await probeSize(c.url);
        return isHD(s) ? { ...c, w: s.width, h: s.height } : null;
      } catch { return null; }
    }));
    for (const c of got) if (c && out.length < HD_MAX) out.push(c);
  }
  return out;
}
const hdCands = new Map();
// Datos del juego elegido (solo ese): resolución actual de su portada y si ya llega a HD
function hdInfo(id) {
  hdCands.clear();
  const g = listGames().find(x => x.id === id);
  if (!g) return null;
  const s = coverRes(id);
  return { id, name: g.name, res: s ? s.width + 'x' + s.height : 'sin portada', hd: isHD(s), key: !!cfg.apiKey };
}
async function hdOptions(id) {
  const g = listGames().find(x => x.id === id);
  if (!g) return [];
  if (!hdCands.has(id)) hdCands.set(id, hdCandidates(g));                       // la promesa se guarda: pedirla dos veces no busca dos veces
  const list = await hdCands.get(id);
  return list.map((c, i) => ({ i, w: c.w, h: c.h, src: c.src, preview: c.preview }));
}
// Guarda una portada elegida por el usuario. Si es HD se guarda el original en covers\hd\ y la baldosa usa una copia de hasta 1000x1500;
// si no, solo la copia reducida de siempre (y se borra una copia HD vieja, que ya no corresponde)
function saveCover(id, buf) {
  fs.mkdirSync(coversDir(), { recursive: true });
  if (isHD(imgSize(buf))) {
    fs.mkdirSync(hdDir(), { recursive: true });
    fs.writeFileSync(hdFile(id), fitJpeg(buf, 3840, 3840, 92));
    fs.writeFileSync(coverFile(id), fitJpeg(buf, 1000, 1500, 88));
  } else {
    fs.writeFileSync(coverFile(id), shrink(buf));
    try { fs.unlinkSync(hdFile(id)); } catch {}
  }
}
// La imagen entera se baja recién al elegirla, y se vuelve a comprobar que llegue a 600x900
async function hdApply(id, i) {
  const c = (await hdCands.get(id))?.[i];
  if (!c) return null;
  try {
    const buf = c.file ? await fs.promises.readFile(c.file) : await download(c.url);
    const s = imgSize(buf);
    if (!isHD(s)) { note(s ? `Esa imagen resultó de ${s.width}x${s.height}, menos que 600x900: elegí otra` : 'No se pudo leer esa imagen: elegí otra'); return null; }
    saveCover(id, buf);
    (cfg.manualCovers = cfg.manualCovers || {})[id] = 1; saveCfg();
    coverFail.delete(id);
    const lg = lib.games.find(x => x.id === id);
    if (lg && lg.cover !== coverFile(id)) { lg.cover = coverFile(id); saveLib(); }
    return coverUrl(coverFile(id));
  } catch { note('No se pudo descargar esa imagen: elegí otra'); return null; }
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
  for (const c of gone) { delete cfg.recent[c.id]; try { fs.unlinkSync(coverFile(c.id)); } catch {} try { fs.unlinkSync(hdFile(c.id)); } catch {} }
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
  t.tried[cur] = Math.round(fps);
  const next = GPU_MODES.find(m => !(m.id in t.tried));
  // "Suficiente" = ~85 % de la frecuencia del monitor (con tope en 52): en un monitor de 50 Hz no se exigen 52 fps imposibles
  let hz = 60; try { hz = screen.getPrimaryDisplay().displayFrequency || 60; } catch {}
  const enough = Math.min(52, hz * .85);
  if ((fps >= enough && cur !== 'soft') || !next || next.id === 'soft' && Object.entries(t.tried).some(([m, f]) => m !== 'soft' && f >= 20)) {
    const best = bestMode(t.tried);                          // suficiente, o ya se probaron todos los modos con GPU: el mejor
    t.done = true;
    if (best !== cur) { cfg.gpuMode = best; saveCfg(); relaunchApp(); return { action: 'restart', mode: best }; }
    saveCfg();
    return { action: 'done', mode: cur, fps };
  }
  cfg.gpuMode = next.id; saveCfg(); relaunchApp();                 // el arranque siguiente marca pending solo
  return { action: 'restart', mode: next.id };
});
// Sin 'pending': si no, el arranque siguiente daba por fallado el modo 'auto' sin probarlo y saltaba al siguiente
ipcMain.handle('retune', () => { cfg.tune = { done: false, tried: {} }; cfg.gpuMode = 'auto'; saveCfg(); relaunchApp(); });

ipcMain.handle('remove', (e, id) => {
  cfg.custom = cfg.custom.filter(c => c.id !== id);
  delete cfg.recent[id]; if (cfg.manualCovers) delete cfg.manualCovers[id];
  saveCfg();
  try { fs.unlinkSync(coverFile(id)); } catch {}
  try { fs.unlinkSync(hdFile(id)); } catch {}
});

ipcMain.handle('setCover', async (e, id) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Elige una portada', properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  fs.mkdirSync(coversDir(), { recursive: true });
  saveCover(id, fs.readFileSync(r.filePaths[0]));
  (cfg.manualCovers = cfg.manualCovers || {})[id] = 1; saveCfg();     // elegida a mano
  return fileUrl(coverFile(id)) + '?t=' + Date.now();
});
ipcMain.handle('hdInfo', (e, id) => hdInfo(id));
ipcMain.handle('hdOptions', (e, id) => hdOptions(id));
ipcMain.handle('hdApply', (e, id, i) => hdApply(id, i));
ipcMain.handle('hdDone', () => { hdCands.clear(); });             // libera las imágenes descargadas

// ---------- Explorador de portadas propio (pantalla completa, cuadros grandes, mando) ----------
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;
const MAX_ENTRIES = 3000;
// Lugares rápidos: carpeta del juego, Imágenes, Descargas, Escritorio, Documentos y los discos
ipcMain.handle('pickPlaces', (e, id) => {
  const out = [];
  const g = listGames().find(x => x.id === id);
  const gdir = g && (g.exe ? path.dirname(g.exe) : g.dir);
  if (gdir && fs.existsSync(gdir)) out.push({ name: 'Carpeta del juego', path: gdir, kind: 'game' });
  for (const [k, name] of [['pictures', 'Imágenes'], ['downloads', 'Descargas'], ['desktop', 'Escritorio'], ['documents', 'Documentos']]) {
    try { const p = app.getPath(k); if (fs.existsSync(p)) out.push({ name, path: p, kind: k }); } catch {}
  }
  if (process.platform === 'win32') {
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { const p = l + ':\\'; try { fs.accessSync(p); out.push({ name: 'Disco ' + l + ':', path: p, kind: 'drive' }); } catch {} }
  }
  const last = cfg.pickDir && fs.existsSync(cfg.pickDir) ? cfg.pickDir : null;
  return { places: out, start: last || out.find(p => p.kind === 'pictures')?.path || out[0]?.path || os.homedir() };
});
// Contenido de una carpeta: primero las subcarpetas, después las imágenes (sin archivos ocultos ni de sistema)
ipcMain.handle('pickList', async (e, dir) => {
  try {
    dir = path.resolve(String(dir));
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    const dirs = [], imgs = [];
    for (const d of ents) {
      if (d.name.startsWith('.') || d.name.startsWith('$') || /^(system volume information|desktop\.ini|thumbs\.db)$/i.test(d.name)) continue;
      if (d.isDirectory()) dirs.push({ name: d.name, path: path.join(dir, d.name), type: 'dir' });
      else if (d.isFile() && IMG_EXT.test(d.name)) imgs.push({ name: d.name, path: path.join(dir, d.name), type: 'img' });
    }
    const by = (a, b) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' });
    const entries = [...dirs.sort(by), ...imgs.sort(by)];
    const parent = path.dirname(dir);
    cfg.pickDir = dir;                                   // se recuerda la última carpeta (se guarda al aplicar una portada)
    return { dir, parent: parent !== dir ? parent : null, entries: entries.slice(0, MAX_ENTRIES), more: Math.max(0, entries.length - MAX_ENTRIES) };
  } catch { return { dir, error: 'No se puede abrir esta carpeta' }; }
});
// Miniatura con la caché de miniaturas de Windows (rápida aunque la foto pese mucho); si falla, se reduce a mano
const thumbCache = new Map();
ipcMain.handle('pickThumb', async (e, file) => {
  file = String(file);
  if (!IMG_EXT.test(file)) return null;
  if (thumbCache.has(file)) return thumbCache.get(file);
  let url = null;
  try {
    let img = await nativeImage.createThumbnailFromPath(file, { width: 360, height: 360 });
    if (img.isEmpty()) throw 0;
    url = img.toDataURL();
  } catch {
    try {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) { const { width, height } = img.getSize(), k = Math.min(1, 360 / Math.max(width, height)); url = img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }).toJPEG(80).toString('base64'); url = 'data:image/jpeg;base64,' + url; }
    } catch {}
  }
  if (thumbCache.size > 1500) thumbCache.delete(thumbCache.keys().next().value);
  thumbCache.set(file, url);
  return url;
});
ipcMain.handle('pickApply', (e, id, file) => {
  file = String(file);
  if (!IMG_EXT.test(file) || !fs.existsSync(file)) return null;
  try {
    fs.mkdirSync(coversDir(), { recursive: true });
    saveCover(id, fs.readFileSync(file));
    (cfg.manualCovers = cfg.manualCovers || {})[id] = 1; saveCfg();     // elegida a mano
    const g = lib.games.find(x => x.id === id);
    if (g && g.cover !== coverFile(id)) { g.cover = coverFile(id); saveLib(); }
    return coverUrl(coverFile(id));
  } catch { return null; }
});

// Avisos cortos para la interfaz (se muestran como toast)
function note(msg) { if (win && !win.isDestroyed()) win.webContents.send('note', msg); }

// ---------- Video de fondo ----------
// Se elige en dos pasos para que la interfaz pueda avisar "Copiando…": el archivo se copia a la carpeta de datos
// (sigue funcionando aunque muevas o borres el original). Solo se copia la ruta que salió del diálogo, nunca una que mande la interfaz.
// Video de la ola del XMB que viene con el launcher (assets/xmb-wave.mp4). En el .exe va fuera del .asar
// (package.json → asarUnpack): Chromium lo lee directo del disco, sin pasar por el archivo empaquetado.
function xmbVideoUrl() {
  const f = path.join(__dirname, 'assets', 'xmb-wave.mp4').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return fs.existsSync(f) ? fileUrl(f) : '';
}
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

ipcMain.handle('getCfg', () => ({ apiKey: cfg.apiKey, layout: cfg.layout, bg: cfg.bg !== false, autostart: !!cfg.autostart, minimized: !!cfg.minimized, hideTaskbar: cfg.hideTaskbar !== false, padMaps: cfg.padMaps || {}, version: app.getVersion(), updSkip: cfg.updSkip || '', bgMode: cfg.bgMode || 'default', bgColor: cfg.bgColor || '#6b4fa0', bgSpeed: Number.isFinite(cfg.bgSpeed) ? cfg.bgSpeed : 30, artBlur: Number.isFinite(cfg.artBlur) ? cfg.artBlur : 55, bgSharp: Number.isFinite(cfg.bgSharp) ? cfg.bgSharp : 100, bgBlur: Number.isFinite(cfg.bgBlur) ? cfg.bgBlur : 0, ps3Src: cfg.ps3Src || 'hd', bgType: cfg.bgType || 'classic', bgVideo: bgVideoUrl(), xmbVideo: xmbVideoUrl(), btnStyle: cfg.btnStyle || 'min', user: os.userInfo().username }));
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
  if (Number.isFinite(patch.artBlur)) cfg.artBlur = Math.max(0, Math.min(100, Math.round(patch.artBlur)));
  if (patch.ps3Src === 'hd' || patch.ps3Src === 'video') cfg.ps3Src = patch.ps3Src;
  if (Number.isFinite(patch.bgBlur)) cfg.bgBlur = Math.max(0, Math.min(100, Math.round(patch.bgBlur)));
  if (Number.isFinite(patch.bgSharp)) cfg.bgSharp = Math.max(25, Math.min(100, Math.round(patch.bgSharp)));
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
    if (cfg.tune && cfg.tune.pending) { cfg.tune.pending = false; delete cfg.tune.pendingMode; saveCfg(); }   // este modo gráfico arrancó bien
    if (!process.argv.includes('--hidden')) showLauncher();
  });
  // Borra restos de una actualización fallida y comprueba si hay versión nueva (unos segundos después de abrir, y cada 6 h)
  try { if (process.env.PORTABLE_EXECUTABLE_FILE) fs.unlinkSync(path.join(path.dirname(process.env.PORTABLE_EXECUTABLE_FILE), 'PS-Launcher.update.exe')); } catch {}
  const autoCheck = async () => { if (updBusy || !win || win.isDestroyed()) return; const r = await updCheck(); if (r.available && !win.isDestroyed()) win.webContents.send('upd-available', { version: r.version }); };
  setTimeout(autoCheck, 12000); setInterval(autoCheck, 6 * 3600 * 1000);
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopShell(); });
app.on('window-all-closed', e => e.preventDefault());
