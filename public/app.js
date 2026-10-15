"use strict";

/* ===================================================================
   Registro de impresiones 3D — interfaz.
   Los formularios, tablas, catálogos y totales se generan a partir de
   config/campos.json, así que para añadir campos no hace falta tocar
   este fichero.
   =================================================================== */

const app = document.getElementById("app");
let CONFIG = null;
const CATALOGS = {}; // id → lista de elementos
const PRINTS = {};   // id → { nombre, tot } (para los campos de tipo "impresion")
const REGS = {};     // id de registro → lista (para los campos de tipo "registro", p. ej. filamentos)
let AJUSTES = null;  // configuración general (copias de seguridad, costes reales)

/**
 * Tarifas de los ajustes de costes reales (solo las configuradas). El consumo y la
 * amortización de cada máquina están en el catálogo de Máquinas.
 */
function costRates() {
  const c = AJUSTES?.costes;
  if (!c?.activo) return {};
  const r = {};
  for (const k of ["precioKWh", "postprocesadoHora", "disenoHora"]) if (Number(c[k]) > 0) r[k] = Number(c[k]);
  return r;
}

const costsActive = () => !!AJUSTES?.costes?.activo;

/** Campos que se muestran (los "ocultos" solo cuentan para los totales). */
const visibleFields = (fields) => fields.filter((f) => !f.oculto);
let formDirty = false;

// ------------------------------------------------------------ utilidades

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const isEmpty = (v) => v === undefined || v === null || v === "" ||
  (typeof v === "number" && isNaN(v)) || (Array.isArray(v) && v.length === 0);

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

const clone = (o) => JSON.parse(JSON.stringify(o ?? {}));

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const NUMERIC = ["moneda", "numero", "duracion", "porcentaje"];
const numFmt = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2, useGrouping: "always" });
const moneyFmt = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" });

function fmtDuration(min) {
  if (isEmpty(min)) return "";
  min = Math.round(Number(min));
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return d ? `${d}/${m}/${y}` : iso;
}

