/**
 * The first-run tour.
 *
 * Cutline Studio looks simpler than it is. The rail has four controls and an
 * export button, and nothing on screen says that "Tight" and "Sticker" are
 * about how much material sits around the cut, or that interior holes is the
 * difference between a decal and a sticker. Someone who already does
 * print-and-cut work knows; someone who does not will pick a preset at
 * random and be disappointed by what comes off the plotter.
 *
 * So this walks the actual flow — open artwork, choose a cut style, decide
 * about holes, export — pointing at the real controls rather than describing
 * them in a modal the user dismisses without reading.
 *
 * Design decisions worth keeping:
 *
 * It does not block. Every step has the app live behind it, and clicking
 * outside advances rather than trapping. A tour that has to be completed
 * before the product can be touched is a tax on the people who already know
 * what they are doing.
 *
 * It anchors to elements that exist rather than to coordinates. A step whose
 * target is missing — the Elements panel before an image is open, say — is
 * skipped rather than pointing at nothing, which is why each step declares
 * its own target and the runner filters before it starts.
 *
 * It is not a replacement for the hints already in the rail. Those stay; this
 * is the once-through that explains the shape of the job.
 */

const SEEN_KEY = 'cutline.tourSeen';

export interface TourStep {
  /** CSS selector for the element to point at. Missing targets are skipped. */
  target: string;
  title: string;
  body: string;
  /** Which side of the target the bubble prefers. */
  placement?: 'right' | 'left' | 'top' | 'bottom';
  /**
   * Run before the step is shown — used to put the app in the state the step
   * describes, e.g. switching to Simple so the tour is not explaining
   * controls that are hidden.
   */
  before?: () => void;
}

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // Private browsing throws. Showing the tour again is a smaller failure
    // than crashing on load, and the same call the splash makes.
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* nothing to do — see tourSeen() */
  }
}

/**
 * The script. Ordered as the job is actually done, not as the UI is laid out:
 * artwork first because nothing else can be judged without it.
 */
export function simpleTourSteps(): TourStep[] {
  return [
    {
      // The drop cards, not #dropzone: that fills the whole canvas, and a
      // ring around the entire viewport highlights nothing.
      target: '.drop-row',
      placement: 'top',
      title: 'Start with your artwork',
      body:
        'Drop a PNG here, or use Open image. Transparent PNGs cut straight from ' +
        'the alpha channel; flat JPGs get their background removed automatically.',
    },
    {
      target: '#mount-cutstyle',
      placement: 'right',
      title: 'Pick how close the cut sits',
      body:
        'This is the gap between your artwork and the blade. Tight hugs the edge ' +
        'for die-cut shapes; Sticker leaves 3 mm of material, the usual choice for ' +
        'stickers with a border. Drag it and the preview updates.',
      before: () => clickIfPresent('#tab-simple'),
    },
    {
      target: '#holes-setting',
      placement: 'right',
      title: 'Decide about enclosed gaps',
      body:
        'Off, the blade only cuts the outline — the middle of an O stays attached. ' +
        'On, it cuts those gaps out too. Leave it off for stickers, turn it on for ' +
        'decals that need to sit flat on glass.',
    },
    {
      target: '#panel-elements',
      placement: 'right',
      title: 'Tune parts separately',
      body:
        'On a logo, the icon and the strapline often want different offsets. ' +
        'Detect finds the separate pieces so you can give each its own.',
    },
    {
      target: '#btn-export',
      placement: 'top',
      title: 'Export when the preview looks right',
      body:
        'SVG and PDF carry a CutContour spot colour that plotters read directly. ' +
        'One credit per cut file, and the preview always shows exactly what the ' +
        'blade will follow.',
    },
    {
      target: '#st-credits',
      placement: 'bottom',
      title: 'Credits live here',
      // Signed out this control reads "Sign in to download" and signed in it
      // shows a balance, so the copy has to describe both without claiming
      // the reader is looking at a number they may not have yet.
      body:
        'Signed in, this shows what you have left and opens the place to top up. ' +
        'New accounts start with free credits, so you can run a real export ' +
        'before paying for anything.',
    },
  ];
}

function clickIfPresent(sel: string): void {
  const el = document.querySelector<HTMLElement>(sel);
  if (el && el.offsetHeight > 0) el.click();
}

