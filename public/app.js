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

/** Formatea un valor según la definición de campo (texto plano, sin HTML). */
function fmtValue(field, value) {
  if (isEmpty(value)) return "";
  switch (field.tipo) {
    case "moneda": return `${moneyFmt.format(Number(value))} ${CONFIG.moneda || "€"}`;
    case "numero": return `${numFmt.format(Number(value))}${field.unidad ? " " + field.unidad : ""}`;
    case "porcentaje": return `${numFmt.format(Number(value))} %`;
    case "duracion": return fmtDuration(value);
    case "fecha": return fmtDate(value);
    case "booleano": return value ? "Sí" : "No";
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

/** Valor de un campo dentro de una fila (calcula las fórmulas). */
function fieldValue(field, row) {
  if (field.formula) return evalFormula(field.formula, (k) => row?.[k]);
  return row?.[field.id];
}

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
  for (const sec of sections()) {
    const rows = sec.repetible ? asArray(item[sec.id]) : [item[sec.id] || {}];
    for (const field of sec.campos) {
      if (!field.total) continue;
      for (const row of rows) {
        const v = fieldValue(field, row);
        if (!isEmpty(v) && !isNaN(Number(v))) {
          for (const key of asArray(field.total)) totals[key] = (totals[key] || 0) + Number(v);
        }
      }
    }
  }
  const declared = new Set(totalDefs().map((t) => t.id));
  // Campos generales: si faltan (impresiones antiguas) se usa su valor por defecto.
  const general = (k) => {
    const v = item.general?.[k];
    return isEmpty(v) ? defaultValue(generalSection().campos.find((f) => f.id === k) || {}) : v;
  };
  for (const t of totalDefs()) {
    if (!t.formula) continue;
    if (asArray(t.requiere).some((k) => isEmpty(totals[k]))) continue;
    const v = evalFormula(t.formula, (k) =>
      k in totals ? totals[k] : declared.has(k) ? 0 : general(k));
    if (v !== null) totals[t.id] = v;
  }
  return totals;
}

function sectionSubtotal(sec, rows) {
  const sum = {};
  for (const field of sec.campos) {
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
  const totCols = totalDefs().filter((t) => t.enListado);
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
        <input type="search" id="q" placeholder="Buscar por nombre, material, impresora, notas…" value="${esc(listState.q)}">
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
        <p class="muted">Registra tu primera impresión con sus placas, accesorios, pintura, ventas y fotos.</p>
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
  const tot = computeTotals(it);
  const gen = generalSection();
  const knownKeys = new Set(["id", "fotos", "creado", "modificado", ...sections().map((s) => s.id)]);

  // Indicadores agrupados (Producción, Filamento, Ventas…)
  const groups = [];
  for (const t of totalDefs().filter((t) => !isEmpty(tot[t.id]))) {
    const g = t.grupo || "";
    let entry = groups.find((x) => x.name === g);
    if (!entry) groups.push((entry = { name: g, defs: [] }));
    entry.defs.push(t);
  }

  const renderKv = (sec, obj, skip = []) => {
    const fields = sec.campos.filter((f) => !skip.includes(f.id) && !isEmpty(fieldValue(f, obj)));
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
    const fields = sec.campos.filter((f) => rows.some((r) => !isEmpty(fieldValue(f, r))));
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
        ${sectionById("ventas") ? `<a class="btn" href="#/editar/${esc(it.id)}?venta">+ Venta</a>` : ""}
        <a class="btn" href="#/editar/${esc(it.id)}">Editar</a>
        <button class="btn" id="pdf">PDF</button>
        <button class="btn" id="dup">Duplicar</button>
        <button class="btn btn-danger" id="del">Eliminar</button>
      </div>
    </div>

    ${groups.map((g) => `
      ${g.name ? `<h3 class="group-title">${esc(g.name)}</h3>` : ""}
      <div class="stats">${statTiles(g.defs, tot)}</div>`).join("")}

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
  if (field.formula) {
    return `<output class="computed" data-formula="${esc(path)}"></output>`;
  }
  switch (field.tipo) {
    case "textoLargo":
      return `<textarea ${attrs}>${esc(value)}</textarea>`;
    case "fecha":
      return `<input type="date" ${attrs} value="${esc(value)}">`;
    case "enlace":
      return `<input type="text" ${attrs} value="${esc(value)}" placeholder="https://… o D:\\carpeta\\fichero">`;
    case "numero":
    case "moneda": {
      const unit = field.tipo === "moneda" ? (CONFIG.moneda || "€") : field.unidad;
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
    case "booleano":
      return `<label class="check"><input type="checkbox" ${attrs} ${value ? "checked" : ""}> Sí</label>`;
    default:
      return `<input type="text" ${attrs} value="${esc(value)}">`;
  }
}

function fieldBlock(field, value, path) {
  const wide = field.tipo === "textoLargo";
  const label = field.tipo === "booleano" || field.formula ? `<span class="label">${esc(field.etiqueta)}</span>`
    : `<label for="f-${esc(path)}">${esc(field.etiqueta)}${field.obligatorio ? ' <span class="req">*</span>' : ""}</label>`;
  let help = field.ayuda ? esc(field.ayuda) : "";
  if (field.tipo === "catalogo") {
    const empty = !(CATALOGS[field.catalogo] || []).length;
    help = `${help ? help + " · " : ""}${empty ? "Catálogo vacío: " : ""}<a href="#/catalogos">gestionar catálogo</a>`;
  }
  return `<div class="field ${wide ? "wide" : ""}">${label}${fieldInput(field, value, path)}
    ${help ? `<span class="help">${help}</span>` : ""}</div>`;
}

function newRow(sec) {
  const row = {};
  for (const f of sec.campos) {
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
    return !isEmpty(v) && !(f && v === defaultValue(f));
  });
}

// ------------------------------------------------------ formulario impresión

async function viewForm(id) {
  const editing = !!id;
  const params = location.hash.split("?")[1] || "";
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
  if (params === "venta" && sectionById("ventas")) {
    draft.ventas = [...asArray(draft.ventas), newRow(sectionById("ventas"))];
  }

  const existingPhotos = [...(draft.fotos || [])];
  const removedPhotos = new Set();
  const pendingPhotos = []; // { file, url }
  formDirty = params === "venta";

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
    const show = ["coste", "costeUnidad", "ingresos", "balance"]
      .map((k) => totalDefs().find((t) => t.id === k)).filter((t) => t && !isEmpty(tot[t.id]));
    document.getElementById("summary").innerHTML = show.map((t) =>
      `<span><span class="muted">${esc(t.etiqueta)}:</span> <strong>${fmtValueHtml(t, tot[t.id])}</strong></span>`).join("");
  };
  const updateComputed = (sec) => {
    const body = app.querySelector(`[data-sec="${sec.id}"]`);
    body.querySelectorAll("output[data-formula]").forEach((out) => {
      const keys = out.dataset.formula.split(".");
      const field = sec.campos.find((f) => f.id === keys[keys.length - 1]);
      const row = sec.repetible ? asArray(draft[sec.id])[Number(keys[1])] : draft[sec.id];
      out.textContent = fmtValue(field, fieldValue(field, row)) || "—";
    });
    const el = body.querySelector(".subtotal");
    if (el) {
      const rows = asArray(draft[sec.id]);
      const sub = sectionSubtotal(sec, rows);
      const txt = sec.campos.filter((f) => f.total && sub[f.id] !== undefined)
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
      body.innerHTML = `<div class="form-grid">${sec.campos.map((f) =>
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
          <div class="form-grid">${sec.campos.map((f) => fieldBlock(f, row[f.id], `${sec.id}.${i}.${f.id}`)).join("")}</div>
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
  };
  sections().forEach(renderSection);

  const form = document.getElementById("form");
  bindInputs(form, draft, (holder, e) => {
    const keys = holder.dataset.path.split(".");
    const sec = sectionById(keys[0]);
    if (!sec) return;
    const field = sec.campos.find((f) => f.id === keys[keys.length - 1]);
    // Al elegir un elemento de catálogo se copian sus datos (p. ej. el precio).
    if (e.type === "change" && field?.tipo === "catalogo" && field.rellena) {
      const item = (CATALOGS[field.catalogo] || []).find((c) => c.nombre === readInput(holder));
      const row = sec.repetible ? draft[sec.id][Number(keys[1])] : draft[sec.id];
      if (item) for (const [dest, src] of Object.entries(field.rellena)) {
        if (!isEmpty(item[src])) row[dest] = item[src];
      }
      renderSection(sec);
      return;
    }
    updateComputed(sec);
  });

  if (params === "venta") {
    const items = app.querySelectorAll('[data-sec="ventas"] .repeat-item');
    const last = items[items.length - 1];
    last?.scrollIntoView({ block: "center" });
    last?.querySelector('[data-path$=".precioUnidad"]')?.focus();
  }

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
    for (const sec of sections().filter((s) => s.repetible)) {
      draft[sec.id] = asArray(draft[sec.id]).filter((r) => !rowIsBlank(sec.campos, r));
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
          <button class="btn btn-primary btn-sm" data-save="${esc(c.id)}">Guardar ${esc(c.titulo.toLowerCase())}</button></div>
        <div class="cat-body"></div>
      </div>`).join("")}</div>
  `;

  const render = (c) => {
    const rows = drafts[c.id];
    const body = app.querySelector(`[data-cat="${c.id}"] .cat-body`);
    body.innerHTML = `
      ${rows.length ? `<div class="table-wrap"><table class="edit-table">
        <thead><tr>${c.campos.map((f) => `<th>${esc(f.etiqueta)}${f.obligatorio ? ' <span class="req">*</span>' : ""}</th>`).join("")}<th></th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr>${c.campos.map((f) =>
          `<td class="${f.tipo === "booleano" ? "center" : ""}">${fieldInput(f, r[f.id], `${c.id}.${i}.${f.id}`)}</td>`).join("")}
          <td><button type="button" class="btn btn-sm btn-ghost btn-danger" data-rm="${i}" title="Quitar">×</button></td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">Sin elementos todavía.</p>`}
      <button type="button" class="btn" data-add style="margin-top:10px">+ Añadir ${esc((c.elemento || "elemento").toLowerCase())}</button>
    `;
    body.querySelector("[data-add]").onclick = () => {
      rows.push({}); formDirty = true; render(c);
      body.querySelector("tbody tr:last-child input")?.focus();
    };
    body.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.rm);
      if (!rowIsBlank(c.campos, rows[i]) && !confirm(`¿Quitar "${rows[i].nombre || "elemento"}" del catálogo?\n\nLas impresiones que ya lo usan conservan su nombre y precio.`)) return;
      rows.splice(i, 1); formDirty = true; render(c);
    }));
  };
  defs.forEach(render);

  bindInputs(document.getElementById("cat-root"), drafts, (holder) => {
    const [cid, i, fid] = holder.dataset.path.split(".");
    const c = defs.find((d) => d.id === cid);
    const field = c?.campos.find((f) => f.id === fid);
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
      render(c);
      toast(`${c.titulo} guardados`);
    } catch (err) {
      toast(err.message, true);
    }
  }));
}

// ================================================================= VENTAS

const salesState = { q: "", year: "" };

async function viewSales() {
  const ventasSec = sectionById("ventas");
  if (!ventasSec) {
    app.innerHTML = `<div class="card empty"><h2>No hay sección de ventas</h2>
      <p class="muted">Añade una sección con id "ventas" en config/campos.json.</p></div>`;
    return;
  }
  const items = await api("GET", "/api/impresiones");
  const F = Object.fromEntries(ventasSec.campos.map((f) => [f.id, f]));
  const money = { tipo: "moneda" };
  const signed = { tipo: "moneda", signo: true };

  const sales = [];
  for (const it of items) {
    const tot = computeTotals(it);
    asArray(it.ventas).forEach((v, i) => {
      const cantidad = Number(v.cantidad) || 0;
      const importe = F.importe ? fieldValue(F.importe, v) : null;
      const costeU = tot.costeUnidad ?? null;
      const coste = costeU !== null ? costeU * cantidad : null;
      sales.push({ it, v, i, cantidad, importe, costeU, coste,
        beneficio: importe !== null ? importe - (coste || 0) : null });
    });
  }
  sales.sort((a, b) => (b.v.fecha || "").localeCompare(a.v.fecha || ""));
  const years = [...new Set(sales.map((s) => (s.v.fecha || "").slice(0, 4)).filter(Boolean))].sort().reverse();

  app.innerHTML = `
    <div class="page-head">
      <div><h1>Ventas</h1><p class="muted" style="margin:4px 0 0">${sales.length} venta(s) registradas</p></div>
    </div>
    ${sales.length ? `
      <div class="stats" id="sales-stats"></div>
      <div class="toolbar">
        <input type="search" id="q" placeholder="Buscar por objeto, canal, cliente…" value="${esc(salesState.q)}">
        <select id="year" style="width:auto"><option value="">Todos los años</option>
          ${years.map((y) => `<option ${y === salesState.year ? "selected" : ""}>${y}</option>`).join("")}</select>
      </div>
      <div class="card table-wrap"><table>
        <thead><tr>
          <th>Fecha</th><th>Objeto</th><th class="num">Uds.</th><th class="num">Precio / ud.</th>
          <th class="num">Importe</th><th class="num">Coste / ud.</th><th class="num">Beneficio</th>
          <th>Canal</th><th>Cliente</th>
        </tr></thead>
        <tbody id="rows"></tbody><tfoot id="foot"></tfoot>
      </table></div>
      <p class="muted" style="font-size:.85rem">El beneficio de cada venta es el importe menos el coste por unidad de esa impresión × unidades vendidas.
        Para registrar una venta, abre la impresión y pulsa <strong>+ Venta</strong>.</p>` : `
      <div class="card empty">
        <h2>Todavía no hay ventas</h2>
        <p class="muted">Abre una impresión y pulsa <strong>+ Venta</strong> para registrar la primera.</p>
        <a class="btn" href="#/">Ir al listado</a>
      </div>`}
  `;
  if (!sales.length) return;

  const render = () => {
    const q = salesState.q.trim().toLowerCase();
    const visible = sales.filter((s) =>
      (!salesState.year || (s.v.fecha || "").startsWith(salesState.year)) &&
      (!q || `${printName(s.it)} ${s.v.canal || ""} ${s.v.cliente || ""} ${s.v.notas || ""}`.toLowerCase().includes(q)));
    const sum = (k) => visible.reduce((a, s) => a + (s[k] || 0), 0);
    const ingresos = sum("importe"), beneficio = sum("beneficio");

    document.getElementById("sales-stats").innerHTML = statTiles([
      { id: "n", etiqueta: "Ventas", tipo: "numero" },
      { id: "uds", etiqueta: "Unidades vendidas", tipo: "numero" },
      { id: "ing", etiqueta: "Ingresos", tipo: "moneda" },
      { id: "ben", etiqueta: "Beneficio", tipo: "moneda", signo: true },
      { id: "mar", etiqueta: "Margen", tipo: "porcentaje", signo: true },
    ], { n: visible.length, uds: sum("cantidad"), ing: ingresos, ben: beneficio,
      mar: ingresos ? (beneficio / ingresos) * 100 : null });

    document.getElementById("rows").innerHTML = visible.map((s) => `
      <tr class="clickable" data-id="${esc(s.it.id)}">
        <td>${esc(fmtDate(s.v.fecha))}</td>
        <td class="name-cell">${esc(printName(s.it))}</td>
        <td class="num">${esc(numFmt.format(s.cantidad))}</td>
        <td class="num">${fmtValueHtml(money, s.v.precioUnidad)}</td>
        <td class="num">${fmtValueHtml(money, s.importe)}</td>
        <td class="num">${fmtValueHtml(money, s.costeU)}</td>
        <td class="num">${fmtValueHtml(signed, s.beneficio)}</td>
        <td>${esc(s.v.canal || "")}</td>
        <td>${esc(s.v.cliente || "")}</td>
      </tr>`).join("") ||
      `<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">Sin resultados</td></tr>`;
    document.getElementById("foot").innerHTML = visible.length > 1 ? `<tr>
      <td colspan="2">Total (${visible.length})</td><td class="num">${esc(numFmt.format(sum("cantidad")))}</td><td></td>
      <td class="num">${fmtValueHtml(money, ingresos)}</td><td></td>
      <td class="num">${fmtValueHtml(signed, beneficio)}</td><td colspan="2"></td></tr>` : "";
  };
  render();

  document.getElementById("q").addEventListener("input", (e) => { salesState.q = e.target.value; render(); });
  document.getElementById("year").addEventListener("change", (e) => { salesState.year = e.target.value; render(); });
  document.getElementById("rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) location.hash = `#/i/${tr.dataset.id}`;
  });
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

async function viewRegister(def) {
  await loadCatalogs();
  let list = await api("GET", `/api/registros/${def.id}`);
  const st = (regState[def.id] ??= { q: "", year: "", group: "" });
  const amountField = def.campos.find((f) => f.total) || def.campos.find((f) => f.tipo === "moneda");
  const groupField = def.campos.find((f) => f.id === def.agruparPor);
  const dateField = def.campos.find((f) => f.tipo === "fecha");
  const cols = def.campos.filter((f) => f.enListado);
  const elem = (def.elemento || "elemento").toLowerCase();
  let editing = null; // { draft, isNew }

  app.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(def.titulo)}</h1>
        ${def.descripcion ? `<p class="muted" style="margin:4px 0 0">${esc(def.descripcion)}</p>` : ""}</div>
      <div class="actions"><button class="btn btn-primary" id="new">+ Nuevo ${esc(elem)}</button></div>
    </div>
    <div id="editor"></div>
    <div id="reg-content"></div>
  `;

  const filtered = () => {
    const q = st.q.trim().toLowerCase();
    return list.filter((it) =>
      (!st.year || (it[dateField?.id] || "").startsWith(st.year)) &&
      (!st.group || it[groupField?.id] === st.group) &&
      (!q || JSON.stringify(it).toLowerCase().includes(q)));
  };

  // --- listado
  const render = () => {
    const content = document.getElementById("reg-content");
    if (!list.length) {
      content.innerHTML = `<div class="card empty"><h2>Todavía no hay ${esc(def.titulo.toLowerCase())}</h2>
        <p class="muted">Pulsa <strong>+ Nuevo ${esc(elem)}</strong> para registrar el primero.</p></div>`;
      return;
    }
    const years = dateField ? [...new Set(list.map((it) => (it[dateField.id] || "").slice(0, 4)).filter(Boolean))].sort().reverse() : [];
    const groups = groupField ? [...new Set([
      ...(CATALOGS[groupField.catalogo] || []).map((c) => c.nombre),
      ...list.map((it) => it[groupField.id]).filter(Boolean)])] : [];

    const rows = filtered().sort((a, b) =>
      (b[dateField?.id] || "").localeCompare(a[dateField?.id] || "") || (b.creado || "").localeCompare(a.creado || ""));
    const amount = (it) => Number(it[amountField?.id]) || 0;
    const total = rows.reduce((s, it) => s + amount(it), 0);
    const thisYear = String(new Date().getFullYear());
    const yearTotal = dateField ? rows.filter((it) => (it[dateField.id] || "").startsWith(thisYear)).reduce((s, it) => s + amount(it), 0) : null;

    // Desglose por tipo
    const byGroup = {};
    if (groupField) for (const it of rows) {
      const g = it[groupField.id] || "Sin tipo";
      byGroup[g] = (byGroup[g] || 0) + amount(it);
    }
    const groupEntries = Object.entries(byGroup).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...groupEntries.map((e) => e[1]), 0);

    content.innerHTML = `
      <div class="stats">${statTiles([
        { id: "total", etiqueta: `Total${st.year ? " " + st.year : ""}`, tipo: "moneda" },
        { id: "n", etiqueta: "Compras", tipo: "numero" },
        ...(dateField && !st.year ? [{ id: "year", etiqueta: `Este año (${thisYear})`, tipo: "moneda" }] : []),
      ], { total, n: rows.length, year: yearTotal })}</div>

      ${groupEntries.length ? `<div class="card card-pad section" style="margin-top:0;margin-bottom:20px">
        <h2>Por ${esc(groupField.etiqueta.toLowerCase())}</h2>
        <div class="bars">${groupEntries.map(([g, v]) => `
          <button class="bar-row ${st.group === g ? "active" : ""}" data-group="${esc(g)}" title="Filtrar por ${esc(g)}">
            <span class="bar-label">${esc(g)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${max ? (v / max) * 100 : 0}%"></span></span>
            <span class="bar-value">${esc(fmtValue(amountField, v))}
              <span class="muted">${total ? numFmt.format((v / total) * 100) : 0} %</span></span>
          </button>`).join("")}</div>
      </div>` : ""}

      <div class="toolbar">
        <input type="search" id="q" placeholder="Buscar…" value="${esc(st.q)}">
        ${groupField ? `<select id="group" style="width:auto"><option value="">Todos los tipos</option>
          ${groups.map((g) => `<option ${g === st.group ? "selected" : ""}>${esc(g)}</option>`).join("")}</select>` : ""}
        ${years.length ? `<select id="year" style="width:auto"><option value="">Todos los años</option>
          ${years.map((y) => `<option ${y === st.year ? "selected" : ""}>${y}</option>`).join("")}</select>` : ""}
      </div>

      <div class="card table-wrap"><table>
        <thead><tr>${cols.map((f) => `<th class="${NUMERIC.includes(f.tipo) ? "num" : ""}">${esc(f.etiqueta)}</th>`).join("")}<th></th></tr></thead>
        <tbody>${rows.map((it) => `<tr class="clickable" data-id="${esc(it.id)}">${cols.map((f) => {
          if (f.tipo === "enlace") return `<td>${linkCell(it[f.id], `data-abrir="${esc(f.id)}" data-item="${esc(it.id)}"`)}</td>`;
          if (f.id === "nombre") return `<td><span class="name-cell">${esc(it.nombre)}</span>
            ${it.descripcion ? `<div class="muted cell-desc">${esc(it.descripcion)}</div>` : ""}</td>`;
          return `<td class="${NUMERIC.includes(f.tipo) ? "num" : ""}">${fmtValueHtml(f, it[f.id])}</td>`;
        }).join("")}<td class="num"><button class="btn btn-sm btn-ghost" data-edit="${esc(it.id)}">Editar</button></td></tr>`).join("") ||
          `<tr><td colspan="${cols.length + 1}" class="muted" style="text-align:center;padding:24px">Sin resultados</td></tr>`}
        </tbody>
        ${rows.length > 1 ? `<tfoot><tr>${cols.map((f, i) =>
          `<td class="${NUMERIC.includes(f.tipo) ? "num" : ""}">${i === 0 ? `Total (${rows.length})` : f === amountField ? esc(fmtValue(f, total)) : ""}</td>`).join("")}<td></td></tr></tfoot>` : ""}
      </table></div>
    `;

    content.querySelector("#q").addEventListener("input", (e) => {
      st.q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const q = document.getElementById("q"); q.focus(); q.setSelectionRange(pos, pos);
    });
    content.querySelector("#year")?.addEventListener("change", (e) => { st.year = e.target.value; render(); });
    content.querySelector("#group")?.addEventListener("change", (e) => { st.group = e.target.value; render(); });
    content.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => {
      st.group = st.group === b.dataset.group ? "" : b.dataset.group; render();
    }));
    content.querySelector("tbody").addEventListener("click", async (e) => {
      const open = e.target.closest("[data-abrir]");
      if (open) {
        try {
          await api("POST", `/api/registros/${def.id}/${encodeURIComponent(open.dataset.item)}/abrir`,
            { campo: open.dataset.abrir, carpeta: !!open.dataset.carpeta });
          toast(open.dataset.carpeta ? "Abriendo la carpeta…" : "Abriendo…");
        } catch (err) { toast(err.message, true); }
        return;
      }
      if (e.target.closest("a")) return;
      const tr = e.target.closest("tr[data-id]");
      if (tr) openEditor(list.find((it) => it.id === tr.dataset.id));
    });
  };

  // --- editor (alta / modificación)
  const openEditor = (item) => {
    if (editing && formDirty && !confirm("Hay cambios sin guardar. ¿Descartarlos?")) return;
    const isNew = !item;
    const draft = isNew ? { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` } : clone(item);
    if (isNew) for (const f of def.campos) { const v = defaultValue(f); if (!isEmpty(v)) draft[f.id] = v; }
    editing = { draft, isNew };
    formDirty = false;

    const box = document.getElementById("editor");
    box.innerHTML = `
      <form class="card card-pad section editor-card" id="reg-form" novalidate style="margin-top:0;margin-bottom:20px">
        <h2>${isNew ? `Nuevo ${esc(elem)}` : `Editar ${esc(elem)}`}</h2>
        <div class="form-grid" style="margin-top:12px">${def.campos.map((f) => fieldBlock(f, draft[f.id], `e.${f.id}`)).join("")}</div>
        <div class="editor-actions">
          ${isNew ? "" : `<button type="button" class="btn btn-danger" id="reg-del">Eliminar</button>`}
          <span style="flex:1"></span>
          <button type="button" class="btn" id="reg-cancel">Cancelar</button>
          <button type="submit" class="btn btn-primary">Guardar</button>
        </div>
      </form>`;
    const form = document.getElementById("reg-form");
    bindInputs(form, { e: draft });
    form.scrollIntoView({ block: "start", behavior: "smooth" });
    form.querySelector("input:not([type=checkbox]), select")?.focus({ preventScroll: true });

    const close = () => { editing = null; formDirty = false; box.innerHTML = ""; };
    const persist = async (next, msg) => {
      list = await api("PUT", `/api/registros/${def.id}`, next);
      close(); render(); toast(msg);
    };

    document.getElementById("reg-cancel").onclick = () => {
      if (formDirty && !confirm("Hay cambios sin guardar. ¿Descartarlos?")) return;
      close();
    };
    document.getElementById("reg-del")?.addEventListener("click", async () => {
      if (!confirm(`¿Eliminar "${item.nombre || elem}"?\n\nSe guarda una copia de seguridad en data/papelera.`)) return;
      try { await persist(list.filter((it) => it.id !== item.id), `${def.elemento || "Elemento"} eliminado`); }
      catch (err) { toast(err.message, true); }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const missing = def.campos.filter((f) => f.obligatorio && isEmpty(draft[f.id])).map((f) => `e.${f.id}`);
      if (!checkRequired(missing)) return;
      const now = new Date().toISOString().slice(0, 19);
      const saved = { ...draft, modificado: now, creado: draft.creado || now };
      const next = isNew ? [...list, saved] : list.map((it) => (it.id === saved.id ? saved : it));
      try { await persist(next, `${def.elemento || "Elemento"} guardado`); }
      catch (err) { toast(err.message, true); }
    });
  };

  document.getElementById("new").onclick = () => openEditor(null);
  render();
}

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
      await loadCatalogs();
    }
    if (route === "nueva") await viewForm(null);
    else if (route === "editar" && param) await viewForm(decodeURIComponent(param));
    else if (route === "i" && param) await viewDetail(decodeURIComponent(param));
    else if (route === "ventas") await viewSales();
    else if (route === "catalogos") await viewCatalogs();
    else if (route === "informes") await viewReports(param);
    else if ((CONFIG.registros || []).some((r) => r.id === route)) {
      await viewRegister(CONFIG.registros.find((r) => r.id === route));
    } else await viewList();
    if (!hash.includes("?venta")) window.scrollTo(0, 0);
  } catch (err) {
    app.innerHTML = `<div class="card empty"><h2>Algo ha fallado</h2><p class="muted">${esc(err.message)}</p>
      <a class="btn" href="#/">Volver al listado</a></div>`;
  }
}

window.addEventListener("hashchange", router);
window.addEventListener("beforeunload", (e) => { if (formDirty) e.preventDefault(); });
router();
