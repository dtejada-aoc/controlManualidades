"use strict";

/* ===================================================================
   Control de cambios: al guardar un catálogo, un registro, una impresión
   o la configuración, revisa a qué datos afecta el cambio y propone
   actualizarlos (con una ventana en la que se elige qué aplicar).

   - Renombrar un elemento de catálogo → cambiar el nombre donde se usa
     (los catálogos se referencian por nombre).
   - Cambiar un dato que se copia al elegir el elemento («rellena»: precio
     de un accesorio, precio por kg de un filamento…) → actualizar la copia.
   - Cambios que alteran el coste de las impresiones (impresión, máquinas,
     configuración de costes) → recalcular el coste por unidad guardado en
     las ventas.
   Cada propuesta viene marcada si el dato estaba al día y desmarcada si
   parece ajustado a mano. Usa las utilidades de app.js.
   =================================================================== */

const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
/** Igualdad para valores copiados (precios pequeños como 0,055 €: sin tolerancia de céntimos). */
const same = (a, b) => (isEmpty(a) && isEmpty(b)) || (!isEmpty(a) && !isEmpty(b) && Math.abs(Number(a) - Number(b)) < 1e-9) || a === b;
/** Formato con los decimales necesarios (hasta 4) para que se vea la diferencia: 0,055 € → 0,06 €. */
const fmtExact = (field, v) => {
  if (isEmpty(v)) return "—";
  if (field?.tipo !== "moneda") return fmtValue(field || {}, v);
  return `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(v))} ${CONFIG.moneda || "€"}${field.unidad || ""}`;
};
const round4 = (v) => Math.round(Number(v) * 10000) / 10000;

// ------------------------------------------------------------ recorrer datos

/** Llama a cb(field, row) por cada campo de cada sección (y lista anidada) de una impresión. */
function forEachPrintField(item, cb) {
  for (const sec of sections()) {
    const rows = sec.repetible ? asArray(item[sec.id]) : (item[sec.id] ? [item[sec.id]] : []);
    for (const row of rows) {
      if (!row) continue;
      for (const f of sec.campos) {
        if (f.tipo === "lista") for (const sub of asArray(row[f.id])) { if (sub) for (const sf of f.campos) cb(sf, sub); }
        else cb(f, row);
      }
    }
  }
}

/** Llama a cb(field, row, def) por cada campo de cada elemento de todos los registros. */
function forEachRegField(regs, cb) {
  for (const def of CONFIG.registros || []) {
    for (const item of asArray(regs[def.id])) for (const f of def.campos) cb(f, item, def);
  }
}

async function loadAllData() {
  const items = await api("GET", "/api/impresiones");
  const regs = {};
  for (const r of CONFIG.registros || []) regs[r.id] = await api("GET", `/api/registros/${r.id}`);
  return { items, regs };
}

/** Ejecuta fn con catálogos y ajustes alternativos (para calcular costes «antes» de un cambio). */
function withState({ catalogs = {}, ajustes } = {}, fn) {
  const savedCat = {};
  for (const [k, v] of Object.entries(catalogs)) { savedCat[k] = CATALOGS[k]; CATALOGS[k] = v; }
  const savedAj = AJUSTES;
  if (ajustes) AJUSTES = ajustes;
  try { return fn(); } finally { Object.assign(CATALOGS, savedCat); AJUSTES = savedAj; }
}

/** Coste por unidad que tendría cada venta con unas impresiones y un estado dados. */
function saleCosts(items, ventas, state) {
  return withState(state, () => {
    const tots = Object.fromEntries(items.map((it) => [it.id, { ...computeTotals(it), unidades: Number(it.general?.unidades) || 1 }]));
    return Object.fromEntries(ventas.filter((v) => tots[v.impresion]).map((v) => [v.id, saleUnitCost(tots[v.impresion], v)]));
  });
}

const printNames = (items) => Object.fromEntries(items.map((it) => [it.id, printName(it)]));

// ------------------------------------------------------------ propuestas

/**
 * Agrupa los usos por sitio (una impresión o un registro) en elementos seleccionables:
 * cada elemento aplica el cambio a todos los usos de ese sitio.
 */
