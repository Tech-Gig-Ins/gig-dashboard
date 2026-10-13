// Located at: lib/assistant.ts
//
// The dashboard assistant. Claude runs on Amazon Bedrock in this AWS account,
// so questions and dashboard data stay inside AWS.
//
// How it answers safely:
//   - Read tools call the dashboard's own API routes with the signed-in
//     person's cookies (and View as header). Every existing permission check
//     applies: a Member's assistant cannot read Welfare, Users or PA Monitor.
//   - Navigation tools only return an instruction; the page opens the section.
//   - Change tools (Welfare grants, file inclusion) are never run here. They
//     come back to the page as a proposal; the person must click Confirm, and
//     the page then calls the normal API, with its normal checks and logging.
//
// Environment: BEDROCK_MODEL_ID (the model or inference profile ID from the
// Bedrock console), optional BEDROCK_REGION (default us-east-1).

import {
  BedrockRuntimeClient, ConverseCommand,
  type Message, type Tool, type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { Session } from '@/lib/auth';
import { readGrants, activeGrantFor } from '@/lib/auth';
import { CONSULTANT_ROWS, REPORT_MONTH as BUILT_IN_CONSULTANT_MONTH } from '@/app/data/consultantData';
import { allRecordsMonth, classifyFile } from '@/lib/fileMonth';

const bedrock = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || process.env.MY_AWS_REGION || 'us-east-1',
  credentials: process.env.MY_AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  } : undefined,
});

export type ChatTurn = { role: 'user' | 'assistant'; text: string };
/** One lookup the assistant made, shown under its answer so people can see what it checked. */
export type TraceItem = { label: string; ok: boolean };
export type AssistantAction =
  | { type: 'navigate'; page: string; month?: string; date?: string; sheet?: string; search?: string; filters?: Record<string, string> }
  | { type: 'download'; kind: 'key' | 'consultant_sheet' | 'welfare'; key?: string; filename?: string; month?: string; consultant?: string }
  | { type: 'confirm'; tool: ConfirmTool; input: any; summary: string };
export type ConfirmTool =
  | 'grant_welfare_access' | 'revoke_welfare_access' | 'set_file_inclusion' | 'set_month_inclusion' | 'move_file'
  | 'upload_attachment' | 'post_billing_message' | 'approve_billing_file' | 'remove_billing_approval'
  | 'generate_billing_report' | 'generate_consultant_report';

const PAGE_NAMES: Record<string, string> = {
  'master': 'Dashboard > Master',
  'all-info': 'Dashboard > All Records',
  'unclassified': 'Dashboard > Unclassified Files',
  'consultant': 'Consultant Report > Monthly',
  'consultant-directory': 'Consultant Report > Directory',
  'billing': 'Billing > CardPointe_Refresh',
  'welfare': 'Billing > Welfare',
  'users': 'Activity > Users',
  'pa-monitor': 'Activity > PA Monitor',
  'ai-monitor': 'Monitor > AI Assistant',
  'support-pending': 'Support > Pending',
  'support-resolved': 'Support > Resolved',
  'other-apps': 'Other Apps',
};

// Gig Workers Universe team members. In support summaries, anything these
// people sent, replied or responded is OUR side of the conversation. Names may
// appear as first name, last name or both. Add new team members here.
const TEAM = [
  'Kowshik Balasubramanian',
  'Andrew Cirillo',
  'Michelle McDonough',
  'Natalia Smith',
];

// Same carrier labels as the Move dialog on All Records.
const MOVE_LABELS = [
  'Cassena Remittance', 'Cassena Credits', 'GWU3 Remittance', 'GWU3 Credits', 'BDSB Remittance', 'BDSB Credits',
  'Northstead Remittance', 'Northstead Credits', 'Gig Remittance', 'Gig Credits', 'EP6 Remittance',
  'Enroll Confidently or PIOPAC', 'Corechoice T1', 'Corechoice T3', 'Refresh', 'Delta Dental', 'NYP Remittance',
];
const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const MAX_TOOL_CHARS = 40000; // enough for full member records in tables
const MAX_STEPS = 6;

// Keep tool results small: the model gets a preview of anything large.
function shrink(value: unknown): Record<string, unknown> {
  const s = JSON.stringify(value ?? null);
  if (s.length <= MAX_TOOL_CHARS) return { result: value as any };
  return { truncated: true, note: 'Result was long; this is the start of it.', preview: s.slice(0, MAX_TOOL_CHARS) };
}

type Ctx = {
  session: Session;
  origin: string;
  cookie: string;
  viewAs: string | null;
  canManage: boolean;
  isAdmin: boolean;
  welfareOk: boolean;
  pages: string[];
};