/** Is this element actually on screen and pointable-at? */
function usable(sel: string): boolean {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) return false;
  if (el.hasAttribute('hidden')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export interface Tour {
  /** Resolves when the tour ends, however it ends. */
  run(): Promise<void>;
}

/**
 * Build the tour. Nothing is shown until run() is called.
 */
export function createTour(steps: TourStep[] = simpleTourSteps()): Tour {
  let index = 0;
  let live: TourStep[] = [];
  let done: (() => void) | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;

  const root = document.createElement('div');
  root.className = 'tour';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Getting started');

  // A dimmed backdrop with a hole cut in it would need to track the target
  // through scrolling and resizing; a ring on the target plus a soft scrim
  // reads the same and cannot drift out of register.
  //
  // The scrim takes no pointer events (see the stylesheet), so the app stays
  // usable throughout — you can drag the very slider the bubble is describing.
  // It blocked clicks in the first version, which broke both the product and
  // every test that tried to drive the rail.
  const scrim = document.createElement('div');
  scrim.className = 'tour-scrim';

  const ring = document.createElement('div');
  ring.className = 'tour-ring';

  const bubble = document.createElement('div');
  bubble.className = 'tour-bubble';
  bubble.innerHTML = `
    <p class="tour-count"></p>
    <h4 class="tour-title"></h4>
    <p class="tour-body"></p>
    <div class="tour-actions">
      <button type="button" class="tour-skip">Skip</button>
      <div class="tour-nav">
        <button type="button" class="tour-back">Back</button>
        <button type="button" class="tour-next">Next</button>
      </div>
    </div>
  `;

  root.append(scrim, ring, bubble);

  const $ = <T extends HTMLElement>(sel: string) => bubble.querySelector(sel) as T;

  function place(step: TourStep): void {
    const el = document.querySelector<HTMLElement>(step.target);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });

    const r = el.getBoundingClientRect();
    const pad = 6;
    ring.style.left = `${r.left - pad}px`;
    ring.style.top = `${r.top - pad}px`;
    ring.style.width = `${r.width + pad * 2}px`;
    ring.style.height = `${r.height + pad * 2}px`;

    // Measure the bubble before positioning it: its height depends on how
    // much text the step has, and guessing produces bubbles that hang off
    // the bottom of short viewports.
    bubble.style.visibility = 'hidden';
    bubble.style.left = '0px';
    bubble.style.top = '0px';
    const b = bubble.getBoundingClientRect();
    const gap = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Flip to the opposite side when the preferred one has no room, rather
    // than clamping into the viewport: clamping alone slides the bubble back
    // over the very thing it is pointing at, which is how step one ended up
    // sitting on top of the toolbar it was describing.
    let side = step.placement ?? 'right';
    if (side === 'top' && r.top < b.height + gap + 12) side = 'bottom';
    else if (side === 'bottom' && vh - r.bottom < b.height + gap + 12) side = 'top';
    else if (side === 'right' && vw - r.right < b.width + gap + 12) side = 'left';
    else if (side === 'left' && r.left < b.width + gap + 12) side = 'right';

    let left: number;
    let top: number;
    switch (side) {
      case 'left':
        left = r.left - b.width - gap;
        top = r.top;
        break;
      case 'top':
        left = r.left + r.width / 2 - b.width / 2;
        top = r.top - b.height - gap;
        break;
      case 'bottom':
        left = r.left + r.width / 2 - b.width / 2;
        top = r.bottom + gap;
        break;
      default:
        left = r.right + gap;
        top = r.top;
    }

    // Keep it on screen whatever the chosen side worked out to.
    left = Math.max(12, Math.min(left, vw - b.width - 12));
    top = Math.max(12, Math.min(top, vh - b.height - 12));

    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.style.visibility = 'visible';
  }

  function show(): void {
    const step = live[index];
    if (!step) return finish();
    step.before?.();

    $('.tour-count').textContent = `${index + 1} of ${live.length}`;
    $('.tour-title').textContent = step.title;
    $('.tour-body').textContent = step.body;
    ($('.tour-back') as HTMLButtonElement).disabled = index === 0;
    $('.tour-next').textContent = index === live.length - 1 ? 'Done' : 'Next';

    // The `before` hook may have switched tabs, so let the layout settle
    // before measuring anything.
    requestAnimationFrame(() => place(step));
  }

  function go(delta: number): void {
    const next = index + delta;
    if (next < 0) return;
    if (next >= live.length) return finish();
    index = next;
    show();
  }

  function finish(): void {
    markSeen();
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    if (onKey) document.removeEventListener('keydown', onKey);
    root.remove();
    done?.();
    done = null;
  }

  function reposition(): void {
    const step = live[index];
    if (step) place(step);
  }

  return {
    run() {
      // Steps whose target is not on screen are dropped rather than shown
      // pointing at nothing — the Elements panel, for instance, does not
      // exist until artwork is open.
      live = steps.filter((s) => usable(s.target));
      if (live.length === 0) {
        markSeen();
        return Promise.resolve();
      }
      index = 0;
      document.body.append(root);

      $('.tour-next').addEventListener('click', () => go(1));
      $('.tour-back').addEventListener('click', () => go(-1));
      $('.tour-skip').addEventListener('click', finish);

      onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') finish();
        else if (e.key === 'ArrowRight') go(1);
        else if (e.key === 'ArrowLeft') go(-1);
      };
      document.addEventListener('keydown', onKey);
      window.addEventListener('resize', reposition);
      // Capture phase: the rail scrolls, not the window.
      window.addEventListener('scroll', reposition, true);

      show();
      return new Promise<void>((resolve) => {
        done = resolve;
      });
    },
  };
}
