/* ═══════════════════════════════════════════════════════════════════════════
   Quartz — el Diario de Fran
   Nació adentro de UmbroSys (1.20.0, 1/11/2026: diseño de Fran con Sam, la
   variante híbrida) y se mudó a esta app suelta el 2/11/2026. Las notas son
   los .md de S:\Diario (src/diario.cjs): esta ventana es solo la cara. Desde
   UmbroSys 1.101.0 (22/11/2026) UmbroSys tiene su propio diario aparte: esta
   carpeta es solo de Quartz. CC las lee y escribe por el servidor MCP
   (mcp/diario.cjs), y lo de afuera entra solo.

   Tres hojas: a la izquierda la lista por fecha (con la
   búsqueda arriba), en el medio la nota (para leer o para escribir) y a la
   derecha quién la nombra (backlinks) y su grafo chico. El grafo grande
   reemplaza a la nota (Ctrl+G).

   Atajos: Ctrl+N nota nueva · Ctrl+D la de hoy · Ctrl+K buscar o saltar a una
   nota · Ctrl+E leer o escribir · Ctrl+G el grafo · Ctrl+S guardar ya. Al
   escribir [[ aparece un menú con los títulos: Enter o Tab completa.

   Seleccionar (el botón de la casilla, 0.6.0): la lista pasa a elegir. Cada
   fila muestra su casilla en el lugar del número del día; clic elige o
   suelta, Shift+clic elige el tramo, Ctrl+A todas las que se ven, Supr las
   manda a la papelera y Esc sale. Arriba, la barra de búsqueda se releva por
   la de la selección, en la misma celda.

   Se guarda sola. Si CC sumó algo al final mientras escribías, se juntan las
   dos cosas; si cambió otra parte, queda lo tuyo y lo de él en las versiones
   (.diario/versiones): nunca se pierde nada.
   ═══════════════════════════════════════════════════════════════════════════ */

import { esc, empty, attempt } from '../ui.js';
import { Icons } from '../icons.js';
import { Menu, Modal, Toast } from '../overlays.js';
import { reconcile, swap, frase, initScrollFades } from '../motion.js';
import { md } from '../md.js';
import { cargarPrism, resaltar } from '../resaltar.js';
import { crearGrafo } from './grafo.js';

const api = window.opal?.diario;
Icons.add({
  // el grafo: tres puntos unidos
  grafo: '<circle cx="4" cy="4.2" r="1.7"/><circle cx="12" cy="6" r="1.7"/><circle cx="6.4" cy="12" r="1.7"/><path d="M5.6 4.6 10.4 5.6M11.1 7.4 7.3 10.6M4.6 5.9l1.2 4.4"/>',
  // seleccionar: una casilla con su tilde
  elegir: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.6"/><path d="M5.4 8.1 7.2 9.9 10.7 6.1"/>',
});

