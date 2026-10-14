"use strict";

/* ===================================================================
   Configuración general: copias de seguridad y costes reales.
   Se guarda en data/ajustes.json (vía /api/ajustes).
   Usa las utilidades de app.js (api, esc, toast, fmtValue…).
   =================================================================== */

async function viewSettings() {
  const [ajustes, copias, gastos] = await Promise.all([
    api("GET", "/api/ajustes"),
    api("GET", "/api/copias").catch((err) => ({ error: err.message, copias: [] })),
    (CONFIG.registros || []).some((r) => r.id === "gastos") ? api("GET", "/api/registros/gastos") : [],
  ]);
  const draft = { copias: { ...ajustes.copias }, costes: { ...ajustes.costes } };
  const money = (v, unit = "") => fmtValue({ tipo: "moneda", unidad: unit }, v);
  const bytes = (n) => (n >= 1048576 ? `${numFmt.format(n / 1048576)} MB` : `${numFmt.format(Math.ceil(n / 1024))} KB`);
  const when = (iso) => new Date(iso).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" });

  // Compra de la impresora registrada en Gastos (para proponer su precio)
  const compra = asArray(gastos).filter((g) => /impresora/i.test(g.tipo || "") && Number(g.precio) > 0)
    .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""))[0];

  const num = (path, value, { step = "any", unit = "", placeholder = "" } = {}) => `
    <div class="with-unit"><input type="number" min="0" step="${step}" data-set="${path}" value="${esc(value ?? "")}"
      placeholder="${esc(placeholder)}" inputmode="decimal">${unit ? `<span>${esc(unit)}</span>` : ""}</div>`;

  app.innerHTML = `<div id="settings-root">
    <div class="page-head"><div><h1>Configuración</h1>
      <p class="muted" style="margin:4px 0 0">Ajustes generales de la aplicación. Se guardan en <code>data/ajustes.json</code>.</p></div></div>

    <div class="card card-pad section">
      <h2>Copias de seguridad</h2>
      <p class="muted note">Cada copia es un .zip con todos tus datos (impresiones, fotos, filamentos, gastos, ventas, catálogos)
        y la configuración de campos.</p>
      <div class="form-grid">
        <div class="field wide">
          <label for="s-carpeta">Carpeta de las copias</label>
          <input type="text" id="s-carpeta" data-set="copias.carpeta" value="${esc(draft.copias.carpeta)}"
            placeholder="${esc(ajustes.carpetaPorDefecto)}" spellcheck="false">
          <span class="help">Vacío = carpeta <code>copias</code> de la aplicación. Recomendado: una carpeta sincronizada en la nube
            (p. ej. Movistar Cloud, OneDrive, Google Drive) para no perderlas si falla el disco.</span>
        </div>
        <div class="field">
          <label>Copias a conservar</label>
          ${num("copias.conservar", draft.copias.conservar, { step: 1 })}
          <span class="help">Al superarlas se borran las más antiguas.</span>
        </div>
        <div class="field">
          <span class="label">Copia automática</span>
          <label class="check"><input type="checkbox" data-set="copias.automatica" ${draft.copias.automatica ? "checked" : ""}>
            Al arrancar la app (una al día como máximo)</label>
        </div>
      </div>
      <div class="editor-actions">
        <button class="btn" id="backup-now">Hacer copia ahora</button>
        <button class="btn" id="backup-open">Abrir carpeta</button>
      </div>
      <div id="backup-list" style="margin-top:14px"></div>
    </div>

    <div class="card card-pad section">
      <div class="repeat-head"><h2>Costes reales</h2>
        <label class="check switch"><input type="checkbox" data-set="costes.activo" ${draft.costes.activo ? "checked" : ""}>
          <strong>Calcular el coste real</strong></label></div>
      <p class="muted note">Además del material y los accesorios, suma a cada impresión la electricidad y la amortización de las
        máquinas usadas en cada placa, y la mano de obra (postprocesado y diseño). Los datos que dejes vacíos no se aplican.</p>
      <div id="costes-body">
        <div class="settings-grid">
          <div class="settings-block">
            <h3>Electricidad</h3>
            <div class="form-grid">
              <div class="field"><label>Precio de la electricidad</label>${num("costes.precioKWh", draft.costes.precioKWh, { unit: "€/kWh", placeholder: "0,20" })}
                <span class="help">Mira tu factura (término de energía). El consumo de cada máquina se indica en el catálogo.</span></div>
            </div>
          </div>
          <div class="settings-block">
            <h3>Postprocesado</h3>
            <div class="form-grid">
              <div class="field"><label>Coste por hora</label>${num("costes.postprocesadoHora", draft.costes.postprocesadoHora, { unit: "€/h" })}
                <span class="help">Pintura, montaje, lijado, acabados. Se aplica al tiempo de pintura y al de montaje de cada impresión.</span></div>
            </div>
          </div>
          <div class="settings-block">
            <h3>Diseño</h3>
            <div class="form-grid">
              <div class="field"><label>Coste por hora</label>${num("costes.disenoHora", draft.costes.disenoHora, { unit: "€/h" })}
                <span class="help">Se aplica al tiempo de diseño de cada impresión.</span></div>
            </div>
          </div>
        </div>
        <div class="settings-block" style="margin-top:14px">
          <h3>Máquinas</h3>
          <p class="muted small" style="margin:0 0 8px">Electricidad y amortización por hora de uso de cada máquina. Se aplican a cada placa
            según la máquina elegida. Consumo, precio y vida útil se editan en <a href="#/catalogos">Catálogos → Máquinas</a>.</p>
          <div id="machines"></div>
        </div>
      </div>
    </div>

    <div class="form-actions">
      <button class="btn btn-primary" id="settings-save">Guardar configuración</button>
    </div>
  </div>`;
  const root = document.getElementById("settings-root");

  // --- vista previa: coste por hora de cada máquina
  const updateRates = () => {
    const c = draft.costes;
    const maquinas = CATALOGS.maquinas || [];
    const rows = maquinas.map((m) => {
      const luz = Number(m.consumoW) > 0 && Number(c.precioKWh) > 0 ? (m.consumoW / 1000) * c.precioKWh : null;
      const amort = Number(m.precio) > 0 && Number(m.vidaUtilHoras) > 0 ? m.precio / m.vidaUtilHoras : null;
      return { m, luz, amort, total: (luz || 0) + (amort || 0) };
    });
    const cell = (v) => (v === null ? '<span class="muted">—</span>' : esc(money(v, "/h")));
    document.getElementById("machines").innerHTML = maquinas.length ? `<div class="table-wrap"><table class="report-table">
      <thead><tr><th>Máquina</th><th>Tipo</th><th class="num">Electricidad</th><th class="num">Amortización</th><th class="num">Total por hora</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><strong>${esc(r.m.nombre)}</strong></td><td>${esc(r.m.tipo || "")}</td>
        <td class="num">${cell(r.luz)}${r.luz === null ? ' <span class="muted small">(falta consumo)</span>' : ""}</td>
        <td class="num">${cell(r.amort)}${r.amort === null ? ' <span class="muted small">(falta precio o vida útil)</span>' : ""}</td>
        <td class="num"><strong>${r.total ? esc(money(r.total, "/h")) : "—"}</strong></td></tr>`).join("")}</tbody></table></div>
      ${compra && !maquinas.some((m) => Number(m.precio) > 0) ? `<p class="muted small">Tienes registrada en Gastos la compra
        «${esc(compra.nombre || "")}» por ${esc(money(compra.precio))}: puedes usarla como precio en el catálogo.</p>` : ""}`
      : '<p class="muted">No hay máquinas en el catálogo.</p>';
    document.getElementById("costes-body").classList.toggle("disabled", !c.activo);
  };

  // --- lista de copias
  const renderBackups = (data) => {
    const el = document.getElementById("backup-list");
    if (data.error) { el.innerHTML = `<p class="neg">${esc(data.error)}</p>`; return; }
    el.innerHTML = `<p class="muted small">Carpeta actual: <span class="path">${esc(data.carpeta)}</span></p>
      ${data.copias.length ? `<div class="table-wrap"><table class="report-table">
        <thead><tr><th>Fecha</th><th>Fichero</th><th class="num">Tamaño</th></tr></thead>
        <tbody>${data.copias.slice(0, 10).map((b) => `<tr><td>${esc(when(b.fecha))}</td><td class="path">${esc(b.nombre)}</td>
          <td class="num">${esc(bytes(b.bytes))}</td></tr>`).join("")}</tbody></table></div>
        ${data.copias.length > 10 ? `<p class="muted small">… y ${data.copias.length - 10} más.</p>` : ""}`
      : `<p class="muted">Todavía no hay copias en esta carpeta.</p>`}`;
  };
  renderBackups(copias);
  updateRates();

  // --- edición
  formDirty = false;
  const set = (path, value) => {
    const [sec, key] = path.split(".");
    draft[sec][key] = value;
    formDirty = true;
    document.getElementById("settings-save").classList.add("pending");
    updateRates();
  };
  const onEdit = (e) => {
    const el = e.target.closest?.("[data-set]");
    if (!el) return;
    if (el.type === "checkbox") set(el.dataset.set, el.checked);
    else if (el.type === "number") set(el.dataset.set, el.value === "" ? null : Number(el.value));
    else set(el.dataset.set, el.value);
  };
  root.addEventListener("input", onEdit);
  root.addEventListener("change", onEdit);

  const save = async () => {
    const saved = await api("PUT", "/api/ajustes", draft);
    AJUSTES = saved;
    formDirty = false;
    document.getElementById("settings-save").classList.remove("pending");
    return saved;
  };

  document.getElementById("settings-save").addEventListener("click", async () => {
    try {
      await save();
      renderBackups(await api("GET", "/api/copias").catch((err) => ({ error: err.message, copias: [] })));
      toast("Configuración guardada");
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById("backup-now").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      if (formDirty) await save(); // la copia usa la carpeta y el número de copias indicados
      btn.disabled = true; btn.textContent = "Copiando…";
      const r = await api("POST", "/api/copias");
      renderBackups(await api("GET", "/api/copias"));
      toast(`Copia creada: ${r.nombre}`);
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; btn.textContent = "Hacer copia ahora"; }
  });

  document.getElementById("backup-open").addEventListener("click", async () => {
    try {
      if (formDirty) await save();
      await api("POST", "/api/copias/abrir");
    } catch (err) { toast(err.message, true); }
  });
}
