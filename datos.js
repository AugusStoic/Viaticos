/* datos.js — lo comparten la app y la guía de administración.
   - Lee la lista de servicios y de personas tal como se pegan desde Excel.
   - Cifra y descifra el archivo "datos.cifrado" con el código de la empresa,
     para que la lista de servicios y del personal no se pueda leer online.
   Cifrado: AES-GCM de 256 bits; la clave sale del código con PBKDF2 (SHA-256, 250.000 vueltas).
   Todo pasa dentro del navegador: el código nunca se manda a ningún lado. */
'use strict';

// Para comparar sin importar mayúsculas ni tildes
function normalizar(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

const Datos = {
  PERFILES_VALIDOS: ['pie', 'camioneta', 'admin'],

  // Servicios: una línea por servicio, columnas separadas por TAB (como sale al copiar de Excel).
  // Columna 1 = nombre. El resto = dirección (calle, número, localidad...). Los repetidos se ignoran.
  leerServicios(texto) {
    const vistos = new Set();
    const lista = [];
    for (const linea of String(texto || '').split(/\r?\n/)) {
      const cols = linea.split('\t').map(s => s.trim());
      const nombre = cols[0].replace(/\s+/g, ' ');
      if (!nombre || /^(servicio|servicios|nombre|cliente)$/i.test(nombre)) continue;
      let resto = cols.slice(1).filter(v => v && v !== '0');
      resto = resto.filter((v, i) => i === 0 || normalizar(v) !== normalizar(resto[i - 1])); // "CABA, CABA" -> "CABA"
      let dir;
      if (resto.length >= 2 && /^\d/.test(resto[1])) dir = [resto[0] + ' ' + resto[1], ...resto.slice(2)].join(', ');
      else dir = resto.join(', ');
      const clave = normalizar(nombre).replace(/[^a-z0-9]/g, '') + '|' + normalizar(dir).replace(/[^a-z0-9]/g, '');
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      lista.push({ nombre, direccion: dir });
    }
    return lista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  },

  // Personas: una por línea, "Nombre Apellido" y el perfil separado por TAB, ";" o "|".
  // Perfiles: pie, camioneta o admin (si no se pone, queda "pie").
  leerPersonas(texto) {
    const lista = [];
    const errores = [];
    for (const linea of String(texto || '').split(/\r?\n/)) {
      if (!linea.trim()) continue;
      const [nombreCrudo, perfilCrudo] = linea.split(/\t|;|\|/).map(s => (s || '').trim());
      const nombre = nombreCrudo.replace(/\s+/g, ' ');
      if (/^(nombre|persona|personas)$/i.test(nombre)) continue;
      let perfil = normalizar(perfilCrudo || 'pie');
      if (perfil.startsWith('admin')) perfil = 'admin';
      if (perfil.startsWith('cami')) perfil = 'camioneta';
      if (perfil.startsWith('pie') || perfil.startsWith('super')) perfil = 'pie';
      if (!Datos.PERFILES_VALIDOS.includes(perfil)) { errores.push(`"${nombre}": perfil "${perfilCrudo}" no existe`); perfil = 'pie'; }
      if (lista.some(p => normalizar(p.nombre) === normalizar(nombre))) continue;
      lista.push({ nombre, perfil });
    }
    return { lista, errores };
  },

  // El código se compara sin mayúsculas, tildes ni espacios: "Limpia Sol 2026" = "limpiasol2026"
  limpiarCodigo(c) { return normalizar(c).replace(/\s+/g, ''); },

  _b64(bytes) { let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); }); return btoa(s); },
  _deB64(t) { return Uint8Array.from(atob(t), c => c.charCodeAt(0)); },

  async _clave(codigo, sal) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(Datos.limpiarCodigo(codigo)), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: sal, iterations: 250000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  },

  // objeto -> texto del archivo datos.cifrado
  async cifrar(objeto, codigo) {
    const sal = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const clave = await Datos._clave(codigo, sal);
    const datos = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, clave,
      new TextEncoder().encode(JSON.stringify(objeto))));
    return JSON.stringify({ formato: 'viaticos-cifrado', version: 1, sal: Datos._b64(sal), iv: Datos._b64(iv), datos: Datos._b64(datos) });
  },

  // texto del archivo -> objeto. Si el código es incorrecto, tira un error.
  async descifrar(texto, codigo) {
    const a = JSON.parse(texto);
    const clave = await Datos._clave(codigo, Datos._deB64(a.sal));
    let plano;
    try { plano = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Datos._deB64(a.iv) }, clave, Datos._deB64(a.datos)); }
    catch (e) { throw new Error('codigo incorrecto'); }
    return JSON.parse(new TextDecoder().decode(plano));
  }
};