/** ¿Es una ruta de fichero local (D:\…, \\servidor\…, /home/…) en vez de una web? */
const isLocalPath = (v) => /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(String(v).trim().replace(/^"/, ""));

/** ¿Parece una dirección web? (si no, p. ej. un nº de pedido, se muestra como texto) */
const isUrl = (v) => /^(?:https?:\/\/|www\.)\S+$|^[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:[/?#]\S*)?$/i.test(String(v).trim());

/** Resumen en una línea de un elemento de una lista anidada (p. ej. un filamento de una placa). */
function listItemText(field, sub) {
  return field.campos.map((sf) => {
    const v = fieldValue(sf, sub);
    if (isEmpty(v) || sf.subtotal === false) return "";
    return `${fmtValue(sf, v)}${sf.abrev ? " " + sf.abrev : ""}`;
  }).filter(Boolean).join(" · ");
}

const isHexColor = (v) => /^#[0-9a-f]{6}$/i.test(String(v ?? ""));

/** Normaliza un color escrito a mano a #RRGGBB en mayúsculas ("9d432c" → "#9D432C"); null si no es válido. */
const normalizeHex = (v) => {
  const s = String(v ?? "").trim().replace(/^#?/, "#").toUpperCase();
  return isHexColor(s) ? s : null;
};
const swatch = (hex) => `<span class="swatch" style="background:${hex}"></span>`;

/** Formatea un valor según la definición de campo (texto plano, sin HTML). */
function fmtValue(field, value) {
  if (isEmpty(value)) return "";
  switch (field.tipo) {
    case "moneda": return `${moneyFmt.format(Number(value))} ${CONFIG.moneda || "€"}${field.unidad || ""}`;
    case "numero": return `${numFmt.format(Number(value))}${field.unidad ? " " + field.unidad : ""}`;
    case "porcentaje": return `${numFmt.format(Number(value))} %`;
    case "duracion": return fmtDuration(value);
    case "fecha": return fmtDate(value);
    case "booleano": return value ? "Sí" : "No";
    case "impresion": return PRINTS[value]?.nombre || `${value} (no encontrada)`;
    case "registro": return registerLabel(field, value) || "(eliminado)";
    case "lista": return asArray(value).map((sub) => listItemText(field, sub)).join("; ");
    default: return String(value);
  }
}

/** Igual que fmtValue pero devuelve HTML (enlaces, insignias, signo…). */
function fmtValueHtml(field, value) {
  if (isEmpty(value)) return `<span class="muted">—</span>`;
  if (field.tipo === "enlace" && isLocalPath(value)) {
    return `<span class="path">${esc(value)}</span>`;
  }
  if (field.tipo === "enlace" && isUrl(value)) {
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(value)}</a>`;
  }
  if (field.id === "estado") return `<span class="badge badge-${esc(value)}">${esc(value)}</span>`;
  if (field.tipo === "registro") {
    const item = (REGS[field.registro] || []).find((x) => x.id === value);
    const hex = item?.[field.muestra];
    return `${isHexColor(hex) ? swatch(hex) + " " : ""}${esc(fmtValue(field, value))}`;
  }
  if (field.tipo === "lista") {
    // Primer campo (p. ej. el filamento) destacado; el resto en una línea discreta
    const [main, ...rest] = field.campos;
    return `<ul class="sublist">${asArray(value).map((sub) => {
      const head = isEmpty(sub?.[main.id]) ? '<span class="muted">Sin especificar</span>' : fmtValueHtml(main, fieldValue(main, sub));
      const tail = rest.filter((sf) => sf.subtotal !== false && !isEmpty(fieldValue(sf, sub)))
        .map((sf) => `${fmtValue(sf, fieldValue(sf, sub))}${sf.abrev ? " " + sf.abrev : ""}`).join(" · ");
      return `<li>${head} <span class="muted">${esc(tail)}</span></li>`;
    }).join("")}</ul>`;
  }
  if (field.tipo === "color") return isHexColor(value) ? `${swatch(value)} <span class="muted">${esc(value.toUpperCase())}</span>` : esc(value);
  if (field.tipo === "impresion" && PRINTS[value]) {
    return `<a href="#/i/${esc(value)}">${esc(PRINTS[value].nombre)}</a>`;
  }
  if (field.signo && Number(value) !== 0) {
    return `<span class="${Number(value) > 0 ? "pos" : "neg"}">${esc(fmtValue(field, value))}</span>`;
  }
  return esc(fmtValue(field, value));
}

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), isError ? 5000 : 2500);
}

async function api(method, url, body, raw = false) {
  const opts = { method, headers: { "X-App": "impresiones-3d" } };
  if (body !== undefined) {
    if (raw) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const photoUrl = (id, name) => `/fotos/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
const sections = () => CONFIG.secciones || [];
const sectionById = (id) => sections().find((s) => s.id === id);
const generalSection = () => sectionById("general") || sections()[0];
const totalDefs = () => CONFIG.totales || [];
const printName = (p) => p.general?.nombre || "(sin nombre)";

/** Carga las impresiones (nombre y totales) para los desplegables de tipo "impresion". */
async function loadPrints(items) {
  items ??= await api("GET", "/api/impresiones");
  for (const k of Object.keys(PRINTS)) delete PRINTS[k];
  for (const it of items) {
    const tot = { ...(it._tot || computeTotals(it)), unidades: Number(it.general?.unidades) || 1 };
    // Función: depende de lo que se marque en la venta (incluir diseño, postprocesado…)
    tot.costeVenta = (flags) => saleUnitCost(tot, flags);
    PRINTS[it.id] = { nombre: printName(it), tot };
  }
  return items;
}

/** Componentes del coste real que se pueden incluir o no en una venta (y si se incluyen por defecto). */
const SALE_PARTS = [
  { flag: "incluirElectricidad", total: "costeElectricidad", etiqueta: "electricidad", def: true },
  { flag: "incluirAmortizacion", total: "costeAmortizacion", etiqueta: "amortización", def: true },
  { flag: "incluirPostprocesado", total: "costePostprocesado", etiqueta: "postprocesado", def: true },
  { flag: "incluirDiseno", total: "costeDiseno", etiqueta: "diseño", def: false },
];

/**
 * Coste por unidad para una venta: material y accesorios, más los componentes del
 * coste real marcados en la venta (si los costes reales están activados).
 */
function saleUnitCost(tot, flags = {}) {
  if (isEmpty(tot.coste) && !costsActive()) return null;
  return saleCostParts(tot, flags).reduce((s, p) => s + p.valor, 0) / (tot.unidades || 1);
}

/** Desglose (por impresión completa) de lo que entra en el coste de una venta. */
function saleCostParts(tot, flags = {}) {
  const parts = [{ etiqueta: "material", valor: Number(tot.coste) || 0 }];
  if (!costsActive()) return parts;
  for (const p of SALE_PARTS) {
    if ((flags?.[p.flag] ?? p.def) && Number(tot[p.total]) > 0) parts.push({ etiqueta: p.etiqueta, valor: Number(tot[p.total]) });
  }
  return parts;
}

/** Carga los registros indicados (p. ej. filamentos) para los campos de tipo "registro". */
async function loadRegisters(ids) {
  await Promise.all([...new Set(ids)].map(async (id) => { REGS[id] = await api("GET", `/api/registros/${id}`); }));
}

/** Registros que usan los campos de las secciones de impresión (también dentro de listas). */
const registersUsed = () => sections().flatMap((s) => s.campos)
  .flatMap((f) => (f.tipo === "lista" ? f.campos : [f]))
  .filter((f) => f.tipo === "registro").map((f) => f.registro);

/** Texto para mostrar un elemento de registro, según "mostrar" del campo. */
function registerLabel(field, id) {
  const item = (REGS[field.registro] || []).find((x) => x.id === id);
  if (!item) return null;
  return asArray(field.mostrar || ["nombre"]).map((k) => item[k]).filter((v) => !isEmpty(v)).join(field.separador ?? " · ");
}

async function loadCatalogs() {
  await Promise.all((CONFIG.catalogos || []).map(async (c) => {
    CATALOGS[c.id] = await api("GET", `/api/catalogos/${c.id}`);
  }));
}

// -------------------------------------------------------------- fórmulas

/**
 * Evalúa expresiones sencillas: números, nombres, + - * / y paréntesis.
 * `lookup(nombre)` devuelve el valor numérico o null. Si falta algún
 * dato o se divide entre cero, el resultado es null.
 */
function evalFormula(expr, lookup) {
  const tokens = expr.match(/\d+(?:\.\d+)?|[A-Za-z_]\w*|[-+*/()]/g) || [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const MISSING = Symbol();
  const bin = (a, b, f) => (a === MISSING || b === MISSING ? MISSING : f(a, b));

  function primary() {
    const t = next();
    if (t === "(") { const v = sum(); next(); return v; }
    if (t === "-") return bin(0, primary(), (a, b) => a - b);
    if (/^\d/.test(t)) return Number(t);
    const v = lookup(t);
    return isEmpty(v) || isNaN(Number(v)) ? MISSING : Number(v);
  }
  function product() {
    let v = primary();
    while (peek() === "*" || peek() === "/") {
      const op = next(), r = primary();
      v = bin(v, r, (a, b) => (op === "*" ? a * b : b === 0 ? MISSING : a / b));
    }
    return v;
  }
  function sum() {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = next(), r = product();
      v = bin(v, r, (a, b) => (op === "+" ? a + b : a - b));
    }
    return v;
  }
  try {
    const v = sum();
    return v === MISSING || !isFinite(v) ? null : v;
  } catch {
    return null;
  }
}

/** Valor de un campo dentro de una fila (calcula las fórmulas y las sumas de listas). */
function fieldValue(field, row) {
  if (field.formula) {
    if (field.ajuste === "costes" && !costsActive()) return null;
    // "ceroSiFalta": campos que, vacíos, cuentan como 0 (p. ej. gramos desperdiciados)
    const zero = asArray(field.ceroSiFalta);
    // "datosDe": datos del elemento de catálogo elegido en la fila (p. ej. consumo y precio de la máquina)
    const linked = field.datosDe
      ? (CATALOGS[field.datosDe.catalogo] || []).find((c) => c.nombre === row?.[field.datosDe.campo]) || {}
      : {};
    const rates = field.ajuste === "costes" ? costRates() : {};
    return evalFormula(field.formula, (k) => {
      if (!isEmpty(row?.[k])) return row[k];
      if (zero.includes(k)) return 0;
      if (!isEmpty(linked[k])) return linked[k];
      return rates[k];
    });
  }
  if (field.sumaDe) {
    // Suma de campos de una lista anidada, p. ej. el coste de los filamentos de una placa
    const lista = listFieldById(field.sumaDe.lista);
    let s = null;
    for (const sub of asArray(row?.[field.sumaDe.lista])) {
      for (const id of asArray(field.sumaDe.campos)) {
        const sf = lista?.campos.find((f) => f.id === id);
        const v = sf ? fieldValue(sf, sub) : sub?.[id];
        if (!isEmpty(v) && !isNaN(Number(v))) s = (s || 0) + Number(v);
      }
    }
    return s;
  }
  return row?.[field.id];
}

const listFieldById = (id) => sections().flatMap((s) => s.campos).find((f) => f.tipo === "lista" && f.id === id);

function defaultValue(field) {
  if (field.porDefecto === "hoy") return today();
  if (field.porDefecto !== undefined) return field.porDefecto;
  if (field.tipo === "catalogo") return catalogDefault(field.catalogo)?.nombre;
  return undefined;
}

function catalogDefault(cid) {
  const def = (CONFIG.catalogos || []).find((c) => c.id === cid);
  const flag = def?.campos.find((f) => f.unico)?.id;
  return flag ? (CATALOGS[cid] || []).find((it) => it[flag]) : undefined;
}

// ---------------------------------------------------------------- totales

/** Suma los campos marcados con "total" y luego calcula los totales con fórmula. */
function computeTotals(item) {
  const totals = {};
  const add = (field, row) => {
    const v = fieldValue(field, row);
    if (!isEmpty(v) && !isNaN(Number(v))) {
      for (const key of asArray(field.total)) totals[key] = (totals[key] || 0) + Number(v);
    }
  };
  for (const sec of sections()) {
    const rows = sec.repetible ? asArray(item[sec.id]) : [item[sec.id] || {}];
    for (const field of sec.campos) {
      for (const row of rows) {
        if (field.tipo === "lista") {
          // Listas anidadas (filamentos de una placa): se suman sus campos con "total"
          for (const sub of asArray(row?.[field.id])) for (const sf of field.campos) if (sf.total) add(sf, sub);
        } else if (field.total) add(field, row);
      }
    }
  }
  const declared = new Set(totalDefs().map((t) => t.id));
  // Campos generales: si faltan (impresiones antiguas) se usa su valor por defecto.
  const general = (k) => {
    const v = item.general?.[k];
    return isEmpty(v) ? defaultValue(generalSection().campos.find((f) => f.id === k) || {}) : v;
  };
  const rates = costRates();
  for (const t of totalDefs()) {
    if (!t.formula) continue;
    if (t.ajuste === "costes" && !AJUSTES?.costes?.activo) continue; // costes reales desactivados
    if (asArray(t.requiere).some((k) => isEmpty(totals[k]))) continue;
    if (t.requiereAlguno && asArray(t.requiereAlguno).every((k) => isEmpty(totals[k]))) continue;
    const v = evalFormula(t.formula, (k) =>
      k in totals ? totals[k] : declared.has(k) ? 0 : k in rates ? rates[k] : general(k));
    if (v !== null) totals[t.id] = v;
  }
  return totals;
}

function sectionSubtotal(sec, rows) {
  const sum = {};
  for (const field of visibleFields(sec.campos)) {
    if (!NUMERIC.includes(field.tipo) || field.subtotal === false) continue;
    let s = null;
    for (const r of rows) {
      const v = fieldValue(field, r);
      if (!isEmpty(v)) s = (s || 0) + Number(v);
    }
    if (s !== null) sum[field.id] = s;
  }
  return sum;
}

/** Indicadores de una impresión agrupados (Producción, Filamento, Coste real…), solo los que tienen valor. */
function totalsGroupsHtml(tot) {
  const groups = [];
  for (const t of totalDefs().filter((t) => !isEmpty(tot[t.id]) && !t.oculto)) {
    const g = t.grupo || "";
    let entry = groups.find((x) => x.name === g);
    if (!entry) groups.push((entry = { name: g, defs: [] }));
    entry.defs.push(t);
  }
  return groups.map((g) => `
    ${g.name ? `<h3 class="group-title">${esc(g.name)}</h3>` : ""}
    <div class="stats">${statTiles(g.defs, tot)}</div>`).join("");
}

function statTiles(defs, values) {
  return defs.map((t) => `
    <div class="card stat" ${t.ayuda ? `title="${esc(t.ayuda)}"` : ""}>
      <div class="label">${esc(t.etiqueta)}</div>
      <div class="value">${fmtValueHtml(t, values[t.id])}</div>
    </div>`).join("");
}

// ================================================================ LISTADO

const listState = { q: "", sort: "fecha", dir: -1 };

async function viewList() {
  const items = await api("GET", "/api/impresiones");
  items.forEach((it) => (it._tot = computeTotals(it)));

  const gen = generalSection();
  const genCols = gen.campos.filter((f) => f.enListado && f.id !== "nombre");
  // Columnas de totales: solo las que tienen algún valor (p. ej. el coste real si está activado)
  const totCols = totalDefs().filter((t) => t.enListado && items.some((it) => !isEmpty(it._tot[t.id])));
  const isSumable = (t) => t.sumable !== false;

  const columns = [
    { key: "nombre", label: "Nombre", get: (it) => printName(it).toLowerCase(), html: (it) => `<span class="name-cell">${esc(printName(it))}</span>` },
    ...genCols.map((f) => ({ key: f.id, label: f.etiqueta, num: NUMERIC.includes(f.tipo),
      get: (it) => it.general?.[f.id] ?? "", html: (it) => fmtValueHtml(f, it.general?.[f.id]) })),
    { key: "_placas", label: "Placas", num: true, get: (it) => asArray(it.placas).length, html: (it) => asArray(it.placas).length || "—" },
    ...totCols.map((t) => ({ key: "t_" + t.id, label: t.etiqueta, num: true, total: isSumable(t) ? t : null,
      get: (it) => it._tot[t.id] ?? -Infinity, html: (it) => fmtValueHtml(t, it._tot[t.id]) })),
  ];

  const allTotals = {};
  for (const it of items) for (const [k, v] of Object.entries(it._tot)) allTotals[k] = (allTotals[k] || 0) + v;
  const statDefs = totalDefs().filter((t) => t.resumen && isSumable(t) && !isEmpty(allTotals[t.id]));

  app.innerHTML = `
    <div class="page-head">
      <div><h1>Impresiones</h1><p class="muted" style="margin:4px 0 0">${items.length} registradas</p></div>
    </div>
    ${items.length ? `
      <div class="stats">${statTiles(statDefs, allTotals)}</div>
      <div class="toolbar">
        <input type="search" id="q" placeholder="Buscar por nombre, máquina, notas…" value="${esc(listState.q)}">
      </div>
      <div class="card table-wrap"><table>
        <thead><tr><th style="width:60px"></th>${columns.map((c) => `
          <th class="sortable ${c.num ? "num" : ""}" data-key="${c.key}">${esc(c.label)}
          <span class="arrow">${listState.sort === c.key ? (listState.dir > 0 ? "▲" : "▼") : ""}</span></th>`).join("")}
        </tr></thead>
        <tbody id="rows"></tbody>
        <tfoot id="foot"></tfoot>
      </table></div>` : `
      <div class="card empty">
        <h2>Todavía no hay impresiones</h2>
        <p class="muted">Registra tu primera impresión con sus placas, accesorios, pintura y fotos.</p>
        <a class="btn btn-primary" href="#/nueva">+ Nueva impresión</a>
      </div>`}
  `;
  if (!items.length) return;

  const renderRows = () => {
    const q = listState.q.trim().toLowerCase();
    const col = columns.find((c) => c.key === listState.sort) || columns[0];
    const visible = items
      .filter((it) => !q || JSON.stringify(it).toLowerCase().includes(q))
      .sort((a, b) => {
        const va = col.get(a), vb = col.get(b);
        return (va > vb ? 1 : va < vb ? -1 : 0) * listState.dir || (a.creado < b.creado ? 1 : -1);
      });

    document.getElementById("rows").innerHTML = visible.map((it) => `
      <tr class="clickable" data-id="${esc(it.id)}">
        <td>${it.fotos.length
          ? `<img class="thumb" loading="lazy" src="${photoUrl(it.id, it.fotos[0])}" alt="">`
          : `<div class="thumb thumb-empty">▢</div>`}</td>
        ${columns.map((c) => `<td class="${c.num ? "num" : ""}">${c.html(it)}</td>`).join("")}
      </tr>`).join("") ||
      `<tr><td colspan="${columns.length + 1}" class="muted" style="text-align:center;padding:24px">Sin resultados</td></tr>`;

    const sums = {};
    for (const it of visible) for (const [k, v] of Object.entries(it._tot)) sums[k] = (sums[k] || 0) + v;
    document.getElementById("foot").innerHTML = visible.length > 1 ? `<tr><td></td>${columns.map((c, i) =>
      `<td class="${c.num ? "num" : ""}">${i === 0 ? `Total (${visible.length})`
        : c.total ? fmtValueHtml(c.total, sums[c.total.id]) : ""}</td>`).join("")}</tr>` : "";
  };
  renderRows();

  document.getElementById("q").addEventListener("input", (e) => { listState.q = e.target.value; renderRows(); });
  app.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.key;
    listState.dir = listState.sort === k ? -listState.dir : (k === "nombre" ? 1 : -1);
    listState.sort = k;
    app.querySelectorAll("th .arrow").forEach((a) => (a.textContent = ""));
    th.querySelector(".arrow").textContent = listState.dir > 0 ? "▲" : "▼";
    renderRows();
  }));
  document.getElementById("rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && !e.target.closest("a")) location.hash = `#/i/${tr.dataset.id}`;
  });
}

// ================================================================ DETALLE

async function viewDetail(id) {
  const it = await api("GET", `/api/impresiones/${encodeURIComponent(id)}`);
  await loadRegisters(registersUsed());
  const tot = computeTotals(it);
  const gen = generalSection();
  // Las ventas viven en su propio registro; aquí solo se enlazan discretamente.
  const sold = (CONFIG.registros || []).some((r) => r.id === "ventas")
    ? (await api("GET", "/api/registros/ventas")).filter((v) => v.impresion === it.id) : [];
  const knownKeys = new Set(["id", "fotos", "creado", "modificado", ...sections().map((s) => s.id)]);

  const renderKv = (sec, obj, skip = []) => {
    const fields = visibleFields(sec.campos).filter((f) => !skip.includes(f.id) && !isEmpty(fieldValue(f, obj)));
    const extra = Object.keys(obj || {}).filter((k) => !sec.campos.some((f) => f.id === k) && !isEmpty(obj[k]));
    if (!fields.length && !extra.length) return `<p class="muted empty-note" style="margin:0">Sin datos</p>`;
    return `<dl class="kv">
      ${fields.map((f) => {
        const v = fieldValue(f, obj);
        const local = f.tipo === "enlace" && isLocalPath(v);
        return `<div class="${f.tipo === "textoLargo" || local ? "wide" : ""}"><dt>${esc(f.etiqueta)}</dt><dd>${fmtValueHtml(f, v)}
          ${local ? `<span class="path-actions">
            <button class="btn btn-sm" data-abrir="${esc(sec.id)}.${esc(f.id)}">Abrir</button>
            <button class="btn btn-sm" data-abrir="${esc(sec.id)}.${esc(f.id)}" data-carpeta="1">Abrir carpeta</button></span>` : ""}</dd></div>`;
      }).join("")}
      ${extra.map((k) => `<div><dt>${esc(k)} <span class="muted">(campo antiguo)</span></dt><dd>${esc(typeof obj[k] === "object" ? JSON.stringify(obj[k]) : obj[k])}</dd></div>`).join("")}
    </dl>`;
  };

  const renderTable = (sec, rows) => {
    if (!rows.length) return `<p class="muted empty-note" style="margin:0">Ninguno</p>`;
    const fields = visibleFields(sec.campos).filter((f) => rows.some((r) => !isEmpty(fieldValue(f, r))));
    const isNum = (f) => NUMERIC.includes(f.tipo);
    const sub = sectionSubtotal(sec, rows);
    return `<div class="table-wrap"><table>
      <thead><tr><th>#</th>${fields.map((f) => `<th class="${isNum(f) ? "num" : ""}">${esc(f.etiqueta)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr><td class="muted">${i + 1}</td>${fields.map((f) =>
        `<td class="${isNum(f) ? "num" : ""}">${fmtValueHtml(f, fieldValue(f, r))}</td>`).join("")}</tr>`).join("")}</tbody>
      ${rows.length > 1 ? `<tfoot><tr><td>Total</td>${fields.map((f) =>
        `<td class="${isNum(f) ? "num" : ""}">${sub[f.id] !== undefined ? esc(fmtValue(f, sub[f.id])) : ""}</td>`).join("")}</tr></tfoot>` : ""}
    </table></div>`;
  };

  const otherSections = sections().filter((s) => s !== gen);
  const extraTop = Object.keys(it).filter((k) => !knownKeys.has(k) && !isEmpty(it[k]));
  const unidades = it.general?.unidades;

  app.innerHTML = `
    <a class="back" href="#/">← Volver al listado</a>
    <div class="page-head">
      <div>
        <div class="print-only report-brand">Impresiones 3D · Ficha de impresión</div>
        <h1>${esc(printName(it))}</h1>
        <p class="muted" style="margin:4px 0 0">
          ${it.general?.estado ? fmtValueHtml({ id: "estado" }, it.general.estado) + " · " : ""}
          ${it.general?.fecha ? esc(fmtDate(it.general.fecha)) + " · " : ""}
          ${asArray(it.placas).length} placa(s)
          ${!isEmpty(unidades) ? ` · ${esc(numFmt.format(unidades))} unidad(es)` : ""}
        </p>
      </div>
      <div class="actions">
        <a class="btn" href="#/editar/${esc(it.id)}">Editar</a>
        <button class="btn" id="pdf">PDF</button>
        <button class="btn" id="dup">Duplicar</button>
        <button class="btn btn-danger" id="del">Eliminar</button>
      </div>
    </div>

    ${totalsGroupsHtml(tot)}

    ${it.fotos.length ? `<div class="card card-pad section"><h2>Fotos</h2>
      <div class="gallery">${it.fotos.map((f, i) => `
        <button data-i="${i}"><img loading="lazy" src="${photoUrl(it.id, f)}" alt="Foto ${i + 1}"></button>`).join("")}</div></div>` : ""}

    <div class="card card-pad section"><h2>${esc(gen.titulo)}</h2>${renderKv(gen, it.general, ["nombre", "estado", "fecha"])}</div>

    ${otherSections.map((sec) => `
      <div class="card card-pad section"><h2>${esc(sec.titulo)}</h2>
      ${sec.repetible ? renderTable(sec, asArray(it[sec.id])) : renderKv(sec, it[sec.id])}</div>`).join("")}

    ${extraTop.length ? `<div class="card card-pad section"><h2>Otros datos</h2>
      <pre style="margin:0;white-space:pre-wrap">${esc(JSON.stringify(Object.fromEntries(extraTop.map((k) => [k, it[k]])), null, 2))}</pre></div>` : ""}

    <p class="muted" style="font-size:.8rem;margin-top:20px">
      Creado ${esc((it.creado || "").replace("T", " "))} · Modificado ${esc((it.modificado || "").replace("T", " "))}
      ${sold.length ? `<span class="no-print"> · Vendida: ${esc(numFmt.format(sold.reduce((s, v) => s + (Number(v.cantidad) || 0), 0)))} ud. en
        ${sold.length} venta(s) · <a href="#/ventas?impresion=${encodeURIComponent(it.id)}">ver ventas</a></span>` : ""}
    </p>
  `;

  app.querySelectorAll(".gallery button").forEach((b) =>
    b.addEventListener("click", () => openLightbox(it.fotos.map((f) => photoUrl(it.id, f)), Number(b.dataset.i))));

  app.querySelectorAll("[data-abrir]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await api("POST", `/api/impresiones/${encodeURIComponent(it.id)}/abrir`,
        { campo: b.dataset.abrir, carpeta: !!b.dataset.carpeta });
      toast(b.dataset.carpeta ? "Abriendo la carpeta…" : "Abriendo el fichero…");
    } catch (err) {
      toast(err.message, true);
    }
  }));

  document.getElementById("pdf").addEventListener("click", () => printAs(`Ficha - ${printName(it)}`));

  document.getElementById("del").addEventListener("click", async () => {
    if (!confirm(`¿Eliminar "${printName(it)}"?\n\nSe moverá a data/papelera (se puede recuperar).`)) return;
    await api("DELETE", `/api/impresiones/${encodeURIComponent(it.id)}`);
    toast("Impresión movida a la papelera");
    location.hash = "#/";
  });

  document.getElementById("dup").addEventListener("click", () => {
    const copy = clone(it);
    delete copy.id; delete copy.fotos; delete copy.creado; delete copy.modificado;
    delete copy.ventas;
    copy.general = { ...(copy.general || {}), nombre: `${printName(it)} (copia)` };
    delete copy.general.fecha; delete copy.general.estado; // se rellenan con los valores por defecto
    sessionStorage.setItem("borrador", JSON.stringify(copy));
    location.hash = "#/nueva?copia";
  });
}

