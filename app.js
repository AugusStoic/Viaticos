/* =====================================================================
   Viáticos Limpiarte — app para cargar los gastos del día desde el celular.

   - No hay servidor ni usuarios: todo queda guardado en el teléfono.
     · Los gastos y los datos de la persona, en localStorage.
     · Las fotos de tickets, en IndexedDB (se borran solas a los 60 días).
   - La lista de personas, la oficina y las tarifas vienen de config.json.
   - La lista de servicios viene de servicios.txt (pegada desde Excel).
   ===================================================================== */
'use strict';

const VERSION_APP = '1.3.0';
const DIAS_FOTOS = 60;            // las fotos más viejas que esto se borran
const PERFILES = {
  pie: 'Supervisor a pie',
  camioneta: 'Supervisor con camioneta',
  admin: 'Administrativo'
};
const ICONOS = {
  VIAJES: '🚌', NAFTA: '⛽', LLAVES: '🔑', INSUMOS: '🧴',
  ESTACIONAMIENTO: '🅿️', PEAJE: '🛣️', 'TRÁMITES': '📄', OTROS: '➕'
};
const CAMINANDO = 'Caminando';   // viaje entre servicios cercanos, sin costo
const MEDIOS = [
  { id: 'Colectivo', ico: '🚌' },
  { id: 'Subte', ico: '🚇' },
  { id: 'Tren', ico: '🚆' }
];

// Estado general de la app
const S = {
  config: null,        // config.json + servicios.txt ya leídos
  errorConfig: '',     // mensaje si config.json tiene un error
  yo: null,            // { nombre, perfil, casa }
  pantalla: '',
  dia: hoyISO(),       // día que se muestra en la pantalla principal
  hist: { modo: 'semana', ref: hoyISO() },
  f: null,             // gasto que se está cargando o editando
  instalar: null,      // evento para instalar la app
  empujado: false, modalEmpujado: false, ignorarPop: 0
};

/* ---------------------------------------------------------------------
   Utilidades: fechas, plata, textos
   --------------------------------------------------------------------- */
