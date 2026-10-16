"use strict";

/* ===================================================================
   Ficha para el cliente: hoja con la foto del producto, las partes cuyo
   color elige el cliente y los datos que hay que pedirle. Se exporta a
   PDF en blanco (para enviarla) o con las respuestas rellenadas en la app.
   Es opcional: se configura en su propia pantalla (#/ficha/<id>?editar) y
   se guarda en la impresión como «ficha». Usa las utilidades de app.js.
   =================================================================== */

const FICHA_REG = "filamentos";
const FICHA_TIPOS = ["Texto", "Texto largo", "Opciones", "Número", "Fecha", "Sí / No"];

/** Filamentos ordenados por color (los que no tienen color, al final). */
const fichaFilaments = () => [...(REGS[FICHA_REG] || [])]
  .sort((a, b) => isEmpty(a.color) - isEmpty(b.color)
    || String(a.color || "").localeCompare(String(b.color || ""), "es")
    || String(a.tipo || "").localeCompare(String(b.tipo || ""), "es"));
const fichaLabel = (f) => (f ? [f.color, f.tipo, f.nombre].filter(Boolean).join(" - ") : "");

async function viewClientSheet(id) {
  const it = await api("GET", `/api/impresiones/${encodeURIComponent(id)}`);
  await loadRegisters([FICHA_REG]);
  const ficha = it.ficha || {};
  const titulo = ficha.titulo || printName(it);
  const partes = asArray(ficha.partes).filter((p) => !isEmpty(p?.nombre));
  const preguntas = asArray(ficha.preguntas).filter((q) => !isEmpty(q?.etiqueta));
  // Sin ficha todavía: directamente a configurarla
  if (!partes.length && !preguntas.length && !ficha.descripcion) {
    location.replace(`#/ficha/${encodeURIComponent(id)}?editar`);
    return;
  }
  // Todos los filamentos para elegir y, en la carta de colores, solo los que tienen color
  const todos = fichaFilaments();
  const filamentos = todos.filter((f) => !isEmpty(f.color) || isHexColor(f.colorHex));
  const filById = Object.fromEntries((REGS[FICHA_REG] || []).map((f) => [f.id, f]));

  // Respuestas en curso (solo en esta pestaña del navegador)
  const KEY = `ficha:${id}`;
  let st = null;
  try { st = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { /* sin almacenamiento */ }
  const firma = JSON.stringify([partes.map((p) => p.nombre), preguntas.map((q) => q.etiqueta)]);
  if (st?.firma !== firma) st = null;
  st ??= { firma, partes: partes.map((p) => p.filamento || ""), datos: preguntas.map(() => ""), cliente: {}, foto: 0, paleta: true, verCliente: true };
  // Partes o datos añadidos después: el color propuesto y la respuesta vacía
  partes.forEach((p, i) => { if (st.partes[i] === undefined) st.partes[i] = p.filamento || ""; });
  preguntas.forEach((q, i) => { if (st.datos[i] === undefined) st.datos[i] = ""; });
  const persist = () => { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch { /* sin almacenamiento */ } };

  // En la carta: tipo y línea, sin repetir el color si el nombre ya lo lleva («PLA Basic Rojo» → «PLA Basic»)
  const paletteDetail = (f) => {
    const nombre = String(f.nombre || "").trim();
    const color = String(f.color || "").trim();
    const linea = color && nombre.toLowerCase().endsWith(` ${color.toLowerCase()}`)
      ? nombre.slice(0, -(color.length + 1)).trim() : nombre;
    return [f.tipo, linea].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(" · ");
  };
  const label = fichaLabel;
  const sw = (f) => (f && isHexColor(f.colorHex) ? swatch(f.colorHex) : "");
  const LINE = '<span class="blank-line"></span>';
  const BOX = '<span class="blank-box"></span>';
  const opciones = (q) => String(q.opciones || "").split(",").map((x) => x.trim()).filter(Boolean);
  const fecha = new Date().toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });

  /** Cómo se imprime un dato sin rellenar: líneas, casillas o fecha. */
  const blankFor = (q) => {
    switch (q.tipo) {
      case "Texto largo": return `${LINE}${LINE}${LINE}`;
      case "Opciones": return `<span class="blank-options">${opciones(q).map((o) => `${BOX} ${esc(o)}`).join("&emsp;")}</span>`;
      case "Sí / No": return `<span class="blank-options">${BOX} Sí&emsp;${BOX} No</span>`;
      case "Fecha": return `<span class="blank-date">____ / ____ / ________</span>`;
      default: return LINE;
    }
  };
  /** Versión impresa de una respuesta (o su hueco en blanco si está vacía). */
  const fillFor = (q, v) => {
    const shown = q.tipo === "Fecha" && v ? fmtDate(v) : v;
    return isEmpty(shown) ? blankFor(q) : `<span class="pre">${esc(shown)}</span>`;
  };
  const parteFill = (f) => (f ? `${sw(f)} ${esc(label(f))}` : LINE);

  /** Entrada en pantalla + versión impresa (rellena o en blanco) de cada dato. */
  const answer = (q, i) => {
    const v = st.datos[i] ?? "";
    const path = `d${i}`;
    const sel = (opts) => `<select data-ans="${path}"><option value=""></option>${opts.map((o) =>
      `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    const input = {
      "Texto largo": `<textarea data-ans="${path}" rows="3">${esc(v)}</textarea>`,
      "Opciones": sel(opciones(q)),
      "Sí / No": sel(["Sí", "No"]),
      "Número": `<input type="number" data-ans="${path}" value="${esc(v)}">`,
      "Fecha": `<input type="date" data-ans="${path}" value="${esc(v)}">`,
    }[q.tipo] || `<input type="text" data-ans="${path}" value="${esc(v)}">`;
    return `<div class="sheet-row"><div class="sheet-label">${esc(q.etiqueta)}</div>
      <div class="sheet-value"><span class="no-print">${input}</span>
        <span class="ans-fill print-only">${fillFor(q, v)}</span>
        <span class="ans-blank print-only">${blankFor(q)}</span></div></div>`;
  };

  const parteRow = (p, i) => {
    const sel = filById[st.partes[i]];
    return `<tr><td class="sheet-label">${esc(p.nombre)}</td>
      <td class="sheet-value">
        <span class="no-print"><select data-ans="p${i}"><option value="">— Sin elegir —</option>
          ${todos.map((f) => `<option value="${esc(f.id)}" ${f.id === st.partes[i] ? "selected" : ""}>${esc(label(f))}</option>`).join("")}
        </select> <span class="sel-sw">${sw(sel)}</span></span>
        <span class="ans-fill print-only">${parteFill(sel)}</span>
        <span class="ans-blank print-only">${LINE}</span></td></tr>`;
  };

  const render = () => {
    const foto = it.fotos[st.foto] || it.fotos[0];
    const clienteField = (k, lbl, type = "text") => `<div class="sheet-row"><div class="sheet-label">${lbl}</div>
      <div class="sheet-value"><span class="no-print"><input type="${type}" data-cli="${k}" value="${esc(st.cliente[k] || "")}"></span>
      <span class="ans-fill print-only">${isEmpty(st.cliente[k]) ? LINE : esc(type === "date" ? fmtDate(st.cliente[k]) : st.cliente[k])}</span>
      <span class="ans-blank print-only">${LINE}</span></div></div>`;

    app.innerHTML = `
      <div class="report-toolbar no-print">
        <a class="back" href="#/i/${esc(it.id)}">← Volver a la impresión</a>
        <div class="report-actions">
          <label class="check"><input type="checkbox" id="opt-cliente" ${st.verCliente ? "checked" : ""}> Datos del cliente</label>
          <label class="check"><input type="checkbox" id="opt-paleta" ${st.paleta ? "checked" : ""}> Carta de colores</label>
          <a class="btn" href="#/ficha/${esc(it.id)}?editar">Configurar ficha</a>
          <button class="btn" id="pdf-blank" title="Para enviar al cliente: con líneas en blanco">PDF en blanco</button>
          <button class="btn btn-primary" id="pdf-fill" title="Con lo rellenado aquí">PDF con respuestas</button>
        </div>
      </div>

      <article class="client-sheet card card-pad">
        <header class="sheet-head">
          <div class="report-brand">Impresiones 3D · Ficha de pedido</div>
          <h1>${esc(titulo)}</h1>
          <p class="muted">${esc(fecha)}</p>
        </header>

        ${foto ? `<figure class="sheet-photo"><img src="${photoUrl(it.id, foto)}" alt="Foto de referencia">
          <figcaption class="muted small">Foto de referencia</figcaption></figure>
          ${it.fotos.length > 1 ? `<div class="sheet-thumbs no-print">${it.fotos.map((f, i) => `
            <button type="button" data-foto="${i}" class="${f === foto ? "active" : ""}"><img src="${photoUrl(it.id, f)}" alt=""></button>`).join("")}
            <span class="muted small">Foto que aparece en la ficha</span></div>` : ""}` : ""}

        ${ficha.descripcion ? `<p class="sheet-text pre">${esc(ficha.descripcion)}</p>` : ""}

        ${st.verCliente ? `<section class="sheet-section"><h2>Datos del cliente</h2>
          ${clienteField("nombre", "Nombre")}${clienteField("contacto", "Teléfono / e-mail")}${clienteField("fecha", "Fecha de entrega deseada", "date")}
        </section>` : ""}

        ${partes.length ? `<section class="sheet-section"><h2>Colores</h2>
          <table class="sheet-table"><tbody>${partes.map(parteRow).join("")}</tbody></table>
        </section>` : ""}

        ${preguntas.length ? `<section class="sheet-section"><h2>Datos de la pieza</h2>
          ${preguntas.map(answer).join("")}</section>` : ""}

        ${st.paleta && partes.length && filamentos.length ? `<section class="sheet-section sheet-palette"><h2>Colores disponibles</h2>
          <div class="palette">${filamentos.map((f) => `<div class="palette-item">${sw(f)}
            <span><strong>${esc(f.color || "")}</strong> <span class="muted">${esc(paletteDetail(f))}</span></span></div>`).join("")}</div>
        </section>` : ""}
      </article>
    `;

    // --- eventos
    app.querySelector(".client-sheet").addEventListener("input", onEdit);
    app.querySelector(".client-sheet").addEventListener("change", onEdit);
    app.querySelectorAll("[data-foto]").forEach((b) => (b.onclick = () => { st.foto = Number(b.dataset.foto); persist(); render(); }));
    document.getElementById("opt-paleta").onchange = (e) => { st.paleta = e.target.checked; persist(); render(); };
    document.getElementById("opt-cliente").onchange = (e) => { st.verCliente = e.target.checked; persist(); render(); };
    document.getElementById("pdf-fill").onclick = () => printAs(`Ficha - ${titulo}`);
    document.getElementById("pdf-blank").onclick = () => {
      document.body.classList.add("sheet-blank");
      window.addEventListener("afterprint", () => document.body.classList.remove("sheet-blank"), { once: true });
      printAs(`Ficha en blanco - ${titulo}`);
    };
  };

  /** Guarda la respuesta y actualiza solo su versión impresa (sin repintar, para no perder el foco). */
  const onEdit = (e) => {
    const el = e.target;
    const fill = el.closest(".sheet-row, tr")?.querySelector(".ans-fill");
    if (el.dataset.ans) {
      const i = Number(el.dataset.ans.slice(1));
      if (el.dataset.ans[0] === "p") {
        st.partes[i] = el.value;
        const f = filById[el.value];
        el.parentElement.querySelector(".sel-sw").innerHTML = sw(f);
        if (fill) fill.innerHTML = parteFill(f);
      } else {
        st.datos[i] = el.value;
        if (fill) fill.innerHTML = fillFor(preguntas[i], el.value);
      }
    } else if (el.dataset.cli) {
      st.cliente[el.dataset.cli] = el.value;
      const v = el.type === "date" && el.value ? fmtDate(el.value) : el.value;
      if (fill) fill.innerHTML = isEmpty(v) ? LINE : esc(v);
    } else return;
    persist();
  };

  render();
}