// ============================================================ FORMULARIOS

function fieldInput(field, value, path) {
  const attrs = `data-path="${esc(path)}" data-tipo="${field.tipo}" id="f-${esc(path)}"`;
  if (field.formula || field.sumaDe) {
    return `<output class="computed" data-formula="${esc(path)}"></output>`;
  }
  switch (field.tipo) {
    case "registro": {
      // Orden alfabético por lo que se muestra (empieza por el color); los que no tienen
      // el primer dato (p. ej. sin color) van al final.
      const first = asArray(field.mostrar || ["nombre"])[0];
      const items = [...(REGS[field.registro] || [])].sort((a, b) =>
        isEmpty(a[first]) - isEmpty(b[first]) ||
        (registerLabel(field, a.id) || "").localeCompare(registerLabel(field, b.id) || "", "es"));
      const missing = !isEmpty(value) && !items.some((x) => x.id === value);
      return `<select ${attrs}><option value="">${items.length ? "" : "(no hay ninguno registrado)"}</option>
        ${missing ? `<option value="${esc(value)}" selected>(eliminado)</option>` : ""}
        ${items.map((x) => `<option value="${esc(x.id)}" ${x.id === value ? "selected" : ""}>${esc(registerLabel(field, x.id))}</option>`).join("")}</select>`;
    }
    case "lista":
      return listEditor(field, asArray(value), path);
    case "textoLargo":
      return `<textarea ${attrs}>${esc(value)}</textarea>`;
    case "fecha":
      return `<input type="date" ${attrs} value="${esc(value)}">`;
    case "enlace":
      return `<input type="text" ${attrs} value="${esc(value)}" placeholder="https://… o D:\\carpeta\\fichero">`;
    case "numero":
    case "moneda": {
      const unit = field.tipo === "moneda" ? `${CONFIG.moneda || "€"}${field.unidad || ""}` : field.unidad;
      const input = `<input type="number" inputmode="decimal" step="${field.tipo === "moneda" ? "0.01" : "any"}" min="0" ${attrs} value="${esc(value)}">`;
      return unit ? `<div class="with-unit">${input}<span>${esc(unit)}</span></div>` : input;
    }
    case "duracion": {
      const h = isEmpty(value) ? "" : Math.floor(value / 60);
      const m = isEmpty(value) ? "" : Math.round(value % 60);
      return `<div class="duration" ${attrs}>
        <div class="with-unit"><input type="number" min="0" step="1" data-part="h" value="${h}" aria-label="${esc(field.etiqueta)} horas"><span>h</span></div>
        <div class="with-unit"><input type="number" min="0" step="1" data-part="m" value="${m}" aria-label="${esc(field.etiqueta)} minutos"><span>min</span></div>
      </div>`;
    }
    case "seleccion":
    case "catalogo": {
      const opts = field.tipo === "catalogo"
        ? (CATALOGS[field.catalogo] || []).map((c) => c.nombre).filter(Boolean)
        : asArray(field.opciones);
      const extra = !isEmpty(value) && !opts.includes(value) ? [value] : [];
      return `<select ${attrs}><option value=""></option>${[...opts, ...extra].map((o) =>
        `<option ${o === value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    }
    case "color": {
      // Selector visual + código #RRGGBB editable. El valor se guarda desde el campo de texto
      // (el selector nunca está vacío, así que no se guarda nada hasta que se elige o escribe un color).
      const hex = isHexColor(value) ? value.toUpperCase() : "";
      return `<div class="color-input">
        <input type="color" data-color-picker aria-label="${esc(field.etiqueta)}" value="${hex || "#808080"}">
        <input type="text" ${attrs} value="${esc(hex)}" placeholder="#RRGGBB" maxlength="7" spellcheck="false" autocomplete="off">
      </div>`;
    }
    case "booleano":
      return `<label class="check"><input type="checkbox" ${attrs} ${value ? "checked" : ""}> Sí</label>`;
    case "impresion": {
      const opts = Object.entries(PRINTS).sort((a, b) => a[1].nombre.localeCompare(b[1].nombre, "es"));
      const missing = !isEmpty(value) && !PRINTS[value];
      return `<select ${attrs}><option value=""></option>
        ${missing ? `<option value="${esc(value)}" selected>${esc(value)} (no encontrada)</option>` : ""}
        ${opts.map(([id, p]) => `<option value="${esc(id)}" ${id === value ? "selected" : ""}>${esc(p.nombre)}</option>`).join("")}</select>`;
    }
    default:
      return `<input type="text" ${attrs} value="${esc(value)}">`;
  }
}

/**
 * Editor de una lista anidada (p. ej. los filamentos de una placa): una fila
 * compacta por elemento, con cabecera de columnas y botones para añadir/quitar.
 */
function listEditor(field, rows, path) {
  const cols = field.campos;
  const tpl = cols.map((f) => (f.tipo === "registro" ? "minmax(180px, 2.4fr)" : "minmax(90px, 1fr)")).join(" ") + " 36px";
  return `<div class="sublist-editor" data-list="${esc(path)}" style="--cols:${tpl}">
    <div class="sub-row sub-head">${cols.map((f) => `<span>${esc(f.etiqueta)}</span>`).join("")}<span></span></div>
    ${rows.map((r, j) => `<div class="sub-row">${cols.map((f) =>
      `<div class="sub-cell" data-label="${esc(f.etiqueta)}">${fieldInput(f, r?.[f.id], `${path}.${j}.${f.id}`)}</div>`).join("")}
      <button type="button" class="btn btn-sm btn-ghost btn-danger" data-sub="rm" data-list="${esc(path)}" data-j="${j}" title="Quitar">×</button>
    </div>`).join("")}
    <button type="button" class="btn btn-sm" data-sub="add" data-list="${esc(path)}">+ ${esc(field.elemento || "Añadir")}</button>
    ${field.ayuda ? `<span class="help">${esc(field.ayuda)}</span>` : ""}
  </div>`;
}

function fieldBlock(field, value, path) {
  const wide = field.tipo === "textoLargo" || field.tipo === "lista";
  const label = field.tipo === "booleano" || field.formula || field.sumaDe || field.tipo === "lista" ? `<span class="label">${esc(field.etiqueta)}</span>`
    : `<label for="f-${esc(path)}">${esc(field.etiqueta)}${field.obligatorio ? ' <span class="req">*</span>' : ""}</label>`;
  let help = field.ayuda ? esc(field.ayuda) : "";
  if (field.tipo === "catalogo") {
    const empty = !(CATALOGS[field.catalogo] || []).length;
    help = `${help ? help + " · " : ""}${empty ? "Catálogo vacío: " : ""}<a href="#/catalogos">gestionar catálogo</a>`;
  }
  if (field.tipo === "lista") help = ""; // la ayuda va dentro del editor de la lista
  return `<div class="field ${wide ? "wide" : ""}">${label}${fieldInput(field, value, path)}
    ${help ? `<span class="help">${help}</span>` : ""}</div>`;
}

function newRow(sec) {
  const row = {};
  for (const f of sec.campos) {
    if (f.tipo === "lista") {
      if (f.inicial) row[f.id] = Array.from({ length: f.inicial }, () => newRow(f));
      continue;
    }
    const v = defaultValue(f);
    if (!isEmpty(v)) row[f.id] = v;
  }
  return row;
}

function setPath(target, path, value) {
  const keys = path.split(".");
  let obj = target;
  for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]] ??= {};
  const last = keys[keys.length - 1];
  if (isEmpty(value)) delete obj[last]; else obj[last] = value;
}

