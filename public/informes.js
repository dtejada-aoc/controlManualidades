"use strict";

/* ===================================================================
   Informes: resumen, gastos, producción y ventas.
   Se exportan a PDF con la impresión del navegador ("Guardar como PDF").
   Usa las utilidades de app.js (api, fmtValue, computeTotals…).
   =================================================================== */

const REPORTS = [
  { id: "resumen", titulo: "Resumen general" },
  { id: "gastos", titulo: "Informe de gastos" },
  { id: "produccion", titulo: "Informe de producción" },
  { id: "ventas", titulo: "Informe de ventas y rentabilidad" },
];
const reportState = { year: "" };
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const money = (v) => fmtValue({ tipo: "moneda" }, v || 0);
const grams = (v) => (v >= 1000 ? `${numFmt.format(v / 1000)} kg` : `${numFmt.format(Math.round(v || 0))} g`);
const pct = (v) => (v === null || v === undefined || !isFinite(v) ? "—" : `${numFmt.format(v)} %`);
const hours = (min) => fmtDuration(min || 0) || "0 min";
const yearOf = (d) => (d || "").slice(0, 4);
const inPeriod = (d) => !reportState.year || yearOf(d) === reportState.year;

// ------------------------------------------------------------- gráficos

/** Valor máximo "redondo" y paso de la escala para ~4 líneas de guía. */
function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { max: 1, step: 0.25 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s * ticks >= max);
  return { max: step * ticks, step };
}

/** Recorta números del eje: 1.200 → "1,2k". */
const axisFmt = (v) => (v >= 1000 ? `${numFmt.format(v / 1000)}k` : numFmt.format(v));

/** Barras verticales. data: [{label, value, tip}] */
function barChart(data, { fmt = money, height = 230 } = {}) {
  return (W) => {
    const pad = { l: 48, r: 8, t: 22, b: 26 };
    const iw = W - pad.l - pad.r, ih = height - pad.t - pad.b;
    const { max, step } = niceScale(Math.max(...data.map((d) => d.value), 0));
    const band = iw / Math.max(data.length, 1);
    const bw = Math.min(46, band * 0.62);
    const y = (v) => pad.t + ih - (v / max) * ih;
    const top = Math.max(...data.map((d) => d.value));
    const labelAll = data.length <= 8;
    let s = `<svg viewBox="0 0 ${W} ${height}" class="chart-svg" role="img">`;
    for (let v = 0; v <= max + 1e-9; v += step) {
      s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? "axis" : "grid"}"/>
        <text x="${pad.l - 8}" y="${y(v) + 4}" class="tick" text-anchor="end">${axisFmt(v)}</text>`;
    }
    data.forEach((d, i) => {
      const cx = pad.l + band * i + band / 2;
      const h = (d.value / max) * ih;
      const x0 = cx - bw / 2, yb = pad.t + ih, r = Math.min(4, h, bw / 2);
      if (h > 0) {
        s += `<path class="bar" d="M${x0},${yb} V${yb - h + r} Q${x0},${yb - h} ${x0 + r},${yb - h} H${x0 + bw - r} Q${x0 + bw},${yb - h} ${x0 + bw},${yb - h + r} V${yb} Z"/>`;
      }
      if (h > 0 && (labelAll || d.value === top)) {
        s += `<text x="${cx}" y="${yb - h - 6}" class="val" text-anchor="middle">${esc(fmt(d.value))}</text>`;
      }
      s += `<text x="${cx}" y="${height - 8}" class="tick" text-anchor="middle">${esc(d.label)}</text>
        <rect x="${pad.l + band * i}" y="${pad.t}" width="${band}" height="${ih}" class="hit" data-tip="${esc(d.tip || `${d.label}: ${fmt(d.value)}`)}"/>`;
    });
    return s + `</svg>`;
  };
}

/** Línea de un acumulado mensual. data: [{key:"2024-06", value}] */
function lineChart(data, { fmt = money, height = 230 } = {}) {
  return (W) => {
    const pad = { l: 48, r: 70, t: 18, b: 26 };
    const iw = W - pad.l - pad.r, ih = height - pad.t - pad.b;
    const { max, step } = niceScale(Math.max(...data.map((d) => d.value), 0));
    const x = (i) => pad.l + (data.length < 2 ? iw / 2 : (i / (data.length - 1)) * iw);
    const y = (v) => pad.t + ih - (v / max) * ih;
    let s = `<svg viewBox="0 0 ${W} ${height}" class="chart-svg" role="img">`;
    for (let v = 0; v <= max + 1e-9; v += step) {
      s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? "axis" : "grid"}"/>
        <text x="${pad.l - 8}" y="${y(v) + 4}" class="tick" text-anchor="end">${axisFmt(v)}</text>`;
    }
    data.forEach((d, i) => {
      if (d.key.endsWith("-01") || i === 0) {
        s += `<text x="${x(i)}" y="${height - 8}" class="tick" text-anchor="${i === 0 ? "start" : "middle"}">${d.key.slice(0, 4)}</text>`;
      }
    });
    const pts = data.map((d, i) => `${x(i)},${y(d.value)}`).join(" L");
    s += `<path d="M${pad.l},${y(0)} L${pts} L${x(data.length - 1)},${y(0)} Z" class="area"/>
      <path d="M${pts}" class="line"/>`;
    const last = data[data.length - 1];
    if (last) {
      s += `<circle cx="${x(data.length - 1)}" cy="${y(last.value)}" r="5" class="dot"/>
        <text x="${x(data.length - 1) + 10}" y="${y(last.value) + 4}" class="val">${esc(fmt(last.value))}</text>`;
    }
    const hw = iw / Math.max(data.length - 1, 1);
    data.forEach((d, i) => {
      const [yy, mm] = d.key.split("-");
      s += `<rect x="${x(i) - hw / 2}" y="${pad.t}" width="${hw}" height="${ih}" class="hit"
        data-tip="${esc(`${MONTHS[mm - 1]} ${yy}: ${fmt(d.value)} acumulado${d.delta ? ` (+${fmt(d.delta)})` : ""}`)}"/>`;
    });
    return s + `</svg>`;
  };
}