// ======================================================= CONFIGURAR LA FICHA

/** Pantalla propia para definir la ficha de una impresión (título, texto, partes y datos a pedir). */
async function editClientSheet(id) {
  const it = await api("GET", `/api/impresiones/${encodeURIComponent(id)}`);
  await loadRegisters([FICHA_REG]);
  const draft = clone(it.ficha || {});
  draft.partes = asArray(draft.partes);
  draft.preguntas = asArray(draft.preguntas);
  const filamentos = fichaFilaments();
  const filById = Object.fromEntries(filamentos.map((f) => [f.id, f]));
  const isNew = !it.ficha;
  formDirty = false;

  const filSelect = (value, i) => `<select data-k="partes.${i}.filamento"><option value="">— Sin color propuesto —</option>
    ${filamentos.map((f) => `<option value="${esc(f.id)}" ${f.id === value ? "selected" : ""}>${esc(fichaLabel(f))}</option>`).join("")}</select>`;
  const moveBtns = (list, i, n) => `<span class="order-btns">
    <button type="button" class="btn btn-sm btn-ghost" data-move="${list}" data-i="${i}" data-d="-1" ${i === 0 ? "disabled" : ""} title="Subir">↑</button>
    <button type="button" class="btn btn-sm btn-ghost" data-move="${list}" data-i="${i}" data-d="1" ${i === n - 1 ? "disabled" : ""} title="Bajar">↓</button>
    <button type="button" class="btn btn-sm btn-ghost btn-danger" data-rm="${list}" data-i="${i}" title="Quitar">×</button></span>`;

  const render = () => {
    app.innerHTML = `
      <a class="back" href="#/i/${esc(it.id)}">← Volver a la impresión</a>
      <div class="page-head">
        <div><h1>Ficha de «${esc(printName(it))}»</h1>
          <p class="muted" style="margin:4px 0 0">Qué hay que pedir al cliente al encargar esta pieza. Después podrás sacarla en PDF.</p></div>
        <div class="actions">
          ${isNew ? "" : `<a class="btn" href="#/ficha/${esc(it.id)}">Ver ficha</a>`}
          ${isNew ? "" : `<button class="btn btn-danger" id="f-del">Quitar ficha</button>`}
        </div>
      </div>
      <div id="ficha-root">
        <div class="card card-pad section">
          <h2>Presentación</h2>
          <div class="form-grid" style="margin-top:12px">
            <div class="field"><label>Título de la ficha</label>
              <input type="text" data-k="titulo" value="${esc(draft.titulo || "")}" placeholder="${esc(printName(it))}">
              <span class="help">Vacío = nombre de la impresión. P. ej.: «Contador para …»</span></div>
            <div class="field wide"><label>Texto para el cliente</label>
              <textarea data-k="descripcion" rows="3" placeholder="Explicación, plazo de entrega, precio orientativo…">${esc(draft.descripcion || "")}</textarea></div>
          </div>
        </div>

        <div class="card card-pad section">
          <div class="repeat-head"><h2>Colores: partes que elige el cliente</h2>
            <button type="button" class="btn btn-sm" id="f-proponer" title="Una parte por cada filamento de las placas">Proponer desde las placas</button></div>
          <p class="muted small" style="margin:0 0 10px">Cada parte de la pieza cuyo color elige el cliente. El color propuesto es opcional.</p>
          ${draft.partes.length ? `<div class="table-wrap"><table class="edit-table">
            <thead><tr><th>Parte</th><th>Color propuesto</th><th></th></tr></thead>
            <tbody>${draft.partes.map((p, i) => `<tr>
              <td><input type="text" data-k="partes.${i}.nombre" value="${esc(p.nombre || "")}" placeholder="P. ej.: Base"></td>
              <td><div class="color-pick">${filSelect(p.filamento, i)} <span class="sel-sw">${filById[p.filamento] && isHexColor(filById[p.filamento].colorHex) ? swatch(filById[p.filamento].colorHex) : ""}</span></div></td>
              <td class="order-col">${moveBtns("partes", i, draft.partes.length)}</td></tr>`).join("")}</tbody></table></div>`
            : `<p class="muted">Sin partes. Añádelas a mano o pulsa «Proponer desde las placas».</p>`}
          <button type="button" class="btn" data-add="partes" style="margin-top:10px">+ Añadir parte</button>
        </div>

        <div class="card card-pad section">
          <h2>Datos a pedir</h2>
          <p class="muted small" style="margin:4px 0 10px">P. ej. «Cartel: motivo del contador». Para «Opciones», escríbelas separadas por comas.</p>
          ${draft.preguntas.length ? `<div class="table-wrap"><table class="edit-table">
            <thead><tr><th>Dato</th><th>Tipo</th><th>Opciones</th><th></th></tr></thead>
            <tbody>${draft.preguntas.map((q, i) => `<tr>
              <td><input type="text" data-k="preguntas.${i}.etiqueta" value="${esc(q.etiqueta || "")}" placeholder="P. ej.: Nombre a grabar"></td>
              <td><select data-k="preguntas.${i}.tipo">${FICHA_TIPOS.map((t) => `<option ${t === (q.tipo || "Texto") ? "selected" : ""}>${t}</option>`).join("")}</select></td>
              <td><input type="text" data-k="preguntas.${i}.opciones" value="${esc(q.opciones || "")}" placeholder="A, B, C"
                ${q.tipo === "Opciones" ? "" : "disabled"}></td>
              <td class="order-col">${moveBtns("preguntas", i, draft.preguntas.length)}</td></tr>`).join("")}</tbody></table></div>`
            : `<p class="muted">Sin datos a pedir.</p>`}
          <button type="button" class="btn" data-add="preguntas" style="margin-top:10px">+ Añadir dato</button>
        </div>

        <div class="form-actions">
          <a class="btn" href="${isNew ? `#/i/${esc(it.id)}` : `#/ficha/${esc(it.id)}`}" id="f-cancel">Cancelar</a>
          <button class="btn btn-primary" id="f-save">Guardar ficha</button>
        </div>
      </div>
    `;
    bind();
  };

  const bind = () => {
    const root = document.getElementById("ficha-root");
    const onEdit = (e) => {
      const k = e.target.dataset?.k;
      if (!k) return;
      const [a, i, b] = k.split(".");
      const v = e.target.value;
      if (b) draft[a][Number(i)][b] = v; else draft[a] = v;
      formDirty = true;
      if (b === "filamento") {
        const f = filById[v];
        e.target.parentElement.querySelector(".sel-sw").innerHTML = f && isHexColor(f.colorHex) ? swatch(f.colorHex) : "";
      }
      if (b === "tipo" && e.type === "change") render(); // activa o desactiva «Opciones»
    };
    root.addEventListener("input", onEdit);
    root.addEventListener("change", onEdit);
    root.querySelectorAll("[data-add]").forEach((btn) => (btn.onclick = () => {
      draft[btn.dataset.add].push(btn.dataset.add === "preguntas" ? { tipo: "Texto" } : {});
      formDirty = true;
      render();
      const rows = document.querySelectorAll(`[data-k^="${btn.dataset.add}."]`);
      [...rows].filter((x) => x.tagName === "INPUT").pop()?.focus();
    }));
    root.querySelectorAll("[data-move]").forEach((btn) => (btn.onclick = () => {
      const list = draft[btn.dataset.move], i = Number(btn.dataset.i), j = i + Number(btn.dataset.d);
      [list[i], list[j]] = [list[j], list[i]];
      formDirty = true;
      render();
    }));
    root.querySelectorAll("[data-rm]").forEach((btn) => (btn.onclick = () => {
      draft[btn.dataset.rm].splice(Number(btn.dataset.i), 1);
      formDirty = true;
      render();
    }));
    document.getElementById("f-proponer").onclick = () => {
      // Una parte por cada filamento de cada placa, con su color como propuesta
      const existentes = new Set(draft.partes.map((p) => String(p.nombre || "").toLowerCase()));
      let n = 0;
      asArray(it.placas).forEach((placa, i) => {
        const subs = asArray(placa?.filamentos).filter((x) => x && (x.filamento || x.gramosModelo));
        subs.forEach((sub, j) => {
          const base = placa.nombre || `Placa ${i + 1}`;
          const nombre = subs.length > 1 ? `${base} ${j + 1}` : base;
          if (existentes.has(nombre.toLowerCase())) return;
          draft.partes.push({ nombre, ...(sub.filamento ? { filamento: sub.filamento } : {}) });
          n++;
        });
      });
      toast(n ? `${n} parte(s) añadida(s): cámbiales el nombre por uno que entienda el cliente`
        : "No hay placas con filamentos nuevos que añadir");
      if (n) { formDirty = true; render(); }
    };
    document.getElementById("f-cancel").onclick = (e) => {
      if (formDirty && !confirm("Hay cambios sin guardar. ¿Descartarlos?")) e.preventDefault(); else formDirty = false;
    };
    document.getElementById("f-save").onclick = () => save();
    document.getElementById("f-del")?.addEventListener("click", async () => {
      if (!confirm("¿Quitar la ficha de esta impresión?\n\nLa impresión no cambia; solo se borra la definición de la ficha.")) return;
      await persist(null);
      toast("Ficha quitada");
      location.hash = `#/i/${it.id}`;
    });
  };

  /** Guarda la ficha en la impresión (leyendo antes la versión actual para no pisar otros cambios). */
  const persist = async (ficha) => {
    const actual = await api("GET", `/api/impresiones/${encodeURIComponent(id)}`);
    delete actual.fotos;
    if (ficha) actual.ficha = ficha; else delete actual.ficha;
    await api("PUT", `/api/impresiones/${encodeURIComponent(id)}`, actual);
    formDirty = false;
  };

  const save = async () => {
    const ficha = {
      ...(isEmpty(draft.titulo?.trim()) ? {} : { titulo: draft.titulo.trim() }),
      ...(isEmpty(draft.descripcion?.trim()) ? {} : { descripcion: draft.descripcion.trim() }),
      partes: draft.partes.filter((p) => !isEmpty(p.nombre?.trim()))
        .map((p) => ({ nombre: p.nombre.trim(), ...(p.filamento ? { filamento: p.filamento } : {}) })),
      preguntas: draft.preguntas.filter((q) => !isEmpty(q.etiqueta?.trim()))
        .map((q) => ({ etiqueta: q.etiqueta.trim(), tipo: q.tipo || "Texto",
          ...(q.tipo === "Opciones" && !isEmpty(q.opciones?.trim()) ? { opciones: q.opciones.trim() } : {}) })),
    };
    if (!ficha.partes.length && !ficha.preguntas.length && !ficha.descripcion) {
      return toast("Añade al menos una parte, un dato a pedir o un texto para el cliente", true);
    }
    try {
      await persist(ficha);
      toast("Ficha guardada");
      location.hash = `#/ficha/${it.id}`;
    } catch (err) { toast(err.message, true); }
  };

  render();
}