function readInput(holder) {
  const tipo = holder.dataset.tipo;
  if (tipo === "duracion") {
    const h = holder.querySelector('[data-part="h"]').value;
    const m = holder.querySelector('[data-part="m"]').value;
    return h === "" && m === "" ? null : (Number(h) || 0) * 60 + (Number(m) || 0);
  }
  if (tipo === "booleano") return holder.checked;
  if (tipo === "numero" || tipo === "moneda") return holder.value === "" ? null : Number(holder.value);
  if (tipo === "color") return normalizeHex(holder.value); // incompleto o no válido → no se guarda
  return holder.value.trim() === "" ? null : holder.value;
}

/** Enlaza las entradas de `root` con el objeto `target` (por data-path). */
function bindInputs(root, target, after) {
  const handler = (e) => {
    const holder = e.target.closest("[data-path]");
    if (!holder || !root.contains(holder)) return;
    holder.classList.remove("invalid");
    setPath(target, holder.dataset.path, readInput(holder));
    formDirty = true;
    after?.(holder, e);
  };
  root.addEventListener("input", handler);
  root.addEventListener("change", handler);
}

/** Marca los obligatorios vacíos; devuelve true si todo está bien. */
function checkRequired(list) {
  list.forEach((p) => document.querySelector(`[data-path="${CSS.escape(p)}"]`)?.classList.add("invalid"));
  if (!list.length) return true;
  document.querySelector(".invalid")?.focus();
  toast("Rellena los campos obligatorios", true);
  return false;
}