function pad(n) { return String(n).padStart(2, '0'); }
function isoDe(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function hoyISO() { return isoDe(new Date()); }
function fechaDe(iso) { const [a, m, d] = iso.split('-').map(Number); return new Date(a, m - 1, d, 12); }
function sumarDias(iso, n) { const d = fechaDe(iso); d.setDate(d.getDate() + n); return isoDe(d); }
function ddmm(iso) { const [, m, d] = iso.split('-'); return d + '/' + m; }
function ddmmaaaa(iso) { const [a, m, d] = iso.split('-'); return d + '/' + m + '/' + a; }
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function nombreDia(iso) { return DIAS[fechaDe(iso).getDay()]; }

// 1234.5 -> "$1.234,50"
function plata(n) {
  n = Math.round((Number(n) || 0) * 100) / 100;
  const [ent, dec] = Math.abs(n).toFixed(2).split('.');
  return (n < 0 ? '-' : '') + '$' + ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec;
}
// 1234.5 -> "1234,50" (para mostrar dentro de un campo)
function montoCampo(n) {
  if (!n) return '';
  const t = (Math.round(n * 100) / 100).toFixed(2).replace('.', ',');
  return t.endsWith(',00') ? t.slice(0, -3) : t;
}
// Entiende "1002", "1.002", "887,87", "$ 1.753,00" -> número
function leerMonto(txt) {
  let s = String(txt || '').replace(/[^\d,.]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}
function esc(t) {
  return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// normalizar() (para buscar sin mayúsculas ni tildes) está en datos.js
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function $(sel, base) { return (base || document).querySelector(sel); }
function $$(sel, base) { return Array.from((base || document).querySelectorAll(sel)); }

/* ---------------------------------------------------------------------
   Guardado en el teléfono
   --------------------------------------------------------------------- */
const LS = {
  get(clave, porDefecto) {
    try { const v = localStorage.getItem('viaticos.' + clave); return v ? JSON.parse(v) : porDefecto; }
    catch (e) { return porDefecto; }
  },
  set(clave, valor) { localStorage.setItem('viaticos.' + clave, JSON.stringify(valor)); }
};
function todosLosGastos() { return LS.get('gastos', []); }
function guardarTodos(lista) { LS.set('gastos', lista); }
function ordenar(lista) { return lista.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.creado - b.creado); }
function gastosEntre(desde, hasta) { return ordenar(todosLosGastos().filter(g => g.fecha >= desde && g.fecha <= hasta)); }
function gastosDelDia(iso) { return gastosEntre(iso, iso); }
function sumar(lista) { return Math.round(lista.reduce((s, g) => s + (Number(g.monto) || 0), 0) * 100) / 100; }

// Fotos en IndexedDB: { blob, creado }
const Fotos = {
  db: null,
  abrir() {
    return new Promise((ok, mal) => {
      const r = indexedDB.open('viaticos-fotos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('fotos');
      r.onsuccess = () => { this.db = r.result; ok(); };
      r.onerror = () => mal(r.error);
    });
  },
  _pedido(modo, accion) {
    return new Promise((ok, mal) => {
      if (!this.db) return ok(null);
      const r = accion(this.db.transaction('fotos', modo).objectStore('fotos'));
      r.onsuccess = () => ok(r.result);
      r.onerror = () => mal(r.error);
    });
  },
  guardar(id, blob) { return this._pedido('readwrite', s => s.put({ blob, creado: Date.now() }, id)); },
  async leer(id) { const v = id ? await this._pedido('readonly', s => s.get(id)) : null; return v ? v.blob : null; },
  borrar(id) { return this._pedido('readwrite', s => s.delete(id)); },
  // Borra las fotos de más de 60 días para no llenar el teléfono
  limpiarViejas() {
    if (!this.db) return;
    const limite = Date.now() - DIAS_FOTOS * 86400000;
    const r = this.db.transaction('fotos', 'readwrite').objectStore('fotos').openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return;
      if (c.value.creado < limite) c.delete();
      c.continue();
    };
  }
};

// Achica la foto (máx. 1280 px) para que ocupe poco
async function achicarFoto(archivo) {
  try {
    const img = await createImageBitmap(archivo);
    const k = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(ok => c.toBlob(b => ok(b || archivo), 'image/jpeg', 0.7));
  } catch (e) {
    return archivo; // si no se puede achicar, se guarda como vino
  }
}

/* ---------------------------------------------------------------------
   Configuración
   - config.json (público): oficina, tarifas, motivos, propósitos.
   - datos.cifrado (privado): personas y servicios. Se abre con el código de la empresa,
     que cada persona escribe una sola vez y queda guardado en su teléfono.
   --------------------------------------------------------------------- */
function armarConfig(base, datos) {
  return { ...base, personas: datos.personas || [], servicios: datos.servicios || [], actualizado: datos.actualizado || base.actualizado };
}

async function cargarConfig() {
  const guardada = LS.get('config', null);
  try {
    const [rc, rd] = await Promise.all([
      fetch('config.json', { cache: 'no-cache' }),
      fetch('datos.cifrado', { cache: 'no-cache' })
    ]);
    if (!rc.ok || !rd.ok) throw new Error('sin conexión');
    let base;
    try { base = JSON.parse(await rc.text()); }
    catch (e) { throw new Error('config.json tiene un error de escritura (' + e.message + ')'); }
    LS.set('base', base);
    LS.set('cifrado', await rd.text());
  } catch (e) {
    if (/error de escritura/.test(e.message)) S.errorConfig = e.message;
    if (!LS.get('base', null)) return guardada; // sin internet y nunca se bajó nada
  }
  return (await abrirConCodigo(LS.get('codigo', ''))) || guardada;
}

// Intenta abrir datos.cifrado con un código. Devuelve la configuración o null si no se pudo.
async function abrirConCodigo(codigo) {
  const base = LS.get('base', null), cifrado = LS.get('cifrado', null);
  if (!base || !cifrado) return null;
  if (!codigo) { S.pideCodigo = true; return null; }
  try {
    const cfg = armarConfig(base, await Datos.descifrar(cifrado, codigo));
    LS.set('codigo', codigo);
    LS.set('config', cfg);
    S.pideCodigo = false;
    S.errorConfig = '';
    return cfg;
  } catch (e) {
    S.pideCodigo = true; // código incorrecto, o administración lo cambió
    return null;
  }
}
function oficina() { return (S.config && S.config.oficina) || { nombre: 'Oficina', direccion: '' }; }

/* ---------------------------------------------------------------------
   Cómo se describe un gasto (lo usan la lista, WhatsApp y Excel)
   --------------------------------------------------------------------- */
function nombreLugar(l) { return l ? l.nombre : ''; }
function servicioDe(g) {
  if (g.motivo === 'VIAJES') return (nombreLugar(g.origen) || '?') + ' → ' + nombreLugar(g.destino);
  return nombreLugar(g.servicio);
}
function obsDe(g) {
  const partes = [];
  if (g.proposito) partes.push(g.proposito);
  if (g.motivo === 'VIAJES' && g.transportes && g.transportes.length) {
    const tr = g.transportes.map(t => t.medio === CAMINANDO ? 'Caminando'
      : t.medio + (t.linea ? ' ' + t.linea : '') + ' (' + plata(t.monto) + ')').join(' + ');
    partes.push(tr + (g.idaVuelta ? ' · ida y vuelta' : ''));
  }
  if (g.obs) partes.push(g.obs);
  return partes.join(' · ');
}

/* ---------------------------------------------------------------------
   Navegación entre pantallas (el botón "atrás" del celular también anda)
   --------------------------------------------------------------------- */
function mostrar(p) {
  S.pantalla = p;
  $$('.pantalla').forEach(s => s.classList.toggle('visible', s.id === 'p-' + p));
  $('#menu').classList.toggle('oculto', p === 'inicio' || p === 'gasto');
  $$('#menu button').forEach(b => b.classList.toggle('activo', b.dataset.ir === p));
  $('#barra-quien').textContent = S.yo ? S.yo.nombre : '';
  window.scrollTo(0, 0);
  if (p === 'hoy') pantallaHoy();
  if (p === 'historial') pantallaHistorial();
  if (p === 'ajustes') pantallaAjustes();
}
function ir(p) {
  const principal = p === 'hoy' || p === 'inicio';
  if (!principal && !S.empujado) { history.pushState({ p }, ''); S.empujado = true; }
  if (principal && S.empujado) { S.empujado = false; S.ignorarPop++; history.back(); }
  mostrar(p);
}
window.addEventListener('popstate', () => {
  if (S.ignorarPop > 0) { S.ignorarPop--; return; }
  if (!$('#modal').classList.contains('oculto')) { S.modalEmpujado = false; cerrarModal(true); return; }
  if (S.empujado) { S.empujado = false; mostrar('hoy'); }
});

function abrirModal(html) {
  $('#modal-caja').innerHTML = html;
  $('#modal').classList.remove('oculto');
  $('#modal-caja').scrollTop = 0;
  if (!S.modalEmpujado) { history.pushState({ m: 1 }, ''); S.modalEmpujado = true; }
  $$('[data-cerrar]', $('#modal-caja')).forEach(b => b.onclick = () => cerrarModal());
}
function cerrarModal(desdeHistorial) {
  $('#modal').classList.add('oculto');
  $('#modal-caja').innerHTML = '';
  if (!desdeHistorial && S.modalEmpujado) { S.modalEmpujado = false; S.ignorarPop++; history.back(); }
}
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') cerrarModal(); });

let temporizadorAviso;
function aviso(texto) {
  const a = $('#aviso');
  a.textContent = texto;
  a.classList.remove('oculto');
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => a.classList.add('oculto'), 2800);
}

/* ---------------------------------------------------------------------
   Pantalla 1: primera vez (elegir nombre y perfil)
   --------------------------------------------------------------------- */
// Código de la empresa: se pide la primera vez, o si administración lo cambia
function pantallaCodigo() {
  if (S.pantalla !== 'inicio') ir('inicio');
  const p = $('#p-inicio');
  const cambio = !!LS.get('codigo', '');
  p.innerHTML = `<h1>🔒 Código de la empresa</h1>
    <p>${cambio ? 'Administración <b>cambió el código</b>. Escribí el nuevo.' : 'Escribilo una sola vez. Te lo pasa administración por WhatsApp.'}</p>
    <div class="campo">
      <input type="text" id="codigo" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Código">
      <div class="ayuda">No importan las mayúsculas ni los espacios.</div>
    </div>
    <button class="btn enorme" id="codigo-ok">Entrar</button>
    ${S.config ? '<button class="btn secundario" id="codigo-despues">Más tarde</button>' : ''}`;
  $('#codigo').focus();
  $('#codigo-ok').onclick = async () => {
    const codigo = $('#codigo').value;
    if (!codigo.trim()) return aviso('Escribí el código');
    $('#codigo-ok').disabled = true;
    $('#codigo-ok').textContent = 'Revisando...';
    const cfg = await abrirConCodigo(codigo);
    if (!cfg) {
      $('#codigo-ok').disabled = false;
      $('#codigo-ok').textContent = 'Entrar';
      return aviso(LS.get('cifrado', null) ? '✖ Código incorrecto' : 'Necesitás internet la primera vez');
    }
    S.config = cfg;
    aviso('✔ Listo');
    if (S.yo) ir('hoy'); else pantallaInicio();
  };
  if ($('#codigo-despues')) $('#codigo-despues').onclick = () => { if (S.yo) ir('hoy'); else pantallaInicio(); };
}

function pantallaInicio(persona) {
  const p = $('#p-inicio');
  const c = S.config;
  if (!c && S.pideCodigo) return pantallaCodigo();
  if (!c) {
    p.innerHTML = `<h1>Sin conexión</h1>
      <p>La primera vez la app necesita internet para bajar la lista de servicios.
      Conectate (wifi o datos) y tocá el botón.</p>
      <button class="btn" id="reintentar">Probar de nuevo</button>`;
    $('#reintentar').onclick = async () => { S.config = await cargarConfig(); pantallaInicio(); };
    return;
  }
  if (!persona && !c.personas.length) return pantallaNombreNuevo(); // sin lista: cada uno escribe su nombre
  if (!persona) {
    p.innerHTML = `<h1>¡Hola! 👋</h1>
      <p>Tocá tu nombre:</p>
      <div class="lista-botones">
        ${c.personas.map((x, i) => `<button class="opcion" data-i="${i}">${esc(x.nombre)}</button>`).join('')}
      </div>
      <button class="btn secundario" id="nuevo-nombre">➕ No estoy en la lista</button>`;
    $$('[data-i]', p).forEach(b => b.onclick = () => pantallaInicio(c.personas[b.dataset.i]));
    $('#nuevo-nombre').onclick = () => pantallaNombreNuevo();
    return;
  }
  let perfil = persona.perfil || 'pie';
  const dibujar = () => {
    p.innerHTML = `<h1>${esc(persona.nombre)}</h1>
      <p>¿Cómo trabajás?</p>
      <div class="lista-botones">
        ${Object.entries(PERFILES).map(([id, txt]) =>
          `<button class="opcion ${id === perfil ? 'elegida' : ''}" data-perfil="${id}">${txt}
            <small>${id === 'pie' ? 'Viajo en colectivo, subte o tren' : id === 'camioneta' ? 'Uso la camioneta de la empresa' : 'Salgo a hacer trámites, cobranzas o visitas'}</small>
          </button>`).join('')}
      </div>
      <button class="btn enorme" id="empezar">Empezar</button>
      <button class="btn secundario" id="volver">${c.personas.length ? 'No soy yo' : 'Corregir mi nombre'}</button>`;
    $$('[data-perfil]', p).forEach(b => b.onclick = () => { perfil = b.dataset.perfil; dibujar(); });
    $('#empezar').onclick = () => {
      const anterior = LS.get('yo', {}) || {};
      S.yo = { nombre: persona.nombre, perfil, casa: anterior.casa || '' };
      LS.set('yo', S.yo);
      ir('hoy');
    };
    $('#volver').onclick = () => pantallaInicio();
  };
  dibujar();
}

// Para alguien que todavía no está en config.json (incorporación nueva).
// El nombre queda solo en su teléfono; administración lo agrega a la lista cuando pueda.
function pantallaNombreNuevo() {
  const p = $('#p-inicio');
  p.innerHTML = `<h1>Tu nombre</h1>
    <div class="campo">
      <label for="nombre-nuevo">Escribí tu nombre y apellido</label>
      <input type="text" id="nombre-nuevo" autocomplete="name" placeholder="Ej.: Juan Pérez" value="${esc(S.yo ? S.yo.nombre : '')}">
      <div class="ayuda">Así va a aparecer en los resúmenes que le mandás a administración.</div>
    </div>
    <button class="btn enorme" id="nombre-ok">Seguir</button>
    ${S.config.personas.length ? '<button class="btn secundario" id="volver">Volver a la lista</button>' : ''}`;
  $('#nombre-nuevo').focus();
  $('#nombre-ok').onclick = () => {
    const nombre = $('#nombre-nuevo').value.trim().replace(/\s+/g, ' ');
    if (nombre.split(' ').length < 2) return aviso('Escribí nombre y apellido');
    // Si ya estaba en la lista (escrito distinto), se usa el de la lista
    const existente = S.config.personas.find(x => normalizar(x.nombre) === normalizar(nombre));
    pantallaInicio(existente || { nombre, perfil: 'pie' });
  };
  if ($('#volver')) $('#volver').onclick = () => pantallaInicio();
}

/* ---------------------------------------------------------------------
   Pantalla 2: el día (lista de gastos y total)
   --------------------------------------------------------------------- */
function etiquetaDia(iso) {
  const hoy = hoyISO();
  if (iso === hoy) return 'Hoy · ' + ddmm(iso);
  if (iso === sumarDias(hoy, -1)) return 'Ayer · ' + ddmm(iso);
  return nombreDia(iso).replace(/^./, c => c.toUpperCase()) + ' ' + ddmm(iso);
}

function pantallaHoy() {
  const p = $('#p-hoy');
  const lista = gastosDelDia(S.dia);
  const total = sumar(lista);
  p.innerHTML = `
    ${S.errorConfig ? `<div class="consejo">⚠️ La lista de servicios tiene un problema. Avisale a administración.</div>` : ''}
    ${S.pideCodigo ? `<div class="consejo">🔒 Administración cambió el código de la empresa. Podés seguir cargando, pero para tener la lista nueva de servicios escribí el código nuevo.
       <button class="btn chico-btn" id="codigo-banner">Escribir código</button></div>` : ''}
    ${S.instalar ? `<div class="banner"><b>Instalá la app</b> para abrirla más rápido.
       <button class="btn chico-btn" id="instalar-banner">📲 Instalar</button></div>` : ''}
    <div class="dia-nav">
      <button class="flecha" id="dia-ant" aria-label="Día anterior">‹</button>
      <label class="dia-centro" style="display:flex;align-items:center;justify-content:center">
        ${etiquetaDia(S.dia)}
        <input type="date" id="dia-elegir" value="${S.dia}" aria-label="Elegir día">
      </label>
      <button class="flecha" id="dia-sig" aria-label="Día siguiente">›</button>
    </div>

    <button class="btn enorme" id="nuevo">＋ Cargar gasto</button>

    ${lista.length ? lista.map((g, i) => `
      <button class="gasto" data-id="${g.id}">
        <span class="num">${i + 1})</span>
        <span class="cuerpo">
          <div class="motivo">${ICONOS[g.motivo] || ''} ${esc(g.motivo)} ${g.fotoId ? '📷' : ''}</div>
          <div class="serv">${esc(servicioDe(g))}</div>
          ${obsDe(g) ? `<div class="obs">${esc(obsDe(g))}</div>` : ''}
        </span>
        <span class="monto">${plata(g.monto)}</span>
      </button>`).join('')
    : `<div class="vacio">Todavía no cargaste gastos ${S.dia === hoyISO() ? 'hoy' : 'este día'}.</div>`}

    <div class="total"><span>TOTAL DEL DÍA</span><span class="valor">${plata(total)}</span></div>
    ${lista.length ? '<p class="chico centro">Tocá un gasto para corregirlo o borrarlo.</p>' : ''}

    <button class="btn wa" id="whatsapp" ${lista.length ? '' : 'disabled'}>💬 Enviar resumen por WhatsApp</button>
    <button class="btn secundario" id="excel">📥 Descargar para el tablero</button>`;

  $('#dia-ant').onclick = () => { S.dia = sumarDias(S.dia, -1); pantallaHoy(); };
  $('#dia-sig').onclick = () => { S.dia = sumarDias(S.dia, 1); pantallaHoy(); };
  $('#dia-elegir').onchange = e => { if (e.target.value) { S.dia = e.target.value; pantallaHoy(); } };
  $('#nuevo').onclick = () => abrirGasto(null);
  $$('.gasto', p).forEach(b => b.onclick = () => abrirGasto(b.dataset.id));
  $('#whatsapp').onclick = enviarWhatsApp;
  $('#excel').onclick = () => elegirPeriodoExcel();
  if ($('#instalar-banner')) $('#instalar-banner').onclick = instalarApp;
  if ($('#codigo-banner')) $('#codigo-banner').onclick = pantallaCodigo;
}

