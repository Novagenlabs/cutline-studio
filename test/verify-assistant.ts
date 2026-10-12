// The assistant panel, end to end in the browser — with the model scripted.
//
// Everything on the client side of the agent loop is exercised for real:
// the panel, the request body (conversation + studio snapshot), the stream
// parser, tool validation and execution against the actual studio, the
// tool-result message, and the second request that carries it. Only the
// model's replies are scripted, by answering /api/assistant from inside the
// page with the same server-sent events the route emits — so this needs no
// API key and spends nothing. The route itself is covered by
// assistant-server.test.ts.
//
// The scenario: the user asks for a tighter cut. Turn 1: the model says a
// word and calls set_cut_style(tight). The studio must actually switch to
// Tight. Turn 2: the request must carry the tool result, and the model's
// final sentence must land in the transcript.
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.APP_URL ?? 'http://localhost:3000';
const FIXTURE = 'test/fixtures/feelathome.png';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`);
  if (!ok) fails++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (ev: Record<string, unknown>) => `data: ${JSON.stringify(ev)}\n\n`;

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1500, height: 940 });

  // The scripted model. Each request body is kept so the loop can be
  // checked from the outside.
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }>; snapshot: Record<string, unknown> }> = [];
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/me')) {
      void req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ signedIn: true, balance: 5, signupGrant: 3 }),
      });
      return;
    }
    if (url.includes('/api/assistant') && req.method() === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}');
      bodies.push(body);
      const last = body.messages[body.messages.length - 1];
      const isToolTurn = Array.isArray(last.content) && last.content.some((c: { type: string }) => c.type === 'tool_result');
      const events = isToolTurn
        ? [
            frame({ type: 'text', text: 'Tightened: the cut now sits ' }),
            frame({ type: 'text', text: 'right on the edge.' }),
            frame({
              type: 'message',
              content: [{ type: 'text', text: 'Tightened: the cut now sits right on the edge.' }],
              stop_reason: 'end_turn',
              model: 'scripted',
            }),
          ]
        : [
            frame({ type: 'text', text: 'Setting the cut style to Tight.' }),
            frame({
              type: 'message',
              content: [
                { type: 'thinking', thinking: '', signature: 'sig-1' },
                { type: 'text', text: 'Setting the cut style to Tight.' },
                { type: 'tool_use', id: 'toolu_01', name: 'set_cut_style', input: { style: 'tight' } },
              ],
              stop_reason: 'tool_use',
              model: 'scripted',
            }),
          ];
      void req.respond({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: events.join(''),
      });
      return;
    }
    void req.continue();
  });

  await p.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await wait(6500);
  await p.evaluate(`document.querySelector('.tour-skip')?.click()`);
  await wait(400);
  const input = await p.$('input[type=file]');
  await input!.uploadFile(FIXTURE);
  await wait(5000);

  const text = async (sel: string) =>
    String(await p.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim() ?? ''`));
  const cut = async () => String(await p.evaluate(`document.getElementById('cut-path')?.getAttribute('d') || ''`));

  console.log('--- the panel ---');
  check((await p.evaluate(`document.getElementById('assistant').hidden`)) === true, 'closed to begin with');
  await p.evaluate(`document.getElementById('btn-assistant').click()`);
  await wait(300);
  check((await p.evaluate(`document.getElementById('assistant').hidden`)) === false, 'the top-bar button opens it');
  check((await text('.asst-welcome')).length > 0, 'and it says what it is for');
  check((await text('#out-cut-offset')) === '3.00 mm', 'the studio starts at Sticker (3.00 mm)');
  const before = await cut();

  console.log('\n--- turn 1: the model acts ---');
  await p.type('#asst-input', 'make the cut tighter');
  await p.keyboard.press('Enter');
  // Two requests, one tool execution and a retrace in between.
  for (let i = 0; i < 60 && bodies.length < 2; i++) await wait(250);
  await wait(1500);

  check(bodies.length >= 1, 'a request went to the assistant route');
  const first = bodies[0];
  check(first?.messages?.length === 1 && first.messages[0].role === 'user', 'carrying just the user message');
  check(typeof first?.snapshot?.cutStyle === 'string', `and a studio snapshot (cut style "${first?.snapshot?.cutStyle}")`);
  check(first?.snapshot?.cutStyle === 'sticker', 'which reported Sticker before anything changed');

  const chips = (await p.evaluate(`Array.from(document.querySelectorAll('.asst-action')).map((e) => e.textContent)`)) as string[];
  check(chips.includes('Cut style → Tight'), `the action was shown as a chip (${JSON.stringify(chips)})`);
  check((await text('#out-cut-offset')) === '0.00 mm', `the studio actually switched to Tight (got "${await text('#out-cut-offset')}")`);
  check((await cut()) !== before, 'and the cut changed');

  console.log('\n--- turn 2: the result goes back ---');
  check(bodies.length === 2, `a second request followed (${bodies.length} total)`);
  const second = bodies[1];
  const msgs = second?.messages ?? [];
  check(msgs.length === 3, `with the full history (${msgs.length} messages)`);
  const assistantTurn = msgs[1]?.content as Array<Record<string, unknown>> | undefined;
  check(
    Array.isArray(assistantTurn) && assistantTurn.some((c) => c.type === 'thinking' && c.signature === 'sig-1'),
    'the assistant turn was echoed back verbatim, signature included',
  );
  const resultTurn = msgs[2]?.content as Array<Record<string, unknown>> | undefined;
  const result = Array.isArray(resultTurn) ? resultTurn.find((c) => c.type === 'tool_result') : undefined;
  check(!!result && result.tool_use_id === 'toolu_01', 'and the tool result answers the right call');
  check(
    typeof result?.content === 'string' && /tight/i.test(result.content) && /nodes/.test(result.content),
    `the result tells the model what changed ("${String(result?.content).slice(0, 70)}…")`,
  );
  check(second?.snapshot?.cutStyle === 'tight', 'the second snapshot reports Tight');

  const replies = (await p.evaluate(`Array.from(document.querySelectorAll('.asst-assistant')).map((e) => e.textContent)`)) as string[];
  check(replies.some((r) => r.includes('right on the edge')), 'the final sentence landed in the transcript');
  check(
    (await p.evaluate(`document.getElementById('asst-send').disabled`)) === false,
    'and the composer is ready for the next message',
  );

  console.log('\n--- the conversation survives a reload ---');
  await p.reload({ waitUntil: 'networkidle2' });
  await wait(3000);
  await p.evaluate(`document.querySelector('.tour-skip')?.click()`);
  await wait(300);
  await p.evaluate(`document.getElementById('btn-assistant').click()`);
  await wait(300);
  const replayed = (await p.evaluate(`Array.from(document.querySelectorAll('.asst-assistant, .asst-user')).map((e) => e.textContent)`)) as string[];
  check(replayed.some((r) => r.includes('make the cut tighter')), 'the user message is still there');
  check(replayed.some((r) => r.includes('right on the edge')), 'and so is the reply');

  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