function usosAElementos(usos, aplicar) {
  const grupos = new Map();
  for (const u of usos) {
    if (!grupos.has(u.donde)) grupos.set(u.donde, []);
    grupos.get(u.donde).push(u);
  }
  return [...grupos].map(([donde, list]) => ({
    texto: list.length > 1 ? `${donde} (${list.length} usos)` : donde,
    apply: (mark) => { for (const u of list) { aplicar(u); u.mark(mark); } },
  }));
}

/** Propuestas de ventas cuyo coste por unidad cambia entre dos estados (una casilla por venta). */
function salesProposals(ventas, before, after, names) {
  const sync = [], manual = [];
  for (const v of ventas) {
    if (!(v.id in after) || after[v.id] === null) continue;
    const b = before[v.id], a = after[v.id];
    if (near(a, v.costeUnidad) || (b !== undefined && near(a, b))) continue;
    (b !== undefined && b !== null && near(v.costeUnidad, b) ? sync : manual).push({ v, a });
  }
  const texto = ({ v, a }) => `${fmtDate(v.fecha)} · ${names[v.impresion] || v.impresion} · ${v.cantidad} ud.`
    + `${v.cliente ? ` · ${v.cliente}` : ""}: ${fmtValue({ tipo: "moneda" }, v.costeUnidad)} → ${fmtValue({ tipo: "moneda" }, a)}`;
  const make = (list, marcada, titulo) => list.length ? [{
    grupo: "Ventas", marcada, titulo,
    elementos: list.map((x) => ({ texto: texto(x), apply: (mark) => { x.v.costeUnidad = round4(x.a); mark.reg("ventas"); } })),
  }] : [];
  return [
    ...make(sync, true, "Recalcular el coste por unidad de las ventas que estaban al día"),
    ...make(manual, false, "Recalcular también las ventas con un coste ajustado a mano o ya desactualizado"),
  ];
}

/**
 * Propuestas para un dato copiado al elegir un elemento («rellena»), p. ej. el precio
 * de un accesorio: actualizar las copias que tenían el valor antiguo.
 */
function fillProposals({ grupo, nombreElemento, usos, campoDestino, etiqueta, antes, despues, fmt }) {
  const sync = usos.filter((u) => same(u.row[campoDestino], antes));
  const otros = usos.filter((u) => !sync.includes(u) && !same(u.row[campoDestino], despues));
  const mk = (list, marcada, titulo) => list.length ? [{
    grupo, marcada, titulo,
    elementos: usosAElementos(list, (u) => { u.row[campoDestino] = despues; }),
  }] : [];
  return [
    ...mk(sync, true, `${etiqueta} de «${nombreElemento}»: ${fmt(antes)} → ${fmt(despues)} donde tenía el valor anterior`),
    ...mk(otros, false, `${etiqueta} de «${nombreElemento}»: poner también ${fmt(despues)} donde tenía otro valor (ajustado a mano)`),
  ];
}

// ------------------------------------------------------------ ventana de revisión

/**
 * Muestra las propuestas, cada una con su lista de afectados seleccionables uno a uno,
 * y devuelve los elementos marcados (vacío si se cancela).
 */