const clave = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
// «hoy» o «today»: en la búsqueda, en un [[ ]] y en abrir() llevan a la nota de hoy
const HOY = new Set(['hoy', 'today']);
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
const dos = (n) => String(n).padStart(2, '0');
const hoyEs = () => { const d = new Date(); return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`; };
const sinFrontmatter = (t) => String(t || '').replace(/^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '').replace(/^\n+/, '');

/* Cómo se nombra una fecha: «hoy», «ayer», «sábado 1 de noviembre» (con el año si no es este). */
function nombreDia(f, { largo = true } = {}) {
  if (!esFecha(f)) return f;
  const hoy = hoyEs();
  const d = new Date(`${f}T12:00:00`);
  const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
  if (f === hoy) return largo ? `Today, ${d.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })}` : 'today';
  if (f === `${ayer.getFullYear()}-${dos(ayer.getMonth() + 1)}-${dos(ayer.getDate())}`) return largo ? `Yesterday, ${d.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })}` : 'yesterday';
  const o = largo ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  const t = d.toLocaleDateString('en-US', o).replace('.', '');
  return largo ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
const tituloDe = (n) => (n.dia ? nombreDia(n.dia) : n.titulo);

/* La edad de una nota, de 0 (hoy) a 1 (un año o más), en escala logarítmica: entre
   ayer y hace una semana se nota más que entre marzo y abril. Con esto la tinta de la
   lista se apaga de a poco (vitra.css, «la tinta que envejece»). */
function edadDe(f) {
  if (!esFecha(f)) return 0;
  const dias = Math.max(0, (Date.now() - new Date(`${f}T12:00:00`)) / 86400e3);
  return Math.min(1, Math.log1p(dias) / Math.log1p(365));
}
/** El mismo día del año pasado (el 29 de febrero cae en el 28). */
function haceUnAnio() {
  const d = new Date();
  const a = new Date(d.getFullYear() - 1, d.getMonth(), d.getDate());
  if (a.getMonth() !== d.getMonth()) a.setDate(0);
  return `${a.getFullYear()}-${dos(a.getMonth() + 1)}-${dos(a.getDate())}`;
}

/**
 * Arma el Diario adentro de `raiz` (el cuerpo de su ventana).
 * @param {{ menuExtra?: () => object[] }} [opciones]  menuExtra: ítems de la app para el menú «Más»
 * @returns {{ alEnfocar(): void, alAjustar(): void, abrir(ref: string): void, destruir(): void }}
 */
export function montarDiario(raiz, { menuExtra = null } = {}) {
  raiz.classList.add('vt-diario');
  raiz.innerHTML = `
    <aside class="vt-diario__lado">
      <div class="vt-diario__barras">
        <div class="vt-diario__barra vt-diario__barra--normal">
          <div class="op-inputwrap vt-diario__buscar">${Icons.svg('search')}<input class="op-input" type="search" placeholder="Search or jump to" spellcheck="false" aria-label="Search the journal"></div>
          <button type="button" class="op-iconbtn op-iconbtn--sm" data-accion="elegir" aria-label="Select notes" data-tip="Select notes">${Icons.svg('elegir')}</button>
          <button type="button" class="op-iconbtn op-iconbtn--sm" data-accion="hoy" aria-label="Today's note" data-tip="Today's note (Ctrl+D)">${Icons.svg('calendar')}</button>
          <button type="button" class="op-iconbtn op-iconbtn--sm" data-accion="nueva" aria-label="New note" data-tip="New note (Ctrl+N)">${Icons.svg('plus')}</button>
        </div>
        <div class="vt-diario__barra vt-diario__barra--sel" inert>
          <button type="button" class="op-iconbtn op-iconbtn--sm" data-accion="sel-salir" aria-label="Stop selecting" data-tip="Done (Esc)">${Icons.svg('close')}</button>
          <span class="vt-diario__selcuenta" aria-live="polite"></span>
          <button type="button" class="op-btn op-btn--ghost op-btn--sm" data-accion="sel-todas" data-tip="Ctrl+A"><span class="vt-diario__seltodas"></span></button>
          <button type="button" class="op-btn op-btn--danger op-btn--sm" data-accion="sel-papelera" data-tip="Del" disabled>${Icons.svg('trash')}<span>Trash</span></button>
        </div>
      </div>
      <div class="vt-diario__lista op-scroll" role="listbox" aria-label="Notes" tabindex="-1"></div>
    </aside>
    <section class="vt-diario__hoja">
      <header class="vt-diario__cab">
        <div class="vt-diario__cabtxt">
          <h2 class="vt-diario__titulo"></h2>
          <div class="vt-diario__meta"></div>
        </div>
        <span class="vt-diario__estado" aria-live="polite"></span>
        <div class="vt-diario__acciones">
          <button type="button" class="op-iconbtn op-iconbtn--sm op-iconswap vt-diario__modo" data-accion="modo" aria-label="Write" data-tip="Write (Ctrl+E)">${Icons.svg('edit')}${Icons.svg('eye')}</button>
          <button type="button" class="op-iconbtn op-iconbtn--sm" data-accion="grafo" aria-label="Graph" data-tip="Graph (Ctrl+G)">${Icons.svg('grafo')}</button>
          <button type="button" class="op-iconbtn op-iconbtn--sm" data-accion="mas" aria-label="More" data-tip="More">${Icons.svg('more')}</button>
        </div>
      </header>
      <div class="vt-diario__cuerpo">
        <div class="vt-diario__leer op-scroll" tabindex="-1"><div class="vt-md"></div></div>
        <textarea class="vt-diario__editor op-scroll" spellcheck="false" aria-label="Note" placeholder="Write… Type [[ to link another note."></textarea>
        <div class="vt-diario__sugerir" role="listbox" aria-label="Notes to link"></div>
        <div class="vt-diario__grande"></div>
        <div class="vt-diario__vacio"></div>
      </div>
    </section>
    <aside class="vt-diario__panel">
      <div class="vt-diario__sec vt-diario__anio">
        <div><div class="vt-diario__sectit">A year ago today</div><div class="vt-diario__aniocuerpo"></div></div>
      </div>
      <div class="vt-diario__sec">
        <div class="vt-diario__sectit">Linked from <span class="vt-diario__cuenta"></span></div>
        <div class="vt-diario__back op-scroll"></div>
      </div>
      <div class="vt-diario__sec vt-diario__sec--grafo">
        <div class="vt-diario__sectit">Nearby</div>
        <div class="vt-diario__mini"></div>
      </div>
    </aside>`;
  const $ = (s) => raiz.querySelector(s);
  const buscar = $('.vt-diario__buscar input');
  const lista = $('.vt-diario__lista');
  const hoja = $('.vt-diario__hoja');
  const titulo = $('.vt-diario__titulo');
  const metaEl = $('.vt-diario__meta');
  const estado = $('.vt-diario__estado');
  const leer = $('.vt-diario__leer');
  const leerMd = leer.querySelector('.vt-md');
  const editor = $('.vt-diario__editor');
  const sugerir = $('.vt-diario__sugerir');
  const vacio = $('.vt-diario__vacio');
  const back = $('.vt-diario__back');
  const cuentaBack = $('.vt-diario__cuenta');
  const modoBtn = $('.vt-diario__modo');
  const anio = $('.vt-diario__anio');
  const anioCuerpo = $('.vt-diario__aniocuerpo');
  const lado = $('.vt-diario__lado');
  const barraNormal = $('.vt-diario__barra--normal');
  const barraSel = $('.vt-diario__barra--sel');
  const selCuenta = $('.vt-diario__selcuenta');
  const selTodas = $('.vt-diario__seltodas');
  const selPapelera = $('[data-accion="sel-papelera"]');

  let notas = [];                 // las metas, de la más nueva a la más vieja
  let existen = new Set();        // claves de títulos (y fechas) que existen, para los [[ ]]
  let grafo = { nodos: [], aristas: [] };
  /** La nota abierta: { id, titulo, dia, fecha, etiquetas, hash, base } (base: el texto de ese hash). */
  let actual = null;
  let modo = 'leer';              // 'leer' | 'escribir'
  let enGrafo = false;
  let q = '', resultados = null, creando = false;
  let sucio = false, tGuardar = 0, guardando = null;
  let pintadoVacio = null;
  let vivo = true;
  let armada = false, ultimaTecla = 0;   // la hora de la próxima entrada (ver «La hora de cada entrada»)
  let eligiendo = false;          // la lista está en modo seleccionar
  const elegidas = new Set();     // los ids elegidos
  let ancla = null;               // la última que se tocó, para Shift+clic

  const mini = crearGrafo($('.vt-diario__mini'), { chico: true, alElegir: (n) => elegirDelGrafo(n) });
  let grande = null;

  /* ── Lo que hay ──────────────────────────────────────────────────────── */
  async function refrescar() {
    if (!api) return;
    const [l, g] = await Promise.all([api.listar().catch(() => null), api.grafo().catch(() => null)]);
    if (!vivo) return;
    if (l) {
      notas = l;
      existen = new Set(l.flatMap((n) => [clave(n.titulo), clave(n.id)]));
    }
    if (g) grafo = g;
    if (q) await correrBusqueda();
    // lo elegido que ya no está (se borró afuera, o recién se mandó a la papelera) se suelta
    for (const id of elegidas) if (!notas.some((n) => n.id === id)) elegidas.delete(id);
    pintarLista();
    pintarSel();
    pintarGrafos();
    pintarAnio();
    if (actual) pintarBack();
  }
  const existe = (t) => existen.has(clave(t)) || (HOY.has(clave(t)) && existen.has(hoyEs()));

  /* ── La lista ────────────────────────────────────────────────────────── */
  async function correrBusqueda() {
    resultados = q ? await api.buscar(q).catch(() => []) : null;
  }
  function pintarLista() {
    const items = [];
    if (resultados) {
      const exacta = resultados.some((r) => clave(r.titulo) === clave(q)) || (HOY.has(clave(q)) && existe('hoy'));
      for (const r of resultados) items.push({ key: `b:${r.id}`, html: itemHtml(r, r.fragmento) });
      if (!exacta && q.trim() && !eligiendo) {
        items.push({ key: 'crear', html: `<button type="button" class="vt-diario__item vt-diario__item--crear" role="option" data-crear="1">
          <span class="vt-diario__ico" aria-hidden="true">${Icons.svg('plus')}</span>
          <span class="vt-diario__txt"><span class="vt-diario__nom">Create “${esc(q.trim())}”</span><span class="vt-diario__res">Enter</span></span></button>` });
      }
      if (!items.length) items.push({ key: 'nada', html: '<p class="vt-diario__nada">Nothing here.</p>' });
    } else {
      let mes = '';
      for (const n of notas) {
        const m = n.fecha.slice(0, 7);
        if (m !== mes) {
          mes = m;
          const d = new Date(`${m}-15T12:00:00`);
          const t = d.toLocaleDateString('en-US', { month: 'long', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
          items.push({ key: `m:${m}`, html: `<div class="vt-diario__mes">${esc(t.charAt(0).toUpperCase() + t.slice(1))}</div>` });
        }
        items.push({ key: n.id, html: itemHtml(n, n.resumen) });
      }
    }
    reconcile(lista, items);
  }
  /* La casilla vive siempre adentro del ícono y lo de elegir va en atributos
     (clases y aria-selected): así reconcile() solo cambia atributos y todo lo
     lleva la transición del CSS, sin rehacer la fila. */
  function itemHtml(n, sub) {
    const activo = actual?.id === n.id;
    const elegida = eligiendo && elegidas.has(n.id);
    return `<button type="button" class="vt-diario__item${activo ? ' is-activo' : ''}${elegida ? ' is-elegida' : ''}${n.dia ? ' is-dia' : ''}" role="option" aria-selected="${eligiendo ? elegida : activo}" data-id="${esc(n.id)}" style="--vt-edad: ${edadDe(n.dia || n.fecha).toFixed(3)}">
      <span class="vt-diario__ico" aria-hidden="true">${n.dia ? `<b>${esc(String(Number(n.dia.slice(8))))}</b>` : Icons.svg('file')}<span class="vt-diario__casilla">${Icons.svg('check')}</span></span>
      <span class="vt-diario__txt">
        <span class="vt-diario__fila"><span class="vt-diario__nom">${esc(n.dia ? nombreDia(n.dia, { largo: true }).replace(/^(Today|Yesterday), /, '$1 · ') : n.titulo)}</span>${n.dia ? '' : `<span class="vt-diario__cuando">${esc(nombreDia(n.fecha, { largo: false }))}</span>`}</span>
        ${sub ? `<span class="vt-diario__res">${esc(sub)}</span>` : n.vacia ? '<span class="vt-diario__res is-vacia">empty</span>' : ''}
      </span>
    </button>`;
  }

  lista.addEventListener('click', (e) => {
    const b = e.target.closest('.vt-diario__item');
    if (!b) return;
    if (eligiendo) { if (b.dataset.id) tocar(b.dataset.id, e.shiftKey); return; }
    if (b.dataset.crear) crearNota(q.trim());
    else abrir(b.dataset.id);
  });

  /* ── Seleccionar varias ──────────────────────────────────────────────── */
  // las que se ven ahora en la lista, en su orden (sin las que se están yendo)
  const visibles = () => [...lista.querySelectorAll('.vt-diario__item[data-id]')]
    .filter((b) => !b.closest('.op-swap-out') && b.dataset.state !== 'closing')
    .map((b) => b.dataset.id);
  function seleccionar(on = !eligiendo) {
    if (on === eligiendo) return;
    eligiendo = on;
    elegidas.clear();
    ancla = null;
    lado.classList.toggle('is-eligiendo', on);
    barraNormal.inert = on;
    barraSel.inert = !on;
    pintarLista();
    pintarSel();
    if (on) (lista.querySelector('.is-activo') || lista.querySelector('.vt-diario__item[data-id]') || lista).focus({ preventScroll: true });
    else lista.focus({ preventScroll: true });
  }
  function tocar(id, tramo = false) {
    const orden = visibles();
    if (tramo && ancla && orden.includes(ancla)) {
      // Shift+clic: el tramo entre la última tocada y esta queda como quedó la última
      const [a, b] = [orden.indexOf(ancla), orden.indexOf(id)].sort((x, y) => x - y);
      const poner = elegidas.has(ancla);
      for (const x of orden.slice(a, b + 1)) { if (poner) elegidas.add(x); else elegidas.delete(x); }
    } else if (elegidas.has(id)) elegidas.delete(id);
    else elegidas.add(id);
    ancla = id;
    pintarLista();
    pintarSel();
  }
  // el botón alterna (Todas ↔ Ninguna); Ctrl+A siempre elige todas
  function todasONinguna({ siempreTodas = false } = {}) {
    const orden = visibles();
    const todas = !siempreTodas && orden.length && orden.every((id) => elegidas.has(id));
    for (const id of orden) { if (todas) elegidas.delete(id); else elegidas.add(id); }
    pintarLista();
    pintarSel();
  }
  function pintarSel() {
    const n = elegidas.size;
    frase(selCuenta, n ? `${n} ${n === 1 ? 'note' : 'notes'}` : 'Select notes');
    const orden = visibles();
    frase(selTodas, orden.length && orden.every((id) => elegidas.has(id)) ? 'None' : 'All');
    selPapelera.disabled = !n;
  }
  async function papeleraElegidas() {
    const ids = [...elegidas].filter((id) => notas.some((n) => n.id === id));
    if (!ids.length) return;
    const nombres = ids.map((id) => tituloDe(notas.find((n) => n.id === id)));
    const uno = ids.length === 1;
    const quienes = nombres.length <= 4 ? `${nombres.map((t) => `“${t}”`).join(', ').replace(/, ([^,]*)$/, ' and $1')} ${uno ? 'goes' : 'go'}` : `All ${nombres.length} go`;
    const si = await Modal.confirm({
      title: uno ? 'Move to trash' : `Move ${ids.length} notes to trash`,
      sub: `${quienes} to .diario/papelera, inside the journal folder. ${uno ? "It isn't deleted: you can take it back out" : "They aren't deleted: you can take them back out"} from there.`,
      confirmLabel: 'Move', danger: true,
    });
    if (!si) return;
    const abierta = actual && ids.includes(actual.id);
    if (abierta) { clearTimeout(tGuardar); sucio = false; if (guardando) await guardando.catch(() => {}); }
    let fallas = 0;
    for (const id of ids) {
      try { await api.papelera(id); } catch { fallas++; }
    }
    if (abierta) actual = null;
    seleccionar(false);
    await refrescar();
    pintarNota(); pintarBack(); pintarGrafos();
    const idas = ids.length - fallas;
    if (fallas) Toast.show({ title: "Couldn't move them all", text: `${idas} moved to trash, ${fallas} ${fallas === 1 ? 'stayed where it was' : 'stayed where they were'}.`, tone: 'error' });
    else Toast.show({ title: idas === 1 ? 'Note moved to trash' : `${idas} notes moved to trash`, text: idas === 1 ? "It's in .diario/papelera." : "They're in .diario/papelera.", icon: 'check' });
  }
  lista.addEventListener('keydown', (e) => {
    const items = [...lista.querySelectorAll('.vt-diario__item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const sig = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (i <= 0 && e.key === 'ArrowUp' && !eligiendo) { buscar.focus(); return; }
      sig?.focus({ preventScroll: false });
    }
  });

  /* ── Buscar, saltar y crear ──────────────────────────────────────────── */
  let tBuscar = 0;
  buscar.addEventListener('input', () => {
    q = buscar.value;
    clearTimeout(tBuscar);
    tBuscar = setTimeout(async () => { await correrBusqueda(); if (vivo) pintarLista(); }, 120);
  });
  buscar.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      if (buscar.value || creando) { e.preventDefault(); e.stopPropagation(); limpiarBusqueda(); (actual ? cuerpoFoco() : lista.focus()); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); lista.querySelector('.vt-diario__item')?.focus(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const t = buscar.value.trim();
    if (!t) return;
    clearTimeout(tBuscar);
    q = buscar.value;
    await correrBusqueda();
    const exacta = resultados.find((r) => clave(r.titulo) === clave(t));
    if (exacta) return abrir(exacta.id).then(limpiarBusqueda);
    if (HOY.has(clave(t)) || esFecha(t)) return irDia(HOY.has(clave(t)) ? hoyEs() : t).then(limpiarBusqueda);
    if (creando || !resultados.length) return crearNota(t);
    abrir(resultados[0].id).then(limpiarBusqueda);
  });
  function limpiarBusqueda() {
    buscar.value = ''; q = ''; resultados = null; creando = false;
    buscar.placeholder = 'Search or jump to';
    pintarLista();
  }
  function nuevaConTeclado() {
    limpiarBusqueda();
    creando = true;
    buscar.placeholder = 'Title of the new note, then Enter';
    buscar.focus();
  }
  async function crearNota(t) {
    const n = await attempt(() => api.crear({ titulo: t }), { errorTitle: "Couldn't create the note" });
    if (!n) return;
    limpiarBusqueda();
    await refrescar();
    await abrir(n.id, { escribir: true });
  }
  async function irDia(f = hoyEs()) {
    const n = await attempt(() => api.dia(f), { errorTitle: "Couldn't open the day" });
    if (!n) return;
    if (!notas.some((x) => x.id === n.id)) await refrescar();
    await abrir(n.id, { escribir: true });
  }

  /* ── La nota abierta ─────────────────────────────────────────────────── */
  async function abrir(ref, { escribir = null } = {}) {
    await guardarYa();
    const n = await api.leer(ref).catch(() => null);
    if (!vivo) return;
    if (!n) { Toast.show({ title: 'That note is gone', text: String(ref), icon: 'alert' }); refrescar(); return; }
    actual = { id: n.id, titulo: n.titulo, dia: n.dia, fecha: n.fecha, etiquetas: n.etiquetas, hash: n.hash, base: n.texto };
    sucio = false;
    editor.value = n.texto;
    // escribir: true/false lo decide quien abre; sin decir, las vacías abren para escribir
    modo = (escribir ?? n.vacia) ? 'escribir' : 'leer';
    armar();
    if (enGrafo) alternarGrafo(false);
    pintarNota();
    pintarLista();
    pintarBack();
    pintarGrafos();
    if (escribir) setTimeout(() => { editor.focus({ preventScroll: true }); editor.setSelectionRange(editor.value.length, editor.value.length); editor.scrollTop = editor.scrollHeight; }, 30);
    lista.querySelector('.is-activo')?.scrollIntoView({ block: 'nearest' });
    try { localStorage.setItem('vt-diario:ultima', n.id); } catch { /* sin almacenamiento: abre la más nueva */ }
  }

  function pintarCab() {
    const t = actual ? tituloDe(actual) : '';
    if (titulo.dataset.v !== t) { titulo.dataset.v = t; swap(titulo, esc(t), { relevo: true }); }
    const m = actual ? `${actual.dia ? '' : `<span>${esc(nombreDia(actual.fecha))}</span>`}${actual.etiquetas.map((e) => `<span class="vt-diario__chip">#${esc(e)}</span>`).join('')}<span class="vt-diario__ruta">${esc(actual.id)}.md</span>` : '';
    if (metaEl.dataset.v !== m) { metaEl.dataset.v = m; swap(metaEl, m, { relevo: true }); }
  }
  function pintarNota() {
    const hay = !!actual;
    hoja.classList.toggle('is-vacia', !hay && !enGrafo);
    hoja.classList.toggle('is-escribir', hay && modo === 'escribir');
    hoja.classList.toggle('is-hoy', hay && actual.dia === hoyEs());   // el latido de la última hora
    modoBtn.classList.toggle('is-b', modo === 'escribir');
    const tipModo = modo === 'escribir' ? 'Read (Ctrl+E)' : 'Write (Ctrl+E)';
    modoBtn.dataset.tip = tipModo; modoBtn.setAttribute('aria-label', tipModo.replace(/ \(.*/, ''));
    pintarCab();
    if (!hay) { pintarVacio(); return; }
    if (modo === 'leer') pintarLectura();
  }
  function pintarLectura({ relevo = true } = {}) {
    const cuerpo = sinFrontmatter(editor.value);
    const html = cuerpo.trim()
      ? md(cuerpo, { resaltar, wiki: existe })
      : `<p class="vt-diario__nada">This note is empty. Ctrl+E to write.</p>`;
    if (relevo) swap(leerMd, html, { relevo: true }); else leerMd.innerHTML = html;
    initScrollFades(leer);
  }
  function pintarVacio() {
    const que = notas.length ? 'elegir' : 'nada';
    if (pintadoVacio === que) return;
    pintadoVacio = que;
    swap(vacio, que === 'nada'
      ? empty({ icon: 'book', title: 'Your journal is empty', text: "Ctrl+D opens today's note and Ctrl+N a new one. Type [[ to name another note and they get linked.", actions: '<button type="button" class="op-btn op-btn--secondary" data-accion="hoy">Write today</button>' })
      : empty({ icon: 'book', title: 'Pick a note', text: "Or write today's with Ctrl+D." }), { relevo: true });
  }
  const cuerpoFoco = () => (modo === 'escribir' ? editor : leer).focus({ preventScroll: true });

  function alternarModo(a = modo === 'leer' ? 'escribir' : 'leer') {
    if (!actual) return;
    if (enGrafo) alternarGrafo(false);
    modo = a;
    if (modo === 'leer') { guardarYa(); cerrarSugerir(); }
    armar();
    pintarNota();
    cuerpoFoco();
  }

  /* Un [[enlace]] en la lectura: abre la nota, o la crea si todavía no existe. */
  leer.addEventListener('click', (e) => {
    const a = e.target.closest('.md-wiki');
    if (!a) return;
    e.preventDefault();
    irANota(a.dataset.nota);
  });
  async function irANota(t) {
    if (HOY.has(clave(t)) || esFecha(t)) return irDia(HOY.has(clave(t)) ? hoyEs() : t);
    const n = await api.leer(t).catch(() => null);
    if (n) return abrir(n.id);
    crearNota(t);
  }
  function elegirDelGrafo(n) {
    if (n.fantasma) crearNota(n.titulo);
    else abrir(n.id);
  }

  /* ── La hora de cada entrada (Fran, 3/11/2026: «sí o sí») ────────────────
     En la nota de un día, cada entrada empieza con su hora: «## 14:32» (la
     misma que pone el núcleo a lo que entra por el MCP). Al entrar a escribir
     un día la hora queda ARMADA, y se escribe recién con la primera letra que
     cae al final de la nota, junto con esa letra: así es la hora en que se
     escribió, nunca queda una hora sola, y corregir algo de más arriba no
     cuenta como entrada nueva. Escribir de corrido es una sola entrada; si
     pasa media hora sin tocar una tecla, lo que sigue es otra. Va con
     execCommand para que Ctrl+Z la saque junto con la letra. */
  const PAUSA_ENTRADA = 30 * 60 * 1000;
  const horaAhora = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  function armar() {
    armada = !!actual?.dia && modo === 'escribir';
    ultimaTecla = 0;
  }
  editor.addEventListener('beforeinput', (e) => {
    if (!actual?.dia || !/^insert(Text|LineBreak|Paragraph|FromPaste|FromDrop|ReplacementText)$/.test(e.inputType)) return;
    if (!armada && ultimaTecla && Date.now() - ultimaTecla > PAUSA_ENTRADA) armada = true;
    ultimaTecla = Date.now();
    if (!armada) return;
    const v = editor.value, c = editor.selectionStart;
    if (editor.selectionEnd !== c || v.slice(c).trim()) return;   // corrigiendo algo de antes: no es una entrada nueva
    armada = false;
    const dato = /LineBreak|Paragraph/.test(e.inputType) ? '\n'
      : (e.data ?? e.dataTransfer?.getData('text/plain') ?? '');
    const base = v.replace(/\s+$/, '');
    e.preventDefault();
    editor.setSelectionRange(base.length, v.length);
    document.execCommand('insertText', false, `${base ? '\n\n' : ''}## ${horaAhora()}\n\n${dato}`);
  });

  /* ── Guardar ─────────────────────────────────────────────────────────── */
  function ponerEstado(t, tono = '') {
    if (estado.dataset.v === t + tono) return;
    estado.dataset.v = t + tono;
    estado.className = `vt-diario__estado${tono ? ` is-${tono}` : ''}`;
    swap(estado, esc(t), { relevo: true });
  }
  editor.addEventListener('input', () => {
    if (!actual) return;
    sucio = editor.value !== actual.base;
    if (sucio) ponerEstado('Unsaved');
    clearTimeout(tGuardar);
    tGuardar = setTimeout(guardarYa, 700);
    revisarSugerir();
  });
  function guardarYa() {
    clearTimeout(tGuardar);
    if (guardando) return guardando.then(() => (sucio ? guardarYa() : undefined));
    if (!actual || !sucio) return Promise.resolve();
    const yo = actual;
    guardando = (async () => {
      ponerEstado('Saving');
      let texto = editor.value;
      let r = await api.guardar(yo.id, texto, yo.hash).catch((err) => ({ error: err }));
      if (r?.conflicto) {
        // alguien (CC) la cambió mientras escribías
        const disco = r.nota.texto, base = yo.base.replace(/\s+$/, '');
        let juntas = null;
        if (disco.startsWith(base)) juntas = `${texto.replace(/\s+$/, '')}${disco.slice(base.length)}`;
        if (juntas != null && actual === yo) {
          const { selectionStart: s, selectionEnd: f } = editor;
          editor.value = juntas;
          editor.setSelectionRange(s, f);
          texto = juntas;
        }
        r = await api.guardar(yo.id, texto, r.nota.hash).catch((err) => ({ error: err }));
        if (!r?.error) {
          Toast.show(juntas != null
            ? { title: 'Both changes were merged', text: 'Someone added to the end of the note while you were writing: both your text and theirs were kept.', icon: 'info' }
            : { title: 'Your version was kept', text: 'Someone changed the note while you were writing. Their version was saved in .diario/versiones.', icon: 'info' });
        }
      }
      if (r?.error) {
        ponerEstado("Couldn't save", 'error');
        Toast.show({ title: "Couldn't save the note", text: String(r.error?.message || r.error), tone: 'error' });
        return;
      }
      if (actual === yo) {
        yo.hash = r.nota.hash;
        yo.base = r.nota.texto;
        yo.etiquetas = r.nota.etiquetas;
        sucio = editor.value !== yo.base;
        pintarCab();
        ponerEstado(sucio ? 'Unsaved' : 'Saved');
      }
    })().finally(() => { guardando = null; });
    return guardando;
  }

  /* Lo que cambió afuera (CC por el MCP, un editor) o en otra parte de la app. */
  const soltarCambios = api?.onCambio?.(async (cambios) => {
    const mia = actual && cambios.find((c) => c.id === actual.id);
    await refrescar();
    if (!mia || !actual || mia.desde === 'app') return;
    if (!mia.existe) {
      Toast.show({ title: 'The note was moved or deleted outside Quartz', text: `${actual.id}.md`, icon: 'alert' });
      actual = null; pintarNota(); pintarBack(); pintarGrafos(); pintarLista();
      return;
    }
    if (mia.hash === actual.hash) return;
    if (sucio) { guardarYa(); return; } // el guardado se da cuenta y junta
    const n = await api.leer(actual.id).catch(() => null);
    if (!n || !actual || n.id !== actual.id) return;
    const { selectionStart: s, selectionEnd: f } = editor;
    Object.assign(actual, { hash: n.hash, base: n.texto, etiquetas: n.etiquetas });
    editor.value = n.texto;
    if (document.activeElement === editor) editor.setSelectionRange(Math.min(s, n.texto.length), Math.min(f, n.texto.length));
    pintarCab();
    if (modo === 'leer') pintarLectura();
    ponerEstado('Updated from outside', 'afuera');
  });

  /* ── Backlinks y grafos ──────────────────────────────────────────────── */
  let pintadoBack = null;
  async function pintarBack() {
    if (!actual) {
      if (pintadoBack !== 'nada') { pintadoBack = 'nada'; swap(back, '', { relevo: true }); cuentaBack.textContent = ''; }
      return;
    }
    const yo = actual.id;
    const bl = await api.backlinks(yo).catch(() => []);
    if (!vivo || actual?.id !== yo) return;
    const html = bl.length
      ? bl.map((b) => `<button type="button" class="vt-diario__bl" data-id="${esc(b.id)}">
          <span class="vt-diario__blnom">${esc(b.dia ? nombreDia(b.dia) : b.titulo)}</span>
          ${b.renglones.map((r) => `<span class="vt-diario__blren">${esc(r.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').replace(/[*_`#>]/g, '').trim())}</span>`).join('')}
        </button>`).join('')
      : `<p class="vt-diario__nada">No note links here yet. Write [[${esc(actual.titulo)}]] in another one and it shows up here.</p>`;
    if (pintadoBack === yo + html) return;
    pintadoBack = yo + html;
    cuentaBack.textContent = bl.length ? String(bl.length) : '';
    swap(back, html, { relevo: true });
    initScrollFades(back.parentElement);
  }
  back.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) abrir(b.dataset.id); });

  /* ── Hace un año, hoy ────────────────────────────────────────────────────
     Arriba en el panel, la nota del mismo día del año pasado, si existe y no
     está vacía: la fecha y sus primeros renglones (sin las horas). La sección
     siempre está en el DOM; se abre y se cierra con .is-hay (vitra.css). */
  let anioVisto = '';
  async function pintarAnio() {
    const f = haceUnAnio();
    const n = notas.find((x) => x.dia === f && !x.vacia);
    const llave = n ? `${n.id}:${n.hash}` : '';
    if (llave === anioVisto) return;
    anioVisto = llave;
    if (!n) { anio.classList.remove('is-hay'); return; }
    const nota = await api.leer(n.id).catch(() => null);
    if (!vivo || anioVisto !== llave) return;
    if (!nota) { anio.classList.remove('is-hay'); return; }
    const renglones = sinFrontmatter(nota.texto).split('\n').map((r) => r.trim())
      .filter((r) => r && !/^#{1,6}\s/.test(r)).slice(0, 2)
      .map((r) => r.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').replace(/[*_`>]/g, '').replace(/^[-+]\s+(\[[ x]\]\s+)?/i, ''));
    const fecha = new Date(`${f}T12:00:00`).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
    anioCuerpo.innerHTML = `<button type="button" class="vt-diario__bl" data-id="${esc(n.id)}">
      <span class="vt-diario__blnom">${esc(fecha)}</span>
      ${renglones.map((r) => `<span class="vt-diario__blren">${esc(r)}</span>`).join('')}</button>`;
    anio.classList.add('is-hay');
  }
  anio.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) abrir(b.dataset.id); });

  // en el grafo, los días se nombran como en la lista («hoy», «31 oct»), no por su archivo
  const paraGrafo = () => ({ ...grafo, nodos: grafo.nodos.map((n) => (n.dia ? { ...n, titulo: nombreDia(n.dia, { largo: false }) } : n)) });
  function pintarGrafos() {
    const g = paraGrafo();
    mini.poner(g, { foco: actual?.id || null, local: !!actual });
    grande?.poner(g, { foco: actual?.id || null });
  }
  function alternarGrafo(a = !enGrafo) {
    enGrafo = a;
    if (enGrafo && !grande) grande = crearGrafo($('.vt-diario__grande'), { alElegir: (n) => elegirDelGrafo(n) });
    hoja.classList.toggle('is-grafo', enGrafo);
    hoja.classList.toggle('is-vacia', !actual && !enGrafo);
    if (enGrafo) { cerrarSugerir(); guardarYa(); grande.poner(paraGrafo(), { foco: actual?.id || null }); grande.centrar(); }
    else if (actual) pintarNota();
    else pintarVacio();
  }

  /* ── El menú de [[ ]] mientras se escribe ────────────────────────────── */
  let sug = null; // { desde, items, i }
  function revisarSugerir() {
    const c = editor.selectionStart;
    if (c !== editor.selectionEnd) return cerrarSugerir();
    const antes = editor.value.slice(Math.max(0, c - 140), c);
    const m = /\[\[([^\]\n|#]*)$/.exec(antes);
    if (!m) return cerrarSugerir();
    const busca = clave(m[1]);
    const todos = notas.map((n) => ({ t: n.titulo, nom: n.dia ? nombreDia(n.dia) : n.titulo, k: clave(`${n.titulo} ${n.dia ? nombreDia(n.dia) : ''}`) }))
      .filter((x) => x.t !== actual?.titulo);
    let items = busca ? todos.filter((x) => x.k.includes(busca)) : todos;
    items.sort((a, b) => Number(clave(b.t).startsWith(busca)) - Number(clave(a.t).startsWith(busca)));
    items = items.slice(0, 8);
    if (m[1].trim() && !notas.some((n) => clave(n.titulo) === busca)) items.push({ t: m[1].trim(), nom: `New: ${m[1].trim()}`, nueva: true });
    if (!items.length) return cerrarSugerir();
    sug = { desde: c - m[1].length, items, i: Math.min(sug?.i ?? 0, items.length - 1) };
    pintarSugerir();
  }
  function pintarSugerir() {
    sugerir.innerHTML = sug.items.map((x, i) => `<button type="button" class="vt-diario__sug${i === sug.i ? ' is-activo' : ''}${x.nueva ? ' is-nueva' : ''}" role="option" aria-selected="${i === sug.i}" data-i="${i}" tabindex="-1">
      ${x.nueva ? Icons.svg('plus') : Icons.svg('file')}<span>${esc(x.nom)}</span></button>`).join('');
    const p = caretXY();
    const cuerpo = editor.parentElement;
    const w = 260;
    sugerir.style.left = `${Math.max(8, Math.min(cuerpo.clientWidth - w - 8, p.x))}px`;
    const abajo = p.y + 24;
    const alto = Math.min(sug.items.length * 30 + 8, 248);
    sugerir.style.top = `${abajo + alto > cuerpo.clientHeight - 8 ? Math.max(8, p.y - alto - 6) : abajo}px`;
    sugerir.classList.add('is-on');
  }
  function cerrarSugerir() { if (!sug) return; sug = null; sugerir.classList.remove('is-on'); }
  function completar(x) {
    const c = editor.selectionStart;
    const v = editor.value;
    const cierra = v.slice(c, c + 2) === ']]' ? 2 : 0;
    const nuevo = `${v.slice(0, sug.desde)}${x.t}]]`;
    editor.setRangeText(`${x.t}]]`, sug.desde, c + cierra, 'end');
    editor.setSelectionRange(nuevo.length, nuevo.length);
    cerrarSugerir();
    editor.dispatchEvent(new Event('input'));
  }
  sugerir.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // el foco se queda en el editor
    const b = e.target.closest('[data-i]');
    if (b && sug) completar(sug.items[Number(b.dataset.i)]);
  });
  editor.addEventListener('keydown', (e) => {
    if (!sug) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sug.i = (sug.i + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
      pintarSugerir();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      completar(sug.items[sug.i]);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); // solo cierra el menú
      cerrarSugerir();
    }
  });
  editor.addEventListener('click', revisarSugerir);
  editor.addEventListener('blur', () => setTimeout(cerrarSugerir, 100));
  editor.addEventListener('scroll', () => { if (sug) pintarSugerir(); });

  /* Dónde está el cursor del editor, en px dentro de su caja: un espejo
     invisible con el mismo texto hasta el cursor y una marca al final. */
  const espejo = document.createElement('div');
  espejo.className = 'vt-diario__espejo';
  espejo.setAttribute('aria-hidden', 'true');
  editor.parentElement.append(espejo);
  function caretXY() {
    const cs = getComputedStyle(editor);
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'tabSize']) espejo.style[p] = cs[p];
    espejo.style.width = `${editor.clientWidth}px`;
    espejo.textContent = editor.value.slice(0, editor.selectionStart);
    const marca = document.createElement('span');
    marca.textContent = '\u200b';
    espejo.append(marca);
    return { x: editor.offsetLeft + marca.offsetLeft, y: editor.offsetTop + marca.offsetTop - editor.scrollTop };
  }

  /* ── Los botones y los atajos ────────────────────────────────────────── */
  raiz.addEventListener('click', (e) => {
    const b = e.target.closest('[data-accion]');
    if (!b) return;
    const a = b.dataset.accion;
    if (a === 'hoy') irDia();
    else if (a === 'nueva') nuevaConTeclado();
    else if (a === 'modo') alternarModo();
    else if (a === 'grafo') alternarGrafo();
    else if (a === 'mas') menuMas(b);
    else if (a === 'elegir') seleccionar(true);
    else if (a === 'sel-salir') seleccionar(false);
    else if (a === 'sel-todas') todasONinguna();
    else if (a === 'sel-papelera') papeleraElegidas();
  });
  titulo.addEventListener('dblclick', () => { if (actual && !actual.dia) renombrar(); });

  function menuMas(ancla) {
    Menu.show(ancla, [
      ...(actual && !actual.dia ? [{ label: 'Rename', icon: 'edit', onSelect: renombrar }] : []),
      { label: 'Open the journal folder', icon: 'folder', onSelect: () => attempt(() => api.abrirCarpeta(), { errorTitle: "Couldn't open the folder" }) },
      ...(menuExtra?.() || []),
      ...(actual ? [{ sep: true }, { label: 'Move to trash', icon: 'trash', danger: true, onSelect: aPapelera }] : []),
    ], { align: 'end' });
  }
  async function renombrar() {
    if (!actual || actual.dia) return;
    await guardarYa();
    const campo = document.createElement('input');
    campo.className = 'op-input';
    campo.value = actual.titulo;
    campo.spellcheck = false;
    campo.setAttribute('aria-label', 'New title');
    campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); Modal.close('ok'); } });
    const cuerpo = document.createElement('div');
    cuerpo.append(campo);
    const r = await Modal.show({ title: 'Rename note', sub: 'Notes that link to it with [[ ]] are updated automatically.', body: cuerpo, actions: [{ label: 'Cancel', value: null }, { label: 'Rename', value: 'ok', variant: 'primary' }] });
    const nuevo = campo.value.trim();
    if (r !== 'ok' || !nuevo || nuevo === actual?.titulo) return;
    const res = await attempt(() => api.renombrar(actual.id, nuevo), { errorTitle: "Couldn't rename the note" });
    if (!res) return;
    await refrescar();
    await abrir(res.nota.id, { escribir: modo === 'escribir' });
    if (res.corregidas) Toast.show({ title: 'Renamed', text: `Links were updated in ${res.corregidas} ${res.corregidas === 1 ? 'note' : 'notes'}.`, icon: 'check' });
  }
  async function aPapelera() {
    if (!actual) return;
    const yo = actual;
    const si = await Modal.confirm({ title: 'Move to trash', sub: `“${tituloDe(yo)}” goes to .diario/papelera, inside the journal folder. It isn't deleted: you can take it back out from there.`, confirmLabel: 'Move', danger: true });
    if (!si) return;
    clearTimeout(tGuardar); sucio = false;
    if (!(await attempt(() => api.papelera(yo.id), { errorTitle: "Couldn't move the note" }))) return;
    actual = null;
    await refrescar();
    pintarNota(); pintarBack(); pintarGrafos();
  }

  // seleccionando: Esc sale, Supr manda lo elegido y Ctrl+A elige todas (fuera de un campo)
  raiz.addEventListener('keydown', (e) => {
    if (!eligiendo || e.altKey) return;
    const enCampo = e.target.closest?.('input, textarea, [contenteditable]');
    if (e.key === 'Escape' && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); seleccionar(false); }
    else if (e.key === 'Delete' && !enCampo) { e.preventDefault(); papeleraElegidas(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !enCampo) { e.preventDefault(); e.stopPropagation(); todasONinguna({ siempreTodas: true }); }
  }, true);
  raiz.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const hecho = () => { e.preventDefault(); e.stopPropagation(); };
    // lo que usa la barra de búsqueda (inerte mientras se elige) sale de la selección primero
    if (eligiendo && (k === 'n' || k === 'k' || k === 'd')) seleccionar(false);
    if (k === 'n') { hecho(); nuevaConTeclado(); }
    else if (k === 'd') { hecho(); irDia(); }
    else if (k === 'k') { hecho(); limpiarBusqueda(); buscar.focus(); }
    else if (k === 'e') { hecho(); alternarModo(); }
    else if (k === 'g') { hecho(); alternarGrafo(); }
    else if (k === 's') { hecho(); guardarYa(); }
  });

  /* ── Arranque ────────────────────────────────────────────────────────── */
  if (!api) {
    swap(vacio, empty({ icon: 'alert', title: 'The journal is unavailable', text: 'The journal bridge is missing (preload.cjs).' }));
    hoja.classList.add('is-vacia');
  } else {
    refrescar().then(() => {
      if (!vivo || actual) return;
      let ultima = null;
      try { ultima = localStorage.getItem('vt-diario:ultima'); } catch { /* nada */ }
      const n = notas.find((x) => x.id === ultima) || notas.find((x) => x.dia === hoyEs()) || notas[0];
      if (n) abrir(n.id); else pintarNota();
    });
  }
  cargarPrism().then(() => { if (actual && modo === 'leer') pintarLectura({ relevo: false }); });
  pintarNota();

  return {
    alEnfocar() { if (document.activeElement && raiz.contains(document.activeElement)) return; actual ? cuerpoFoco() : buscar.focus({ preventScroll: true }); },
    alAjustar() { mini.ajustar(); grande?.ajustar(); if (sug) pintarSugerir(); },
    /** Abre una nota por su título o id (o «hoy»). */
    abrir(ref) { if (HOY.has(clave(ref))) irDia(); else irANota(ref); },
    destruir() { vivo = false; guardarYa(); soltarCambios?.(); mini.destruir(); grande?.destruir(); },
  };
}