/** ¿La fila solo tiene valores por defecto? */
function rowIsBlank(fields, row) {
  return !Object.entries(row || {}).some(([k, v]) => {
    const f = fields.find((x) => x.id === k);
    if (f?.tipo === "lista") return asArray(v).some((sub) => !rowIsBlank(f.campos, sub));
    return !isEmpty(v) && !(f && v === defaultValue(f));
  });
}

/** Quita de las listas anidadas los elementos que solo tienen valores por defecto. */
function pruneLists(fields, row) {
  for (const f of fields.filter((x) => x.tipo === "lista")) {
    if (Array.isArray(row?.[f.id])) row[f.id] = row[f.id].filter((sub) => !rowIsBlank(f.campos, sub));
  }
}

/**
 * Localiza el campo y la fila de una ruta del formulario de impresión, también
 * dentro de listas: "placas.0.filamentos.1.gramosModelo".
 */
function resolvePath(draft, path) {
  const keys = path.split(".");
  const sec = sectionById(keys[0]);
  if (!sec) return {};
  let row = sec.repetible ? asArray(draft[sec.id])[Number(keys[1])] : draft[sec.id];
  let rest = keys.slice(sec.repetible ? 2 : 1);
  let fields = sec.campos;
  while (rest.length > 1) {
    const lista = fields.find((f) => f.id === rest[0] && f.tipo === "lista");
    if (!lista) break;
    row = asArray(row?.[rest[0]])[Number(rest[1])];
    fields = lista.campos;
    rest = rest.slice(2);
  }
  return { sec, field: fields.find((f) => f.id === rest[0]), row };
}

