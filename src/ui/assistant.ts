/**
 * The assistant panel: a conversation that can drive the studio.
 *
 * The model runs on the server; this is the other half of the agent. It
 * sends the conversation and a snapshot of the studio, streams the reply
 * into the transcript, and when the model asks for a tool it runs it —
 * through a whitelist the studio provides (StudioApi) — and sends the result
 * back for the next step. Everything the model can do, a user can do by
 * clicking; the tools call the same code the controls do.
 *
 * The conversation is kept per tab (sessionStorage) and sent in full every
 * time: the server stores nothing. Assistant turns are stored exactly as
 * received, because the model's own blocks carry signatures that must go
 * back untouched; the history is append-only.
 */
import {
  TOOL_SCHEMAS,
  describeToolCall,
  type StudioSnapshot,
  type ToolName,
} from '../lib/assistant-tools';

export interface StudioApi {
  snapshot(): StudioSnapshot;
  /** Run one whitelisted action. Returns a one-line account of what changed. */
  run(name: ToolName, input: unknown): Promise<string>;
  /** Prompt for sign-in; resolves true once signed in. */
  signIn(): Promise<boolean>;
}

type TextBlock = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type AnyBlock = { type: string } & Record<string, unknown>;
type UserContent =
  | string
  | Array<TextBlock | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }>;
type Message = { role: 'user'; content: UserContent } | { role: 'assistant'; content: AnyBlock[] };

type Event =
  | { type: 'text'; text: string }
  | { type: 'message'; content: AnyBlock[]; stop_reason: string | null; model: string }
  | { type: 'error'; message: string };

const STORE_KEY = 'cutline-assistant-v1';
/** Tool rounds per user message. A loop that long is not a conversation. */
const MAX_ROUNDS = 8;
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;

