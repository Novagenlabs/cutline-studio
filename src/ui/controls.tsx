/**
 * Base UI controls, mounted into the plain-TS cutter.
 *
 * The cutter is not a React app and is not becoming one. This is a set of
 * small islands: each one replaces a single hand-rolled control, reads and
 * writes the same state the rest of the app already uses, and reports changes
 * through a plain callback. Everything outside these mounts stays imperative.
 *
 * Why bother: the hand-rolled slider was a native range input with its track,
 * ticks and thumb drawn underneath it, and keeping the painted thumb aligned
 * with that artwork meant guessing at vendor pseudo-element box models. It was
 * wrong three times — horizontally, then at the ends, then vertically — and
 * each fix was invisible to the test that was supposed to catch it, because
 * the thumb is not a DOM node you can measure. Base UI's thumb IS a DOM node,
 * positioned by the library, so the alignment question stops existing.
 *
 * React 19 is already a dependency (Next serves the account pages with it), so
 * this adds a mount, not a framework.
 */
import { createRoot, type Root } from 'react-dom/client';
import { Slider } from '@base-ui-components/react/slider';
import { Switch } from '@base-ui-components/react/switch';
import { Checkbox } from '@base-ui-components/react/checkbox';
import { Select } from '@base-ui-components/react/select';
import { Button } from '@base-ui-components/react/button';
import { Meter } from '@base-ui-components/react/meter';

const roots = new WeakMap<Element, Root>();

/** Mount (or re-render) a React island on an element, reusing its root. */
function mount(host: Element, node: React.ReactNode): void {
  let root = roots.get(host);
  if (!root) {
    root = createRoot(host);
    roots.set(host, root);
  }
  root.render(node);
}

/* ---------------- cut style slider ---------------- */

export interface CutStop {
  id: string;
  label: string;
  sub: string;
}

export interface CutSliderOptions {
  stops: CutStop[];
  value: number;
  onChange: (index: number) => void;
}