// ------------------------------------------------------ formulario impresión

async function viewForm(id) {
  const editing = !!id;
  const params = location.hash.split("?")[1] || "";
  await loadRegisters(registersUsed());
  let draft;
  if (editing) {
    draft = await api("GET", `/api/impresiones/${encodeURIComponent(id)}`);
  } else {
    const fromCopy = params === "copia" && sessionStorage.getItem("borrador");
    draft = fromCopy ? JSON.parse(fromCopy) : {};
    sessionStorage.removeItem("borrador");
    for (const sec of sections()) {
      if (sec.repetible) {
        if (!asArray(draft[sec.id]).length && sec.inicial) {
          draft[sec.id] = Array.from({ length: sec.inicial }, () => newRow(sec));
        }
      } else {
        draft[sec.id] = { ...newRow(sec), ...(draft[sec.id] || {}) };
      }
    }
  }
  const existingPhotos = [...(draft.fotos || [])];
  const removedPhotos = new Set();
  const pendingPhotos = []; // { file, url }
  formDirty = false;

  app.innerHTML = `
    <a class="back" href="${editing ? `#/i/${esc(id)}` : "#/"}">← ${editing ? "Volver a la impresión" : "Volver al listado"}</a>
    <div class="page-head"><h1>${editing ? "Editar impresión" : "Nueva impresión"}</h1></div>
    <form id="form" novalidate>
      ${sections().map((sec) => `
        <div class="card card-pad section" data-sec="${esc(sec.id)}">
          <h2>${esc(sec.titulo)}</h2>
          <div class="sec-body" style="margin-top:12px"></div>
        </div>`).join("")}
      <div class="card card-pad section">
        <h2>Fotos</h2>
        <div class="dropzone" id="drop" style="margin-top:12px" tabindex="0">
          Arrastra imágenes aquí o <strong>haz clic para elegirlas</strong>
          <input type="file" id="file" accept="image/*" multiple hidden>
        </div>
        <div class="photo-grid" id="photos"></div>
      </div>
      <div class="card card-pad section form-totals">
        <h2>Resumen de costes</h2>
        <div id="totals-live" style="margin-top:12px"></div>
      </div>
      <div class="form-actions">
        <div class="form-summary" id="summary"></div>
        <a class="btn" href="${editing ? `#/i/${esc(id)}` : "#/"}" id="cancel">Cancelar</a>
        <button class="btn btn-primary" type="submit" id="save">Guardar</button>
      </div>
    </form>
  `;

  // --- cálculos en vivo
  const updateSummary = () => {
    const tot = computeTotals(draft);
    const show = ["coste", "costeUnidad", "costeReal", "costeRealUnidad"]
      .map((k) => totalDefs().find((t) => t.id === k)).filter((t) => t && !isEmpty(tot[t.id]));
    document.getElementById("summary").innerHTML = show.map((t) =>
      `<span><span class="muted">${esc(t.etiqueta)}:</span> <strong>${fmtValueHtml(t, tot[t.id])}</strong></span>`).join("");

    document.getElementById("totals-live").innerHTML = totalsGroupsHtml(tot) ||
      `<p class="muted" style="margin:0">Rellena las placas (tiempo y filamentos), los accesorios y los tiempos de montaje para ver el coste.</p>`;
  };
  const updateComputed = (sec) => {
    const body = app.querySelector(`[data-sec="${sec.id}"]`);
    body.querySelectorAll("output[data-formula]").forEach((out) => {
      const { field, row } = resolvePath(draft, out.dataset.formula);
      if (field) out.textContent = fmtValue(field, fieldValue(field, row)) || "—";
    });
    const el = body.querySelector(".subtotal");
    if (el) {
      const rows = asArray(draft[sec.id]);
      const sub = sectionSubtotal(sec, rows);
      const txt = sec.campos.filter((f) => (f.total || f.sumaDe) && sub[f.id] !== undefined)
        .map((f) => `${esc(f.etiqueta)}: <strong>${esc(fmtValue(f, sub[f.id]))}</strong>`).join(" · ");
      el.innerHTML = rows.length > 1 && txt ? `Total ${esc(sec.titulo.toLowerCase())} — ${txt}` : "";
    }
    updateSummary();
  };

  // --- secciones
  const renderSection = (sec) => {
    const body = app.querySelector(`[data-sec="${sec.id}"] .sec-body`);
    if (!sec.repetible) {
      draft[sec.id] = draft[sec.id] || {};
      body.innerHTML = `<div class="form-grid">${visibleFields(sec.campos).map((f) =>
        fieldBlock(f, draft[sec.id][f.id], `${sec.id}.${f.id}`)).join("")}</div>`;
      updateComputed(sec);
      return;
    }
    const rows = (draft[sec.id] = asArray(draft[sec.id]));
    body.innerHTML = `
      ${rows.map((row, i) => `
        <div class="repeat-item" data-row="${i}">
          <div class="repeat-head">
            <strong>${esc(sec.elemento || "Elemento")} ${i + 1}</strong>
            <div class="btns">
              <button type="button" class="btn btn-sm btn-ghost" data-act="dup" data-i="${i}">Duplicar</button>
              <button type="button" class="btn btn-sm btn-ghost btn-danger" data-act="rm" data-i="${i}">Quitar</button>
            </div>
          </div>
          <div class="form-grid">${visibleFields(sec.campos).map((f) => fieldBlock(f, row[f.id], `${sec.id}.${i}.${f.id}`)).join("")}</div>
        </div>`).join("")}
      <button type="button" class="btn" data-act="add">+ Añadir ${esc((sec.elemento || "elemento").toLowerCase())}</button>
      <p class="subtotal"></p>
    `;
    updateComputed(sec);
    body.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      if (b.dataset.act === "add") rows.push(newRow(sec));
      if (b.dataset.act === "dup") rows.splice(i + 1, 0, clone(rows[i]));
      if (b.dataset.act === "rm") {
        if (!rowIsBlank(sec.campos, rows[i]) && !confirm(`¿Quitar ${sec.elemento || "elemento"} ${i + 1}?`)) return;
        rows.splice(i, 1);
      }
      formDirty = true;
      renderSection(sec);
      if (b.dataset.act === "add") body.querySelector(".repeat-item:last-of-type")?.scrollIntoView({ block: "center", behavior: "smooth" });
    }));
    // Listas anidadas (filamentos de cada placa): añadir / quitar elementos
    body.querySelectorAll("[data-sub]").forEach((b) => b.addEventListener("click", () => {
      const keys = b.dataset.list.split(".");
      const { field } = resolvePath(draft, b.dataset.list);
      const parent = resolvePath(draft, `${keys.slice(0, -1).join(".")}.__`).row;
      if (!field || !parent) return;
      const list = (parent[field.id] = asArray(parent[field.id]));
      if (b.dataset.sub === "add") list.push(newRow(field));
      if (b.dataset.sub === "rm") {
        const j = Number(b.dataset.j);
        if (!rowIsBlank(field.campos, list[j]) && !confirm(`¿Quitar este ${(field.elemento || "elemento").toLowerCase()}?`)) return;
        list.splice(j, 1);
      }
      formDirty = true;
      renderSection(sec);
    }));
  };
  sections().forEach(renderSection);

  const form = document.getElementById("form");
  bindInputs(form, draft, (holder, e) => {
    const { sec, field, row } = resolvePath(draft, holder.dataset.path);
    if (!sec) return;
    // Al elegir un elemento de catálogo o de registro se copian sus datos
    // (p. ej. el precio del accesorio o el precio por kg del filamento).
    if (e.type === "change" && field?.rellena && row) {
      const value = readInput(holder);
      const item = field.tipo === "registro"
        ? (REGS[field.registro] || []).find((x) => x.id === value)
        : (CATALOGS[field.catalogo] || []).find((c) => c.nombre === value);
      if (item) for (const [dest, src] of Object.entries(field.rellena)) {
        if (!isEmpty(item[src])) row[dest] = item[src];
      }
      renderSection(sec);
      return;
    }
    updateComputed(sec);
  });


  // --- fotos
  const photosEl = document.getElementById("photos");
  const renderPhotos = () => {
    photosEl.innerHTML =
      existingPhotos.filter((n) => !removedPhotos.has(n)).map((n) => `
        <div class="photo-item"><img src="${photoUrl(id, n)}" alt="">
        <button type="button" class="rm" data-old="${esc(n)}" title="Quitar">×</button></div>`).join("") +
      pendingPhotos.map((p, i) => `
        <div class="photo-item"><img src="${p.url}" alt=""><span class="tag">nueva</span>
        <button type="button" class="rm" data-new="${i}" title="Quitar">×</button></div>`).join("");
    photosEl.querySelectorAll(".rm").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.old) removedPhotos.add(b.dataset.old);
      else { URL.revokeObjectURL(pendingPhotos[b.dataset.new].url); pendingPhotos.splice(Number(b.dataset.new), 1); }
      formDirty = true;
      renderPhotos();
    }));
  };
  const addFiles = (files) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      pendingPhotos.push({ file, url: URL.createObjectURL(file) });
    }
    formDirty = true;
    renderPhotos();
  };
  renderPhotos();
  const drop = document.getElementById("drop");
  const fileInput = document.getElementById("file");
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  // --- guardar
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const missing = [];
    for (const sec of sections()) {
      for (const f of sec.campos.filter((c) => c.obligatorio)) {
        if (sec.repetible) {
          asArray(draft[sec.id]).forEach((r, i) => { if (isEmpty(r[f.id])) missing.push(`${sec.id}.${i}.${f.id}`); });
        } else if (isEmpty(draft[sec.id]?.[f.id])) missing.push(`${sec.id}.${f.id}`);
      }
    }
    if (!checkRequired(missing)) return;

    // Quitar filas que solo tienen valores por defecto.
    for (const sec of sections()) {
      if (sec.repetible) {
        draft[sec.id] = asArray(draft[sec.id]).filter((r) => !rowIsBlank(sec.campos, r));
        draft[sec.id].forEach((r) => pruneLists(sec.campos, r));
      } else pruneLists(sec.campos, draft[sec.id]);
    }

    const btn = document.getElementById("save");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const payload = clone(draft);
      delete payload.fotos;
      const saved = editing
        ? await api("PUT", `/api/impresiones/${encodeURIComponent(id)}`, payload)
        : await api("POST", "/api/impresiones", payload);
      for (const name of removedPhotos) {
        await api("DELETE", `/api/impresiones/${encodeURIComponent(saved.id)}/fotos/${encodeURIComponent(name)}`);
      }
      for (const p of pendingPhotos) {
        await api("POST", `/api/impresiones/${encodeURIComponent(saved.id)}/fotos?nombre=${encodeURIComponent(p.file.name)}`, p.file, true);
      }
      formDirty = false;
      toast("Impresión guardada");
      location.hash = `#/i/${saved.id}`;
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false; btn.textContent = "Guardar";
    }
  });
}