/* ---------------------------------------------------------------------
   Pantalla 3: cargar / corregir un gasto
   --------------------------------------------------------------------- */
// Para VIAJES: el origen arranca donde terminó el último viaje del día
function ultimoDestino(iso) {
  const viajes = gastosDelDia(iso).filter(g => g.motivo === 'VIAJES' && g.destino);
  return viajes.length ? viajes[viajes.length - 1].destino : null;
}
function motivosDelPerfil() {
  const todos = S.config.motivos;
  return S.yo.perfil === 'camioneta' ? todos.filter(m => m !== 'VIAJES') : todos;
}
// Precio sugerido: el último que usó la persona para esa línea, o para ese medio, o la tarifa de config.json
function precioSugerido(medio, linea) {
  const memo = LS.get('precios', {});
  if (linea && memo[medio + '|' + linea]) return memo[medio + '|' + linea];
  if (memo[medio]) return memo[medio];
  return Number((S.config.tarifas || {})[medio]) || 0;
}
function esCaminando(f) { return f.transportes.length > 0 && f.transportes.every(t => t.medio === CAMINANDO); }
function totalTransportes(f) {
  const s = f.transportes.reduce((a, t) => a + (Number(t.monto) || 0), 0);
  return Math.round(s * (f.idaVuelta ? 2 : 1) * 100) / 100;
}

