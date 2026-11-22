/* ═══════════════════════════════════════════════════════════════════════════
   Quartz — las actualizaciones, en la cara
   Autoupdate (Fran, 2/11/2026): el main busca al rato de abrir y cada 4
   horas, y una versión nueva se baja sola (src/actualizador.cjs). Acá no se
   interrumpe nada: un solo aviso cuando ya está bajada («entra al salir»),
   y reiniciar antes vive en el menú «Más» de la nota (diario.js lo pide con
   menuExtra).
   ═══════════════════════════════════════════════════════════════════════════ */

import { Toast } from './overlays.js';
import { fmtBytes } from './format.js';

const api = window.opal?.update;
let estado = null;
let avisada = null;   // la versión de la que ya se avisó (un aviso por versión)

function alCambiar(s) {
  const antes = estado;
  estado = s;
  if (!s) return;
  if (s.fase === 'listo' && avisada !== s.version) {
    avisada = s.version;
    // Con el botón a mano (pedido de Fran, 0.8.0): dura más que un aviso común
    // (y el hover la pausa), para que dé tiempo a decidir.
    Toast.show({
      title: `Quartz ${s.version || ''} is ready`.replace('  ', ' '),
      text: 'It downloaded on its own and installs when you quit Quartz from the tray or shut down the PC.',
      icon: 'check',
      duration: 15000,
      action: { label: 'Restart now', onSelect: () => api.instalar() },
    });
  } else if (s.manual && s.fase === 'al-dia' && antes?.fase === 'buscando') {
    Toast.show({ title: "You're up to date", text: `Quartz ${s.actual} is the latest.`, icon: 'check' });
  } else if (s.fase === 'error' && (s.manual || antes?.fase === 'descargando') && antes?.error !== s.error) {
    Toast.show({ title: "Couldn't update", text: s.error, tone: 'error' });
  }
}

export function iniciarActualizaciones() {
  if (!api) return;
  api.onCambio(alCambiar);
  api.estado().then(alCambiar).catch(() => {});
}

/** Los ítems del menú «Más»: qué se puede hacer con la versión ahora mismo. */
export function itemsActualizar() {
  if (!api || !estado || estado.fase === 'sin-soporte' || estado.fase === 'inactivo') return [];
  const s = estado;
  if (s.fase === 'disponible') {
    return [{ label: `Download Quartz ${s.version}${s.bytes ? ` (${fmtBytes(s.bytes)})` : ''}`, icon: 'download', onSelect: () => api.descargar() }];
  }
  if (s.fase === 'descargando') {
    return [{ label: `Downloading… ${Math.round((s.progreso?.pct || 0) * 100)} %`, icon: 'download', disabled: true }];
  }
  if (s.fase === 'listo') {
    return [{ label: `Restart with Quartz ${s.version}`, icon: 'retry', onSelect: () => api.instalar() }];
  }
  return [{ label: s.fase === 'buscando' ? 'Checking for updates…' : 'Check for updates', icon: 'retry', disabled: s.fase === 'buscando', onSelect: () => api.buscar({ manual: true }) }];
}