/** Barras horizontales (HTML, se imprimen bien). entries: [{label, value, sub}] */
function hBars(entries, { fmt = money, total = null } = {}) {
  if (!entries.length) return `<p class="muted">Sin datos en este periodo.</p>`;
  const max = Math.max(...entries.map((e) => e.value), 0);
  return `<div class="bars report-bars">${entries.map((e) => `
    <div class="bar-row" data-tip="${esc(`${e.label}: ${fmt(e.value)}${e.sub ? " · " + e.sub : ""}`)}">
      <span class="bar-label">${esc(e.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${max ? (e.value / max) * 100 : 0}%"></span></span>
      <span class="bar-value">${esc(fmt(e.value))}${total ? ` <span class="muted">${pct((e.value / total) * 100)}</span>` : e.sub ? ` <span class="muted">${esc(e.sub)}</span>` : ""}</span>
    </div>`).join("")}</div>`;
}

/** Barras horizontales apiladas de dos series. rows: [{label, a, b}] */
function stackedBars(rows, { labels, fmt = grams }) {
  if (!rows.length) return `<p class="muted">Sin datos en este periodo.</p>`;
  const max = Math.max(...rows.map((r) => r.a + r.b), 0);
  return `<div class="legend"><span><i class="sw s1"></i>${esc(labels[0])}</span><span><i class="sw s2"></i>${esc(labels[1])}</span></div>
    <div class="bars report-bars">${rows.map((r) => `
    <div class="bar-row" data-tip="${esc(`${r.label}: ${labels[0]} ${fmt(r.a)} · ${labels[1]} ${fmt(r.b)}`)}">
      <span class="bar-label">${esc(r.label)}</span>
      <span class="bar-track stack">
        <span class="bar-fill" style="width:${max ? (r.a / max) * 100 : 0}%"></span>
        ${r.b > 0 ? `<span class="bar-fill s2" style="width:${max ? (r.b / max) * 100 : 0}%"></span>` : ""}
      </span>
      <span class="bar-value">${esc(fmt(r.a + r.b))} <span class="muted">${pct(r.a + r.b ? (r.b / (r.a + r.b)) * 100 : 0)} desp.</span></span>
    </div>`).join("")}</div>`;
}

function kpis(list) {
  return `<div class="stats report-kpis">${list.map((k) => `
    <div class="card stat"><div class="label">${esc(k.label)}</div>
      <div class="value ${k.cls || ""}">${esc(k.value)}</div>
      ${k.sub ? `<div class="sub">${esc(k.sub)}</div>` : ""}</div>`).join("")}</div>`;
}

const chartBox = (id, title, note = "") => `
  <div class="card card-pad section report-block">
    <h2>${esc(title)}</h2>${note ? `<p class="muted note">${esc(note)}</p>` : ""}
    <div class="chart" data-chart="${id}"></div>
  </div>`;

const block = (title, html, note = "") => `
  <div class="card card-pad section report-block">
    <h2>${esc(title)}</h2>${note ? `<p class="muted note">${esc(note)}</p>` : ""}${html}
  </div>`;

// ---------------------------------------------------------------- datos

async function loadReportData() {
  await loadCatalogs();
  await loadRegisters(registersUsed());
  const items = await api("GET", "/api/impresiones");
  items.forEach((it) => (it._tot = computeTotals(it)));
  const gastosDef = (CONFIG.registros || []).find((r) => r.id === "gastos");
  const gastos = gastosDef ? await api("GET", "/api/registros/gastos") : [];
  // Ventas: registro propio; cada venta apunta a una impresión y guarda su coste por unidad.
  const ventasDef = (CONFIG.registros || []).find((r) => r.id === "ventas");
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  const ventas = (ventasDef ? await api("GET", "/api/registros/ventas") : []).map((v) => {
    const it = byId[v.impresion] || { id: v.impresion, general: { nombre: `${v.impresion || "?"} (eliminada)` }, _tot: {} };
    const cantidad = Number(v.cantidad) || 0;
    const costeU = !isEmpty(v.costeUnidad) ? Number(v.costeUnidad) : (it._tot.costeUnidad ?? null);
    return { it, v, cantidad, importe: cantidad * (Number(v.precioUnidad) || 0), costeU,
      coste: costeU !== null ? costeU * cantidad : 0 };
  });
  return { items, gastos, ventas };
}

function sumBy(list, keyFn, valFn) {
  const out = {};
  for (const x of list) { const k = keyFn(x); out[k] = (out[k] || 0) + valFn(x); }
  return out;
}

/** Serie por meses (año filtrado) o por años (todos). */
function timeSeries(list, dateFn, valFn) {
  if (reportState.year) {
    const by = sumBy(list, (x) => Number((dateFn(x) || "").slice(5, 7)) || 0, valFn);
    return MONTHS.map((m, i) => ({ label: m, value: by[i + 1] || 0, tip: `${m} ${reportState.year}: ${money(by[i + 1] || 0)}` }));
  }
  const by = sumBy(list, (x) => yearOf(dateFn(x)) || "s/f", valFn);
  return Object.keys(by).sort().map((y) => ({ label: y, value: by[y] }));
}

// ============================================================== INFORMES

function reportResumen({ items, gastos }, charts) {
  const g = gastos.filter((x) => inPeriod(x.fecha));
  const its = items.filter((x) => inPeriod(x.general?.fecha));
  const inversion = g.reduce((s, x) => s + (Number(x.precio) || 0), 0);
  const t = (k) => its.reduce((s, x) => s + (x._tot[k] || 0), 0);

  charts.gastosTiempo = barChart(timeSeries(g, (x) => x.fecha, (x) => Number(x.precio) || 0));
  if (!reportState.year && g.length) charts.acumulado = lineChart(cumulative(g));
  const porTipo = Object.entries(sumBy(g, (x) => x.tipo || "Sin tipo", (x) => Number(x.precio) || 0))
    .sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  const topCoste = [...its].filter((x) => x._tot.coste).sort((a, b) => b._tot.coste - a._tot.coste).slice(0, 8)
    .map((x) => ({ label: printName(x), value: x._tot.coste, sub: x._tot.costeUnidad ? `${money(x._tot.costeUnidad)}/ud.` : "" }));

  return `
    ${kpis([
      { label: "Inversión en material", value: money(inversion), sub: `${g.length} compras` },
      { label: "Impresiones", value: numFmt.format(its.length), sub: `${its.reduce((s, x) => s + asArray(x.placas).length, 0)} placas` },
      { label: "Horas de impresión", value: hours(t("tiempoImpresion")) },
      { label: "Filamento usado", value: grams(t("gramosTotal")), sub: `${pct(t("gramosTotal") ? (t("gramosDesperdicio") / t("gramosTotal")) * 100 : null)} desperdicio` },
      { label: "Coste de producción", value: money(t("coste")) },
      { label: "Horas de pintura", value: hours(t("tiempoPintura")) },
    ])}
    <div class="report-grid">
      ${chartBox("gastosTiempo", reportState.year ? `Inversión por mes (${reportState.year})` : "Inversión por año")}
      ${block("Inversión por tipo", hBars(porTipo, { total: inversion }))}
    </div>
    ${charts.acumulado ? chartBox("acumulado", "Inversión acumulada", "Evolución mensual de todo lo invertido en las máquinas y su material.") : ""}
    ${block("Impresiones con más coste", hBars(topCoste), "Coste total de producción; a la derecha, el coste por unidad.")}
  `;
}

function cumulative(gastos) {
  const by = sumBy(gastos.filter((x) => x.fecha), (x) => x.fecha.slice(0, 7), (x) => Number(x.precio) || 0);
  const keys = Object.keys(by).sort();
  if (!keys.length) return [];
  const out = [];
  let [y, m] = keys[0].split("-").map(Number);
  const now = new Date();
  const [ey, em] = [now.getFullYear(), now.getMonth() + 1];
  let acc = 0;
  while (y < ey || (y === ey && m <= em)) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    acc += by[key] || 0;
    out.push({ key, value: acc, delta: by[key] || 0 });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

function reportGastos({ gastos }, charts) {
  const g = gastos.filter((x) => inPeriod(x.fecha));
  if (!g.length) return `<div class="card empty"><h2>No hay gastos en este periodo</h2></div>`;
  const price = (x) => Number(x.precio) || 0;
  const total = g.reduce((s, x) => s + price(x), 0);
  const mayor = g.reduce((a, b) => (price(b) > price(a) ? b : a));
  const tipos = Object.entries(sumBy(g, (x) => x.tipo || "Sin tipo", price)).sort((a, b) => b[1] - a[1]);

  charts.gastosTiempo = barChart(timeSeries(g, (x) => x.fecha, price));

  // Tabla cruzada tipo × año
  let pivot = "";
  if (!reportState.year) {
    const years = [...new Set(g.map((x) => yearOf(x.fecha) || "s/f"))].sort();
    const cell = {};
    for (const x of g) {
      const k = `${x.tipo || "Sin tipo"}|${yearOf(x.fecha) || "s/f"}`;
      cell[k] = (cell[k] || 0) + price(x);
    }
    const maxCell = Math.max(...Object.values(cell));
    const yearTot = sumBy(g, (x) => yearOf(x.fecha) || "s/f", price);
    pivot = block("Gasto por tipo y año", `<div class="table-wrap"><table class="report-table">
      <thead><tr><th>Tipo</th>${years.map((y) => `<th class="num">${y}</th>`).join("")}<th class="num">Total</th></tr></thead>
      <tbody>${tipos.map(([tipo, tot]) => `<tr><td>${esc(tipo)}</td>${years.map((y) => {
        const v = cell[`${tipo}|${y}`];
        return `<td class="num heat" style="--h:${v ? 10 + (v / maxCell) * 55 : 0}%">${v ? esc(money(v)) : '<span class="muted">—</span>'}</td>`;
      }).join("")}<td class="num"><strong>${esc(money(tot))}</strong></td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Total</td>${years.map((y) => `<td class="num">${esc(money(yearTot[y]))}</td>`).join("")}<td class="num">${esc(money(total))}</td></tr></tfoot>
    </table></div>`, "Cuanto más intenso el fondo, mayor el gasto.");
  }

  const detail = tipos.map(([tipo, tot]) => {
    const rows = g.filter((x) => (x.tipo || "Sin tipo") === tipo).sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
    return `<tbody class="group">
      <tr class="group-row"><td colspan="3">${esc(tipo)} <span class="muted">(${rows.length})</span></td><td class="num">${esc(money(tot))}</td></tr>
      ${rows.map((x) => `<tr><td>${esc(fmtDate(x.fecha))}</td><td><strong>${esc(x.nombre || "")}</strong>
        ${x.descripcion ? `<div class="muted small pre">${esc(x.descripcion)}</div>` : ""}</td>
        <td class="small">${esc(refText(x.enlace))}</td><td class="num">${esc(money(price(x)))}</td></tr>`).join("")}
    </tbody>`;
  }).join("");

  return `
    ${kpis([
      { label: "Total invertido", value: money(total) },
      { label: "Compras", value: numFmt.format(g.length) },
      { label: "Compra media", value: money(total / g.length) },
      { label: "Mayor compra", value: money(price(mayor)), sub: mayor.nombre },
    ])}
    <div class="report-grid">
      ${chartBox("gastosTiempo", reportState.year ? `Gasto por mes (${reportState.year})` : "Gasto por año")}
      ${block("Gasto por tipo", hBars(tipos.map(([label, value]) => ({ label, value })), { total }))}
    </div>
    ${pivot}
    ${block("Detalle de compras", `<div class="table-wrap"><table class="report-table">
      <thead><tr><th>Fecha</th><th>Compra</th><th>Referencia</th><th class="num">Precio</th></tr></thead>
      ${detail}
      <tfoot><tr><td colspan="3">Total (${g.length} compras)</td><td class="num">${esc(money(total))}</td></tr></tfoot>
    </table></div>`)}
  `;
}

/** Texto corto para un enlace, ruta o número de pedido. */
function refText(v) {
  if (isEmpty(v)) return "";
  if (isLocalPath(v)) return String(v).split(/[\\/]/).pop();
  if (isUrl(v)) { try { return new URL(/^https?:/i.test(v) ? v : `https://${v}`).hostname.replace(/^www\./, ""); } catch { return v; } }
  return String(v);
}

function reportProduccion({ items }, charts) {
  const its = items.filter((x) => inPeriod(x.general?.fecha))
    .sort((a, b) => (a.general?.fecha || "").localeCompare(b.general?.fecha || ""));
  if (!its.length) return `<div class="card empty"><h2>No hay impresiones en este periodo</h2></div>`;
  const t = (k) => its.reduce((s, x) => s + (x._tot[k] || 0), 0);
  const placas = its.reduce((s, x) => s + asArray(x.placas).length, 0);
  const fallidas = its.reduce((s, x) => s + asArray(x.placas).filter((p) => p.correcta === false).length, 0);

  const fil = its.filter((x) => x._tot.gramosTotal)
    .map((x) => ({ label: printName(x), a: x._tot.gramosModelo || 0, b: x._tot.gramosDesperdicio || 0 }))
    .sort((a, b) => b.a + b.b - (a.a + a.b));
  const tiempo = its.filter((x) => x._tot.tiempoImpresion)
    .map((x) => ({ label: printName(x), value: x._tot.tiempoImpresion, sub: x._tot.tiempoPintura ? `+ ${hours(x._tot.tiempoPintura)} pintura` : "" }))
    .sort((a, b) => b.value - a.value);

  // Accesorios usados
  const accSec = sectionById("accesorios");
  const costeF = accSec?.campos.find((f) => f.id === "coste");
  const acc = {};
  for (const it of its) for (const r of asArray(it.accesorios)) {
    const k = r.accesorio || r.nombre || "—";
    acc[k] ??= { cantidad: 0, coste: 0 };
    acc[k].cantidad += Number(r.cantidad) || 0;
    acc[k].coste += Number(costeF ? fieldValue(costeF, r) : r.coste) || 0;
  }
  const accRows = Object.entries(acc).sort((a, b) => b[1].coste - a[1].coste);

  // Consumo por filamento (gramos y coste de los filamentos de cada placa)
  const filList = listFieldById("filamentos");
  const filField = filList?.campos.find((f) => f.tipo === "registro");
  const costeSub = filList?.campos.find((f) => f.id === "coste");
  const uso = {};
  const tiposPorImpresion = {};
  for (const it of its) for (const p of asArray(it.placas)) for (const sub of asArray(p?.filamentos)) {
    const k = sub[filField?.id] || "";
    uso[k] ??= { modelo: 0, desp: 0, coste: 0, impresiones: new Set() };
    uso[k].modelo += Number(sub.gramosModelo) || 0;
    uso[k].desp += Number(sub.gramosDesperdicio) || 0;
    uso[k].coste += Number(costeSub ? fieldValue(costeSub, sub) : 0) || 0;
    uso[k].impresiones.add(it.id);
    const tipo = (REGS[filField?.registro] || []).find((x) => x.id === k)?.tipo;
    if (tipo) (tiposPorImpresion[it.id] ??= new Set()).add(tipo);
  }
  const usoRows = Object.entries(uso).sort((a, b) => b[1].modelo + b[1].desp - (a[1].modelo + a[1].desp));

  return `
    ${kpis([
      { label: "Impresiones", value: numFmt.format(its.length), sub: `${placas} placas${fallidas ? ` · ${fallidas} fallidas` : ""}` },
      { label: "Horas de impresión", value: hours(t("tiempoImpresion")) },
      { label: "Horas de pintura", value: hours(t("tiempoPintura")) },
      { label: "Filamento usado", value: grams(t("gramosTotal")) },
      { label: "Desperdicio", value: grams(t("gramosDesperdicio")), sub: pct(t("gramosTotal") ? (t("gramosDesperdicio") / t("gramosTotal")) * 100 : null) },
      { label: "Coste de producción", value: money(t("coste")), sub: `${money(t("coste") / its.length)} por impresión` },
      ...(t("costeReal") ? [{ label: "Coste real", value: money(t("costeReal")), sub: `${money(t("costeReal") / its.length)} por impresión` }] : []),
    ])}
    ${t("costeReal") ? block("Desglose del coste real", hBars([
      { label: "Material y accesorios", value: t("coste") },
      { label: "Electricidad", value: t("costeElectricidad") },
      { label: "Amortización máquinas", value: t("costeAmortizacion") },
      { label: "Postprocesado", value: t("costePostprocesado") },
      { label: "Diseño", value: t("costeDiseno") },
    ].filter((e) => e.value > 0), { total: t("costeReal") }), "Según las tarifas de Configuración → Costes reales.") : ""}
    <div class="report-grid">
      ${block("Filamento por impresión", stackedBars(fil, { labels: ["Modelo", "Desperdicio"] }))}
      ${block("Tiempo de impresión", hBars(tiempo, { fmt: hours }))}
    </div>
    ${block("Detalle por impresión", `<div class="table-wrap"><table class="report-table">
      <thead><tr><th>Fecha</th><th>Impresión</th><th class="num">Placas</th><th class="num">Tiempo</th>
        <th class="num">Filamento</th><th class="num">% desp.</th><th class="num">Accesorios</th><th class="num">Coste</th>
        <th class="num">Uds.</th><th class="num">Coste/ud.</th></tr></thead>
      <tbody>${its.map((x) => {
        const accCost = asArray(x.accesorios).reduce((s, r) => s + (Number(costeF ? fieldValue(costeF, r) : r.coste) || 0), 0);
        return `<tr><td>${esc(fmtDate(x.general?.fecha))}</td><td><strong>${esc(printName(x))}</strong>
          <div class="muted small">${esc([[...(tiposPorImpresion[x.id] || [])].join("/"), [...new Set(asArray(x.placas).map((p) => p.maquina).filter(Boolean))].join(", "), x.general?.estado].filter(Boolean).join(" · "))}</div></td>
          <td class="num">${asArray(x.placas).length}</td><td class="num">${esc(hours(x._tot.tiempoImpresion))}</td>
          <td class="num">${esc(grams(x._tot.gramosTotal || 0))}</td><td class="num">${esc(pct(x._tot.porcentajeDesperdicio))}</td>
          <td class="num">${accCost ? esc(money(accCost)) : "—"}</td><td class="num">${esc(money(x._tot.coste))}</td>
          <td class="num">${esc(numFmt.format(Number(x.general?.unidades) || 1))}</td><td class="num">${esc(money(x._tot.costeUnidad))}</td></tr>`;
      }).join("")}</tbody>
      <tfoot><tr><td colspan="2">Total (${its.length})</td><td class="num">${placas}</td><td class="num">${esc(hours(t("tiempoImpresion")))}</td>
        <td class="num">${esc(grams(t("gramosTotal")))}</td><td class="num">${esc(pct(t("gramosTotal") ? (t("gramosDesperdicio") / t("gramosTotal")) * 100 : null))}</td>
        <td></td><td class="num">${esc(money(t("coste")))}</td><td></td><td></td></tr></tfoot>
    </table></div>`)}
    ${usoRows.length ? block("Consumo por filamento", `<div class="table-wrap"><table class="report-table">
      <thead><tr><th>Filamento</th><th class="num">Impresiones</th><th class="num">Modelo</th><th class="num">Desperdicio</th>
        <th class="num">Total</th><th class="num">Coste</th></tr></thead>
      <tbody>${usoRows.map(([k, v]) => `<tr><td>${k ? fmtValueHtml(filField, k) : '<span class="muted">Sin especificar</span>'}</td>
        <td class="num">${v.impresiones.size}</td><td class="num">${esc(grams(v.modelo))}</td><td class="num">${esc(grams(v.desp))}</td>
        <td class="num"><strong>${esc(grams(v.modelo + v.desp))}</strong></td><td class="num">${esc(money(v.coste))}</td></tr>`).join("")}</tbody>
    </table></div>`) : ""}
    ${accRows.length ? block("Accesorios utilizados", `<div class="table-wrap"><table class="report-table">
      <thead><tr><th>Accesorio</th><th class="num">Cantidad</th><th class="num">Coste</th></tr></thead>
      <tbody>${accRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${esc(numFmt.format(v.cantidad))}</td><td class="num">${esc(money(v.coste))}</td></tr>`).join("")}</tbody>
    </table></div>`) : ""}
  `;
}

function reportVentas({ items, ventas }, charts) {
  const vs = ventas.filter((x) => inPeriod(x.v.fecha));
  if (!vs.length) {
    return `<div class="card empty"><h2>Todavía no hay ventas${reportState.year ? ` en ${reportState.year}` : ""}</h2>
      <p class="muted">Cuando registres ventas (pestaña <strong>Ventas</strong> del menú) aquí verás ingresos,
      beneficio, margen, ventas por mes y por canal, y la rentabilidad de cada impresión.</p></div>`;
  }
  const ingresos = vs.reduce((s, x) => s + x.importe, 0);
  const coste = vs.reduce((s, x) => s + x.coste, 0);
  const beneficio = ingresos - coste;
  const uds = vs.reduce((s, x) => s + x.cantidad, 0);
  charts.ventasTiempo = barChart(timeSeries(vs, (x) => x.v.fecha, (x) => x.importe));
  const canales = Object.entries(sumBy(vs, (x) => x.v.canal || "Sin canal", (x) => x.importe))
    .sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));

  const porImpresion = items.map((it) => {
    const mine = vs.filter((x) => x.it === it);
    if (!mine.length) return null;
    const ing = mine.reduce((s, x) => s + x.importe, 0);
    const cos = mine.reduce((s, x) => s + x.coste, 0);
    const u = mine.reduce((s, x) => s + x.cantidad, 0);
    return { it, u, ing, cos, ben: ing - cos, pm: u ? ing / u : null };
  }).filter(Boolean).sort((a, b) => b.ben - a.ben);
  const signed = (v) => `<span class="${v >= 0 ? "pos" : "neg"}">${esc(money(v))}</span>`;

  return `
    ${kpis([
      { label: "Ventas", value: numFmt.format(vs.length), sub: `${numFmt.format(uds)} unidades` },
      { label: "Ingresos", value: money(ingresos) },
      { label: "Coste de lo vendido", value: money(coste) },
      { label: "Beneficio", value: money(beneficio), cls: beneficio >= 0 ? "pos" : "neg" },
      { label: "Margen", value: pct(ingresos ? (beneficio / ingresos) * 100 : null) },
      { label: "Precio medio por unidad", value: money(uds ? ingresos / uds : 0) },
    ])}
    <div class="report-grid">
      ${chartBox("ventasTiempo", reportState.year ? `Ingresos por mes (${reportState.year})` : "Ingresos por año")}
      ${block("Ingresos por canal", hBars(canales, { total: ingresos }))}
    </div>
    ${block("Rentabilidad por impresión", `<div class="table-wrap"><table class="report-table">
      <thead><tr><th>Impresión</th><th class="num">Uds. vendidas</th><th class="num">Precio medio</th><th class="num">Ingresos</th>
        <th class="num">Coste</th><th class="num">Beneficio</th><th class="num">Margen</th></tr></thead>
      <tbody>${porImpresion.map((r) => `<tr><td><strong>${esc(printName(r.it))}</strong></td>
        <td class="num">${esc(numFmt.format(r.u))}</td><td class="num">${esc(money(r.pm))}</td><td class="num">${esc(money(r.ing))}</td>
        <td class="num">${esc(money(r.cos))}</td><td class="num">${signed(r.ben)}</td><td class="num">${esc(pct(r.ing ? (r.ben / r.ing) * 100 : null))}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${esc(numFmt.format(uds))}</td><td></td><td class="num">${esc(money(ingresos))}</td>
        <td class="num">${esc(money(coste))}</td><td class="num">${signed(beneficio)}</td><td class="num">${esc(pct(ingresos ? (beneficio / ingresos) * 100 : null))}</td></tr></tfoot>
    </table></div>`, "Coste = coste por unidad de cada impresión × unidades vendidas.")}
    ${block("Detalle de ventas", `<div class="table-wrap"><table class="report-table">
      <thead><tr><th>Fecha</th><th>Impresión</th><th class="num">Uds.</th><th class="num">Precio/ud.</th><th class="num">Importe</th><th>Canal</th><th>Cliente</th></tr></thead>
      <tbody>${[...vs].sort((a, b) => (a.v.fecha || "").localeCompare(b.v.fecha || "")).map((x) => `<tr>
        <td>${esc(fmtDate(x.v.fecha))}</td><td>${esc(printName(x.it))}</td><td class="num">${esc(numFmt.format(x.cantidad))}</td>
        <td class="num">${esc(money(x.v.precioUnidad))}</td><td class="num">${esc(money(x.importe))}</td>
        <td>${esc(x.v.canal || "")}</td><td>${esc(x.v.cliente || "")}</td></tr>`).join("")}</tbody>
    </table></div>`)}
  `;
}

// ================================================================= VISTA

async function viewReports(reportId) {
  const rep = REPORTS.find((r) => r.id === reportId) || REPORTS[0];
  const data = await loadReportData();
  const years = [...new Set([
    ...data.gastos.map((x) => yearOf(x.fecha)),
    ...data.items.map((x) => yearOf(x.general?.fecha)),
    ...data.ventas.map((x) => yearOf(x.v.fecha)),
  ].filter(Boolean))].sort().reverse();
  if (reportState.year && !years.includes(reportState.year)) reportState.year = "";

  const charts = {};
  const builders = { resumen: reportResumen, gastos: reportGastos, produccion: reportProduccion, ventas: reportVentas };
  const body = builders[rep.id](data, charts);
  const periodo = reportState.year ? `Año ${reportState.year}` : "Todo el periodo";
  const generado = new Date().toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });

  app.innerHTML = `
    <div class="report-toolbar no-print">
      <nav class="tabs">${REPORTS.map((r) => `
        <a href="#/informes/${r.id}" class="tab ${r.id === rep.id ? "active" : ""}">${esc(r.titulo.replace(/^Informe de /, "").replace(/^\w/, (c) => c.toUpperCase()))}</a>`).join("")}
      </nav>
      <div class="report-actions">
        <select id="rep-year" style="width:auto" aria-label="Periodo">
          <option value="">Todo el periodo</option>
          ${years.map((y) => `<option ${y === reportState.year ? "selected" : ""}>${y}</option>`).join("")}
        </select>
        <button class="btn btn-primary" id="rep-pdf">Exportar PDF</button>
      </div>
    </div>
    <header class="report-head">
      <div class="print-only report-brand">Impresiones 3D</div>
      <h1>${esc(rep.titulo)}</h1>
      <p class="muted">${esc(periodo)} · Generado el ${esc(generado)}</p>
    </header>
    <div class="report-body">${body}</div>
  `;

  drawCharts(charts);

  document.getElementById("rep-year").addEventListener("change", (e) => {
    reportState.year = e.target.value;
    viewReports(rep.id);
  });
  document.getElementById("rep-pdf").addEventListener("click", () =>
    printAs(`${rep.titulo} - ${periodo}`));
}

/** Dibuja los SVG al ancho real del contenedor. */
function drawCharts(charts) {
  const draw = () => document.querySelectorAll("[data-chart]").forEach((el) => {
    const fn = charts[el.dataset.chart];
    if (fn) el.innerHTML = fn(Math.max(280, Math.round(el.clientWidth)));
  });
  draw();
  drawCharts.current = draw;
  clearTimeout(drawCharts.t);
  window.onresize = () => { clearTimeout(drawCharts.t); drawCharts.t = setTimeout(draw, 150); };
}

// Al imprimir, redibuja los gráficos al ancho del papel (y al volver, al de la pantalla).
const redrawForMedia = () => { if (document.querySelector("[data-chart]")) drawCharts.current?.(); };
window.matchMedia("print").addEventListener("change", redrawForMedia);
window.addEventListener("beforeprint", redrawForMedia);
window.addEventListener("afterprint", redrawForMedia);

/** Imprime (→ "Guardar como PDF") sugiriendo un nombre de fichero. */
function printAs(title) {
  const old = document.title;
  document.title = title.replace(/[\\/:*?"<>|]/g, "-");
  window.addEventListener("afterprint", () => (document.title = old), { once: true });
  window.print();
}

// --------------------------------------------------------- tooltip global

(() => {
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  document.body.appendChild(tip);
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
  });
  document.addEventListener("mousemove", (e) => {
    if (tip.hidden) return;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - w - 8)}px`;
    tip.style.top = `${e.clientY + 16}px`;
  });
})();