async function abrirGasto(id) {
  const existente = id ? todosLosGastos().find(g => g.id === id) : null;
  S.f = existente ? JSON.parse(JSON.stringify(existente)) : {
    id: null, fecha: S.dia, motivo: null, servicio: null,
    origen: ultimoDestino(S.dia), destino: null, transportes: [], idaVuelta: false,
    proposito: null, monto: 0, obs: '', fotoId: null
  };
  S.f._fotoUrl = null;
  if (S.f.fotoId) {
    const blob = await Fotos.leer(S.f.fotoId);
    if (blob) S.f._fotoUrl = URL.createObjectURL(blob);
    else S.f._fotoVencida = true;
  }
  ir('gasto');
  dibujarGasto();
}

function botonLugar(id, lugar, vacio) {
  return `<button class="elegir ${lugar ? '' : 'vacio-elegir'}" id="${id}">
    ${lugar ? esc(lugar.nombre) + (lugar.direccion ? `<small>${esc(lugar.direccion)}</small>` : '') : vacio}
  </button>`;
}
function linkMapa(origen, destino) {
  const q = l => encodeURIComponent(l.direccion || (l.nombre + ', Buenos Aires'));
  return `https://www.google.com/maps/dir/?api=1&origin=${q(origen)}&destination=${q(destino)}&travelmode=transit`;
}

