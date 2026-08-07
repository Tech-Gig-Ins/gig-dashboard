// app/api/billing/generate/route.ts
//
// POST body: { month: "August 2026" }
//
// Invokes the reconcile-billing Lambda synchronously and returns its payload.
// The Lambda reads the two source files from billing-sources/{YYYY-MM}/ and
// writes billing-reports/Reconciliation_Output_<Month>_<Year>.xlsx, which is
// where /api/billing/report-file looks for it.
//
// Note the function is named "reconcile-billing" (no -lambda suffix), unlike
// consultant-report-lambda. The IAM role it runs as is called
// reconcile-billing-lambda-role, which is a separate thing; do not confuse them.

import { NextRequest, NextResponse } from 'next/server';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

import { requireAdmin } from '@/lib/auth';
const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const FUNCTION_NAME = process.env.BILLING_LAMBDA_NAME || 'reconcile-billing';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

// After a successful run, drop any approved-file override for the month so the
// freshly generated report is what gets displayed.
//
// report-file resolves the displayed file as:
//     approvedKey || Reconciliation_Output_<Month>_<Year>.xlsx
// so without this the Lambda would write a new report that nobody ever sees,
// because an older approved file keeps winning.
//
// This only rewrites the small approved.json pointer. No report files are
// copied, moved or duplicated: the generated xlsx is overwritten in place by
// the Lambda, and approved files stay where they were uploaded.
async function clearApproval(prefix: string, who: string) {
  const jsonKey = `billing-updates/${prefix}/approved.json`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: jsonKey,
    Body: JSON.stringify(
      { approvedKey: null, clearedAt: new Date().toISOString(), clearedBy: who },
      null, 2
    ),
    ContentType: 'application/json',
  }));
}

const lambda = new LambdaClient({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

// "August 2026" -> "2026-08". Returned to the client so it can be logged or
// displayed; the Lambda derives its own prefix from curr_month.
function monthToPrefix(label: string): string | null {
  const parts = String(label || '').trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const mi = MONTH_NAMES.findIndex(m => m.toLowerCase() === parts[0].toLowerCase());
  const yr = parseInt(parts[1], 10);
  if (mi < 0 || !Number.isFinite(yr) || yr < 2020 || yr > 2099) return null;
  return `${yr}-${String(mi + 1).padStart(2, '0')}`;
}

export async function POST(req: NextRequest) {
  // Auth boundary. proxy.ts only does an optimistic cookie check;
  // this is what actually verifies the token and role.
  const gate = await requireAdmin(req);
  if (gate instanceof NextResponse) return gate;

  try {
    const body = await req.json().catch(() => ({}));
    const month: string = body.month || body.curr_month || '';

    if (!month) {
      return NextResponse.json(
        { error: 'month is required (e.g. "August 2026")' },
        { status: 400 }
      );
    }
    const prefix = monthToPrefix(month);
    if (!prefix) {
      return NextResponse.json(
        { error: `Could not parse month "${month}". Expected a label like "August 2026".` },
        { status: 400 }
      );
    }

    // The July 9 run took ~4.4s plus ~3s cold start, so this is comfortable.
    const payloadObj = { curr_month: month, bucket: BUCKET };

    const started = Date.now();
    const result = await lambda.send(new InvokeCommand({
      FunctionName: FUNCTION_NAME,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(JSON.stringify(payloadObj)),
      LogType: 'None',
    }));
    const durationMs = Date.now() - started;

    if (result.FunctionError) {
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
      // reconcile-billing may return a bare string or nothing at all. That is
      // not a failure: the report is written to S3 regardless, so report-file
      // will pick it up. Surface the raw text instead of erroring.
      await clearApproval(prefix, gate.email);
      return NextResponse.json({
        ok: true,
        month,
        monthPrefix: prefix,
        durationMs,
        clearedApproval: true,
        raw: payloadText,
      });
    }

    await clearApproval(prefix, gate.email);
    return NextResponse.json({
      ok: true,
      month,
      monthPrefix: prefix,
      durationMs,
      clearedApproval: true,
      ...(payload && typeof payload === 'object' ? payload : { result: payload }),
    });
  } catch (err: any) {
    // A missing lambda:InvokeFunction grant surfaces here as AccessDeniedException.
    const name = err?.name || '';
    if (name === 'AccessDeniedException' || name === 'AccessDenied') {
      return NextResponse.json({
        error: `Not authorized to invoke ${FUNCTION_NAME}. The dashboard's IAM user ` +
               `needs lambda:InvokeFunction on that function.`,
      }, { status: 403 });
    }
    if (name === 'ResourceNotFoundException') {
      return NextResponse.json({
        error: `Lambda function "${FUNCTION_NAME}" not found in ${REGION}.`,
      }, { status: 404 });
    }
    console.error('billing/generate error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to invoke Lambda' },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const maxDuration = 60;