function showReview(titulo, intro, proposals) {
  return new Promise((resolve) => {
    const grupos = [...new Set(proposals.map((p) => p.grupo))];
    const box = document.createElement("div");
    box.className = "modal";
    box.innerHTML = `<div class="modal-card card" role="dialog" aria-modal="true" aria-labelledby="rev-title">
      <h2 id="rev-title">${esc(titulo)}</h2>
      <p class="muted">${esc(intro)}</p>
      <div class="modal-body">${grupos.map((g) => `<section class="review-group"><h3>${esc(g)}</h3>
        ${proposals.map((p, i) => p.grupo !== g ? "" : `<div class="review-item" data-p="${i}">
          <input type="checkbox" class="rev-all" data-p="${i}" ${p.marcada ? "checked" : ""} aria-label="Todos">
          <div>
            <strong>${esc(p.titulo)}</strong> <span class="muted small rev-count" data-p="${i}"></span>
            ${p.nota ? `<div class="muted small">${esc(p.nota)}</div>` : ""}
            <details class="rev-list" ${p.elementos.length <= 10 ? "open" : ""}>
              <summary class="small">${p.elementos.length <= 10 ? "Afectados" : `Ver los ${p.elementos.length} afectados`}</summary>
              ${p.elementos.map((e, j) => `<label class="rev-el">
                <input type="checkbox" class="rev-one" data-p="${i}" data-e="${j}" ${p.marcada ? "checked" : ""}>
                <span class="small">${esc(e.texto)}</span></label>`).join("")}
            </details>
          </div></div>`).join("")}
      </section>`).join("")}</div>
      <div class="editor-actions">
        <button class="btn" data-r="none">No cambiar nada</button>
        <span style="flex:1"></span>
        <button class="btn btn-primary" data-r="ok">Aplicar lo marcado</button>
      </div></div>`;
    document.body.appendChild(box);

    // Casilla de la propuesta: marcada, desmarcada o a medias según sus elementos
    const sync = (i) => {
      const ones = [...box.querySelectorAll(`.rev-one[data-p="${i}"]`)];
      const n = ones.filter((c) => c.checked).length;
      const all = box.querySelector(`.rev-all[data-p="${i}"]`);
      all.checked = n === ones.length;
      all.indeterminate = n > 0 && n < ones.length;
      box.querySelector(`.rev-count[data-p="${i}"]`).textContent = `(${n} de ${ones.length} seleccionados)`;
    };
    proposals.forEach((_, i) => sync(i));
    box.addEventListener("change", (e) => {
      const t = e.target;
      if (t.classList.contains("rev-all")) {
        box.querySelectorAll(`.rev-one[data-p="${t.dataset.p}"]`).forEach((c) => (c.checked = t.checked));
        sync(t.dataset.p);
      } else if (t.classList.contains("rev-one")) sync(t.dataset.p);
    });

    const close = (sel) => { box.remove(); resolve(sel); };
    box.querySelector('[data-r="none"]').onclick = () => close([]);
    box.querySelector('[data-r="ok"]').onclick = () =>
      close([...box.querySelectorAll(".rev-one:checked")].map((c) => proposals[Number(c.dataset.p)].elementos[Number(c.dataset.e)]));
    box.addEventListener("keydown", (e) => { if (e.key === "Escape") close([]); });
    box.querySelector('[data-r="ok"]').focus();
  });
}

/** Revisa unas propuestas y guarda los elementos marcados. Devuelve true si se cambió algo. */
async function reviewAndApply(titulo, intro, proposals, data) {
  proposals = proposals.filter((p) => p.elementos?.length);
  if (!proposals.length) return false;
  const sel = await showReview(titulo, intro, proposals);
  if (!sel.length) return false;
  const prints = new Set(), regs = new Set();
  const mark = { print: (it) => prints.add(it), reg: (rid) => regs.add(rid) };
  for (const e of sel) e.apply(mark);
  for (const it of prints) {
    const body = clone(it);
    delete body.fotos; delete body._tot;
    await api("PUT", `/api/impresiones/${encodeURIComponent(it.id)}`, body);
  }
  for (const rid of regs) data.regs[rid] = await api("PUT", `/api/registros/${rid}`, data.regs[rid]);
  toast(`Aplicados ${sel.length} cambio(s): ${prints.size ? `${prints.size} impresión(es)` : ""}${prints.size && regs.size ? " y " : ""}${regs.size ? [...regs].join(", ") : ""}`);
  return true;
}

// ------------------------------------------------------------ flujos

/** Ventas afectadas al pasar de un estado a otro (impresiones y/o catálogos y/o ajustes). */
async function reviewSales({ itemsBefore, itemsAfter, stateBefore = {}, stateAfter = {}, data, motivo }) {
  const ventas = asArray(data.regs.ventas);
  if (!ventas.length) return false;
  const before = saleCosts(itemsBefore, ventas, stateBefore);
  const after = saleCosts(itemsAfter, ventas, stateAfter);
  const props = salesProposals(ventas, before, after, printNames(itemsAfter));
  return reviewAndApply("Revisión de cambios: ventas", `${motivo} Cambia el coste por unidad de algunas ventas ya registradas. `
    + "Las ventas guardan el coste del momento en que se registraron: elige si quieres recalcularlas.", props, data);
}