function dibujarGasto() {
  const f = S.f;
  const p = $('#p-gasto');
  const perfil = S.yo.perfil;
  const esViaje = f.motivo === 'VIAJES';
  const sinDireccion = l => l && (l.tipo === 'casa' || l.tipo === 'banco') && !l.direccion;

  p.innerHTML = `
    <h1>${f.id ? 'Corregir gasto' : 'Nuevo gasto'}</h1>

    <div class="campo">
      <label for="f-fecha">📅 Fecha</label>
      <input type="date" id="f-fecha" value="${f.fecha}">
    </div>

    <div class="campo">
      <span class="etiqueta">¿Qué gastaste?</span>
      <div class="grilla">
        ${motivosDelPerfil().map(m => `<button class="ficha ${f.motivo === m ? 'elegida' : ''}" data-motivo="${m}">
          <span class="ico">${ICONOS[m] || '•'}</span>${m}</button>`).join('')}
      </div>
    </div>

    ${!f.motivo ? '' : esViaje ? `
      <div class="campo">
        <span class="etiqueta">Desde</span>
        ${botonLugar('f-origen', f.origen, 'Tocá para elegir de dónde saliste')}
        <div class="flecha-abajo">⬇</div>
        <span class="etiqueta">Hasta</span>
        ${botonLugar('f-destino', f.destino, 'Tocá para elegir a dónde fuiste')}
        ${f.origen && f.destino && !sinDireccion(f.origen) && !sinDireccion(f.destino)
          ? `<a class="link-mapa" href="${linkMapa(f.origen, f.destino)}" target="_blank" rel="noopener">🗺️ Ver recorrido en Google Maps</a>` : ''}
        ${[f.origen, f.destino].some(l => sinDireccion(l) && l.tipo === 'casa') ? '<div class="ayuda">Para ver el recorrido desde tu casa, cargá tu dirección en Ajustes.</div>' : ''}
      </div>

      <div class="campo">
        <span class="etiqueta">¿En qué viajaste?</span>
        ${f.transportes.map((t, i) => t.medio === CAMINANDO ? `
          <div class="transporte">
            <span class="medio">🚶 Caminando</span>
            <span class="chico" style="grid-column: span 2">Sin costo</span>
            <button class="quitar" data-quitar="${i}" aria-label="Quitar">✕</button>
          </div>` : `
          <div class="transporte">
            <span class="medio">${(MEDIOS.find(m => m.id === t.medio) || {}).ico || ''} ${t.medio}</span>
            <input type="text" data-linea="${i}" value="${esc(t.linea || '')}" placeholder="Línea" aria-label="Línea">
            <input type="text" data-tmonto="${i}" inputmode="decimal" value="${montoCampo(t.monto)}" placeholder="$" aria-label="Precio">
            <button class="quitar" data-quitar="${i}" aria-label="Quitar">✕</button>
          </div>`).join('')}
        ${esCaminando(f) ? '' : `
        <div class="grilla tres">
          ${MEDIOS.map(m => `<button class="ficha" data-medio="${m.id}"><span class="ico">${m.ico}</span>${f.transportes.length ? '+ ' : ''}${m.id}</button>`).join('')}
        </div>
        <div class="ayuda">${f.transportes.length > 1 ? '✔ Combinación: se suman los ' + f.transportes.length + ' transportes.'
          : 'Si tomaste más de uno (combinación), tocá otro botón y se suman.'}</div>
        ${f.transportes.length ? '' : '<button class="opcion" data-caminando style="margin-top:10px">🚶 Fui caminando <small>Servicios cerca, sin costo</small></button>'}`}
      </div>

      ${esCaminando(f) ? '' : `
      <div class="campo">
        <div class="par">
          <button class="opcion ${!f.idaVuelta ? 'elegida' : ''}" data-ida="0">Solo ida</button>
          <button class="opcion ${f.idaVuelta ? 'elegida' : ''}" data-ida="1">Ida y vuelta</button>
        </div>
      </div>`}
    ` : `
      <div class="campo">
        <span class="etiqueta">¿Para qué servicio o lugar?</span>
        ${botonLugar('f-servicio', f.servicio, 'Tocá para elegir el servicio')}
      </div>
    `}

    ${f.motivo && perfil === 'admin' ? `
      <div class="campo">
        <span class="etiqueta">Propósito</span>
        <div class="grilla">
          ${S.config.propositos.map(x => `<button class="ficha ${f.proposito === x ? 'elegida' : ''}" data-proposito="${esc(x)}">${esc(x)}</button>`).join('')}
        </div>
      </div>` : ''}

    ${f.motivo ? `
      ${esViaje && esCaminando(f) ? '<div class="campo"><span class="etiqueta">💲 Monto: $0,00</span><div class="ayuda">Queda registrado el recorrido, sin gasto.</div></div>' : `
      <div class="campo">
        <label for="f-monto">💲 Monto</label>
        <input type="text" id="f-monto" class="input-monto" inputmode="decimal" placeholder="0" value="${montoCampo(f.monto)}">
        ${esViaje ? '<div class="ayuda">Se calcula solo con los transportes. Si no coincide, corregilo.</div>' : ''}
      </div>`}

      <div class="campo">
        <label for="f-obs">Observación <span class="chico">(opcional)</span></label>
        <textarea id="f-obs" placeholder="Ej.: compra de lavandina, copia de llave del portón...">${esc(f.obs || '')}</textarea>
      </div>

      <div class="campo">
        <span class="etiqueta">📷 Foto del ticket ${perfil === 'camioneta' ? '' : '<span class="chico">(opcional)</span>'}</span>
        ${perfil === 'camioneta' && !f._fotoUrl ? '<div class="consejo">Sacale foto a la <b>factura</b>. Es muy importante para rendir el gasto.</div>' : ''}
        ${f._fotoVencida && !f._fotoUrl ? '<div class="ayuda">La foto de este gasto ya se borró (tenía más de 60 días).</div>' : ''}
        ${f._fotoUrl ? `<img class="foto-previa" src="${f._fotoUrl}" alt="Foto del ticket">
          <button class="btn peligro chico-btn" id="f-sacar-foto">Quitar foto</button>` : ''}
        <label class="btn secundario" style="margin-top:10px">
          ${f._fotoUrl ? 'Cambiar foto' : 'Sacar foto'}
          <input type="file" id="f-foto" accept="image/*" capture="environment" hidden>
        </label>
      </div>

      <button class="btn enorme" id="f-guardar">✔ Guardar</button>` : ''}

    <button class="btn secundario" id="f-cancelar">Cancelar</button>
    ${f.id ? '<button class="btn peligro" id="f-borrar">🗑 Borrar este gasto</button>' : ''}
  `;

  // --- Eventos del formulario ---
  $('#f-fecha').onchange = e => { f.fecha = e.target.value || f.fecha; };
  $$('[data-motivo]', p).forEach(b => b.onclick = () => {
    f.motivo = b.dataset.motivo;
    if (f.motivo === 'VIAJES' && f.transportes.length) f.monto = totalTransportes(f);
    dibujarGasto();
  });
  const elegirY = (campo, titulo, conCasa) => {
    if ($('#' + campo.id)) $('#' + campo.id).onclick = () => elegirLugar(titulo, conCasa, lugar => { f[campo.clave] = lugar; dibujarGasto(); });
  };
  elegirY({ id: 'f-origen', clave: 'origen' }, '¿Desde dónde?', true);
  elegirY({ id: 'f-destino', clave: 'destino' }, '¿Hasta dónde?', true);
  elegirY({ id: 'f-servicio', clave: 'servicio' }, '¿Qué servicio o lugar?', false);

  $$('[data-medio]', p).forEach(b => b.onclick = () => {
    f.transportes.push({ medio: b.dataset.medio, linea: '', monto: precioSugerido(b.dataset.medio, '') });
    f.monto = totalTransportes(f);
    dibujarGasto();
  });
  if ($('[data-caminando]', p)) $('[data-caminando]', p).onclick = () => {
    f.transportes = [{ medio: CAMINANDO, linea: '', monto: 0 }];
    f.monto = 0;
    f.idaVuelta = false;
    dibujarGasto();
  };
  $$('[data-quitar]', p).forEach(b => b.onclick = () => {
    f.transportes.splice(Number(b.dataset.quitar), 1);
    f.monto = totalTransportes(f);
    dibujarGasto();
  });
  const refrescarTotal = () => { f.monto = totalTransportes(f); $('#f-monto').value = montoCampo(f.monto); };
  $$('[data-linea]', p).forEach(inp => {
    inp.oninput = () => { f.transportes[inp.dataset.linea].linea = inp.value.trim(); };
    // Al terminar de escribir la línea, si ya la usó antes, pone el precio de esa vez
    inp.onchange = () => {
      const t = f.transportes[inp.dataset.linea];
      const memo = LS.get('precios', {})[t.medio + '|' + t.linea];
      if (memo) { t.monto = memo; $(`[data-tmonto="${inp.dataset.linea}"]`).value = montoCampo(memo); refrescarTotal(); }
    };
  });
  $$('[data-tmonto]', p).forEach(inp => inp.oninput = () => {
    f.transportes[inp.dataset.tmonto].monto = leerMonto(inp.value);
    refrescarTotal();
  });
  $$('[data-ida]', p).forEach(b => b.onclick = () => { f.idaVuelta = b.dataset.ida === '1'; f.monto = totalTransportes(f); dibujarGasto(); });
  $$('[data-proposito]', p).forEach(b => b.onclick = () => { f.proposito = b.dataset.proposito; dibujarGasto(); });

  if ($('#f-monto')) $('#f-monto').oninput = e => { f.monto = leerMonto(e.target.value); };
  if ($('#f-obs')) $('#f-obs').oninput = e => { f.obs = e.target.value; };
  if ($('#f-foto')) $('#f-foto').onchange = async e => {
    const archivo = e.target.files[0];
    if (!archivo) return;
    f._fotoNueva = await achicarFoto(archivo);
    f._sacarFoto = false;
    f._fotoUrl = URL.createObjectURL(f._fotoNueva);
    dibujarGasto();
  };
  if ($('#f-sacar-foto')) $('#f-sacar-foto').onclick = () => { f._fotoNueva = null; f._fotoUrl = null; f._sacarFoto = true; dibujarGasto(); };
  if ($('#f-guardar')) $('#f-guardar').onclick = guardarGasto;
  $('#f-cancelar').onclick = () => ir('hoy');
  if ($('#f-borrar')) $('#f-borrar').onclick = borrarGasto;
}

