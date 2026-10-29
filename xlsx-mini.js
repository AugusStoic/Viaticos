/* xlsx-mini.js — arma un archivo Excel (.xlsx) de una sola hoja, sin librerías.
   Un .xlsx es un .zip con algunos archivos XML adentro; acá se arma ese zip "a mano".
   Uso: XlsxMini.crear(encabezados, filas, opciones) -> Blob
     - cada celda de "filas" puede ser: texto, número, o { fecha: 'AAAA-MM-DD' }
     - opciones.columnasPlata: índices de columnas que son montos en pesos
     - opciones.anchos: ancho de cada columna */
(function () {
  'use strict';

  // ---- CRC32 (lo pide el formato zip) ----
  const TABLA = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    TABLA[n] = c >>> 0;
  }
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = TABLA[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---- Zip sin compresión ----
  function zip(archivos) {
    const enc = new TextEncoder();
    const ahora = new Date();
    const hora = (ahora.getHours() << 11) | (ahora.getMinutes() << 5) | (ahora.getSeconds() >> 1);
    const fecha = ((ahora.getFullYear() - 1980) << 9) | ((ahora.getMonth() + 1) << 5) | ahora.getDate();
    const partes = [], central = [];
    let offset = 0;
    for (const a of archivos) {
      const nombre = enc.encode(a.nombre);
      const datos = typeof a.datos === 'string' ? enc.encode(a.datos) : a.datos;
      const crc = crc32(datos);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);      // nombres en UTF-8
      local.setUint16(8, 0, true);           // sin compresión
      local.setUint16(10, hora, true);
      local.setUint16(12, fecha, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, datos.length, true);
      local.setUint32(22, datos.length, true);
      local.setUint16(26, nombre.length, true);
      local.setUint16(28, 0, true);
      partes.push(new Uint8Array(local.buffer), nombre, datos);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, hora, true);
      cd.setUint16(14, fecha, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, datos.length, true);
      cd.setUint32(24, datos.length, true);
      cd.setUint16(28, nombre.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nombre);
      offset += 30 + nombre.length + datos.length;
    }
    const tamCentral = central.reduce((s, p) => s + p.length, 0);
    const fin = new DataView(new ArrayBuffer(22));
    fin.setUint32(0, 0x06054b50, true);
    fin.setUint16(8, archivos.length, true);
    fin.setUint16(10, archivos.length, true);
    fin.setUint32(12, tamCentral, true);
    fin.setUint32(16, offset, true);
    return new Blob([...partes, ...central, new Uint8Array(fin.buffer)],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ---- Armado de la hoja ----
  function xml(texto) {
    return String(texto)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function letra(i) { return String.fromCharCode(65 + i); } // alcanza para pocas columnas
  // Excel guarda las fechas como "días desde el 30/12/1899"
  function serialFecha(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    return (Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  }

  // Estilos: 0 normal, 1 fecha dd/mm/aaaa, 2 pesos, 3 encabezado en negrita
  const ESTILOS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>' +
    '<numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  function crear(encabezados, filas, opciones) {
    opciones = opciones || {};
    const plata = new Set(opciones.columnasPlata || []);
    const anchos = opciones.anchos || [];
    let hoja = '';
    const todas = [encabezados, ...filas];
    todas.forEach((fila, r) => {
      const nro = r + 1;
      hoja += `<row r="${nro}">`;
      fila.forEach((v, c) => {
        const ref = letra(c) + nro;
        if (r === 0) {
          hoja += `<c r="${ref}" t="inlineStr" s="3"><is><t>${xml(v)}</t></is></c>`;
        } else if (v && typeof v === 'object' && v.fecha) {
          hoja += `<c r="${ref}" s="1"><v>${serialFecha(v.fecha)}</v></c>`;
        } else if (typeof v === 'number') {
          hoja += `<c r="${ref}"${plata.has(c) ? ' s="2"' : ''}><v>${v}</v></c>`;
        } else if (v !== null && v !== undefined && v !== '') {
          hoja += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
        }
      });
      hoja += '</row>';
    });
    const cols = anchos.length
      ? '<cols>' + anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
      : '';
    const nombreHoja = xml(opciones.nombreHoja || 'Viáticos');

    return zip([
      { nombre: '[Content_Types].xml', datos:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>' },
      { nombre: '_rels/.rels', datos:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>' },
      { nombre: 'xl/workbook.xml', datos:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${nombreHoja}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { nombre: 'xl/_rels/workbook.xml.rels', datos:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>' },
      { nombre: 'xl/styles.xml', datos: ESTILOS },
      { nombre: 'xl/worksheets/sheet1.xml', datos:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        cols + `<sheetData>${hoja}</sheetData></worksheet>` }
    ]);
  }

  window.XlsxMini = { crear };
})();