/** Usos de un elemento de catálogo (por nombre) en impresiones y registros. */
function catalogUsages(cid, nombre, data) {
  const usos = [];
  for (const it of data.items) {
    forEachPrintField(it, (f, row) => {
      if (f.tipo === "catalogo" && f.catalogo === cid && row[f.id] === nombre) usos.push({ f, row, donde: printName(it), mark: (m) => m.print(it) });
    });
  }
  forEachRegField(data.regs, (f, row, def) => {
    if (f.tipo === "catalogo" && f.catalogo === cid && row[f.id] === nombre) {
      usos.push({ f, row, donde: `${def.elemento || def.titulo}: ${row.nombre || fmtDate(row.fecha) || row.id}`, mark: (m) => m.reg(def.id) });
    }
  });
  return usos;
}

/**
 * Tras guardar un catálogo: renombres, datos copiados (precio…) y, si cambian costes, las ventas.
 * pares: [{ antes, despues }] de los elementos que siguen existiendo.
 */
async function reviewCatalogChange(def, oldList, newList, pares) {
  const data = await loadAllData();
  const itemsBefore = clone(data.items);
  const props = [];
  for (const { antes, despues } of pares) {
    // 1) Renombrado: cambiar el nombre donde se usa
    if (antes.nombre !== despues.nombre) {
      const usos = catalogUsages(def.id, antes.nombre, data);
      if (usos.length) {
        props.push({
          grupo: "Nombres", marcada: true,
          titulo: `«${antes.nombre}» → «${despues.nombre}»: cambiar el nombre donde se usa`,
          nota: "Los que no se cambien se quedarán apuntando a un nombre que ya no está en el catálogo (se marcarán con ⚠).",
          elementos: usosAElementos(usos, (u) => { u.row[u.f.id] = despues.nombre; }),
        });
      }
    }
    // 2) Datos que se copian al elegir el elemento («rellena»)
    const campos = [];
    for (const it of data.items) forEachPrintField(it, (f, row) => {
      if (f.tipo === "catalogo" && f.catalogo === def.id && f.rellena && (row[f.id] === antes.nombre || row[f.id] === despues.nombre)) {
        campos.push({ f, row, donde: printName(it), mark: (m) => m.print(it) });
      }
    });
    for (const [dest, src] of Object.entries(campos[0]?.f.rellena || {})) {
      if (isEmpty(despues[src]) || antes[src] === despues[src]) continue;
      const fdef = def.campos.find((x) => x.id === src);
      props.push(...fillProposals({
        grupo: "Valores copiados", nombreElemento: despues.nombre, usos: campos, campoDestino: dest,
        etiqueta: fdef?.etiqueta || src, antes: antes[src], despues: despues[src], fmt: (v) => fmtExact(fdef, v),
      }));
    }
  }
  await reviewAndApply("Revisión de cambios", `Has modificado «${def.titulo}». Estos datos usan los elementos cambiados:`, props, data);
  // 3) Ventas (si cambian costes: máquinas, precios copiados…)
  await reviewSales({ itemsBefore, itemsAfter: data.items, stateBefore: { catalogs: { [def.id]: oldList } }, data,
    motivo: `El cambio en «${def.titulo}» modifica el coste de algunas impresiones.` });
}

/** Antes de borrar elementos de catálogo: avisa si están en uso. Devuelve true para continuar. */
async function confirmCatalogDeletes(def, borrados) {
  if (!borrados.length) return true;
  const data = await loadAllData();
  const enUso = borrados.map((b) => ({ b, n: catalogUsages(def.id, b.nombre, data).length })).filter((x) => x.n);
  if (!enUso.length) return true;
  return confirm(`Vas a quitar de «${def.titulo}» elementos que se están usando:\n\n${enUso.map((x) => `• ${x.b.nombre}: ${x.n} uso(s)`).join("\n")}`
    + "\n\nEsos datos conservarán el nombre, pero ya no estará en el catálogo (se marcará con ⚠). ¿Quitar igualmente?");
}