async function guardarGasto() {
  const f = S.f;
  if (!f.motivo) return aviso('Elegí qué gastaste');
  if (f.motivo === 'VIAJES') {
    if (!f.origen) return aviso('Elegí desde dónde saliste');
    if (!f.destino) return aviso('Elegí a dónde fuiste');
  } else if (!f.servicio) return aviso('Elegí el servicio o lugar');
  if (S.yo.perfil === 'admin' && !f.proposito) return aviso('Elegí el propósito');
  if (f.motivo === 'VIAJES' && esCaminando(f)) { f.monto = 0; f.idaVuelta = false; }
  else if (!(f.monto > 0)) return aviso(f.motivo === 'VIAJES' ? 'Escribí el monto o elegí "Fui caminando"' : 'Escribí el monto');
  if (S.yo.perfil === 'camioneta' && !f._fotoUrl &&
      !confirm('No sacaste foto de la factura.\n¿Querés guardar igual?')) return;

  // Fotos
  if (f._fotoNueva) {
    const idFoto = uid();
    await Fotos.guardar(idFoto, f._fotoNueva);
    if (f.fotoId) await Fotos.borrar(f.fotoId);
    f.fotoId = idFoto;
  } else if (f._sacarFoto && f.fotoId) {
    await Fotos.borrar(f.fotoId);
    f.fotoId = null;
  }

  // Recordar precios de cada línea para la próxima
  if (f.motivo === 'VIAJES') {
    const memo = LS.get('precios', {});
    f.transportes.forEach(t => {
      if (!t.monto) return;
      memo[t.medio] = t.monto;
      if (t.linea) memo[t.medio + '|' + t.linea] = t.monto;
    });
    LS.set('precios', memo);
  } else {
    f.transportes = []; f.origen = null; f.destino = null; f.idaVuelta = false;
  }
  recordarLugares([f.servicio, f.origen, f.destino]);

  // Guardar (sin los campos temporales que empiezan con _)
  const g = {};
  Object.keys(f).forEach(k => { if (!k.startsWith('_')) g[k] = f[k]; });
  if (g.motivo !== 'VIAJES') delete g.transportes;
  const lista = todosLosGastos();
  if (g.id) {
    const i = lista.findIndex(x => x.id === g.id);
    if (i >= 0) lista[i] = g; else lista.push(g);
  } else {
    g.id = uid();
    g.creado = Date.now();
    lista.push(g);
  }
  guardarTodos(lista);
  S.dia = g.fecha;
  ir('hoy');
  aviso('✔ Gasto guardado');
}

async function borrarGasto() {
  if (!confirm('¿Seguro que querés borrar este gasto?')) return;
  if (S.f.fotoId) await Fotos.borrar(S.f.fotoId);
  guardarTodos(todosLosGastos().filter(g => g.id !== S.f.id));
  ir('hoy');
  aviso('Gasto borrado');
}

/* ---------------------------------------------------------------------
   Buscador de servicios / lugares
   --------------------------------------------------------------------- */
function recordarLugares(lugares) {
  let rec = LS.get('recientes', []);
  lugares.forEach(l => {
    if (!l || l.tipo === 'oficina' || l.tipo === 'casa' || l.tipo === 'banco') return;
    rec = [l, ...rec.filter(r => !(r.nombre === l.nombre && r.direccion === l.direccion))];
  });
  LS.set('recientes', rec.slice(0, 8));
}

function elegirLugar(titulo, conCasa, alElegir) {
  const ofi = oficina();
  const fijos = [
    { tipo: 'oficina', nombre: 'Oficina', direccion: ofi.direccion },
    ...(conCasa ? [{ tipo: 'casa', nombre: 'Casa', direccion: S.yo.casa || '' }] : []),
    { tipo: 'banco', nombre: 'Banco', direccion: '' }
  ];
  const recientes = LS.get('recientes', []);
  const servicios = S.config.servicios.map(s => ({ ...s, tipo: 'servicio', _b: normalizar(s.nombre + ' ' + s.direccion) }));

  abrirModal(`
    <div class="modal-cabeza"><h2>${esc(titulo)}</h2><button class="cerrar" data-cerrar aria-label="Cerrar">✕</button></div>
    <div class="buscador"><input type="search" id="buscar" placeholder="🔎 Buscá por nombre o calle" autocomplete="off"></div>
    <div id="resultados"></div>`);

  const caja = $('#resultados');
  const fila = (l, i, fija) => `<button class="fila-lugar ${fija ? 'fija' : ''}" data-k="${i}">${esc(l.nombre)}${l.direccion ? `<small>${esc(l.direccion)}</small>` : ''}</button>`;
  let mostrados = [];
  const dibujarLista = q => {
    const nq = normalizar(q).trim();
    const palabras = nq.split(/\s+/).filter(Boolean);
    let html = '';
    mostrados = [];
    const agregar = (l, fija) => { html += fila(l, mostrados.length, fija); mostrados.push(l); };
    if (!nq) {
      fijos.forEach(l => agregar(l, true));
      html += `<button class="fila-lugar fija" data-otro>✏️ Otro (escribir)</button>`;
      if (recientes.length) { html += '<div class="separador">Usados hace poco</div>'; recientes.forEach(l => agregar(l)); }
      html += '<div class="separador">Todos los servicios</div>';
      servicios.forEach(l => agregar(l));
    } else {
      fijos.filter(l => normalizar(l.nombre).includes(nq)).forEach(l => agregar(l, true));
      const encontrados = servicios.filter(s => palabras.every(w => s._b.includes(w)));
      encontrados.slice(0, 80).forEach(l => agregar(l));
      if (!encontrados.length) html += '<p class="chico centro">No encontré ningún servicio con ese nombre.</p>';
      html += `<button class="fila-lugar fija" data-otro>✏️ Usar "${esc(q)}" (otro lugar)</button>`;
    }
    caja.innerHTML = html;
    $$('[data-k]', caja).forEach(b => b.onclick = () => {
      const l = mostrados[b.dataset.k];
      const elegido = { tipo: l.tipo, nombre: l.nombre, direccion: l.direccion || '' };
      cerrarModal();
      alElegir(elegido);
    });
    $$('[data-otro]', caja).forEach(b => b.onclick = () => escribirOtro(q, alElegir));
  };
  $('#buscar').oninput = e => dibujarLista(e.target.value);
  dibujarLista('');
}

function escribirOtro(inicial, alElegir) {
  $('#modal-caja').innerHTML = `
    <div class="modal-cabeza"><h2>Otro lugar</h2><button class="cerrar" data-cerrar aria-label="Cerrar">✕</button></div>
    <div class="campo"><label for="otro-texto">Escribí el nombre o la dirección</label>
      <input type="text" id="otro-texto" value="${esc(inicial || '')}" placeholder="Ej.: Ferretería de Cabildo 2000"></div>
    <button class="btn" id="otro-ok">Usar este lugar</button>`;
  $$('[data-cerrar]', $('#modal-caja')).forEach(b => b.onclick = () => cerrarModal());
  $('#otro-texto').focus();
  $('#otro-ok').onclick = () => {
    const t = $('#otro-texto').value.trim();
    if (!t) return aviso('Escribí algo');
    cerrarModal();
    alElegir({ tipo: 'otro', nombre: t, direccion: '' });
  };
}

/* ---------------------------------------------------------------------
   WhatsApp
   --------------------------------------------------------------------- */
