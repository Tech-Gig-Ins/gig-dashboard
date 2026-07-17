// Located at: app/api/consultant/generate/route.ts
//
// POST body: { curr_month: "July 2026", prev_month: "June 2026" }
//
// Invokes consultant-report-lambda synchronously and returns its payload.
// The Lambda takes a few seconds to run through the parsing / assignment /
// workbook generation, then writes both output files back to S3.

import { NextRequest, NextResponse } from 'next/server';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const FUNCTION_NAME = process.env.CONSULTANT_LAMBDA_NAME || 'consultant-report-lambda';

const lambda = new LambdaClient({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

// Compute previous month label from a "July 2026" style string.
// Only used when the client didn't supply prev_month explicitly.
function prevMonthLabel(curr: string): string | null {
  const months = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  const parts = curr.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const mi = months.findIndex(m => m.toLowerCase() === parts[0].toLowerCase());
  const yr = parseInt(parts[1], 10);
  if (mi < 0 || !Number.isFinite(yr)) return null;
  if (mi === 0) return `December ${yr - 1}`;
  return `${months[mi - 1]} ${yr}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const curr_month: string = body.curr_month || '';
    const prev_month: string = body.prev_month || prevMonthLabel(curr_month) || '';

    if (!curr_month) {
      return NextResponse.json(
        { error: 'curr_month is required (e.g. "July 2026")' },
        { status: 400 }
      );
    }

    const payloadObj = {
      curr_month,
      prev_month,
      bucket: BUCKET,
    };

    const started = Date.now();
    const result = await lambda.send(new InvokeCommand({
      FunctionName: FUNCTION_NAME,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(JSON.stringify(payloadObj)),
      LogType: 'None',
    }));
    const durationMs = Date.now() - started;

    if (result.FunctionError) {
      // Lambda ran but the handler raised
      const errText = result.Payload
        ? new TextDecoder().decode(result.Payload)
        : 'Unknown Lambda error';
      return NextResponse.json(
        { error: `Lambda handler error: ${errText}`, durationMs },
        { status: 500 }
      );
    }

    const payloadText = result.Payload ? new TextDecoder().decode(result.Payload) : '{}';
    let payload: any;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      return NextResponse.json(
        { error: 'Lambda returned non-JSON response', raw: payloadText, durationMs },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      durationMs,
      ...payload,
    });
  } catch (err: any) {
    console.error('consultant/generate error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to invoke Lambda' },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
// The Lambda cold-starts around 2-3 seconds and typically finishes within
// 10-15 seconds. Allow well past that for larger months.
export const maxDuration = 60;