// ============================================================== CATÁLOGOS

async function viewCatalogs() {
  await loadCatalogs();
  const defs = CONFIG.catalogos || [];
  const drafts = Object.fromEntries(defs.map((c) => [c.id, clone(CATALOGS[c.id] || [])]));

  app.innerHTML = `
    <div class="page-head"><div><h1>Catálogos</h1>
      <p class="muted" style="margin:4px 0 0">Listas que luego eliges al registrar cada impresión.</p></div></div>
    <div id="cat-root">${defs.map((c) => `
      <div class="card card-pad section" data-cat="${esc(c.id)}">
        <div class="repeat-head"><h2>${esc(c.titulo)}</h2>
          <div class="btns">
            <button class="btn btn-sm" data-sort="${esc(c.id)}" title="Ordenar alfabéticamente por nombre">Ordenar A→Z</button>
            <button class="btn btn-primary btn-sm" data-save="${esc(c.id)}">Guardar ${esc(c.titulo.toLowerCase())}</button>
          </div></div>
        <p class="muted small cat-hint">${c.descripcion ? `${esc(c.descripcion)} ` : ""}El orden de esta lista es el de los desplegables. Arrastra ⠿ o usa ↑ ↓ para cambiarlo.</p>
        <div class="cat-body"></div>
      </div>`).join("")}</div>
  `;

  // Marca el catálogo como pendiente de guardar (resalta su botón)
  const changed = (c) => {
    formDirty = true;
    const pending = JSON.stringify(drafts[c.id]) !== JSON.stringify(CATALOGS[c.id] || []);
    app.querySelector(`[data-save="${c.id}"]`).classList.toggle("pending", pending);
  };
  const move = (c, from, to) => {
    const rows = drafts[c.id];
    if (to < 0 || to >= rows.length || from === to) return;
    rows.splice(to, 0, rows.splice(from, 1)[0]);
    changed(c);
    render(c);
  };

  const render = (c) => {
    const rows = drafts[c.id];
    const body = app.querySelector(`[data-cat="${c.id}"] .cat-body`);
    body.innerHTML = `
      ${rows.length ? `<div class="table-wrap"><table class="edit-table">
        <thead><tr><th class="order-col"></th>${c.campos.map((f) => `<th>${esc(f.etiqueta)}${f.obligatorio ? ' <span class="req">*</span>' : ""}</th>`).join("")}<th></th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr data-i="${i}">
          <td class="order-col"><span class="order-btns">
            <span class="drag" data-drag="${i}" title="Arrastrar para mover" aria-hidden="true">⠿</span>
            <button type="button" class="btn btn-sm btn-ghost" data-move="-1" data-i="${i}" title="Subir" ${i === 0 ? "disabled" : ""}>↑</button>
            <button type="button" class="btn btn-sm btn-ghost" data-move="1" data-i="${i}" title="Bajar" ${i === rows.length - 1 ? "disabled" : ""}>↓</button>
          </span></td>
          ${c.campos.map((f) =>
          `<td class="${f.tipo === "booleano" ? "center" : ""}">${fieldInput(f, r[f.id], `${c.id}.${i}.${f.id}`)}</td>`).join("")}
          <td><button type="button" class="btn btn-sm btn-ghost btn-danger" data-rm="${i}" title="Quitar">×</button></td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">Sin elementos todavía.</p>`}
      <button type="button" class="btn" data-add style="margin-top:10px">+ Añadir ${esc((c.elemento || "elemento").toLowerCase())}</button>
    `;
    body.querySelector("[data-add]").onclick = () => {
      rows.push({}); changed(c); render(c);
      body.querySelector("tbody tr:last-child input")?.focus();
    };
    body.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.rm);
      if (!rowIsBlank(c.campos, rows[i]) && !confirm(`¿Quitar "${rows[i].nombre || "elemento"}" del catálogo?\n\nLas impresiones que ya lo usan conservan su nombre y precio.`)) return;
      rows.splice(i, 1); changed(c); render(c);
    }));
    body.querySelectorAll("[data-move]").forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.i);
      move(c, i, i + Number(b.dataset.move));
      body.querySelector(`tr[data-i="${i + Number(b.dataset.move)}"] [data-move="${b.dataset.move}"]:not(:disabled)`)?.focus();
    }));

    // Arrastrar y soltar: la fila solo se puede arrastrar desde el asa ⠿
    let dragFrom = null;
    body.querySelectorAll("tbody tr").forEach((tr) => {
      const handle = tr.querySelector("[data-drag]");
      handle.addEventListener("mousedown", () => (tr.draggable = true));
      handle.addEventListener("mouseup", () => (tr.draggable = false)); // clic sin arrastrar
      tr.addEventListener("dragstart", (e) => {
        dragFrom = Number(tr.dataset.i);
        tr.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(dragFrom));
      });
      tr.addEventListener("dragend", () => {
        tr.draggable = false;
        tr.classList.remove("dragging");
        body.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
      });
      tr.addEventListener("dragover", (e) => {
        if (dragFrom === null) return;
        e.preventDefault();
        const after = e.offsetY > tr.offsetHeight / 2;
        body.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
        tr.classList.add(after ? "drop-after" : "drop-before");
      });
      tr.addEventListener("drop", (e) => {
        e.preventDefault();
        if (dragFrom === null) return;
        const target = Number(tr.dataset.i);
        let to = tr.classList.contains("drop-after") ? target + 1 : target;
        if (dragFrom < to) to--;
        const from = dragFrom;
        dragFrom = null;
        move(c, from, to);
      });
    });
  };
  defs.forEach(render);

  app.querySelectorAll("[data-sort]").forEach((btn) => btn.addEventListener("click", () => {
    const c = defs.find((d) => d.id === btn.dataset.sort);
    drafts[c.id].sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es", { sensitivity: "base" }));
    changed(c);
    render(c);
  }));

  bindInputs(document.getElementById("cat-root"), drafts, (holder) => {
    const [cid, i, fid] = holder.dataset.path.split(".");
    const c = defs.find((d) => d.id === cid);
    const field = c?.campos.find((f) => f.id === fid);
    if (c) changed(c);
    if (field?.unico && holder.checked) {
      drafts[cid].forEach((r, j) => { if (j !== Number(i)) delete r[fid]; });
      render(c);
    }
  });

  app.querySelectorAll("[data-save]").forEach((btn) => btn.addEventListener("click", async () => {
    const c = defs.find((d) => d.id === btn.dataset.save);
    const rows = drafts[c.id];
    const missing = [];
    rows.forEach((r, i) => {
      if (rowIsBlank(c.campos, r)) return;
      c.campos.filter((f) => f.obligatorio && isEmpty(r[f.id])).forEach((f) => missing.push(`${c.id}.${i}.${f.id}`));
    });
    if (!checkRequired(missing)) return;
    const names = rows.filter((r) => !rowIsBlank(c.campos, r)).map((r) => (r.nombre || "").trim().toLowerCase());
    if (new Set(names).size !== names.length) return toast("Hay nombres repetidos en el catálogo", true);
    try {
      drafts[c.id] = await api("PUT", `/api/catalogos/${c.id}`, rows.filter((r) => !rowIsBlank(c.campos, r)));
      CATALOGS[c.id] = clone(drafts[c.id]);
      formDirty = defs.some((d) => JSON.stringify(drafts[d.id]) !== JSON.stringify(CATALOGS[d.id]));
      btn.classList.remove("pending");
      render(c);
      toast(`${c.titulo} guardados`);
    } catch (err) {
      toast(err.message, true);
    }
  }));
}

// ======================================================= REGISTROS (GASTOS)

const regState = {}; // filtros por registro: { q, year, group }

/** Muestra un enlace web acortado o, si es una ruta local, botones para abrirla. */
function linkCell(value, abrirAttrs) {
  if (isEmpty(value)) return `<span class="muted">—</span>`;
  if (isLocalPath(value)) {
    const file = String(value).split(/[\\/]/).pop();
    return `<span class="link-cell" title="${esc(value)}">
      <button class="btn btn-sm" ${abrirAttrs}>Abrir</button>
      <button class="btn btn-sm btn-ghost" ${abrirAttrs} data-carpeta="1" title="Abrir carpeta">📁</button>
      <span class="muted path-name">${esc(file)}</span></span>`;
  }
  if (!isUrl(value)) return `<span title="Referencia">${esc(value)}</span>`;
  const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let host = value;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* se deja tal cual */ }
  return `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(value)}">${esc(host)} ↗</a>`;
}

