// Lectura del JSON de LibreHardwareMonitor / OpenHardwareMonitor (módulo puro, sin Electron)
const num = v => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : null; };

function walk(n, trail, out) {
  const p = [...trail, { text: n.Text || '', img: String(n.ImageURL || '').toLowerCase() }];
  if (n.Children?.length) n.Children.forEach(c => walk(c, p, out));
  else out.push({ path: p.map(x => x.text), imgs: p.map(x => x.img), text: String(n.Text || ''), raw: String(n.Value ?? '') });
}

// Solo valores en grados Celsius y con sentido físico
function celsius(raw) {
  if (/°?\s*F\s*$/i.test(raw) && !/C\s*$/i.test(raw)) return null;
  const v = num(raw);
  return v != null && v >= 10 && v <= 110 ? v : null;
}

// Sensores que NO son una temperatura real aunque estén bajo "Temperatures"
// ("Distance to TjMax" = grados que faltan hasta el límite)
const NOT_A_TEMP = /distance|tjmax|t\s?junction\s?max|limit|critical|margin|offset|warning|resolution/i;

function parseLhm(j) {
  const s = [];
  walk(j, [], s);
  const temps = s.filter(v => v.path.includes('Temperatures') && !NOT_A_TEMP.test(v.text));
  const inHw = (v, re) => v.imgs.some(i => re.test(i));

  const pick = (list, names) => {
    for (const re of names) {
      const x = list.find(v => re.test(v.text));
      const t = x && celsius(x.raw);
      if (t != null) return t;
    }
    return null;
  };

  const gpuT = temps.filter(v => inHw(v, /nvidia|ati|amd|gpu|intel/) && !inHw(v, /cpu/));
  const gpuTemp = pick(gpuT, [/^GPU Core$/i, /^GPU Hot Spot$/i]);
  const gx = s.find(v => v.path.includes('Load') && /^GPU Core$/i.test(v.text));
  return { gpuTemp, gpuUse: gx ? num(gx.raw) : null };
}

module.exports = { parseLhm };
