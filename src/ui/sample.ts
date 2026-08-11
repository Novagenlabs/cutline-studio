/**
 * Built-in demo artwork: disjoint elements (star, badge, bolt) on a
 * transparent canvas so the offset-merge behavior is visible immediately.
 */
export function makeSampleImage(): HTMLCanvasElement {
  const w = 960;
  const h = 720;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  // Big star
  const cx = 430;
  const cy = 360;
  const spikes = 5;
  const outerR = 240;
  const innerR = 118;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (i * Math.PI) / spikes - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const grad = ctx.createLinearGradient(cx - outerR, cy - outerR, cx + outerR, cy + outerR);
  grad.addColorStop(0, '#ffd166');
  grad.addColorStop(1, '#ef476f');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#231f20';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Face on the star
  ctx.fillStyle = '#231f20';
  ctx.beginPath();
  ctx.arc(cx - 52, cy - 20, 14, 0, Math.PI * 2);
  ctx.arc(cx + 52, cy - 20, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy + 26, 52, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Disjoint badge ring (tests hole handling + merge)
  ctx.beginPath();
  ctx.arc(790, 190, 84, 0, Math.PI * 2);
  ctx.arc(790, 190, 42, 0, Math.PI * 2, true);
  ctx.fillStyle = '#118ab2';
  ctx.fill('evenodd');

  // Disjoint lightning bolt (tests sharp concave corners)
  ctx.beginPath();
  ctx.moveTo(180, 540);
  ctx.lineTo(260, 540);
  ctx.lineTo(214, 612);
  ctx.lineTo(288, 600);
  ctx.lineTo(160, 700);
  ctx.lineTo(204, 616);
  ctx.lineTo(148, 622);
  ctx.closePath();
  ctx.fillStyle = '#ffd166';
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#231f20';
  ctx.stroke();

  return c;
}