function textoWhatsApp(iso) {
  const lista = gastosDelDia(iso);
  const lineas = [`VIÁTICOS – ${S.yo.nombre} – ${ddmm(iso)}`];
  lista.forEach((g, i) => {
    const partes = [g.motivo, servicioDe(g), plata(g.monto)];
    const obs = obsDe(g);
    if (obs) partes.push(obs);
    lineas.push(`${i + 1}) ${partes.join(' · ')}`);
  });
  lineas.push(`TOTAL DEL DÍA: ${plata(sumar(lista))}`);
  return lineas.join('\n');
}

async function enviarWhatsApp() {
  const lista = gastosDelDia(S.dia);
  if (!lista.length) return aviso('No hay gastos cargados este día');
  const texto = textoWhatsApp(S.dia);
  // El texto también queda copiado, por si WhatsApp no lo pega solo
  try { await navigator.clipboard.writeText(texto); } catch (e) { /* no pasa nada */ }

  const archivos = [];
  for (let i = 0; i < lista.length; i++) {
    const blob = await Fotos.leer(lista[i].fotoId);
    if (blob) archivos.push(new File([blob], `ticket_${ddmm(S.dia).replace('/', '-')}_${i + 1}.jpg`, { type: 'image/jpeg' }));
  }
  try {
    if (archivos.length && navigator.canShare && navigator.canShare({ files: archivos })) {
      await navigator.share({ text: texto, files: archivos });
      aviso('Si el texto no aparece en WhatsApp, mantené apretado y "Pegar"');
      return;
    }
    if (navigator.share) { await navigator.share({ text: texto }); return; }
  } catch (e) {
    if (e.name === 'AbortError') return; // la persona canceló
  }
  window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank');
}

/* ---------------------------------------------------------------------
   Excel para el tablero
   --------------------------------------------------------------------- */
function rangoDe(modo, ref) {
  if (modo === 'semana') {
    const desde = sumarDias(ref, -((fechaDe(ref).getDay() + 6) % 7)); // lunes
    return { desde, hasta: sumarDias(desde, 6) };
  }
  const d = fechaDe(ref);
  return { desde: ref.slice(0, 8) + '01', hasta: isoDe(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12)) };
}

function elegirPeriodoExcel() {
  const sem = rangoDe('semana', S.dia), mes = rangoDe('mes', S.dia);
  abrirModal(`
    <div class="modal-cabeza"><h2>¿Qué días querés bajar?</h2><button class="cerrar" data-cerrar aria-label="Cerrar">✕</button></div>
    <button class="opcion" data-desde="${S.dia}" data-hasta="${S.dia}">Solo este día<small>${ddmmaaaa(S.dia)}</small></button>
    <button class="opcion" style="margin-top:8px" data-desde="${sem.desde}" data-hasta="${sem.hasta}">Toda la semana<small>${ddmm(sem.desde)} al ${ddmm(sem.hasta)}</small></button>
    <button class="opcion" style="margin-top:8px" data-desde="${mes.desde}" data-hasta="${mes.hasta}">Todo el mes<small>${MESES[fechaDe(S.dia).getMonth()]}</small></button>
    <h2>O elegí las fechas</h2>
    <div class="par">
      <div><span class="chico">Desde</span><input type="date" id="x-desde" value="${S.dia}"></div>
      <div><span class="chico">Hasta</span><input type="date" id="x-hasta" value="${S.dia}"></div>
    </div>
    <button class="btn" id="x-rango">Armar Excel con esas fechas</button>`);
  $$('[data-desde]', $('#modal-caja')).forEach(b => b.onclick = () => prepararExcel(b.dataset.desde, b.dataset.hasta));
  $('#x-rango').onclick = () => {
    const d = $('#x-desde').value, h = $('#x-hasta').value;
    if (!d || !h) return aviso('Elegí las dos fechas');
    prepararExcel(d <= h ? d : h, d <= h ? h : d);
  };
}