/** Antes de borrar un elemento de un registro (p. ej. un filamento): texto de aviso si se usa, o "" si no. */
async function registerDeleteWarning(def, item) {
  const data = await loadAllData();
  const donde = new Set();
  for (const it of data.items) {
    forEachPrintField(it, (f, row) => { if (f.tipo === "registro" && f.registro === def.id && row[f.id] === item.id) donde.add(printName(it)); });
    if (asArray(it.ficha?.partes).some((p) => p.filamento === item.id) && def.id === "filamentos") donde.add(`${printName(it)} (ficha)`);
  }
  forEachRegField(data.regs, (f, row, d) => {
    if (f.tipo === "impresion" && def.id === "impresiones" && row[f.id] === item.id) donde.add(`${d.elemento}: ${row.id}`);
  });
  return donde.size ? `\n\nSe usa en ${donde.size} impresión(es): ${[...donde].slice(0, 6).join(", ")}${donde.size > 6 ? "…" : ""}.`
    + " Si lo borras, esas impresiones lo mostrarán como «(eliminado)»." : "";
}

/** Tras guardar un registro (p. ej. filamentos): datos copiados en las impresiones y, después, las ventas. */
async function reviewRegisterChange(def, oldList, newList) {
  const byId = Object.fromEntries(asArray(oldList).map((x) => [x.id, x]));
  const pares = asArray(newList).filter((x) => byId[x.id] && JSON.stringify(byId[x.id]) !== JSON.stringify(x))
    .map((x) => ({ antes: byId[x.id], despues: x }));
  if (!pares.length) return;
  const data = await loadAllData();
  const itemsBefore = clone(data.items);
  const props = [];
  for (const { antes, despues } of pares) {
    const usos = [];
    for (const it of data.items) forEachPrintField(it, (f, row) => {
      if (f.tipo === "registro" && f.registro === def.id && f.rellena && row[f.id] === despues.id) usos.push({ f, row, donde: printName(it), mark: (m) => m.print(it) });
    });
    for (const [dest, src] of Object.entries(usos[0]?.f.rellena || {})) {
      if (isEmpty(despues[src]) || antes[src] === despues[src]) continue;
      const fdef = def.campos.find((x) => x.id === src);
      props.push(...fillProposals({
        grupo: "Valores copiados", nombreElemento: despues.nombre || despues.id, usos, campoDestino: dest,
        etiqueta: fdef?.etiqueta || src, antes: antes[src], despues: despues[src], fmt: (v) => fmtExact(fdef, v),
      }));
    }
  }
  const cambiado = await reviewAndApply("Revisión de cambios", `Has modificado «${def.titulo}». Estas impresiones guardan una copia del valor anterior:`, props, data);
  if (cambiado) await reviewSales({ itemsBefore, itemsAfter: data.items, data, motivo: "Al actualizar esas impresiones cambia su coste." });
}

/** Tras guardar una impresión: ventas de esa impresión cuyo coste por unidad cambia. */
async function reviewPrintChange(before, after) {
  if (!before || !after) return;
  const data = await loadAllData();
  if (!asArray(data.regs.ventas).some((v) => v.impresion === after.id)) return;
  await reviewSales({ itemsBefore: [before], itemsAfter: [after], data, motivo: `Has cambiado «${printName(after)}».` });
}

/** Tras guardar la configuración: ventas afectadas por los nuevos costes. */
async function reviewSettingsChange(beforeAjustes, afterAjustes) {
  if (JSON.stringify(beforeAjustes?.costes) === JSON.stringify(afterAjustes?.costes)
    && JSON.stringify(beforeAjustes?.fallos) === JSON.stringify(afterAjustes?.fallos)) return;
  const data = await loadAllData();
  await reviewSales({ itemsBefore: data.items, itemsAfter: data.items, stateBefore: { ajustes: beforeAjustes }, data,
    motivo: "Has cambiado la configuración de costes." });
}