// viewRegister() está en registros.js

// ======================================================= CAMPOS DE COLOR

// Selector visual y código #RRGGBB van sincronizados; el código se guarda en mayúsculas.
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.matches?.("[data-color-picker]")) {
    const text = el.parentElement.querySelector('[data-tipo="color"]');
    text.value = el.value.toUpperCase();
    text.classList.remove("invalid");
    text.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (el.matches?.('input[data-tipo="color"]')) {
    const hex = normalizeHex(el.value);
    if (hex) el.parentElement.querySelector("[data-color-picker]").value = hex.toLowerCase();
  }
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (!el.matches?.('input[data-tipo="color"]')) return;
  const hex = normalizeHex(el.value);
  if (hex) el.value = hex;                       // "9d432c" → "#9D432C"
  el.classList.toggle("invalid", !hex && el.value.trim() !== "");
  if (!hex && el.value.trim() !== "") toast("Color no válido: usa el formato #RRGGBB, p. ej. #9D432C", true);
}); // en fase de burbuja: después del formulario, que ya guarda el valor normalizado

// ============================================================ VISOR FOTOS

const lb = document.getElementById("lightbox");
const lbState = { urls: [], i: 0 };
function openLightbox(urls, i) {
  lbState.urls = urls; lbState.i = i;
  lb.querySelector("img").src = urls[i];
  lb.querySelector(".lb-prev").hidden = lb.querySelector(".lb-next").hidden = urls.length < 2;
  lb.hidden = false;
}
const lbMove = (d) => {
  lbState.i = (lbState.i + d + lbState.urls.length) % lbState.urls.length;
  lb.querySelector("img").src = lbState.urls[lbState.i];
};
lb.querySelector(".lb-close").onclick = () => (lb.hidden = true);
lb.querySelector(".lb-prev").onclick = () => lbMove(-1);
lb.querySelector(".lb-next").onclick = () => lbMove(1);
lb.addEventListener("click", (e) => { if (e.target === lb) lb.hidden = true; });
document.addEventListener("keydown", (e) => {
  if (lb.hidden) return;
  if (e.key === "Escape") lb.hidden = true;
  if (e.key === "ArrowLeft") lbMove(-1);
  if (e.key === "ArrowRight") lbMove(1);
});

// ================================================================ ROUTER

let currentHash = location.hash;
let skipNextRoute = false;

async function router() {
  if (skipNextRoute) { skipNextRoute = false; return; }
  if (formDirty && location.hash !== currentHash) {
    if (!confirm("Hay cambios sin guardar. ¿Salir sin guardar?")) {
      skipNextRoute = true;
      location.hash = currentHash;
      return;
    }
  }
  formDirty = false;
  currentHash = location.hash;
  lb.hidden = true;
  window.onresize = null;

  const hash = location.hash.replace(/^#\/?/, "");
  const [route, param] = hash.split("?")[0].split("/");
  document.querySelectorAll("[data-nav]").forEach((a) =>
    a.classList.toggle("active", a.dataset.nav === (route || "lista")));
  try {
    if (!CONFIG) {
      CONFIG = await api("GET", "/api/config");
      AJUSTES = await api("GET", "/api/ajustes");
      await loadCatalogs();
    }
    if (route === "nueva") await viewForm(null);
    else if (route === "editar" && param) await viewForm(decodeURIComponent(param));
    else if (route === "i" && param) await viewDetail(decodeURIComponent(param));
    else if (route === "catalogos") await viewCatalogs();
    else if (route === "informes") await viewReports(param);
    else if (route === "configuracion") await viewSettings();
    else if ((CONFIG.registros || []).some((r) => r.id === route)) {
      await viewRegister(CONFIG.registros.find((r) => r.id === route), hash.split("?")[1] || "");
    } else await viewList();
    window.scrollTo(0, 0);
  } catch (err) {
    app.innerHTML = `<div class="card empty"><h2>Algo ha fallado</h2><p class="muted">${esc(err.message)}</p>
      <a class="btn" href="#/">Volver al listado</a></div>`;
  }
}

window.addEventListener("hashchange", router);
window.addEventListener("beforeunload", (e) => { if (formDirty) e.preventDefault(); });
router();
