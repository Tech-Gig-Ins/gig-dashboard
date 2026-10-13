// Located at: app/api/assistant/route.ts
//
// POST { history: [{ role, text }], page } -> { reply, actions }
// The dashboard assistant (lib/assistant.ts), running as the signed-in person.
// Works in a View as tab too: it then acts as the viewed account, and the
// question is recorded in PA Monitor.

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { runAssistant, type ChatTurn } from '@/lib/assistant';
import { recordAiEntry } from '@/lib/aiLog';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  const gate = await requireAuth(req);
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const history: ChatTurn[] = Array.isArray(body?.history) ? body.history : [];

  // Tools call the dashboard's own API as this person: same address, same
  // cookies, same View as header.
  const fwdHost = req.headers.get('x-forwarded-host');
  const fwdProto = req.headers.get('x-forwarded-proto') || 'https';
  const origin = fwdHost ? `${fwdProto}://${fwdHost}` : new URL(req.url).origin;

  // Monitor > AI Assistant: record this exchange (question, answer, lookups).
  const started = Date.now();
  const lastQuestion = [...history].reverse().find(t => t?.role === 'user')?.text || '';
  const log = (answer: string, extra: { lookups?: string[]; proposed?: string[]; opened?: string[]; error?: string | null }) =>
    recordAiEntry({
      kind: 'exchange',
      user: gate.actualEmail || gate.email,
      actingAs: gate.isImpersonating ? gate.email : null,
      convId: String(body?.convId || '').slice(0, 64),
      page: String(body?.page || ''),
      question: String(lastQuestion).slice(0, 8000),
      answer: String(answer).slice(0, 60000),
      ms: Date.now() - started,
      ...extra,
    });

  try {
    const out = await runAssistant({
      session: gate,
      origin,
      cookie: req.headers.get('cookie') || '',
      viewAs: req.headers.get('x-view-as'),
      page: String(body?.page || ''),
      history,
    });
    await log(out.reply, {
      lookups: (out.trace || []).map(t => t.label),
      proposed: out.actions.filter(a => a.type === 'confirm').map(a => (a as any).summary),
      opened: out.actions.filter(a => a.type !== 'confirm').map(a => a.type === 'navigate'
        ? `Opened ${a.page}${a.month ? `, ${a.month}` : ''}${a.sheet ? `, sheet ${a.sheet}` : ''}${a.search ? `, searched "${a.search}"` : ''}`
        : `Download: ${(a as any).filename || (a as any).consultant || (a as any).month || ''}`),
      error: null,
    });
    return NextResponse.json(out, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err: any) {
    console.error('[assistant]', err?.name, err?.message);
    const text = `${err?.name} ${err?.message}`;
    const reply =
      /ResourceNotFound|end of its life|not found|invalid model|model identifier/i.test(text)
        ? 'The assistant\'s AI model is not available: the model ID in BEDROCK_MODEL_ID is retired or wrong. An administrator needs to set it to a current Claude model in Bedrock.'
      : /AccessDenied|not authorized|don't have access|model.*access/i.test(text)
        ? 'The assistant cannot use the AI model yet. An administrator needs to request model access in Bedrock and attach the dashboard-bedrock permission.'
      : /Throttling|Too many|ServiceUnavailable|ModelNotReady/i.test(text)
        ? 'The AI model is busy right now. Please try again in a moment.'
      : 'Sorry, something went wrong. Please try again.';
    await log(reply, { error: `${err?.name || 'Error'}: ${err?.message || ''}`.slice(0, 500) });
    return NextResponse.json({ reply, actions: [], trace: [] }, { status: 200 });
  }
}