export function mountAssistant(api: StudioApi): void {
  // Typed as present: the markup is ours. The runtime check below is for a
  // page that lacks it (the frozen /v1 snapshot never mounts this).
  const panel = $('#assistant') as HTMLElement;
  const toggle = $('#btn-assistant') as HTMLButtonElement;
  const log = $('#asst-log') as HTMLElement;
  const form = $('#asst-form') as HTMLFormElement;
  const input = $('#asst-input') as HTMLTextAreaElement;
  const send = $('#asst-send') as HTMLButtonElement;
  const stop = $('#asst-stop') as HTMLButtonElement;
  const close = $('#asst-close') as HTMLButtonElement | null;
  const clear = $('#asst-clear') as HTMLButtonElement | null;
  if (!panel || !toggle || !log || !form || !input || !send || !stop) return;

  let messages: Message[] = load();
  let busy = false;
  let aborter: AbortController | null = null;

  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    document.body.classList.toggle('assistant-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  close?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden && document.activeElement === input) setOpen(false);
  });

  clear?.addEventListener('click', () => {
    if (busy) return;
    messages = [];
    save(messages);
    log.replaceChildren();
    welcome();
  });

  const setBusy = (on: boolean) => {
    busy = on;
    send.disabled = on;
    input.disabled = on;
    stop.hidden = !on;
    panel.classList.toggle('is-busy', on);
  };
  stop.addEventListener('click', () => aborter?.abort());

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit();
  });
  // Enter sends; Shift+Enter is a new line, as in every chat box.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  });

  async function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    messages.push({ role: 'user', content: text });
    save(messages);
    bubble('user', text);
    await runTurn();
  }

  /** One user message, through as many tool rounds as the model needs. */
  async function runTurn() {
    setBusy(true);
    aborter = new AbortController();
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const result = await requestTurn(aborter.signal);
        if (result.kind === 'aborted') {
          note('Stopped.');
          // The history must stay append-only and end on a user message
          // for the next turn, so a stopped reply is simply not recorded.
          dropTrailingUser();
          break;
        }
        if (result.kind === 'signin') {
          const ok = await api.signIn();
          if (!ok) {
            note('Sign in to use the assistant.');
            dropTrailingUser();
            break;
          }
          round--; // retry the same request, now signed in
          continue;
        }
        if (result.kind === 'error') {
          note(result.message);
          dropTrailingUser();
          break;
        }
        const message = result.message;
        messages.push({ role: 'assistant', content: message.content });
        save(messages);

        if (message.stop_reason === 'refusal') {
          note('The assistant declined that request.');
          break;
        }
        // A reply cut off by the output cap can end in a truncated tool call
        // that still parses; never run that turn's tools.
        if (message.stop_reason === 'max_tokens') {
          note('That reply was cut short — ask again.');
          break;
        }
        const calls = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
        if (message.stop_reason !== 'tool_use' || calls.length === 0) break;

        // Every call runs, every call is answered, all results go back in
        // ONE user message — which is what keeps the model calling tools
        // in parallel when it can.
        const results: Extract<UserContent, unknown[]> = [];
        for (const call of calls) {
          results.push(await execute(call));
        }
        messages.push({ role: 'user', content: results });
        save(messages);
        if (round === MAX_ROUNDS - 1) note('That took too many steps — ask again more specifically.');
      }
    } finally {
      aborter = null;
      setBusy(false);
      input.focus();
    }
  }

  async function execute(call: ToolUseBlock): Promise<{
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }> {
    const name = call.name as ToolName;
    const schema = (TOOL_SCHEMAS as Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>)[name];
    if (!schema) {
      return { type: 'tool_result', tool_use_id: call.id, content: `Unknown tool "${call.name}".`, is_error: true };
    }
    // The server marked these strict, so this is a second line of defence —
    // but it is the line between "the model asked" and "the studio did".
    const parsed = schema.safeParse(call.input);
    if (!parsed.success) {
      return { type: 'tool_result', tool_use_id: call.id, content: 'Invalid arguments for that tool.', is_error: true };
    }
    const chip = action(describeToolCall(name, parsed.data));
    try {
      const outcome = await api.run(name, parsed.data);
      chip.classList.add('is-done');
      return { type: 'tool_result', tool_use_id: call.id, content: outcome };
    } catch (err) {
      chip.classList.add('is-failed');
      const msg = err instanceof Error ? err.message : String(err);
      return { type: 'tool_result', tool_use_id: call.id, content: msg, is_error: true };
    }
  }

  type TurnResult =
    | { kind: 'message'; message: { content: AnyBlock[]; stop_reason: string | null } }
    | { kind: 'signin' }
    | { kind: 'aborted' }
    | { kind: 'error'; message: string };

  /** One request: stream the text into a bubble, return the whole message. */
  async function requestTurn(signal: AbortSignal): Promise<TurnResult> {
    const el = bubble('assistant', '');
    el.classList.add('is-streaming');
    let res: Response;
    try {
      res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ messages, snapshot: api.snapshot() }),
        signal,
      });
    } catch (err) {
      el.remove();
      if (signal.aborted) return { kind: 'aborted' };
      return { kind: 'error', message: 'Could not reach the assistant — check your connection.' };
    }
    if (res.status === 401) {
      el.remove();
      return { kind: 'signin' };
    }
    if (!res.ok || !res.body) {
      el.remove();
      const body = await res.json().catch(() => ({}) as { error?: string });
      return { kind: 'error', message: typeof body.error === 'string' ? body.error : 'The assistant could not answer.' };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let final: Extract<Event, { type: 'message' }> | null = null;
    let error: string | null = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let ev: Event;
          try {
            ev = JSON.parse(line.slice(6)) as Event;
          } catch {
            continue;
          }
          if (ev.type === 'text') {
            text += ev.text;
            el.textContent = text;
            log.scrollTop = log.scrollHeight;
          } else if (ev.type === 'message') {
            final = ev;
          } else if (ev.type === 'error') {
            error = ev.message;
          }
        }
      }
    } catch {
      if (signal.aborted) {
        el.remove();
        return { kind: 'aborted' };
      }
      error = 'The connection dropped mid-reply.';
    }
    el.classList.remove('is-streaming');
    if (error) {
      el.remove();
      return { kind: 'error', message: error };
    }
    if (!final) {
      el.remove();
      return { kind: 'error', message: 'The assistant did not finish its reply — try again.' };
    }
    // A turn that was only tool calls has no text; drop the empty bubble.
    if (!text.trim()) el.remove();
    return { kind: 'message', message: { content: final.content, stop_reason: final.stop_reason } };
  }

  function dropTrailingUser() {
    // Only a dangling user message is removed — never an assistant turn.
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      messages.pop();
      save(messages);
    }
  }

  /* ---------------- transcript ---------------- */

  function bubble(role: 'user' | 'assistant', text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `asst-msg asst-${role}`;
    el.textContent = text;
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function action(label: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'asst-action';
    el.textContent = label;
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function note(text: string) {
    const el = document.createElement('div');
    el.className = 'asst-note';
    el.textContent = text;
    log.append(el);
    log.scrollTop = log.scrollHeight;
  }
  function welcome() {
    const el = document.createElement('div');
    el.className = 'asst-welcome';
    el.textContent =
      'Ask for what you want and I will do it in the studio — "make the border tighter", "cut the holes out", "remove the background", "why are there so many nodes?".';
    log.append(el);
  }

  /** Redraw the transcript from the stored conversation. */
  function replay() {
    log.replaceChildren();
    if (messages.length === 0) {
      welcome();
      return;
    }
    for (const m of messages) {
      if (m.role === 'user') {
        if (typeof m.content === 'string') bubble('user', m.content);
        else for (const b of m.content) if (b.type === 'text') bubble('user', b.text);
      } else {
        for (const b of m.content) {
          if (b.type === 'text' && typeof b.text === 'string' && (b.text as string).trim()) {
            bubble('assistant', b.text as string);
          } else if (b.type === 'tool_use') {
            action(describeToolCall(b.name as ToolName, b.input)).classList.add('is-done');
          }
        }
      }
    }
  }

  replay();
}

/* ---------------- storage ---------------- */

function load(): Message[] {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // A conversation must end on an assistant turn to be resumable; a
    // dangling user message (the tab closed mid-reply) is dropped.
    const msgs = parsed as Message[];
    while (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();
    return msgs;
  } catch {
    return [];
  }
}

function save(messages: Message[]) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(messages));
  } catch {
    // Private mode or a full store: the conversation simply does not survive a reload.
  }
}
