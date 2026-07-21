// Located at: app/api/file-content/route.ts
//
// Downloads a single file from S3 and returns parsed contents.
// Handles CSV and XLSX. Returns first N rows to keep responses small.

import { NextResponse } from 'next/server';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as XLSX from 'xlsx';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const MAX_ROWS = 500;

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

async function streamToBuffer(stream: ReadableStream<Uint8Array> | any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader ? stream.getReader() : null;

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } else {
    // Node stream fallback
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  // Handle CSV with possible quoted fields containing newlines
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += c;
    } else if (c === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (c === '\r' && !inQuotes) {
      // skip
    } else {
      current += c;
    }
  }
  if (current) lines.push(current);

  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let field = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (c === ',' && !inQ) {
        fields.push(field);
        field = '';
      } else {
        field += c;
      }
    }
    fields.push(field);
    return fields;
  };

  const headers = parseLine(lines[0]);
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    rows.push(parseLine(lines[i]));
  }

  return { headers, rows };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');

  if (!key) {
    return NextResponse.json({ error: 'Missing key parameter' }, { status: 400 });
  }

  try {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const res = await s3.send(cmd);

    if (!res.Body) {
      return NextResponse.json({ error: 'Empty file body' }, { status: 500 });
    }

    const buffer = await streamToBuffer(res.Body as any);
    const lowerKey = key.toLowerCase();

    // CSV
    if (lowerKey.endsWith('.csv')) {
      const text = buffer.toString('utf8');
      const parsed = parseCSV(text);
      const totalRows = parsed.rows.length;
      const rows = parsed.rows.slice(0, MAX_ROWS);
      return NextResponse.json({
        headers: parsed.headers,
        rows,
        totalRows,
      });
    }

    // XLSX (Excel)
    if (lowerKey.endsWith('.xlsx') || lowerKey.endsWith('.xls')) {
      const wb = XLSX.read(buffer, { type: 'buffer' });

      let sheetName = wb.SheetNames[0];
      // Corechoice Direct T1/T3, Decisely GWU1/GWU2, and any GWU1/GWU2 file:
      // read ONLY the Anthem Medical sheet. Falls back to the first sheet if
      // no Anthem Medical sheet exists in the workbook.
      const normKey = lowerKey.replace(/[^a-z0-9]/g, '');
      const anthemMedicalOnly =
        (normKey.includes('corechoice') && (normKey.includes('t1') || normKey.includes('t3'))) ||
        normKey.includes('gwu1') ||
        normKey.includes('gwu2');
      if (anthemMedicalOnly) {
        const anthemSheet = wb.SheetNames.find(
          (n) => n.toLowerCase().replace(/[^a-z0-9]/g, '').includes('anthemmedical')
        );
        if (anthemSheet) sheetName = anthemSheet;
      }

      const ws = wb.Sheets[sheetName];
      const allData: any[][] = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        raw: false,
        defval: '',
      });

      if (allData.length === 0) {
        return NextResponse.json({ headers: [], rows: [], totalRows: 0, sheetName });
      }

      // Cassena-style files have a preamble. Detect: find first row with 5+ non-empty cells
      let headerRowIdx = 0;
      const filenameLower = key.split('/').pop()?.toLowerCase() || '';
      const isCassenaStyle =
        !lowerKey.includes('nyp') &&
        !lowerKey.includes('corechoice') &&
        allData[0] &&
        allData[0].filter((v: any) => v !== '' && v != null).length < 3;

      if (isCassenaStyle) {
        for (let i = 0; i < Math.min(25, allData.length); i++) {
          const nonEmpty = allData[i].filter((v: any) => v !== '' && v != null).length;
          if (nonEmpty >= 5) {
            headerRowIdx = i;
            break;
          }
        }
      }

      const headers = (allData[headerRowIdx] || []).map((v: any) => String(v ?? ''));
      const dataRows = allData.slice(headerRowIdx + 1).filter((r) =>
        r.some((v: any) => v !== '' && v != null)
      );
      const totalRows = dataRows.length;
      const rows = dataRows.slice(0, MAX_ROWS).map((r) =>
        headers.map((_h: string, idx: number) => String(r[idx] ?? ''))
      );

      return NextResponse.json({ headers, rows, totalRows, sheetName });
    }

    // Unknown file type
    return NextResponse.json(
      { error: `Unsupported file type. Only CSV and Excel files can be previewed.` },
      { status: 400 }
    );
  } catch (err: any) {
    console.error('File content error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to load file' },
      { status: 500 }
    );
  }
}