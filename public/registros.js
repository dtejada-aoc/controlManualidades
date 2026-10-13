"use strict";

/* ===================================================================
   Registros: listados independientes definidos en config/campos.json
   ("registros"), como Gastos o Ventas. Listado con indicadores,
   desglose, filtros y un editor para dar de alta / modificar.
   Usa las utilidades de app.js (api, fieldBlock, bindInputs…).
   =================================================================== */

async function viewRegister(def, params = "") {
  await loadCatalogs();
  if (def.campos.some((f) => f.tipo === "impresion")) await loadPrints();
  let list = await api("GET", `/api/registros/${def.id}`);
  const st = (regState[def.id] ??= { q: "", year: "", group: "" });
  const val = (f, it) => fieldValue(f, it);
  const amountField = def.campos.find((f) => f.total) || def.campos.find((f) => f.tipo === "moneda");
  const groupField = def.campos.find((f) => f.id === def.agruparPor);
  const dateField = def.campos.find((f) => f.tipo === "fecha");
  const printField = def.campos.find((f) => f.tipo === "impresion");
  const cols = def.campos.filter((f) => f.enListado);
  const elem = (def.elemento || "elemento").toLowerCase();
  const fem = def.genero === "f";
  const nuevo = `${fem ? "Nueva" : "Nuevo"} ${elem}`;
  const done = (verb) => `${def.elemento || "Elemento"} ${verb}${fem ? "a" : "o"}`;
  const describe = (it) => it.nombre ||
    [printField && fmtValue(printField, it[printField.id]), dateField && fmtDate(it[dateField.id])].filter(Boolean).join(" · ") || elem;

  // Filtro fijo desde la URL, p. ej. #/ventas?impresion=<id>
  const fixed = [...new URLSearchParams(params)].filter(([k]) => def.campos.some((f) => f.id === k));
  // Columnas que tiene sentido sumar en el pie de la tabla
  const sumFields = new Set([amountField?.id, ...asArray(def.resumen).map((r) => r.suma)].filter(Boolean));
  let editing = null; // { draft, isNew }

  app.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(def.titulo)}</h1>
        ${def.descripcion ? `<p class="muted" style="margin:4px 0 0">${esc(def.descripcion)}</p>` : ""}</div>
      <div class="actions"><button class="btn btn-primary" id="new">+ ${esc(nuevo)}</button></div>
    </div>
    ${fixed.length ? `<div class="filter-chip">Filtrando por ${fixed.map(([k, v]) => {
      const f = def.campos.find((x) => x.id === k);
      return `${esc(f.etiqueta.toLowerCase())}: <strong>${esc(fmtValue(f, v))}</strong>`;
    }).join(", ")} <a href="#/${esc(def.id)}">✕ Ver todas</a></div>` : ""}
    <div id="editor"></div>
    <div id="reg-content"></div>
  `;

  const filtered = () => {
    const q = st.q.trim().toLowerCase();
    return list.filter((it) =>
      fixed.every(([k, v]) => String(it[k] ?? "") === v) &&
      (!st.year || (it[dateField?.id] || "").startsWith(st.year)) &&
      (!st.group || it[groupField?.id] === st.group) &&
      (!q || `${JSON.stringify(it)} ${cols.map((f) => fmtValue(f, val(f, it))).join(" ")}`.toLowerCase().includes(q)));
  };

  /** Indicadores: los del "resumen" de la configuración o, si no hay, los genéricos. */
  const summary = (rows) => {
    const amount = (it) => Number(val(amountField, it)) || 0;
    if (!def.resumen) {
      const thisYear = String(new Date().getFullYear());
      return {
        defs: [
          { id: "total", etiqueta: `Total${st.year ? " " + st.year : ""}`, tipo: "moneda" },
          { id: "n", etiqueta: def.titulo, tipo: "numero" },
          ...(dateField && !st.year ? [{ id: "year", etiqueta: `Este año (${thisYear})`, tipo: "moneda" }] : []),
        ],
        values: {
          total: rows.reduce((s, it) => s + amount(it), 0),
          n: rows.length,
          year: rows.filter((it) => (it[dateField?.id] || "").startsWith(thisYear)).reduce((s, it) => s + amount(it), 0),
        },
      };
    }
    const values = {};
    for (const r of def.resumen) {
      if (r.contar) values[r.id] = rows.length;
      else if (r.suma) {
        const f = def.campos.find((x) => x.id === r.suma);
        values[r.id] = rows.reduce((s, it) => s + (Number(f ? val(f, it) : it[r.suma]) || 0), 0);
      }
    }
    for (const r of def.resumen.filter((x) => x.formula)) {
      const v = evalFormula(r.formula, (k) => values[k]);
      if (v !== null) values[r.id] = v;
    }
    return { defs: def.resumen, values };
  };

  // --- listado
  const render = () => {
    const content = document.getElementById("reg-content");
    if (!list.length) {
      content.innerHTML = `<div class="card empty"><h2>Todavía no hay ${esc(def.titulo.toLowerCase())}</h2>
        <p class="muted">Pulsa <strong>+ ${esc(nuevo)}</strong> para registrar ${fem ? "la primera" : "el primero"}.</p></div>`;
      return;
    }
    const years = dateField ? [...new Set(list.map((it) => (it[dateField.id] || "").slice(0, 4)).filter(Boolean))].sort().reverse() : [];
    const groups = groupField ? [...new Set([
      ...(groupField.tipo === "catalogo" ? (CATALOGS[groupField.catalogo] || []).map((c) => c.nombre) : asArray(groupField.opciones)),
      ...list.map((it) => it[groupField.id]).filter(Boolean)])] : [];

    const rows = filtered().sort((a, b) =>
      (b[dateField?.id] || "").localeCompare(a[dateField?.id] || "") || (b.creado || "").localeCompare(a.creado || ""));
    const amount = (it) => Number(val(amountField, it)) || 0;
    const total = rows.reduce((s, it) => s + amount(it), 0);
    const sum = summary(rows);
    const colSum = (f) => rows.reduce((s, it) => s + (Number(val(f, it)) || 0), 0);

    // Desglose por el campo de agrupación
    const byGroup = {};
    if (groupField) for (const it of rows) {
      const g = it[groupField.id] || `Sin ${groupField.etiqueta.toLowerCase()}`;
      byGroup[g] = (byGroup[g] || 0) + amount(it);
    }
    const groupEntries = Object.entries(byGroup).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...groupEntries.map((e) => e[1]), 0);

    content.innerHTML = `
      <div class="stats">${statTiles(sum.defs, sum.values)}</div>

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
        ${groupField ? `<select id="group" style="width:auto"><option value="">${esc(groupField.etiqueta)}: todos</option>
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
          return `<td class="${NUMERIC.includes(f.tipo) ? "num" : ""}">${fmtValueHtml(f, val(f, it))}</td>`;
        }).join("")}<td class="num"><button class="btn btn-sm btn-ghost" data-edit="${esc(it.id)}">Editar</button></td></tr>`).join("") ||
          `<tr><td colspan="${cols.length + 1}" class="muted" style="text-align:center;padding:24px">Sin resultados</td></tr>`}
        </tbody>
        ${rows.length > 1 ? `<tfoot><tr>${cols.map((f, i) =>
          `<td class="${NUMERIC.includes(f.tipo) ? "num" : ""}">${i === 0 ? `Total (${rows.length})`
            : sumFields.has(f.id) || (f.formula && f.signo) ? fmtValueHtml(f, colSum(f)) : ""}</td>`).join("")}<td></td></tr></tfoot>` : ""}
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
    if (isNew) {
      for (const f of def.campos) { const v = defaultValue(f); if (!isEmpty(v)) draft[f.id] = v; }
      for (const [k, v] of fixed) draft[k] = v;
      applyFill(draft);
    }
    editing = { draft, isNew };
    formDirty = false;

    const box = document.getElementById("editor");
    box.innerHTML = `
      <form class="card card-pad section editor-card" id="reg-form" novalidate style="margin-top:0;margin-bottom:20px">
        <h2>${isNew ? esc(nuevo) : `Editar ${esc(elem)}`}</h2>
        <div class="form-grid" id="reg-fields" style="margin-top:12px"></div>
        <div class="editor-actions">
          ${isNew ? "" : `<button type="button" class="btn btn-danger" id="reg-del">Eliminar</button>`}
          <span style="flex:1"></span>
          <button type="button" class="btn" id="reg-cancel">Cancelar</button>
          <button type="submit" class="btn btn-primary">Guardar</button>
        </div>
      </form>`;
    const form = document.getElementById("reg-form");
    const updateComputed = () => form.querySelectorAll("output[data-formula]").forEach((out) => {
      const f = def.campos.find((x) => `e.${x.id}` === out.dataset.formula);
      out.innerHTML = isEmpty(val(f, draft)) ? "—" : fmtValueHtml(f, val(f, draft));
    });
    const renderFields = () => {
      document.getElementById("reg-fields").innerHTML = def.campos.map((f) => fieldBlock(f, draft[f.id], `e.${f.id}`)).join("");
      updateComputed();
    };
    renderFields();
    bindInputs(form, { e: draft }, (holder, e) => {
      const f = def.campos.find((x) => `e.${x.id}` === holder.dataset.path);
      if (e.type === "change" && f?.rellena) {
        applyFill(draft, f);
        renderFields();
        return;
      }
      updateComputed();
    });
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
      if (!confirm(`¿Eliminar "${describe(item)}"?\n\nSe guarda una copia de seguridad en data/papelera.`)) return;
      try { await persist(list.filter((it) => it.id !== item.id), done("eliminad")); }
      catch (err) { toast(err.message, true); }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const missing = def.campos.filter((f) => f.obligatorio && isEmpty(draft[f.id])).map((f) => `e.${f.id}`);
      if (!checkRequired(missing)) return;
      const now = new Date().toISOString().slice(0, 19);
      const saved = { ...draft, modificado: now, creado: draft.creado || now };
      const next = isNew ? [...list, saved] : list.map((it) => (it.id === saved.id ? saved : it));
      try { await persist(next, done("guardad")); }
      catch (err) { toast(err.message, true); }
    });
  };

  /**
   * Copia datos del elemento elegido (impresión o elemento de catálogo) según
   * "rellena", p. ej. el coste por unidad de la impresión. Sin `only`, aplica
   * todos los campos que ya tengan valor (alta con filtro fijo).
   */
  function applyFill(draft, only = null) {
    for (const f of def.campos.filter((x) => x.rellena && (!only || x === only))) {
      const source = f.tipo === "impresion" ? PRINTS[draft[f.id]]?.tot
        : (CATALOGS[f.catalogo] || []).find((c) => c.nombre === draft[f.id]);
      if (!source) continue;
      for (const [dest, src] of Object.entries(f.rellena)) {
        const v = Number(source[src]);
        if (!isEmpty(source[src]) && !isNaN(v)) draft[dest] = Math.round(v * 100) / 100;
      }
    }
  }

  document.getElementById("new").onclick = () => openEditor(null);
  render();
}