// Calls one of the dashboard's own API routes as the signed-in person.
async function api(ctx: Ctx, path: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers);
  if (ctx.cookie) headers.set('cookie', ctx.cookie);
  if (ctx.viewAs) headers.set('x-view-as', ctx.viewAs);
  const res = await fetch(ctx.origin + path, { ...init, headers, cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body?.error || `Request failed (${res.status})`, status: res.status };
  return body;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function toolList(ctx: Ctx): Tool[] {
  const t = (name: string, description: string, properties: Record<string, any> = {}, required: string[] = []): Tool => ({
    toolSpec: { name, description, inputSchema: { json: { type: 'object', properties, required } } },
  });
  const month = { type: 'string', description: 'Month in the form "October 2026"' };
  const tools: Tool[] = [
    t('search_everywhere', 'Search the WHOLE dashboard for a word or name at once, and report where and as what it was found: Master (member names, groups, plans, carrier files, source systems in Active, Terminated and New), All Records (names inside carrier files, file names), the Consultant report and Directory (every cell, latest month), the built-in consultant list, the Billing report (every cell, latest month), recent Support cases and, for staff, Users. Call this FIRST for any question that names something, before deciding what the name is.',
      { query: { type: 'string', description: 'The word, name, code or abbreviation to look for' },
        month: { ...month, description: 'Optional month for the Consultant and Billing reports; default is the latest available' } }, ['query']),
    t('navigate', 'Open a page of the dashboard for the user. Use this whenever the user asks to open, show or go to something.',
      { page: { type: 'string', enum: ctx.pages, description: 'Page to open' },
        month: { ...month, description: 'Optional month to select, "October 2026" (Welfare, Consultant, CardPointe_Refresh)' },
        date: { type: 'string', description: 'Optional day to select, YYYY-MM-DD (Support pages)' },
        sheet: { type: 'string', description: 'Optional sheet (Excel tab) to select inside the report: Billing (CardPointe_Refresh), Consultant Monthly or Consultant Directory. Use the exact sheet name from get_billing_report or get_consultant_report.' },
        search: { type: 'string', description: 'Optional text to type into the page\'s search box and run, on Master or All Records. Use "" to clear the search.' },
        filters: { type: 'object', description: 'Master only: filters to apply on the page (replaces current filters; {} clears them)', properties: {
          group: { type: 'string' }, planName: { type: 'string' }, state: { type: 'string' }, city: { type: 'string' },
          file: { type: 'string', description: 'Carrier file label' }, sourceSystem: { type: 'string' }, coverageTier: { type: 'string' } } } }, ['page']),
    t('master_overview', 'Master Dashboard totals: active, terminated and new member counts, months covered, and carrier files missing for the latest months.'),
    t('search_master', 'Search Master Dashboard members by name (any word order) and optional filters. Returns the full record of up to 50 matching members (name, group, plan, Anthem ID, payment, address, city, state, email, phone, carrier file, source system, coverage tier, and termination or effective date) and the total match count.',
      { search: { type: 'string', description: 'Name words to search for; may be empty when only filtering' },
        table: { type: 'string', enum: ['active', 'terminated', 'new'], description: 'Which table, default active' },
        filters: { type: 'object', description: 'Optional exact filters', properties: {
          group: { type: 'string' }, planName: { type: 'string' }, state: { type: 'string' },
          file: { type: 'string', description: 'Carrier file label' }, sourceSystem: { type: 'string' },
          city: { type: 'string' }, coverageTier: { type: 'string' } } } }),
    t('search_all_records', 'Search every carrier file (All Records) for a member name. Returns, for each file that matched, its column headings and the full matching rows (up to 20 per file).',
      { query: { type: 'string', description: 'Name or part of a name, 2+ characters' } }, ['query']),
    t('list_files', 'List carrier files in All Records exactly as the page shows them, newest first: name, carrier label (e.g. Cassena Remittance, Cassena Credits, Refresh), the month block it sits under, when it arrived, and whether it is INCLUDED (counted in the calculations) for that month. Filters: received_month = month it ARRIVED; file_month = the month block it sits under on All Records; contains = text in the name; label = carrier label; included = true for only included files, false for only not-included. Returns every match (up to 200) and the total.',
      { received_month: { ...month, description: 'Month the file arrived, "October 2026"' },
        file_month: { ...month, description: 'Month block on All Records, "October 2026"' },
        contains: { type: 'string', description: 'Optional text the file name must contain, e.g. "Cassena"' },
        label: { type: 'string', description: 'Optional carrier label or part of it, e.g. "Cassena Remittance" or "remittance"' },
        included: { type: 'boolean', description: 'Optional: true = only included files, false = only files that are not included' } }),
    t('get_support', 'Daily AI support email summaries. Without a date: the days available with pending and resolved counts. With a date: that day\'s cases.',
      { date: { type: 'string', description: 'Optional day, YYYY-MM-DD' } }),
    t('find_consultant', 'Find who the consultant of a group is, or which groups a consultant handles. Searches every sheet of the Consultant Monthly report and the Consultant Directory (latest month unless one is given), plus the built-in consultant list. Use this first for any consultant question.',
      { group: { type: 'string', description: 'Group (employer) name or part of it' },
        consultant: { type: 'string', description: 'Consultant name or part of it' },
        month: { ...month, description: 'Optional month, "October 2026"; default is the latest available' } }),
    t('find_in_billing', 'Find a member (or group) in every sheet of a month\'s Billing report (CardPointe, Refresh, declined or rejected, underpaid and so on). Matches all words of the name in any order, so "Mary Ann Minervini" also finds "MINERVINI, MARY ANN". Returns each matching row with its sheet and column headings.',
      { name: { type: 'string', description: 'Member or group name' }, month }, ['name', 'month']),
    t('get_consultant_report', 'The consultant report and directory for a month. Without sheet: each sheet\'s name, column headings, row count and first rows. With sheet: that whole sheet (up to 300 rows).',
      { month, sheet: { type: 'string', description: 'Optional sheet (Excel tab) name, e.g. one from a call without sheet' },
        file: { type: 'string', enum: ['report', 'directory'], description: 'Which workbook, default report' } }, ['month']),
    t('get_billing_report', 'The billing (CardPointe and Refresh reconciliation) report for a month. Without sheet: each sheet\'s name, column headings, row count and first rows. With sheet: that whole sheet (up to 300 rows), e.g. Q3_Underpaid.',
      { month, sheet: { type: 'string', description: 'Optional sheet (Excel tab) name' } }, ['month']),
  ];
  // Reading
  tools.push(t('read_file', 'Read the contents of one carrier file from All Records (its column headings and rows), like the preview on All Records. Find the key with list_files first.',
    { key: { type: 'string', description: 'Exact S3 key from list_files' } }, ['key']));
  tools.push(t('get_billing_chat', 'The messages and attached files in a month\'s Billing (CardPointe_Refresh) updates chat, newest first, with which file is approved as the month\'s report.',
    { month }, ['month']));
  tools.push(t('list_report_months', 'Months that have a Billing report or chat, and months that have a Consultant report or directory.'));
  if (ctx.canManage) {
    tools.push(t('get_consultant_upload_status', 'Which of the required consultant input files are uploaded for a month (the Consultant Monthly upload checklist).', { month }, ['month']));
  }
  // Downloads (start straight away in the browser, like the Download buttons)
  tools.push(t('download', 'Download something to the user\'s computer, like the Download buttons. what: file = any file by key (All Records, Unclassified, billing chat file); billing_report = the month\'s billing report; billing_chat_file = a file attached in the billing chat (give its file name); consultant_report or consultant_directory = the month\'s workbook; consultant_sheet = one consultant\'s tab; welfare = the Welfare table as Excel.',
    { what: { type: 'string', enum: ['file', 'billing_report', 'billing_chat_file', 'consultant_report', 'consultant_directory', 'consultant_sheet', ...(ctx.welfareOk ? ['welfare'] : [])] },
      key: { type: 'string', description: 'what=file: exact S3 key from list_files' },
      month: { ...month, description: 'Month, "October 2026" (all except what=file)' },
      filename: { type: 'string', description: 'what=billing_chat_file: the attached file name' },
      consultant: { type: 'string', description: 'what=consultant_sheet: consultant (tab) name' } }, ['what']));
  // Changes (always confirmed by the user)
  tools.push(t('post_billing_message', 'Propose posting a text message (no file) in a month\'s Billing updates chat, signed with the user\'s name. The user must confirm.',
    { month, message: { type: 'string', description: 'The message, in the user\'s words' } }, ['month', 'message']));
  if (ctx.canManage) {
    tools.push(t('set_month_inclusion', 'Propose Include all or Exclude all for every carrier file shown under a month on All Records (PDF and ZIP excluded). The user must confirm.',
      { month: { type: 'string', description: 'YYYY-MM' }, included: { type: 'boolean' } }, ['month', 'included']));
    tools.push(t('approve_billing_file', 'Propose approving a file from a month\'s billing chat as that month\'s billing report (what Billing then shows). Get the file key from get_billing_chat. The user must confirm.',
      { month, key: { type: 'string', description: 'The chat file\'s s3Key from get_billing_chat' } }, ['month', 'key']));
    tools.push(t('remove_billing_approval', 'Propose removing the approved billing file for a month, so Billing shows the generated report again. The user must confirm.', { month }, ['month']));
    tools.push(t('generate_billing_report', 'Propose running the billing reconciliation for a month from its uploaded CardConnect and Refresh source files (the Generate button on Billing). The user must confirm.', { month }, ['month']));
    tools.push(t('generate_consultant_report', 'Propose generating the consultant report and directory for a month from its uploaded inputs (the Generate button on Consultant Monthly). The user must confirm.', { month }, ['month']));
  }
  tools.push(t('upload_attachment', 'Propose uploading the file the user attached in this chat to the place they asked for. Never assume All Records: pick the destination from their request, and ask if it is unclear. The user must confirm before anything uploads.',
    { file: { type: 'string', description: 'Name of the attached file to upload, when several are attached' },
      destination: { type: 'string', enum: ctx.canManage ? ['all_records', 'billing_chat', 'billing_sources', 'consultant'] : ['billing_chat'],
        description: 'all_records = carrier file in All Records; billing_chat = a message with the file in the Billing (CardPointe_Refresh) updates chat; billing_sources = CardConnect or Refresh source file for billing; consultant = consultant report input file' },
      month: { ...month, description: 'Month it belongs to, "October 2026"' },
      label: { type: 'string', enum: MOVE_LABELS, description: 'all_records only: carrier label' },
      source: { type: 'string', enum: ['cardconnect', 'refresh'], description: 'billing_sources only' },
      message: { type: 'string', description: 'billing_chat only: the message to post with the file, in the user\'s words' },
      if_exists: { type: 'string', enum: ['add_new', 'replace'], description: 'all_records only: what to do if a file with the same label and month already exists. Leave out unless the user said.' },
      replace_key: { type: 'string', description: 'all_records with if_exists=replace: exact key of the existing file to replace, from list_files' } },
    ['destination', 'month']));
  if (ctx.welfareOk) tools.push(t('get_welfare', 'Welfare figures for a month.', { month }, ['month']));
  if (ctx.canManage) {
    tools.push(t('list_users', 'Everyone who can sign in to the dashboard, with role, account status and last active time.'));
    tools.push(t('set_file_inclusion', 'Propose including or excluding a carrier file from a month\'s calculations. The user must confirm it in the chat before anything changes.',
      { key: { type: 'string', description: 'Exact S3 key of the file, from list_files' },
        month: { type: 'string', description: 'Month in the form YYYY-MM' },
        included: { type: 'boolean' } }, ['key', 'month', 'included']));
    tools.push(t('move_file', 'Propose moving (reclassifying) a carrier file to another carrier label and/or month, the same as the Move button on All Records: the file is renamed to "<Label> <Month> <Year>". The user must confirm it in the chat before anything changes. Find the exact key with list_files first.',
      { key: { type: 'string', description: 'Exact S3 key of the file, from list_files' },
        label: { type: 'string', enum: MOVE_LABELS, description: 'Carrier label to move the file to' },
        month: { type: 'string', description: 'Month the file belongs to, "October 2026". Keep the file\'s current month unless the user asks to change it.' },
        overwrite: { type: 'boolean', description: 'Only true if the user agreed to replace a file that already has that name' } },
      ['key', 'label', 'month']));
  }
  if (ctx.isAdmin) {
    tools.push(t('get_pa_monitor', 'What the Platform Admin did while using View as. Without a date: days with activity. With a date: that day\'s events.',
      { date: { type: 'string', description: 'Optional day, YYYY-MM-DD' } }));
    tools.push(t('grant_welfare_access', 'Propose giving someone Welfare access for 1 to 7 days. The user must confirm it in the chat before anything changes.',
      { email: { type: 'string' }, days: { type: 'integer', minimum: 1, maximum: 7 } }, ['email', 'days']));
    tools.push(t('revoke_welfare_access', 'Propose removing someone\'s Welfare access. The user must confirm it in the chat before anything changes.',
      { email: { type: 'string' } }, ['email']));
  }
  return tools;
}

// Billing and Consultant workbooks arrive as a grid of formatted cells
// ({ v: value, ...styles }). Turn a sheet into a heading row plus data rows of
// plain values, skipping empty rows.
function sheetValues(sheet: any): { headers: string[]; rows: string[][] } {
  const grid: string[][] = (sheet?.cells || []).map((row: any[]) =>
    (row || []).map((c: any) => (c && !c.hidden ? String(c.v ?? '').trim() : '')));
  const filled = grid.filter(r => r.some(v => v !== ''));
  if (!filled.length) return { headers: [], rows: [] };
  // The heading row is the first row with at least two filled cells.
  const hi = Math.max(0, filled.findIndex(r => r.filter(v => v !== '').length >= 2));
  return { headers: filled[hi], rows: filled.slice(hi + 1) };
}
const normName = (x: string) => String(x || '').toLowerCase().replace(/[\s_\-]+/g, '');
function findSheet(sheets: any[], want: string): any | null {
  const w = normName(want);
  return sheets.find(sh => sh.name === want) || sheets.find(sh => normName(sh.name) === w)
    || sheets.find(sh => normName(sh.name).includes(w)) || null;
}
function workbookResult(sheets: any[], wanted?: string) {
  if (wanted) {
    const sh = findSheet(sheets, wanted);
    if (!sh) return { error: `No sheet named like "${wanted}". Sheets: ${sheets.map(x => x.name).join(', ')}` };
    const v = sheetValues(sh);
    return { sheet: sh.name, headers: v.headers, rowCount: v.rows.length, rows: v.rows.slice(0, 300),
      ...(v.rows.length > 300 ? { note: `Showing the first 300 of ${v.rows.length} rows.` } : {}) };
  }
  return { sheets: sheets.map(sh => { const v = sheetValues(sh); return { name: sh.name, headers: v.headers, rowCount: v.rows.length, firstRows: v.rows.slice(0, 5) }; }) };
}

const EMPTY_FILTERS = {
  group: '', planName: '', anthemId: '', payment: { lt: '', gt: '', eq: '' }, city: '', state: '',
  address1: '', address2: '', email: '', phone: '', file: '', sourceSystem: '', coverageTier: '',
  terminationDate: '', effectiveDate: '',
};

// Runs one tool. Returns the result for the model and, for navigation and
// change proposals, an action for the page.
async function runTool(ctx: Ctx, name: string, input: any): Promise<{ result: Record<string, unknown>; action?: AssistantAction }> {
  const q = encodeURIComponent;
  switch (name) {
    case 'search_everywhere': {
      const term = String(input?.query || '').trim();
      if (term.length < 2) return { result: { error: 'Give at least 2 characters.' } };
      const key = (x: unknown) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const k = key(term);
      const cellHits = (sheets: any[], limitPerSheet = 5) => {
        const out: any[] = [];
        for (const sh of sheets || []) {
          const v = sheetValues(sh);
          // A sheet NAMED after the term (e.g. a consultant's own tab) counts as a whole.
          if (key(sh.name).includes(k)) {
            out.push({ sheet: sh.name, sheetNameMatches: true, rowCount: v.rows.length, headers: v.headers, sampleRows: v.rows.slice(0, limitPerSheet) });
            continue;
          }
          const rows = v.rows.filter(r => r.some(c => key(c).includes(k)));
          if (rows.length) out.push({ sheet: sh.name, matchingRows: rows.length, headers: v.headers, sampleRows: rows.slice(0, limitPerSheet) });
        }
        return out;
      };
      const pickMonth = (list: any[], has: (m: any) => boolean) => {
        const ok = (list || []).filter(has).sort((a: any, b: any) => String(b.prefix).localeCompare(String(a.prefix)));
        return (input?.month && ok.find(m => key(m.label) === key(input.month))) || ok[0] || null;
      };
      const found: Record<string, any> = {};
      const jobs: Promise<void>[] = [];

      // Master: names, groups, plans, carrier files and sources, in all three tables.
      jobs.push((async () => {
        const sum = await api(ctx, '/api/master?view=summary');
        if (sum.error) { found.master = { error: sum.error }; return; }
        const ask = async (table: string, search: string, filters: any) => {
          const p = await api(ctx, '/api/master/query', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ fp: sum.fingerprint, table, search, filters: { ...EMPTY_FILTERS, ...filters }, sort: null, page: 1, pageSize: 3 }) });
          return p.error ? null : { count: p.matched, sample: (p.rows || []).map((r: any) => ({ name: r.memberName, group: r.group, plan: r.planName, file: r.file })) };
        };
        const master: Record<string, any> = {};
        for (const table of ['active', 'terminated', 'new']) {
          const [byName, byGroup, byPlan, byFile, bySource] = await Promise.all([
            ask(table, term, {}), ask(table, '', { group: term }), ask(table, '', { planName: term }),
            ask(table, '', { file: term }), ask(table, '', { sourceSystem: term }),
          ]);
          const t: Record<string, any> = {};
          if (byName?.count) t.memberName = byName;
          if (byGroup?.count) t.group = byGroup;
          if (byPlan?.count) t.planName = byPlan;
          if (byFile?.count) t.carrierFile = byFile;
          if (bySource?.count) t.sourceSystem = bySource;
          if (Object.keys(t).length) master[table] = t;
        }
        found.master = Object.keys(master).length ? master : 'not found';
      })());

      // All Records: names inside carrier files, and file names.
      jobs.push((async () => {
        const [sr, files] = await Promise.all([api(ctx, `/api/search?q=${q(term)}`), api(ctx, '/api/files')]);
        const named = Array.isArray(files) ? files.filter((f: any) => key(f.filename).includes(k)).map((f: any) => f.filename) : [];
        found.allRecords = {
          namesInFiles: sr?.totalMatches ? { rows: sr.totalMatches, files: (sr.results || []).slice(0, 10).map((f: any) => f.filename) } : 'not found',
          fileNames: named.length ? { count: named.length, files: named.slice(0, 15) } : 'not found',
        };
      })());

      // Consultant report and directory (every cell), plus the built-in list.
      jobs.push((async () => {
        const ml = await api(ctx, '/api/consultant/months');
        const m = pickMonth(ml.months, (x: any) => x.hasReport || x.hasDirectory);
        const builtIn = CONSULTANT_ROWS.filter(c => c.normalizedConsultant.includes(k) || c.normalizedGroup.includes(k));
        const out: any = {
          builtInList: builtIn.length ? { fromReport: BUILT_IN_CONSULTANT_MONTH,
            asConsultant: [...new Set(builtIn.filter(c => c.normalizedConsultant.includes(k)).map(c => c.consultant))],
            groupsOfThatConsultant: builtIn.filter(c => c.normalizedConsultant.includes(k)).length,
            asGroup: builtIn.filter(c => c.normalizedGroup.includes(k)).slice(0, 10).map(c => ({ group: c.group, consultant: c.consultant })) } : 'not found',
        };
        if (m) {
          const r = await api(ctx, `/api/consultant/report?month=${q(m.label)}`);
          out.month = m.label;
          out.monthlyReport = r.report ? (cellHits(r.report.sheets).length ? cellHits(r.report.sheets) : 'not found') : 'no report';
          out.directory = r.directory ? (cellHits(r.directory.sheets).length ? cellHits(r.directory.sheets) : 'not found') : 'no directory';
        }
        found.consultant = out;
      })());

      // Billing report (every cell), latest month with a report.
      jobs.push((async () => {
        const bl = await api(ctx, '/api/billing/months');
        const m = pickMonth(bl.months, (x: any) => x.hasReport);
        if (!m) { found.billing = 'no billing report'; return; }
        const r = await api(ctx, `/api/billing/report-file?month=${q(m.label)}`);
        const hits = cellHits(r.sheets || []);
        found.billing = { month: m.label, sheets: hits.length ? hits : 'not found' };
      })());

      // Support: the last 14 days of summaries.
      jobs.push((async () => {
        const idx = await api(ctx, '/api/support');
        const days = (idx.days || []).slice(0, 14);
        const reps = await Promise.all(days.map((d: any) => api(ctx, `/api/support?date=${q(d.date)}`)));
        const cases: any[] = [];
        reps.forEach((r: any) => (r.items || []).forEach((i: any) => {
          if (key(i.subject).includes(k) || key(i.summary).includes(k)) cases.push({ date: r.date, subject: i.subject, status: i.isOpen ? 'pending' : 'resolved' });
        }));
        found.support = cases.length ? { cases: cases.slice(0, 15), count: cases.length } : 'not found in the last 14 days';
      })());

      // Users (staff only).
      if (ctx.canManage) jobs.push((async () => {
        const u = await api(ctx, '/api/users');
        const hits = (u.users || []).filter((x: any) => key(x.name).includes(k) || key(x.email).includes(k));
        found.users = hits.length ? hits.map((x: any) => ({ name: x.name, email: x.email, role: x.role })) : 'not found';
      })());

      await Promise.all(jobs.map(j => j.catch(() => undefined)));
      return { result: shrink({ searchedFor: term, found }) };
    }
    case 'navigate': {
      if (!ctx.pages.includes(input?.page)) return { result: { error: 'That page is not available to this user.' } };
      const action: AssistantAction = { type: 'navigate', page: input.page,
        ...(input.month ? { month: String(input.month) } : {}), ...(input.date ? { date: String(input.date) } : {}),
        ...(input.sheet ? { sheet: String(input.sheet) } : {}),
        ...(typeof input.search === 'string' && (input.page === 'master' || input.page === 'all-info') ? { search: input.search.trim() } : {}),
        ...(input.filters && typeof input.filters === 'object' && input.page === 'master'
          ? { filters: Object.fromEntries(Object.entries(input.filters).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v).trim()])) as Record<string, string> } : {}) };
      return { result: { ok: true, opened: PAGE_NAMES[input.page], month: input.month || null, sheet: input.sheet || null,
        search: (action as any).search ?? null }, action };
    }
    case 'master_overview': {
      const s = await api(ctx, '/api/master?view=summary');
      if (s.error) return { result: s };
      return { result: shrink({
        activeCount: s.activeCount, terminatedCount: s.terminatedCount, newCount: s.newCount,
        monthsProcessed: s.monthsProcessed, latestMonth: s.latestMonthLabel, previousMonth: s.previousMonthLabel,
        latestMonthMissingFiles: s.latestMonthMissingFiles, previousMonthMissingFiles: s.previousMonthMissingFiles,
      }) };
    }
    case 'search_master': {
      const s = await api(ctx, '/api/master?view=summary');
      if (s.error) return { result: s };
      const p = await api(ctx, '/api/master/query', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fp: s.fingerprint, table: input?.table || 'active', search: String(input?.search || ''),
          filters: { ...EMPTY_FILTERS, ...(input?.filters || {}) }, sort: null, page: 1, pageSize: 50 }),
      });
      if (p.error) return { result: p };
      // The full record, exactly as the Master tables show it ('-' means empty there).
      const pick = (r: any) => ({
        name: r.memberName, group: r.group, plan: r.planName, anthemId: r.anthemId, payment: r.payment,
        address1: r.address1, address2: r.address2, city: r.city, state: r.state, email: r.email, phone: r.phone,
        file: r.file, sourceSystem: r.sourceSystem, coverageTier: r.coverageTier,
        ...(r.terminationDate ? { terminationDate: r.terminationDate } : {}),
        ...(r.effectiveDate ? { effectiveDate: r.effectiveDate } : {}),
      });
      return { result: shrink({ matched: p.matched, totalInTable: p.total, showing: p.rows.length, rows: p.rows.map(pick) }) };
    }
    case 'search_all_records': {
      const r = await api(ctx, `/api/search?q=${q(String(input?.query || ''))}`);
      if (r.error) return { result: r };
      return { result: shrink({
        filesScanned: r.filesScanned, filesWithMatches: r.filesWithMatches, totalMatches: r.totalMatches,
        files: (r.results || []).slice(0, 30).map((f: any) => ({
          file: f.filename, system: f.system, matches: f.rows.length,
          headers: f.headers,
          rows: f.rows.slice(0, 20),
        })),
      }) };
    }
    case 'list_files': {
      const files = await api(ctx, '/api/files');
      if (!Array.isArray(files)) return { result: files };
      const nyMonth = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', year: 'numeric' }).format(new Date(iso));
      const nyDay = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
      const same = (a: string | null, b: unknown) => !!a && a.toLowerCase() === String(b || '').trim().toLowerCase();
      const c = String(input?.contains || '').toLowerCase();
      const lab = String(input?.label || '').toLowerCase();
      const all = files.map((f: any) => {
        const m = allRecordsMonth(f.filename, f.lastModified);
        return {
          key: f.key, filename: f.filename,
          label: classifyFile(f.filename) === 'unknown' ? 'Unclassified' : classifyFile(f.filename),
          fileMonth: `${MONTHS_LONG[m.month]} ${m.year}`,
          received: nyDay(f.lastModified), receivedMonth: nyMonth(f.lastModified),
          _mf: `${m.year}-${String(m.month + 1).padStart(2, '0')}`, _t: String(f.lastModified),
        };
      });
      let hits = all.filter((f: any) =>
        (!input?.received_month || same(f.receivedMonth, input.received_month)) &&
        (!input?.file_month || same(f.fileMonth, input.file_month)) &&
        (!c || String(f.filename).toLowerCase().includes(c)) &&
        (!lab || f.label.toLowerCase().includes(lab)))
        .sort((a: any, b: any) => b._t.localeCompare(a._t));
      // Included or not, from each month's Include list (the same one the buttons use).
      const months = [...new Set(hits.map((f: any) => f._mf))].slice(0, 24) as string[];
      const lists = await Promise.all(months.map(m => api(ctx, `/api/manifest?month=${m}`)));
      const inc = new Map(months.map((m, i) => [m, new Set<string>(lists[i]?.included || [])]));
      hits = hits.map((f: any) => ({ ...f, included: inc.has(f._mf) ? inc.get(f._mf)!.has(f.key) : null }));
      if (typeof input?.included === 'boolean') hits = hits.filter((f: any) => f.included === input.included);
      return { result: shrink({
        filters: { received_month: input?.received_month || null, file_month: input?.file_month || null, contains: input?.contains || null },
        totalFilesInAllRecords: all.length,
        count: hits.length,
        files: hits.slice(0, 200).map(({ _t, _mf, receivedMonth, ...f }: any) => f),
        ...(hits.length > 200 ? { note: `Showing the newest 200 of ${hits.length}.` } : {}),
      }) };
    }
    case 'get_support': {
      const d = input?.date ? await api(ctx, `/api/support?date=${q(input.date)}`) : await api(ctx, '/api/support');
      if (!input?.date && d.days) return { result: shrink({ latestDate: d.latestDate, days: d.days.slice(0, 31) }) };
      if (d.items) {
        return { result: shrink({ date: d.date, emails: d.emails, totalMessages: d.totalMessages, busiest: d.busiest,
          cases: d.items.map((i: any) => ({ subject: i.subject, messages: i.msgCount, status: i.isOpen ? 'pending' : 'resolved',
            summary: String(i.summary).replace(/^\s*STATUS_FLAG:.*$/im, '').trim() })) }) };
      }
      return { result: d };
    }
    case 'find_in_billing': {
      const words = String(input?.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2);
      if (!words.length) return { result: { error: 'Give a name to look for.' } };
      const r = await api(ctx, `/api/billing/report-file?month=${q(input?.month || '')}`);
      if (r.error) return { result: r };
      if (!r.sheets?.length) return { result: { month: input?.month, error: r.message || `No billing report for ${input?.month}.` } };
      const matches: any[] = [];
      for (const sh of r.sheets) {
        const v = sheetValues(sh);
        for (const row of v.rows) {
          const text = row.join(' ').toLowerCase();
          if (words.every(w => text.includes(w))) {
            matches.push({ sheet: sh.name, headers: v.headers, row });
            if (matches.length >= 80) break;
          }
        }
      }
      return { result: shrink({ month: input?.month, file: r.filename || r.sourceFile, searchedFor: input?.name,
        sheetsSearched: r.sheets.map((sh: any) => sh.name), count: matches.length, matches }) };
    }
    case 'find_consultant': {
      const want = String(input?.group || input?.consultant || '').trim();
      if (!want) return { result: { error: 'Give a group name or a consultant name.' } };
      const key = (x: unknown) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const k = key(want);
      // Month: the one asked for, else the newest with a report or directory.
      const ml = await api(ctx, '/api/consultant/months');
      const months: any[] = (ml.months || []).filter((m: any) => m.hasReport || m.hasDirectory)
        .sort((a: any, b: any) => String(b.prefix).localeCompare(String(a.prefix)));
      const chosen = (input?.month && months.find(m => key(m.label) === key(input.month))) || months[0];
      const matches: any[] = [];
      if (chosen) {
        const r = await api(ctx, `/api/consultant/report?month=${q(chosen.label)}`);
        for (const [file, wb] of [['Monthly report', r.report], ['Directory', r.directory]] as [string, any][]) {
          for (const sh of wb?.sheets || []) {
            const v = sheetValues(sh);
            for (const row of v.rows) {
              if (row.some(cell => key(cell).includes(k))) {
                matches.push({ file, sheet: sh.name, headers: v.headers, row });
                if (matches.length >= 60) break;
              }
            }
          }
        }
      }
      // Built-in list (from one monthly report), used to confirm or fill gaps.
      const builtIn = CONSULTANT_ROWS
        .filter(c => (input?.group ? c.normalizedGroup.includes(key(input.group)) : false)
          || (input?.consultant ? c.normalizedConsultant.includes(key(input.consultant)) : false)
          || (!input?.group && !input?.consultant && (c.normalizedGroup.includes(k) || c.normalizedConsultant.includes(k))))
        .slice(0, 60).map(c => ({ consultant: c.consultant, group: c.group }));
      return { result: shrink({
        searchedFor: want,
        month: chosen ? chosen.label : null,
        monthsAvailable: months.slice(0, 12).map(m => m.label),
        reportMatches: matches,
        builtInList: { fromReport: BUILT_IN_CONSULTANT_MONTH, matches: builtIn },
      }) };
    }
    case 'get_consultant_report': {
      const r = await api(ctx, `/api/consultant/report?month=${q(input?.month || '')}`);
      if (r.error) return { result: r };
      const which = input?.file === 'directory' ? r.directory : r.report;
      if (input?.sheet) {
        if (!which) return { result: { error: `No consultant ${input?.file === 'directory' ? 'directory' : 'report'} for ${input?.month}.` } };
        return { result: shrink({ month: input?.month, file: input?.file || 'report', ...workbookResult(which.sheets || [], input.sheet) }) };
      }
      return { result: shrink({ month: input?.month,
        report: r.report ? workbookResult(r.report.sheets || []) : null,
        directory: r.directory ? workbookResult(r.directory.sheets || []) : null }) };
    }
    case 'get_billing_report': {
      const r = await api(ctx, `/api/billing/report-file?month=${q(input?.month || '')}`);
      if (r.error) return { result: r };
      if (!r.sheets?.length) return { result: { month: input?.month, error: r.message || `No billing report for ${input?.month}.` } };
      return { result: shrink({ month: input?.month, file: r.filename || r.sourceFile, ...workbookResult(r.sheets, input?.sheet) }) };
    }
    case 'get_welfare': {
      if (!ctx.welfareOk) return { result: { error: 'This user does not have Welfare access.' } };
      return { result: shrink(await api(ctx, `/api/welfare?month=${q(input?.month || '')}`)) };
    }
    case 'list_users': {
      if (!ctx.canManage) return { result: { error: 'Not available to this user.' } };
      const r = await api(ctx, '/api/users');
      if (r.error) return { result: r };
      return { result: shrink((r.users || []).map((u: any) => ({ name: u.name, email: u.email, role: u.role,
        account: u.enabled ? 'Active' : 'Disabled', lastActive: u.lastActive || null }))) };
    }
    case 'get_pa_monitor': {
      if (!ctx.isAdmin) return { result: { error: 'Admin only.' } };
      const r = input?.date ? await api(ctx, `/api/pa-monitor?date=${q(input.date)}`) : await api(ctx, '/api/pa-monitor');
      return { result: shrink(r) };
    }
    case 'read_file': {
      const r = await api(ctx, `/api/file-content?key=${q(String(input?.key || ''))}`);
      if (r.error) return { result: r };
      return { result: shrink({ file: String(input.key).split('/').pop(), sheet: r.sheetName || null,
        totalRows: r.totalRows, headers: r.headers, rows: (r.rows || []).slice(0, 200),
        ...((r.rows || []).length < r.totalRows ? { note: `The preview holds ${(r.rows || []).length} of ${r.totalRows} rows.` } : {}) }) };
    }
    case 'get_billing_chat': {
      const [u, rep] = await Promise.all([
        api(ctx, `/api/billing/updates?month=${q(input?.month || '')}`),
        api(ctx, `/api/billing/report-file?month=${q(input?.month || '')}`),
      ]);
      if (u.error) return { result: u };
      return { result: shrink({ month: input?.month, approvedKey: rep?.approvedKey || null,
        messages: (u.updates || []).map((m: any) => ({ id: m.id, from: m.name, date: m.date, message: m.comments,
          file: m.filename, s3Key: m.s3Key, approved: !!m.s3Key && m.s3Key === rep?.approvedKey })) }) };
    }
    case 'list_report_months': {
      const [b, c] = await Promise.all([api(ctx, '/api/billing/months'), api(ctx, '/api/consultant/months')]);
      return { result: shrink({ billing: b.months || b, consultant: (c.months || []).map((m: any) => ({ month: m.label, report: !!m.hasReport, directory: !!m.hasDirectory })) }) };
    }
    case 'get_consultant_upload_status': {
      if (!ctx.canManage) return { result: { error: 'Not available to this user.' } };
      return { result: shrink(await api(ctx, `/api/consultant/check-uploads?month=${q(input?.month || '')}`)) };
    }
    case 'download': {
      const what = String(input?.what || '');
      const dl = (key: string, filename: string): { result: Record<string, unknown>; action: AssistantAction } =>
        ({ result: { ok: true, downloading: filename }, action: { type: 'download', kind: 'key', key, filename } });
      if (what === 'file') {
        if (!input?.key) return { result: { error: 'Give the file key (from list_files).' } };
        return dl(String(input.key), String(input.key).split('/').pop() || 'download');
      }
      if (what === 'billing_report') {
        const r = await api(ctx, `/api/billing/report-file?month=${q(input?.month || '')}`);
        const key = r.approvedKey || r.sourceFile;
        if (!key) return { result: { error: r.error || r.message || `No billing report for ${input?.month}.` } };
        return dl(key, r.filename || String(key).split('/').pop());
      }
      if (what === 'billing_chat_file') {
        const u = await api(ctx, `/api/billing/updates?month=${q(input?.month || '')}`);
        const want = String(input?.filename || '').toLowerCase();
        const hit = (u.updates || []).find((m: any) => m.s3Key && String(m.filename || '').toLowerCase().includes(want));
        if (!hit) return { result: { error: `No file like "${input?.filename}" in the ${input?.month} billing chat.` } };
        return dl(hit.s3Key, hit.filename);
      }
      if (what === 'consultant_report' || what === 'consultant_directory') {
        const r = await api(ctx, `/api/consultant/report?month=${q(input?.month || '')}`);
        const f = what === 'consultant_report' ? r.report : r.directory;
        if (!f?.s3Key) return { result: { error: `No consultant ${what === 'consultant_report' ? 'report' : 'directory'} for ${input?.month}.` } };
        return dl(f.s3Key, f.filename);
      }
      if (what === 'consultant_sheet') {
        if (!input?.consultant) return { result: { error: 'Give the consultant name.' } };
        return { result: { ok: true, downloading: `${input.consultant} sheet, ${input?.month}` },
          action: { type: 'download', kind: 'consultant_sheet', month: String(input?.month || ''), consultant: String(input.consultant) } };
      }
      if (what === 'welfare') {
        if (!ctx.welfareOk) return { result: { error: 'This user does not have Welfare access.' } };
        return { result: { ok: true, downloading: `Welfare ${input?.month}` }, action: { type: 'download', kind: 'welfare', month: String(input?.month || '') } };
      }
      return { result: { error: 'Unknown download.' } };
    }
    case 'post_billing_message':
    case 'set_month_inclusion':
    case 'approve_billing_file':
    case 'remove_billing_approval':
    case 'generate_billing_report':
    case 'generate_consultant_report': {
      if (name !== 'post_billing_message' && !ctx.canManage) return { result: { error: 'This user cannot do that.' } };
      const ym = (v: unknown) => { const m = String(v || '').match(/^(\d{4})-(\d{2})$/); return m ? `${MONTHS_LONG[Number(m[2]) - 1]} ${m[1]}` : String(v || ''); };
      let summary = '';
      if (name === 'post_billing_message') {
        if (!String(input?.message || '').trim()) return { result: { error: 'What should the message say?' } };
        summary = `Post in the ${input?.month} billing chat: "${String(input.message).trim().slice(0, 300)}"`;
      } else if (name === 'set_month_inclusion') {
        if (!/^\d{4}-\d{2}$/.test(String(input?.month || ''))) return { result: { error: 'month must be YYYY-MM' } };
        summary = `${input?.included ? 'Include' : 'Exclude'} every carrier file shown under ${ym(input?.month)} on All Records`;
      } else if (name === 'approve_billing_file') {
        summary = `Approve ${String(input?.key || '').split('/').pop()} as the ${input?.month} billing report`;
      } else if (name === 'remove_billing_approval') {
        summary = `Remove the approved billing file for ${input?.month}`;
      } else if (name === 'generate_billing_report') {
        summary = `Generate the ${input?.month} billing report from its CardConnect and Refresh source files`;
      } else {
        summary = `Generate the ${input?.month} consultant report and directory from its uploaded inputs`;
      }
      return {
        result: { status: 'waiting_for_user', note: 'Not done yet. The user must click Confirm in the chat.' },
        action: { type: 'confirm', tool: name as ConfirmTool, input, summary },
      };
    }
    case 'upload_attachment': {
      const dest = String(input?.destination || '');
      if (dest !== 'billing_chat' && !ctx.canManage) return { result: { error: 'This user can only attach files to the billing chat.' } };
      const [mn, yr] = String(input?.month || '').split(' ');
      if (MONTHS_LONG.indexOf(mn) < 0 || !Number(yr)) return { result: { error: 'month must look like "October 2026"' } };
      const monthLabel = `${mn} ${yr}`;
      const fileName = input?.file ? String(input.file) : 'the attached file';
      let summary = '';
      if (dest === 'all_records') {
        if (!MOVE_LABELS.includes(input?.label)) return { result: { error: `For All Records give a label: ${MOVE_LABELS.join(', ')}` } };
        summary = `Upload ${fileName} to All Records as ${input.label}, ${monthLabel}` +
          (input?.if_exists === 'replace' && input?.replace_key ? `, replacing ${String(input.replace_key).split('/').pop()}` : input?.if_exists === 'add_new' ? ', keeping existing files' : '');
      } else if (dest === 'billing_chat') {
        if (!String(input?.message || '').trim()) return { result: { error: 'The billing chat needs a message to post with the file. Ask the user what to write.' } };
        summary = `Post ${fileName} in the ${monthLabel} billing chat with: "${String(input.message).trim().slice(0, 200)}"`;
      } else if (dest === 'billing_sources') {
        if (input?.source !== 'cardconnect' && input?.source !== 'refresh') return { result: { error: 'Say whether it is the CardConnect or the Refresh source file.' } };
        summary = `Upload ${fileName} as the ${input.source === 'cardconnect' ? 'CardConnect' : 'Refresh'} billing source for ${monthLabel}`;
      } else if (dest === 'consultant') {
        summary = `Upload ${fileName} as a consultant report input for ${monthLabel}`;
      } else {
        return { result: { error: 'Unknown destination.' } };
      }
      return {
        result: { status: 'waiting_for_user', note: 'Not uploaded yet. The user must click Confirm in the chat.' },
        action: { type: 'confirm', tool: 'upload_attachment', input: { ...input, month: monthLabel }, summary },
      };
    }
    case 'move_file': {
      if (!ctx.canManage) return { result: { error: 'This user cannot move files.' } };
      if (!MOVE_LABELS.includes(input?.label)) return { result: { error: `Unknown label. Use one of: ${MOVE_LABELS.join(', ')}` } };
      const [mn, yr] = String(input?.month || '').split(' ');
      const mi = MONTHS_LONG.indexOf(mn);
      if (mi < 0 || !Number(yr)) return { result: { error: 'month must look like "October 2026"' } };
      const file = String(input?.key || '').split('/').pop();
      return {
        result: { status: 'waiting_for_user', note: 'Not done yet. The user must click Confirm in the chat.' },
        action: { type: 'confirm', tool: 'move_file',
          input: { sourceKey: input.key, canonicalLabel: input.label, month: mi, year: Number(yr), overwrite: input?.overwrite === true },
          summary: `Move ${file} to ${input.label}, ${mn} ${yr}${input?.overwrite ? ' (replacing the existing file)' : ''}` },
      };
    }
    case 'grant_welfare_access':
    case 'revoke_welfare_access':
    case 'set_file_inclusion': {
      const allowed = name === 'set_file_inclusion' ? ctx.canManage : ctx.isAdmin;
      if (!allowed) return { result: { error: 'This user cannot make that change.' } };
      const file = String(input?.key || '').split('/').pop();
      const summary = name === 'grant_welfare_access'
        ? `Give ${input?.email} Welfare access for ${input?.days} day${Number(input?.days) === 1 ? '' : 's'}`
        : name === 'revoke_welfare_access'
          ? `Remove Welfare access for ${input?.email}`
          : `${input?.included ? 'Include' : 'Exclude'} ${file} ${input?.included ? 'in' : 'from'} the ${(() => {
              const m = String(input?.month || '').match(/^(\d{4})-(\d{2})$/);
              return m ? `${MONTHS_LONG[Number(m[2]) - 1]} ${m[1]}` : String(input?.month || '');
            })()} calculations`;
      return {
        result: { status: 'waiting_for_user', note: 'Not done yet. The user must click Confirm in the chat.' },
        action: { type: 'confirm', tool: name, input, summary },
      };
    }
    default:
      return { result: { error: `Unknown tool ${name}` } };
  }
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function systemPrompt(ctx: Ctx, page: string): string {
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(now);
  const role = ctx.isAdmin ? 'Admin' : ctx.session.isPlatformAdmin ? 'Platform Admin' : 'Member';
  return [
    'You are the assistant inside the Gig Workers Universe (GWU) Internal Dashboard, used by staff to review',
    'carrier remittance files, members, consultant reports, billing reconciliation, Welfare figures and support emails.',
    `You are helping ${ctx.session.fullName || ctx.session.email} (${ctx.session.email}), role: ${role}.`,
    ctx.session.isImpersonating ? `They are using View as on this account (real person: ${ctx.session.actualEmail}).` : '',
    `Today is ${today} (New York time). They are on: ${PAGE_NAMES[page] || 'the dashboard'}.`,
    `Pages this person can open: ${ctx.pages.map(p => PAGE_NAMES[p]).join('; ')}.`,
    '',
    'The dashboard (what exists and what you can do on it):',
    '- Dashboard > Master: Active, Terminated and New member tables from the included carrier files; name search and',
    '  filters (group, plan, state, city, carrier file, source, tier). Tools: master_overview, search_master; navigate',
    '  with search and filters to show it on the page.',
    '- Dashboard > All Records: carrier files by month (what arrived, what each is for), search across every file,',
    '  preview, download, Include / Include all / Exclude all, Move, Upload. Tools: list_files, search_all_records,',
    '  read_file, download, set_file_inclusion, set_month_inclusion, move_file, upload_attachment.',
    '- Dashboard > Unclassified Files (Admin): PDF and ZIP files; download only.',
    '- Consultant Report > Monthly and > Directory: per-month workbooks; upload inputs, check the upload checklist,',
    '  generate, read sheets, download the workbook or one consultant\'s tab. Tools: find_consultant,',
    '  get_consultant_report, get_consultant_upload_status, generate_consultant_report, download, upload_attachment.',
    '- Billing > CardPointe_Refresh: per-month reconciliation report (sheets such as CardPointe, Declined_Rejected,',
    '  Q3_Underpaid); upload CardConnect and Refresh sources, generate the report, a per-month updates chat with',
    '  files, approve a chat file as the month\'s report. Tools: get_billing_report, find_in_billing,',
    '  get_billing_chat, upload_attachment, generate_billing_report, post_billing_message, approve_billing_file,',
    '  remove_billing_approval, download.',
    '- Billing > Welfare: monthly Welfare figures, downloadable as Excel; access is granted per person by Admin.',
    '  Tools: get_welfare, download, grant_welfare_access, revoke_welfare_access.',
    '- Activity > Users (Admin, Platform Admin), Activity > PA Monitor (Admin), Support > Pending / Resolved (daily AI',
    '  support email summaries), Other Apps (links). Tools: list_users, get_pa_monitor, get_support, navigate.',
    '- Not available to you: View as, signing out, changing roles, and deleting files (the storage protects them).',
    '  Say so plainly if asked.',
    '- "Download X" means download it (call download), not upload. Downloads start straight away; changes always',
    '  need the user\'s Confirm. When several changes are needed (for example two uploads then generate), propose',
    '  them all in order in one reply; the user can confirm them one by one or all at once.',
    '',
    'Dashboard words (what people mean):',
    '- "included", "counted", "ticked", "in the calculations": the file is Included on All Records for its month (it',
    '  feeds Master and the Consultant report). "excluded", "not included", "not counted": the opposite. Use',
    '  list_files with included=true or false.',
    '- "remittance" / "credits": carrier labels (Cassena Remittance, Cassena Credits, and so on); use list_files label.',
    '- "this month", "last month", "next month": relative to today\'s date above. "received", "came in", "arrived":',
    '  by arrival date (received_month); "October files", "files for October": the month block (file_month).',
    '- "active", "terminated", "new": the three Master tables. "members", "clients", "enrollees": people in Master.',
    '  "group", "company", "employer": the group column.',
    '- "consultant", "agent", "broker": consultants (Consultant report). "PEPM", "earnings", "commission": consultant pay.',
    '- "pending", "open", "unresolved" / "resolved", "closed", "answered": the two Support pages.',
    '- "underpaid", "overpaid", "declined", "rejected", "batched": Billing report sheets and statuses.',
    '  "approved": the billing chat file chosen as the month\'s report.',
    '- "unclassified": PDF and ZIP files (Admin). "View as", "proxy": acting as another account.',
    '- If the user\'s words narrow things to exactly ONE item, act on it straight away (download, open, propose).',
    '  Ask only when two or more still fit, and then list just those.',
    '',
    'Scope:',
    '- You only help with this dashboard: its pages, its data and the actions listed in your tools. If asked for',
    '  anything else (writing code, general knowledge, essays, maths, chit-chat beyond a greeting), reply in one',
    '  short sentence that you only help with the GWU dashboard, and suggest what you can do instead.',
    '',
    'Rules:',
    '- Answer only from tool results. Never guess names, numbers or dates. If a tool returns an error, say so plainly.',
    'How to answer (every question):',
    '- Step 1: if the question names something (a person, group, consultant, carrier, plan, file, code or',
    '  abbreviation such as "FNA"), call search_everywhere with it FIRST. Do not assume what it is.',
    '- Step 2: decide what it is from WHERE it was found (for example: only in the Consultant report = a consultant;',
    '  in Master as group = a group; in Master as memberName = a member). If it is several things, cover each.',
    '- Step 3: answer with the right specific tools, checking sources in the priority order for the topic below, and',
    '  say which source each fact or number came from.',
    '- Never answer "none" or 0 from one source when another part of the dashboard has it.',
    '',
    'Priority order by topic (check them in this order; use all that apply):',
    '- Money (pay, paid, payment, premium, price, fee, charge, cost, amount, owe, billed, collected, declined):',
    '  1) Master payment column (search_master)  2) Billing report (find_in_billing)  3) Consultant report',
    '  (PEPM, earnings, commission via find_consultant or get_consultant_report).',
    '- Counts (how many members, clients, enrollments, groups, companies): 1) Master (match counts)',
    '  2) Consultant report (enrollments and companies per consultant or group). Give each number with its source.',
    '- Consultants and groups: 1) Consultant report and Directory (find_consultant)  2) built-in consultant list',
    '  3) Master groups.',
    '- Files (received, uploaded, missing, which file): All Records (list_files, read_file), then Master missing files',
    '  (master_overview).',
    '- Emails, replies, cases: Support (get_support).',
    '- People and access (who can, who is): Users, Welfare grants, PA Monitor (as allowed).',
    '',
    '- Do not ask permission to look something up: if a tool can answer, call it. Ask a question only when the',
    '  request is truly ambiguous (for example two different groups match) or required information is missing.',
    '- Questions about what a member pays, paid, owes or was charged (pay, payment, premium, fee, charge, amount,',
    '  billed, collected, declined): ALWAYS do both in the same turn, without being asked:',
    '    1. search_master for the member (Active, Terminated and New) for the payment listed in the carrier file;',
    '    2. find_in_billing for that month (default: the current month) for what was actually charged or collected.',
    '  Answer with both, labelled: "Master (carrier file): ..." and "Billing (CardPointe / Refresh): ...", including',
    '  declined or rejected attempts and their dates. If one side has nothing, say so; do not stop at the first.',
    '- Consultant questions (who is the consultant of a group, which groups a consultant has, consultant pay or',
    '  status): call find_consultant straight away, for the latest month unless one is named. Prefer the report',
    '  rows; use the built-in list when the report has no match, and say which source the answer came from.',
    '  If the report and the built-in list name different consultants, give the report\'s answer and mention that',
    '  the older built-in list says otherwise.',
    '  The Master Dashboard does not hold consultants, so do not stop at Master for these.',
    '- Earlier messages in this chat contain only text, NOT the data behind it. For every question about members,',
    '  files, reports, Welfare, users or support cases, call the tools again in THIS turn, even if you answered a',
    '  similar question before. Never build a table or answer from your own earlier replies.',
    '- Only say a field is empty when this turn\'s tool result shows it as "-" or blank for that record.',
    '- search_master searches one table at a time. For questions about members in general (e.g. "members named',
    '  Donna"), search active, terminated and new, and say which table each member came from. Always name the table.',
    '- When asked to open, show, go to or navigate to something, call navigate (with a month or date when one is',
    '  mentioned). Do it every time it is asked, even if the user is already on that page or you did it before.',
    '- Never say a page, month or sheet was opened unless you called navigate in THIS turn.',
    '- When the user wants to see a search ON THE PAGE ("search ... in the dashboard", "show it on the page", "type',
    '  ... in the search"), call navigate with page master or all-info and search set to their text: the page then',
    '  types it into its search box and runs it. Do this even if a chat search found nothing; the page shows its',
    '  own result. Never tell the user to type the search themselves.',
    '- For an answer in the chat ("find", "who", "how many"), use search_master or search_all_records instead.',
    '- To open a specific sheet (Excel tab) inside Billing or a Consultant report, first call get_billing_report or',
    '  get_consultant_report for that month to read the real sheet names, pick the one that fits (for example',
    '  "underpaid" matches a sheet like Q3_Underpaid), then call navigate with page, month and sheet.',
    '- To answer about the contents of a sheet (e.g. "which consultants are underpaid"), call get_billing_report or',
    '  get_consultant_report WITH that sheet, and answer from its rows. Never call a sheet empty unless that call',
    '  returned rowCount 0.',
    '- Attached files: the user\'s message says "[Attached file: name, size]" when a file is attached. You cannot read',
    '  its contents. To upload it, call upload_attachment with the destination they asked for (All Records, billing',
    '  chat, billing source, consultant file). Never default to All Records; if the destination is unclear, ask.',
    '  If no file is attached, ask them to attach it with the paperclip.',
    '- Changes (Welfare access, including or excluding files, moving files, uploads) are only proposed. After proposing, tell the user to press',
    '  Confirm in the chat. Never say a change is done until you are told it was confirmed.',
    '- Months are written like "October 2026". Support and PA Monitor days are YYYY-MM-DD.',
    '- Files: "received", "came in", "arrived", "got" or "uploaded" a month means list_files with received_month.',
    '  "Files for October" or "October files" means file_month. "This month" is the current month (today\'s date above).',
    '  Never search by guessing spellings in file names to answer these; use the month filters. Give the count, and',
    '  list the files (name, carrier, received date) as a table when there are several.',
    '- Keep answers short and plain: a sentence or two, or a short list. Do not use long dashes.',
    '- When the user asks for a table, or the answer is several records, show a markdown table built from the',
    '  tool results (| header | header | with a | --- | row). Include the columns that were asked for, or the useful',
    '  ones; skip columns that are empty ("-") for every row. Use **bold** sparingly for key facts.',
    '- Answer in the chat whenever the tools give you the data. Do not send the user to a page or tell them to',
    '  search themselves unless they asked to open a page or the data is not available to you.',
    '- If a table would be very long, show the first 50 rows and say how many there are in total.',
    '- Share member details only as needed to answer the question.',
    '',
    'Who is who in support emails:',
    `- Our team (Gig Workers Universe staff): ${TEAM.join(', ')}. Any of them may be named by first name,`,
    '  last name or full name. Anyone else (members, employers, carriers, brokers, pharmacies) is outside the team.',
    '- When a team member "replied", "responded", "sent", "confirmed" or "explained" something, that is OUR response.',
    '  When someone outside the team wrote or asked, that is the customer side.',
    '- Questions like "what did we reply", "our responses" or "what did we tell them" mean: list what the team',
    '  members did, in order, with their dates, taken from the case.',
    '',
    'Reading support cases carefully:',
    '- Each case has the sections Core issue, Details, How it progressed and Current status. Read ALL of them before',
    '  answering. Replies and follow-ups are usually in "How it progressed".',
    '- Never say information is missing until you have checked every section of every matching case.',
    '- Use only what the case text says: copy names, dates, times, phone numbers and amounts exactly. Do not add',
    '  details that are not in the text. If something is not in the case, say it is not in the summary.',
    '- If the user says you missed something, re-read the case text from the tool result before answering again;',
    '  do not simply agree.',
  ].filter(Boolean).join('\n');
}

