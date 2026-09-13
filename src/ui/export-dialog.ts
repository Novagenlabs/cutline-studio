import type { PaidFormat } from '../paid-export';
import { mountSwitch } from './controls';

/**
 * Pick a format, see the cost, download.
 *
 * This replaced a grid of five format buttons in the rail. That grid asked
 * the user to know what DXF is before they could press anything, and it
 * charged a credit on a single click with the price named nowhere. One button
 * leads here instead: the formats are described rather than abbreviated, the
 * cost and the balance after are on the same screen as the choice, and the
 * format someone always wants can be remembered so the dialog becomes a
 * confirmation rather than a decision.
 *
 * The remembered default persists (localStorage). The old session-only "don't
 * ask again" did not, deliberately, because it suppressed the price. This is
 * the opposite: it preselects a format but still shows what will be spent.
 */

export interface FormatOption {
  id: PaidFormat;
  badge: string;
  title: string;
  detail: string;
}

const FORMATS: FormatOption[] = [
  { id: 'SVG', badge: 'SVG', title: 'Layered vector', detail: 'Artwork + cut layer · Illustrator' },
  { id: 'PDF', badge: 'PDF', title: 'Spot colour', detail: 'CutContour separation · print shops' },
  { id: 'DXF', badge: 'DXF', title: 'Plotter paths', detail: 'Cut only · Silhouette, lasers' },
  { id: 'PNG', badge: 'PNG', title: 'Print-and-cut', detail: 'Transparent · Cricut, Silhouette' },
];

const STORE_KEY = 'cutline.defaultFormat';

/** The remembered format, if the user has saved one. */
export function defaultFormat(): PaidFormat | null {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return FORMATS.some((f) => f.id === v) ? (v as PaidFormat) : null;
  } catch {
    // Private browsing and blocked storage both throw here. A missing
    // preference is not worth breaking an export over.
    return null;
  }
}

function rememberFormat(f: PaidFormat | null): void {
  try {
    if (f) localStorage.setItem(STORE_KEY, f);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore — see defaultFormat() */
  }
}

/**
 * Show the dialog. Resolves with the chosen format, or null if dismissed.
 */
export async function chooseExport(balance: number | null): Promise<PaidFormat | null> {
  const dlg = document.getElementById('export-sheet') as HTMLDialogElement | null;
  if (!dlg || typeof dlg.showModal !== 'function') return null;

  const saved = defaultFormat();
  let picked: PaidFormat = saved ?? 'SVG';

  const list = dlg.querySelector('.fmt-list');
  if (!list) return null;

  // Rebuilt per open rather than once: the rows carry the saved-default badge,
  // which changes when the user saves a different one.
  list.replaceChildren(
    ...FORMATS.map((f) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'fmt' + (f.id === picked ? ' is-on' : '');
      row.dataset.format = f.id;
      row.innerHTML = `
        <span class="fmt-badge">${f.badge}</span>
        <span class="fmt-body">
          <span class="fmt-title">${f.title}${
            f.id === saved ? '<span class="fmt-default">DEFAULT</span>' : ''
          }</span>
          <span class="fmt-detail">${f.detail}</span>
        </span>
        <span class="fmt-check" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M6 12.4l4 4 8-8.6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>`;
      row.addEventListener('click', () => {
        if (picked === f.id) return;
        picked = f.id;
        for (const el of list.querySelectorAll('.fmt')) {
          el.classList.toggle('is-on', el === row);
        }
        // Switching format is the one moment the toggle should re-derive:
        // "make PDF my default" is a different question from "make SVG my
        // default", so it reflects whether THIS format is the stored one.
        const box = dlg?.querySelector('#export-save-default') as HTMLInputElement | null;
        if (box) box.checked = saved !== null && saved === picked;
        drawSwitch();
        paint();
      });
      return row;
    })
  );

  const save = dlg.querySelector('#export-save-default') as HTMLInputElement | null;
  if (save) save.checked = saved !== null && saved === picked;

  /**
   * Draw the Base UI switch from the hidden model.
   *
   * The model is what the rest of this file reads, so the switch writes to it
   * and then re-draws itself. Replaces a hand-drawn checkbox whose knob was
   * once silently overwritten by the generic checkbox tick rule — a class of
   * bug that cannot recur when the thumb is the library's own element.
   */
  const switchHost = dlg.querySelector('#mount-save-default');
  function drawSwitch() {
    if (!switchHost || !save) return;
    mountSwitch(switchHost, {
      checked: save.checked,
      label: `Make ${picked} my default`,
      onChange: (on) => {
        save.checked = on;
        drawSwitch();
      },
    });
  }
  drawSwitch();

  const text = (id: string, s: string) => {
    const el = dlg.querySelector(`#${id}`);
    if (el) el.textContent = s;
  };

  /**
   * Redraw the parts that depend on the chosen format.
   *
   * Deliberately does NOT touch the switch. It used to, which meant every
   * repaint reset the toggle from the stored default — so a user could turn
   * "make this my default" on, and the next click of the same format row
   * silently turned it back off. The switch is the user's input; only a
   * change of format may reset it, which happens in the row handler.
   */
  function paint() {
    text('export-balance', balance === null ? '—' : String(balance));
    text('export-after', balance === null ? '—' : String(Math.max(0, balance - 1)));
    const label = dlg?.querySelector('#export-save-label');
    if (label) label.textContent = `Make ${picked} my default`;
  }

  paint();
  dlg.showModal();

  const result = await new Promise<string>((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true });
  });

  if (result !== 'download') return null;

  // Saving is per-format: ticking the box on PDF should replace an SVG
  // default, and unticking it on the format that IS the default clears it
  // rather than silently keeping it.
  if (save?.checked) rememberFormat(picked);
  else if (saved === picked) rememberFormat(null);

  return picked;
}
