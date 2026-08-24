import type { PaidFormat } from '../paid-export';

/**
 * Spend confirmation.
 *
 * A download costs a credit, and a click that silently spends money is the
 * kind of surprise that turns into a support ticket. This states the cost and
 * the balance that will be left before anything is charged.
 *
 * It can be turned off for the session — someone exporting twenty files does
 * not want twenty dialogs — but deliberately not persisted, so a new visit
 * always starts by telling the user what a download costs.
 */

const FORMAT_LABEL: Record<PaidFormat, string> = {
  SVG: 'SVG · layered vector',
  PDF: 'PDF · spot colour',
  DXF: 'DXF · plotter',
  PNG: 'PNG · print-and-cut',
};

let skipForSession = false;

export function resetSpendConfirmation(): void {
  skipForSession = false;
}

export async function confirmSpend(
  format: PaidFormat,
  balance: number | null
): Promise<boolean> {
  if (skipForSession) return true;

  const dlg = document.getElementById('confirm-export') as HTMLDialogElement | null;
  // Without <dialog> support, or if the markup is missing, fall through
  // rather than blocking a paid action the user asked for.
  if (!dlg || typeof dlg.showModal !== 'function') return true;

  const set = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('confirm-format', FORMAT_LABEL[format]);
  set('confirm-cost', '1 credit');
  set(
    'confirm-after',
    balance === null ? 'sign in to see' : `${Math.max(0, balance - 1)} credit${balance - 1 === 1 ? '' : 's'}`
  );
  set(
    'confirm-body',
    balance === null
      ? 'You need to be signed in to download a cut file.'
      : balance <= 1
        ? 'This is your last credit — you will need to buy more to download again.'
        : 'The file is generated on our server and downloads straight away.'
  );

  const skip = document.getElementById('confirm-skip') as HTMLInputElement | null;
  if (skip) skip.checked = false;

  dlg.showModal();

  const result = await new Promise<string>((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true });
  });

  if (result !== 'confirm') return false;
  if (skip?.checked) skipForSession = true;
  return true;
}