export async function runAssistant(opts: {
  session: Session; origin: string; cookie: string; viewAs: string | null;
  page: string; history: ChatTurn[];
}): Promise<{ reply: string; actions: AssistantAction[]; trace: TraceItem[] }> {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) return { reply: 'The assistant is not set up yet (BEDROCK_MODEL_ID is missing).', actions: [], trace: [] };

  const s = opts.session;
  const canManage = !!(s.isAdmin || s.isPlatformAdmin);
  const isAdmin = !!s.isAdmin;
  let welfareOk = isAdmin;
  if (!welfareOk) {
    try { welfareOk = !!activeGrantFor(await readGrants(), s.email); } catch { /* no access */ }
  }
  const pages = Object.keys(PAGE_NAMES).filter(p =>
    p === 'ai-monitor' ? !!(s.isPlatformAdmin && !s.isImpersonating)
    : p === 'unclassified' || p === 'pa-monitor' ? isAdmin
    : p === 'users' ? canManage
    : p === 'welfare' ? (canManage || welfareOk)
    : true);
  const ctx: Ctx = { session: s, origin: opts.origin, cookie: opts.cookie, viewAs: opts.viewAs, canManage, isAdmin, welfareOk, pages };

  // Text-only history from the page, newest last; at most 20 turns.
  const messages: Message[] = [];
  for (const t of opts.history.slice(-20)) {
    const text = String(t.text || '').slice(0, 4000);
    if (!text) continue;
    const role = t.role === 'assistant' ? 'assistant' : 'user';
    if (messages.length && messages[messages.length - 1].role === role) {
      (messages[messages.length - 1].content as ContentBlock[]).push({ text });
    } else {
      messages.push({ role, content: [{ text }] });
    }
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return { reply: 'Ask me anything about the dashboard.', actions: [], trace: [] };

  const tools = toolList(ctx);
  const actions: AssistantAction[] = [];
  const trace: TraceItem[] = [];
  let retriedNav = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await bedrock.send(new ConverseCommand({
      modelId,
      system: [{ text: systemPrompt(ctx, opts.page) }],
      messages,
      toolConfig: { tools },
      inferenceConfig: { maxTokens: 2000, temperature: 0 },
    }));
    const out = res.output?.message;
    if (!out) break;
    messages.push(out);
    const uses = (out.content || []).filter(b => b.toolUse).map(b => b.toolUse!);
    if (res.stopReason !== 'tool_use' || uses.length === 0) {
      const reply = (out.content || []).map(b => b.text || '').join('').trim();
      // Guard: the reply claims a page was opened, but nothing was. Send it back once to actually do it.
      const claimsNav = /\b(you'?re now on|you are now on|i'?ve opened|i have opened|opened the|navigated|taken you to|switched (you )?to)\b/i.test(reply);
      if (claimsNav && !actions.some(a => a.type === 'navigate') && !retriedNav) {
        retriedNav = true;
        messages.push({ role: 'user', content: [{ text: 'You said you opened something, but you did not call navigate in this turn, so nothing changed on screen. Call navigate now with the right page, month and sheet, then reply.' }] });
        continue;
      }
      return { reply: reply || 'Done.', actions, trace };
    }
    const results: ContentBlock[] = [];
    for (const u of uses) {
      let r: { result: Record<string, unknown>; action?: AssistantAction };
      try { r = await runTool(ctx, u.name!, u.input); }
      catch (err: any) { r = { result: { error: err?.message || 'Tool failed' } }; }
      if (r.action) actions.push(r.action);
      trace.push(describeLookup(u.name!, u.input, r.result));
      results.push({ toolResult: { toolUseId: u.toolUseId!, content: [{ json: r.result as any }] } });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'That took too many steps. Try asking in a simpler way.', actions, trace };
}