// Arma el .xlsx con EXACTAMENTE estas columnas: Fecha | Motivo | Servicio / destino | Gasto $ | Observaciones
function armarExcel(desde, hasta) {
  const lista = gastosEntre(desde, hasta);
  const filas = lista.map(g => [{ fecha: g.fecha }, g.motivo, servicioDe(g), Number(g.monto) || 0, obsDe(g)]);
  const blob = XlsxMini.crear(
    ['Fecha', 'Motivo', 'Servicio / destino', 'Gasto $', 'Observaciones'],
    filas,
    { columnasPlata: [3], anchos: [12, 16, 48, 14, 60], nombreHoja: 'Viáticos' }
  );
  const persona = normalizar(S.yo.nombre).replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')
    .replace(/(^|_)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  const fechas = desde === hasta ? ddmmaaaa(desde).replace(/\//g, '-')
    : ddmm(desde).replace('/', '-') + '_al_' + ddmmaaaa(hasta).replace(/\//g, '-');
  return { blob, nombre: `Viaticos_${persona}_${fechas}.xlsx`, cantidad: lista.length, total: sumar(lista) };
}

function prepararExcel(desde, hasta) {
  const x = armarExcel(desde, hasta);
  if (!x.cantidad) return aviso('No hay gastos en esas fechas');
  const archivo = new File([x.blob], x.nombre, { type: x.blob.type });
  const sePuedeCompartir = navigator.canShare && navigator.canShare({ files: [archivo] });
  abrirModal(`
    <div class="modal-cabeza"><h2>Excel listo ✔</h2><button class="cerrar" data-cerrar aria-label="Cerrar">✕</button></div>
    <p><b>${x.cantidad}</b> gasto${x.cantidad === 1 ? '' : 's'} · Total <b>${plata(x.total)}</b><br>
      <span class="chico">${desde === hasta ? ddmmaaaa(desde) : ddmmaaaa(desde) + ' al ' + ddmmaaaa(hasta)}</span></p>
    ${sePuedeCompartir ? '<button class="btn wa" id="x-compartir">💬 Mandar el Excel por WhatsApp</button>' : ''}
    <button class="btn ${sePuedeCompartir ? 'secundario' : ''}" id="x-bajar">📥 Guardar en el teléfono</button>
    <p class="chico">Si lo guardás, queda en la carpeta <b>Descargas</b>. Para mandarlo: en WhatsApp tocá 📎 → <b>Documento</b> → elegí el archivo <b>${esc(x.nombre)}</b>.</p>`);
  $('#x-bajar').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(x.blob);
    a.download = x.nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    aviso('Excel guardado en Descargas');
  };
  if ($('#x-compartir')) $('#x-compartir').onclick = async () => {
    try { await navigator.share({ files: [archivo] }); } catch (e) { if (e.name !== 'AbortError') $('#x-bajar').click(); }
  };
}

/* ---------------------------------------------------------------------
   Pantalla 4: historial (semana / mes, totales por motivo)
   --------------------------------------------------------------------- */
function pantallaHistorial() {
  const p = $('#p-historial');
  const h = S.hist;
  const { desde, hasta } = rangoDe(h.modo, h.ref);
  const lista = gastosEntre(desde, hasta);
  const total = sumar(lista);
  const titulo = h.modo === 'semana'
    ? `Semana del ${ddmm(desde)} al ${ddmm(hasta)}`
    : MESES[fechaDe(desde).getMonth()].replace(/^./, c => c.toUpperCase()) + ' ' + desde.slice(0, 4);

  const porMotivo = {};
  lista.forEach(g => { porMotivo[g.motivo] = (porMotivo[g.motivo] || 0) + Number(g.monto); });
  const motivos = Object.entries(porMotivo).sort((a, b) => b[1] - a[1]);
  const maximo = motivos.length ? motivos[0][1] : 1;
  const porDia = {};
  lista.forEach(g => { porDia[g.fecha] = (porDia[g.fecha] || 0) + Number(g.monto); });

  p.innerHTML = `
    <h1>Historial</h1>
    <div class="pestanas">
      <button class="${h.modo === 'semana' ? 'activo' : ''}" data-modo="semana">Semana</button>
      <button class="${h.modo === 'mes' ? 'activo' : ''}" data-modo="mes">Mes</button>
    </div>
    <div class="dia-nav" style="margin-top:12px">
      <button class="flecha" id="h-ant" aria-label="Anterior">‹</button>
      <div class="dia-centro" style="display:flex;align-items:center;justify-content:center;font-size:17px;text-align:center">${titulo}</div>
      <button class="flecha" id="h-sig" aria-label="Siguiente">›</button>
    </div>
    <div class="total"><span>TOTAL</span><span class="valor">${plata(total)}</span></div>
    <p class="chico">${lista.length} gasto${lista.length === 1 ? '' : 's'} cargado${lista.length === 1 ? '' : 's'}</p>

    ${lista.length ? `
      <h2>Por motivo</h2>
      <table class="tabla">${motivos.map(([m, v]) => `
        <tr><td>${ICONOS[m] || ''} ${esc(m)}<div class="barrita" style="width:${Math.max(4, v / maximo * 100)}%"></div></td><td>${plata(v)}</td></tr>`).join('')}
      </table>
      <h2>Por día</h2>
      <table class="tabla">${Object.keys(porDia).sort().map(d => `
        <tr class="fila-dia" data-dia="${d}"><td>${nombreDia(d)} ${ddmm(d)} ›</td><td>${plata(porDia[d])}</td></tr>`).join('')}
      </table>
      <button class="btn secundario" id="h-excel">📥 Descargar este período (Excel)</button>`
    : '<div class="vacio">No hay gastos en este período.</div>'}`;

  $$('[data-modo]', p).forEach(b => b.onclick = () => { h.modo = b.dataset.modo; pantallaHistorial(); });
  const mover = n => {
    if (h.modo === 'semana') h.ref = sumarDias(h.ref, 7 * n);
    else { const d = fechaDe(h.ref); h.ref = isoDe(new Date(d.getFullYear(), d.getMonth() + n, 1, 12)); }
    pantallaHistorial();
  };
  $('#h-ant').onclick = () => mover(-1);
  $('#h-sig').onclick = () => mover(1);
  $$('[data-dia]', p).forEach(r => r.onclick = () => { S.dia = r.dataset.dia; ir('hoy'); });
  if ($('#h-excel')) $('#h-excel').onclick = () => prepararExcel(desde, hasta);
}

/* ---------------------------------------------------------------------
   Pantalla 5: ajustes
   --------------------------------------------------------------------- */
function pantallaAjustes() {
  const p = $('#p-ajustes');
  const c = S.config || { servicios: [], personas: [] };
  p.innerHTML = `
    <h1>Ajustes</h1>
    <div class="opcion" style="cursor:default">${esc(S.yo.nombre)}<small>${PERFILES[S.yo.perfil]}</small></div>
    <button class="btn secundario" id="a-cambiar">Cambiar nombre o perfil</button>

    <div class="campo">
      <label for="a-casa">🏠 Mi casa <span class="chico">(opcional)</span></label>
      <input type="text" id="a-casa" value="${esc(S.yo.casa || '')}" placeholder="Ej.: Castro 1422, Boedo">
      <div class="ayuda">Solo si a veces te reconocen el viaje desde tu casa. Queda guardada únicamente en tu teléfono.</div>
      <button class="btn chico-btn" id="a-guardar-casa">Guardar dirección</button>
    </div>

    ${S.instalar ? '<button class="btn" id="a-instalar">📲 Instalar la app en el celular</button>' : ''}

    <h2>Listas</h2>
    ${S.errorConfig ? `<div class="consejo">⚠️ ${esc(S.errorConfig)}. Se sigue usando la lista anterior.</div>` : ''}
    <p class="chico">${c.servicios.length} servicios · ${c.personas.length} personas${c.actualizado ? ' · actualizado ' + esc(c.actualizado) : ''}</p>
    <button class="btn secundario" id="a-actualizar">🔄 Actualizar lista de servicios</button>
    <button class="btn secundario" id="a-codigo">🔒 Cambiar código de la empresa</button>

    <h2>Ayuda</h2>
    <a class="btn secundario" href="guia-personal.html" target="_blank">📖 Cómo usar la app</a>
    <p class="chico">Gastos guardados en este teléfono: ${todosLosGastos().length}.<br>
      Las fotos se borran solas a los ${DIAS_FOTOS} días. Versión ${VERSION_APP}.</p>`;

  $('#a-cambiar').onclick = () => { ir('inicio'); pantallaInicio(); };
  $('#a-guardar-casa').onclick = () => {
    S.yo.casa = $('#a-casa').value.trim();
    LS.set('yo', S.yo);
    aviso('Dirección guardada');
  };
  $('#a-actualizar').onclick = async () => {
    aviso('Actualizando...');
    const antes = S.config;
    S.config = (await cargarConfig()) || antes;
    pantallaAjustes();
    aviso(S.errorConfig ? 'La lista nueva tiene un error'
      : S.pideCodigo ? 'Falta el código nuevo de la empresa'
      : (S.config === antes ? 'Sin conexión, probá más tarde' : '✔ Lista actualizada'));
  };
  $('#a-codigo').onclick = pantallaCodigo;
  if ($('#a-instalar')) $('#a-instalar').onclick = instalarApp;
}

/* ---------------------------------------------------------------------
   Instalación como app (PWA) y arranque
   --------------------------------------------------------------------- */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  S.instalar = e;
  if (S.pantalla === 'hoy') pantallaHoy();
});
async function instalarApp() {
  if (!S.instalar) return;
  S.instalar.prompt();
  await S.instalar.userChoice;
  S.instalar = null;
  mostrar(S.pantalla);
}

$$('#menu button').forEach(b => b.onclick = () => ir(b.dataset.ir));

async function iniciar() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  try { await Fotos.abrir(); Fotos.limpiarViejas(); } catch (e) { /* sin fotos */ }
  S.config = await cargarConfig();
  S.yo = LS.get('yo', null);
  if (!S.config) { mostrar('inicio'); pantallaInicio(); }      // pide código o avisa que falta internet
  else if (!S.yo) { mostrar('inicio'); pantallaInicio(); }
  else mostrar('hoy');
}
iniciar();
