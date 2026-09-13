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
