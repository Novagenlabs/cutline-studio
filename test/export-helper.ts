/**
 * Start an export the way a user does.
 *
 * The rail's per-format buttons still exist and still perform the export, but
 * they are no longer on screen — the export dialog picks the format and then
 * clicks one of them. A test that clicks them directly would pass while the
 * path a real user takes was broken, so every test goes through the dialog.
 */
export async function startExport(p: { evaluate: (s: string) => Promise<unknown> }, format = 'SVG') {
  await p.evaluate(`document.getElementById('btn-export').click()`);
  // The dialog builds its rows synchronously on open, but showModal() paints
  // on the next frame; waiting for the row avoids a race on slower machines.
  await p.evaluate(`(async () => {
    for (let i = 0; i < 40; i++) {
      const row = document.querySelector('#export-sheet [data-format="${format}"]');
      if (row) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('export dialog never showed a ${format} row');
  })()`);
  await p.evaluate(`(() => {
    const d = document.getElementById('export-sheet');
    d.querySelector('[data-format="${format}"]').click();
    d.querySelector('button[value="download"]').click();
  })()`);
}