// Plain description of one lookup and what it found.
function describeLookup(name: string, input: any, result: any): TraceItem {
  const r = result?.result ?? result;
  const err = result?.error || r?.error;
  const tableName: Record<string, string> = { active: 'Active', terminated: 'Terminated', new: 'New' };
  let label: string;
  switch (name) {
    case 'search_master': {
      const f = input?.filters ? Object.entries(input.filters).filter(([, v]) => v).map(([k]) => k) : [];
      label = `Searched Master (${tableName[input?.table || 'active'] || input?.table})` +
        (input?.search ? ` for "${input.search}"` : '') + (f.length ? `, filters: ${f.join(', ')}` : '') +
        (r && typeof r.matched === 'number' ? `: ${r.matched} match${r.matched === 1 ? '' : 'es'}` : '');
      break;
    }
    case 'search_all_records':
      label = `Searched All Records for "${input?.query || ''}"` +
        (r && typeof r.totalMatches === 'number' ? `: ${r.totalMatches} rows in ${r.filesWithMatches} files` : '');
      break;
    case 'master_overview': label = 'Read Master totals'; break;
    case 'list_files': {
      const f = [input?.received_month ? `received in ${input.received_month}` : '', input?.file_month ? `for ${input.file_month}` : '',
        input?.contains ? `containing "${input.contains}"` : '', input?.label ? `labelled ${input.label}` : '',
        typeof input?.included === 'boolean' ? (input.included ? 'included only' : 'not included only') : ''].filter(Boolean).join(', ');
      label = `Listed All Records files${f ? ` ${f}` : ''}` + (r && typeof r.count === 'number' ? `: ${r.count} found` : '');
      break;
    }
    case 'get_support': label = 'Read support summaries' + (input?.date ? ` for ${input.date}` : ''); break;
    case 'find_in_billing': label = `Searched the ${input?.month || ''} billing report for "${input?.name || ''}"` +
      (r && typeof r.count === 'number' ? `: ${r.count} row${r.count === 1 ? '' : 's'} in ${new Set((r.matches || []).map((m: any) => m.sheet)).size} sheet(s)` : ''); break;
    case 'find_consultant': label = `Looked up consultant data for "${input?.group || input?.consultant || ''}"` +
      (r?.month ? ` (${r.month})` : '') +
      (r ? `: ${(r.reportMatches || []).length} report rows, ${(r.builtInList?.matches || []).length} list matches` : ''); break;
    case 'get_consultant_report': label = `Read the consultant ${input?.file === 'directory' ? 'directory' : 'report'} for ${input?.month || ''}${input?.sheet ? `, sheet ${input.sheet}` : ''}` +
      (r && typeof r.rowCount === 'number' ? `: ${r.rowCount} rows` : ''); break;
    case 'get_billing_report': label = `Read the billing report for ${input?.month || ''}${input?.sheet ? `, sheet ${input.sheet}` : ''}` +
      (r && typeof r.rowCount === 'number' ? `: ${r.rowCount} rows` : ''); break;
    case 'get_welfare': label = `Read Welfare for ${input?.month || ''}`; break;
    case 'list_users': label = 'Read the user list'; break;
    case 'get_pa_monitor': label = 'Read PA Monitor' + (input?.date ? ` for ${input.date}` : ''); break;
    case 'search_everywhere': {
      const f = r?.found || {};
      const where: string[] = [];
      if (f.master && f.master !== 'not found' && !f.master.error) {
        const kinds = new Set<string>(); Object.values(f.master).forEach((t: any) => Object.keys(t).forEach(x => kinds.add(x)));
        where.push(`Master (${[...kinds].join(', ')})`);
      }
      if (f.allRecords?.namesInFiles && f.allRecords.namesInFiles !== 'not found') where.push('All Records rows');
      if (f.allRecords?.fileNames && f.allRecords.fileNames !== 'not found') where.push('file names');
      if (Array.isArray(f.consultant?.monthlyReport) || Array.isArray(f.consultant?.directory)) where.push(`Consultant report (${f.consultant.month})`);
      if (f.consultant?.builtInList && f.consultant.builtInList !== 'not found') where.push('consultant list');
      if (Array.isArray(f.billing?.sheets)) where.push(`Billing (${f.billing.month})`);
      if (f.support?.count) where.push('Support');
      if (Array.isArray(f.users)) where.push('Users');
      label = `Searched the whole dashboard for "${input?.query || ''}": ${where.length ? `found in ${where.join(', ')}` : 'not found anywhere'}`;
      break;
    }
    case 'read_file': label = `Read ${String(input?.key || '').split('/').pop()}` + (r && typeof r.totalRows === 'number' ? `: ${r.totalRows} rows` : ''); break;
    case 'get_billing_chat': label = `Read the ${input?.month || ''} billing chat` + (r?.messages ? `: ${r.messages.length} messages` : ''); break;
    case 'list_report_months': label = 'Listed report months'; break;
    case 'get_consultant_upload_status': label = `Checked consultant uploads for ${input?.month || ''}`; break;
    case 'download': label = `Started download: ${r?.downloading || input?.what}`; break;
    case 'navigate': label = `Opened ${PAGE_NAMES[input?.page] || input?.page}${input?.month ? `, ${input.month}` : ''}${input?.sheet ? `, sheet ${input.sheet}` : ''}${typeof input?.search === 'string' && (input?.page === 'master' || input?.page === 'all-info') ? (input.search ? `, searched "${input.search}"` : ', cleared the search') : ''}`; break;
    default: label = `Prepared a change for you to confirm (${name.replace(/_/g, ' ')})`;
  }
  return { label: err ? `${label} (failed: ${err})` : label, ok: !err };
}