function CutSlider({ stops, value, onChange }: CutSliderOptions) {
  return (
    <Slider.Root
      value={value}
      min={0}
      max={stops.length - 1}
      step={1}
      onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
      aria-label="Cut style"
      // The stop name, not "2" — a screen reader should say "Sticker".
      format={{ style: 'decimal' }}
    >
      <Slider.Control className="bui-slider-control">
        <Slider.Track className="bui-slider-track">
          {/* Ticks are positioned as a fraction of the track, and the track is
              exactly the thumb's travel range, so they cannot drift out of
              step with the thumb the way the hand-drawn ones did. */}
          <span className="bui-slider-ticks" aria-hidden="true">
            {stops.map((s, i) => (
              <span
                key={s.id}
                className={`bui-slider-tick${i <= value ? ' is-passed' : ''}`}
                style={{ left: `${(i / (stops.length - 1)) * 100}%` }}
              />
            ))}
          </span>
          <Slider.Indicator className="bui-slider-indicator" />
          <Slider.Thumb className="bui-slider-thumb" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}

export function mountCutSlider(host: Element, opts: CutSliderOptions): void {
  mount(host, <CutSlider {...opts} />);
}

/* ---------------- plain value slider ---------------- */

export interface ValueSliderOptions {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  onChange: (value: number) => void;
}

/**
 * Uncontrolled on purpose.
 *
 * With `value`, the host has to re-render on every change to make the thumb
 * move — and re-rendering mid-drag replaces the element the pointer is
 * captured on, so the drag dies after one pixel. `defaultValue` lets Base UI
 * own the position during the gesture and report it outwards; external writes
 * (selecting a region, applying a preset) remount with a new `key` instead.
 */
function ValueSlider({ value, min, max, step, label, onChange }: ValueSliderOptions) {
  return (
    <Slider.Root
      defaultValue={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
      aria-label={label}
    >
      <Slider.Control className="bui-slider-control">
        <Slider.Track className="bui-slider-track">
          <Slider.Indicator className="bui-slider-indicator" />
          <Slider.Thumb className="bui-slider-thumb" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}

/**
 * `key` on the seed value: because the slider is uncontrolled, the only way
 * an external write (region selected, preset applied) can move the thumb is
 * to mount a fresh instance seeded with the new number. During a drag nobody
 * calls this, so the gesture is never interrupted.
 */
export function mountValueSlider(host: Element, opts: ValueSliderOptions): void {
  mount(host, <ValueSlider key={opts.value} {...opts} />);
}

/* ---------------- switch ---------------- */

export interface SwitchOptions {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

export function mountSwitch(host: Element, opts: SwitchOptions): void {
  mount(
    host,
    <Switch.Root
      checked={opts.checked}
      onCheckedChange={opts.onChange}
      className="bui-switch"
      aria-label={opts.label}
    >
      <Switch.Thumb className="bui-switch-thumb" />
    </Switch.Root>
  );
}

/* ---------------- checkbox ---------------- */

export interface CheckboxOptions {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

export function mountCheckbox(host: Element, opts: CheckboxOptions): void {
  mount(
    host,
    <Checkbox.Root
      checked={opts.checked}
      onCheckedChange={opts.onChange}
      className="bui-checkbox"
      aria-label={opts.label}
    >
      <Checkbox.Indicator className="bui-checkbox-indicator">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5 12.5l4.5 4.5L19 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}

/* ---------------- select ---------------- */

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectOptions {
  value: string;
  options: SelectOption[];
  label: string;
  onChange: (value: string) => void;
}

/**
 * A native <select> cannot be themed: the popup is drawn by the OS, so on a
 * near-black interface it opens as a bright system list. The trigger here is
 * ours and so is the list, which is the whole reason to replace it — the old
 * one had a background-image arrow painted over it to hide half the problem.
 */
export function mountSelect(host: Element, opts: SelectOptions): void {
  mount(
    host,
    <Select.Root
      value={opts.value}
      onValueChange={(v) => opts.onChange(String(v))}
    >
      <Select.Trigger className="bui-select-trigger" aria-label={opts.label}>
        {/* The label, not the value. Select.Value renders the raw value when
            it cannot resolve a label from the items, which showed "kiss"
            where the list says "Kiss cut · CutContour". */}
        <span className="bui-select-value">
          {opts.options.find((o) => o.value === opts.value)?.label ?? opts.value}
        </span>
        <Select.Icon className="bui-select-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="bui-select-positioner" sideOffset={6}>
          <Select.Popup className="bui-select-popup">
            {opts.options.map((o) => (
              <Select.Item key={o.value} value={o.value} className="bui-select-item">
                <Select.ItemText className="bui-select-item-text">{o.label}</Select.ItemText>
                <Select.ItemIndicator className="bui-select-item-check">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

/* ---------------- button ---------------- */

export interface ButtonOptions {
  label: string;
  /** Optional leading icon, as raw SVG markup. */
  iconSvg?: string;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  /**
   * A stable id for the rendered <button>.
   *
   * The element is re-created on every state change, so anything outside
   * React needs a handle that survives a re-render — tests especially, which
   * would otherwise have to match on a label that changes while busy.
   */
  id?: string;
  onClick: () => void;
}

/**
 * A Base UI button.
 *
 * Worth the mount rather than a styled <button> for what the library handles
 * that hand-rolled markup routinely gets wrong: a disabled button that still
 * takes focus when asked to, consistent `data-disabled` styling hooks, and
 * correct behaviour for keyboard activation across browsers. The busy state
 * is ours — it sets aria-busy so a screen reader announces the wait rather
 * than reading a label that silently changed underneath it.
 */
export function mountButton(host: Element, opts: ButtonOptions): void {
  mount(
    host,
    <Button
      id={opts.id}
      className={`bui-btn bui-btn-${opts.variant ?? 'primary'}`}
      disabled={opts.disabled || opts.busy}
      // Keeps the control reachable while it is working, so focus is not
      // dumped back to the document mid-task.
      focusableWhenDisabled
      aria-busy={opts.busy || undefined}
      onClick={opts.onClick}
    >
      {opts.iconSvg ? (
        <span
          className="bui-btn-icon"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: opts.iconSvg }}
        />
      ) : null}
      <span className="bui-btn-label">{opts.label}</span>
    </Button>
  );
}

/* ---------------- credit meter ---------------- */

export interface CreditMeterOptions {
  /** Credits left. */
  value: number;
  /**
   * The top of the bar. Not a hard ceiling — a balance can exceed it by
   * buying packs on top of a subscription — so the caller passes whatever
   * makes the number legible and the component clamps the fill.
   */
  max: number;
  /** Shown above the bar, e.g. "200 credits". */
  label?: string;
}

/**
 * The balance as a bar, not just a number.
 *
 * A Meter rather than a Progress: this is a measurement of something that
 * exists, not the progress of a task that is running, and the two carry
 * different semantics for assistive tech. Base UI's Meter renders the right
 * role and value attributes without us restating them.
 *
 * The fill is clamped rather than the value: a subscriber who also buys a
 * pack legitimately holds more than one period's allowance, and a bar that
 * overflows its track looks broken while reporting the truth.
 */
export function mountCreditMeter(host: Element, opts: CreditMeterOptions): void {
  const max = Math.max(1, opts.max);
  const shown = Math.min(opts.value, max);
  const low = opts.value <= 3;
  mount(
    host,
    <Meter.Root
      value={shown}
      max={max}
      className={`bui-meter${low ? ' is-low' : ''}`}
      // The visible number is the real balance, which may exceed `max`; the
      // bar is the clamped one. Announcing the clamped figure would quietly
      // under-report what the user actually has.
      getAriaValueText={() => `${opts.value} credits remaining`}
    >
      {opts.label ? <Meter.Label className="bui-meter-label">{opts.label}</Meter.Label> : null}
      <Meter.Track className="bui-meter-track">
        <Meter.Indicator className="bui-meter-indicator" />
      </Meter.Track>
    </Meter.Root>
  );
}
