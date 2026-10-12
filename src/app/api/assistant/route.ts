import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import {
  BodySchema,
  EFFORT,
  MAX_BODY_BYTES,
  MAX_OUTPUT_TOKENS,
  MODEL,
  SYSTEM_PROMPT,
  buildMessages,
  buildTools,
  sse,
} from '@/lib/assistant-server';

/**
 * One turn of the studio assistant.
 *
 * The browser sends the conversation so far plus a snapshot of the studio;
 * this streams the model's reply back as server-sent events and, at the
 * end, the complete assistant message. If the model asked for tools, the
 * browser runs them and calls again with the results — the loop lives in
 * the browser because that is where the studio is. The server holds the
 * API key and the limits, and nothing else: no conversation is stored.
 *
 * Signed-in only. Every turn costs money, and an anonymous endpoint that
 * spends it is an invitation.
 */
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in to use the assistant.' }, { status: 401 });
  }
  const userId = session.user.id;

  // Abuse control, not a pricing model. A person typing cannot reach this;
  // a script can, and a script is what this is for.
  const limited = await rateLimit(`assistant:${userId}`, { max: 60, windowMs: 10 * 60_000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'The assistant is busy — try again in a few minutes.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.resetMs / 1000)) } }
    );
  }

  // Deploying before the key is set is a normal state. Say so plainly, and
  // log it, because the user-facing copy cannot name an environment variable.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set — /api/assistant cannot answer');
    return NextResponse.json(
      { error: 'The assistant is not available yet.' },
      { status: 503 }
    );
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'That conversation is too long — start a new one.' }, { status: 413 });
  }
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    // The browser builds this body itself, so a rejection is our bug; name
    // the field so it is a one-line fix rather than a shrug.
    const fields = parsed.error.issues.slice(0, 6).map((i) => ({
      field: i.path.join('.') || '(root)',
      problem: i.message,
    }));
    console.error('[assistant] rejected by schema', JSON.stringify(fields));
    return NextResponse.json({ error: 'Malformed assistant request.', fields }, { status: 400 });
  }
  const { messages, snapshot } = parsed.data;

  const client = new Anthropic();
  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Cached as a prefix: tools, then the frozen system prompt. The
      // per-turn state goes AFTER the history, as a system message in
      // messages, so it never touches this prefix.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: buildTools(),
      messages: buildMessages(messages, snapshot),
      output_config: { effort: EFFORT },
      // Thinking is always on for this model; depth comes from effort.
      // Safeguards may decline a request; the default fallback chain re-runs
      // it on a sibling model inside the same call rather than refusing.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    },
    { signal: req.signal }
  );

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(sse(event)));
      try {
        stream.on('text', (delta) => send({ type: 'text', text: delta }));
        const message = await stream.finalMessage();
        const u = message.usage;
        console.info(
          `[assistant] ${message.model} stop=${message.stop_reason} in=${u.input_tokens} cached=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`
        );
        // The whole content array, thinking blocks included: the browser
        // stores it verbatim and sends it back, which is what keeps the
        // conversation valid on this model.
        send({
          type: 'message',
          content: message.content,
          stop_reason: message.stop_reason,
          model: message.model,
        });
      } catch (err) {
        if (req.signal.aborted) {
          // The user pressed Stop; there is nobody to tell.
        } else if (err instanceof Anthropic.RateLimitError) {
          send({ type: 'error', message: 'The assistant is busy right now — try again in a moment.' });
        } else if (err instanceof Anthropic.AuthenticationError) {
          console.error('[assistant] the API key was rejected');
          send({ type: 'error', message: 'The assistant is not available right now.' });
        } else if (err instanceof Anthropic.APIError) {
          console.error(`[assistant] API error ${err.status}: ${err.message}`);
          send({ type: 'error', message: 'The assistant could not answer that — please try again.' });
        } else {
          console.error('[assistant] stream failed', err);
          send({ type: 'error', message: 'The assistant could not answer that — please try again.' });
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      stream.controller.abort();
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      // Proxies that buffer would turn a stream into a wait.
      'X-Accel-Buffering': 'no',
    },
  });
}
