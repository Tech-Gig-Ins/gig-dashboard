// Located at: lib/masterQuery.ts
//
// Server-side search, filtering, sorting and paging for the Master Dashboard
// tables. Returns exactly the rows, in exactly the order, that the browser
// used to produce with filterMasterRows + applyColumnFilters + sortRows.
//
// Part A is the original browser code, copied from app/page.tsx with its
// inputs passed as parameters. It is the reference used by the comparison
// route and tests. One deliberate change: the name search matches each word
// separately, in any order (see legacyFilterMasterRows).
//
// Part B is the indexed engine, built once per table per Master result:
//   - Name search: a suffix array over each row's normalizedName (the same
//     technique as All Info search), so "contains" lookups are binary searches.
//   - Filters: each column is dictionary-encoded (every distinct value stored
//     once, each row holds a number). A filter is tested once per distinct
//     value, not once per row, and the matching rows form a bitmap. Bitmaps for
//     several filters are combined with bitwise AND.
//   - Sorting: each column is ranked once (lazily, then kept). Sorting a result
//     is then an integer sort, and the original stable order breaks ties.
//   - Paging: only the requested page of rows is returned.

// ===========================================================================
// Types (same shapes as app/page.tsx)
// ===========================================================================

export type PaymentFilter = { lt: string; gt: string; eq: string };
export type FilterState = {
  group: string; planName: string; anthemId: string; payment: PaymentFilter;
  city: string; state: string; address1: string; address2: string;
  email: string; phone: string; file: string; sourceSystem: string;
  coverageTier: string; terminationDate: string; effectiveDate: string;
};
export type SortState = { column: string; direction: 'asc' | 'desc' } | null;
export type MasterRow = {
  memberName: string; normalizedName: string; group: string; normalizedGroup: string;
  planName: string; anthemId: string; payment: string; city: string; state: string;
  address1: string; address2: string; email: string; phone: string; file: string;
  sourceSystem: string; coverageTier: string;
  terminationDate?: string; effectiveDate?: string;
};
export type TableKind = 'active' | 'terminated' | 'new';

export const EMPTY_FILTER: FilterState = {
  group: '', planName: '', anthemId: '', payment: { lt: '', gt: '', eq: '' },
  city: '', state: '', address1: '', address2: '', email: '', phone: '',
  file: '', sourceSystem: '', coverageTier: '', terminationDate: '', effectiveDate: '',
};

/** Fills in any missing fields so a partial or malformed body cannot throw. */
export function normalizeFilterState(f: any): FilterState {
  const s = (v: any) => (typeof v === 'string' ? v : '');
  const p = f && typeof f.payment === 'object' && f.payment ? f.payment : {};
  return {
    group: s(f?.group), planName: s(f?.planName), anthemId: s(f?.anthemId),
    payment: { lt: s(p.lt), gt: s(p.gt), eq: s(p.eq) },
    city: s(f?.city), state: s(f?.state), address1: s(f?.address1), address2: s(f?.address2),
    email: s(f?.email), phone: s(f?.phone), file: s(f?.file), sourceSystem: s(f?.sourceSystem),
    coverageTier: s(f?.coverageTier), terminationDate: s(f?.terminationDate), effectiveDate: s(f?.effectiveDate),
  };
}

// ===========================================================================
// Part A: the original browser logic (reference)
// ===========================================================================

/** Words of the search, each normalized like the name (a-z, 0-9), empties dropped. */
export function searchWords(q: string): string[] {
  return q.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(w => w.length > 0);
}

// Name search: every word must appear in the member name, in any order, so
// "murphy donna" finds "Donna Murphy". (Originally the words were joined and
// had to appear in the typed order.) File search is unchanged.
export function legacyFilterMasterRows<T extends { normalizedName: string; file: string }>(rows: T[], masterSearch: string): T[] {
  const q = masterSearch.trim().toLowerCase();
  if (!q) return rows;
  const words = searchWords(q);
  return rows.filter(r => {
    const nameMatches = words.length > 0 && words.every(w => r.normalizedName.includes(w));
    const fileMatches = r.file.toLowerCase().includes(q);
    return nameMatches || fileMatches;
  });
}

export function ymdToMdy(ymd: string): string {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  if (!y || !m || !d) return ymd;
  return `${m}/${d}/${y}`;
}

export function legacyApplyColumnFilters(row: MasterRow, f: FilterState, isTerminatedTable: boolean, isNewTable: boolean): boolean {
  if (f.group && !row.group.toLowerCase().includes(f.group.toLowerCase())) return false;
  if (f.planName && !row.planName.toLowerCase().includes(f.planName.toLowerCase())) return false;
  if (f.anthemId && !row.anthemId.toLowerCase().includes(f.anthemId.toLowerCase())) return false;

  if (f.payment.lt || f.payment.gt || f.payment.eq) {
    const raw = String(row.payment).replace(/[$,]/g, '');
    const num = parseFloat(raw);
    if (isNaN(num)) return false;
    if (f.payment.eq) {
      const target = parseFloat(f.payment.eq);
      if (!isNaN(target) && num !== target) return false;
    } else {
      if (f.payment.lt) {
        const ub = parseFloat(f.payment.lt);
        if (!isNaN(ub) && num >= ub) return false;
      }
      if (f.payment.gt) {
        const lb = parseFloat(f.payment.gt);
        if (!isNaN(lb) && num <= lb) return false;
      }
    }
  }

  if (f.city && !row.city.toLowerCase().includes(f.city.toLowerCase())) return false;
  if (f.state && row.state !== f.state) return false;
  if (f.address1 && !row.address1.toLowerCase().includes(f.address1.toLowerCase())) return false;
  if (f.address2 && !row.address2.toLowerCase().includes(f.address2.toLowerCase())) return false;
  if (f.email && !row.email.toLowerCase().includes(f.email.toLowerCase())) return false;
  if (f.phone) {
    const phoneDigits = String(row.phone).replace(/[^0-9]/g, '');
    const filterDigits = f.phone.replace(/[^0-9]/g, '');
    if (filterDigits && !phoneDigits.includes(filterDigits)) return false;
  }
  if (f.file && row.file !== f.file) return false;
  if (f.sourceSystem && row.sourceSystem !== f.sourceSystem) return false;
  if (f.coverageTier && !row.coverageTier.toLowerCase().includes(f.coverageTier.toLowerCase())) return false;

  if (isTerminatedTable && f.terminationDate) {
    const rowDate = String((row as any).terminationDate || '').trim();
    const filterDate = ymdToMdy(f.terminationDate);
    if (rowDate !== filterDate) return false;
  }
  if (isNewTable && f.effectiveDate) {
    const rowDate = String((row as any).effectiveDate || '').trim();
    const filterDate = ymdToMdy(f.effectiveDate);
    if (rowDate !== filterDate) return false;
  }
  return true;
}

type SortableType = 'numeric' | 'date' | 'text';
export const COLUMN_TYPES: Record<string, SortableType> = {
  memberName: 'text', group: 'text', planName: 'text', anthemId: 'text',
  payment: 'numeric', city: 'text', state: 'text', address1: 'text', address2: 'text',
  email: 'text', phone: 'text', file: 'text', sourceSystem: 'text', coverageTier: 'text',
  terminationDate: 'date', effectiveDate: 'date', consultant: 'text',
};

function parseMdyToTimestamp(s: string): number {
  const parts = String(s).trim().split('/');
  if (parts.length !== 3) return NaN;
  const m = parseInt(parts[0], 10);
  const d = parseInt(parts[1], 10);
  const y = parseInt(parts[2], 10);
  if (!m || !d || !y) return NaN;
  return new Date(y, m - 1, d).getTime();
}

function isMissingSortValue(v: any): boolean {
  return v === undefined || v === null || v === '' || v === '-';
}

export function legacySortRows<T extends Record<string, any>>(rows: T[], sortState: SortState): T[] {
  if (!sortState) return rows;
  const { column, direction } = sortState;
  const type = COLUMN_TYPES[column] || 'text';
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[column];
    const bv = b[column];
    const aMissing = isMissingSortValue(av);
    const bMissing = isMissingSortValue(bv);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (type === 'numeric') {
      const anum = parseFloat(String(av).replace(/[$,]/g, ''));
      const bnum = parseFloat(String(bv).replace(/[$,]/g, ''));
      if (isNaN(anum) && isNaN(bnum)) return 0;
      if (isNaN(anum)) return 1;
      if (isNaN(bnum)) return -1;
      return sign * (anum - bnum);
    }
    if (type === 'date') {
      const at = parseMdyToTimestamp(String(av));
      const bt = parseMdyToTimestamp(String(bv));
      if (isNaN(at) && isNaN(bt)) return 0;
      if (isNaN(at)) return 1;
      if (isNaN(bt)) return -1;
      return sign * (at - bt);
    }
    return sign * String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
  });
}

/** The original end-to-end browser result for one table. */
export function legacyQuery(rows: MasterRow[], kind: TableKind, search: string, f: FilterState, sort: SortState): MasterRow[] {
  const isTerm = kind === 'terminated', isNew = kind === 'new';
  const filtered = legacyFilterMasterRows(rows, search).filter(r => legacyApplyColumnFilters(r, f, isTerm, isNew));
  return legacySortRows(filtered, sort);
}

// ===========================================================================
// Part B: the indexed engine
// ===========================================================================

// ---- Bitmaps: one bit per row, 32 rows per word ----
type Bitmap = Uint32Array;
const newBitmap = (n: number, fill: boolean): Bitmap => {
  const b = new Uint32Array((n + 31) >>> 5);
  if (fill) {
    b.fill(0xffffffff);
    const extra = b.length * 32 - n;
    if (extra > 0) b[b.length - 1] = 0xffffffff >>> extra;
  }
  return b;
};
const setBit = (b: Bitmap, i: number) => { b[i >>> 5] |= 1 << (i & 31); };
const andInto = (target: Bitmap, other: Bitmap) => { for (let i = 0; i < target.length; i++) target[i] &= other[i]; };
const orInto = (target: Bitmap, other: Bitmap) => { for (let i = 0; i < target.length; i++) target[i] |= other[i]; };
function bitsToList(b: Bitmap, n: number): number[] {
  const out: number[] = [];
  for (let w = 0; w < b.length; w++) {
    let word = b[w];
    while (word !== 0) {
      const t = word & -word;
      const i = (w << 5) + (31 - Math.clz32(t));
      if (i < n) out.push(i);
      word ^= t;
    }
  }
  return out;
}

// ---- Dictionary-encoded column ----
type DictColumn = { values: string[]; ids: Int32Array; postings: Map<number, Bitmap> };
function dictColumn(rows: MasterRow[], get: (r: MasterRow) => string): DictColumn {
  const index = new Map<string, number>();
  const values: string[] = [];
  const ids = new Int32Array(rows.length);
  rows.forEach((r, i) => {
    const v = get(r);
    let id = index.get(v);
    if (id === undefined) { id = values.length; values.push(v); index.set(v, id); }
    ids[i] = id;
  });
  return { values, ids, postings: new Map() };
}
/** Rows whose value satisfies pred. pred runs once per distinct value. */
function rowsWhere(col: DictColumn, n: number, pred: (v: string) => boolean): Bitmap {
  const ok = new Uint8Array(col.values.length);
  let any = false;
  for (let i = 0; i < col.values.length; i++) if (pred(col.values[i])) { ok[i] = 1; any = true; }
  const b = newBitmap(n, false);
  if (!any) return b;
  for (let i = 0; i < n; i++) if (ok[col.ids[i]]) setBit(b, i);
  return b;
}
/** Rows equal to one value, from a cached posting bitmap. */
function rowsEqual(col: DictColumn, n: number, value: string): Bitmap {
  const id = col.values.indexOf(value);
  if (id < 0) return newBitmap(n, false);
  let p = col.postings.get(id);
  if (!p) {
    p = newBitmap(n, false);
    for (let i = 0; i < n; i++) if (col.ids[i] === id) setBit(p, i);
    col.postings.set(id, p);
  }
  return p;
}

// ---- Suffix array over normalized names (a-z only) ----
type NameIndex = { bytes: Uint8Array; text: string; starts: Int32Array; sa: Int32Array };
function buildNameIndex(names: string[]): NameIndex {
  const text = names.join('\x01') + '\x01';
  const bytes = Buffer.from(text, 'latin1');
  const starts = new Int32Array(names.length);
  let pos = 0;
  names.forEach((nm, i) => { starts[i] = pos; pos += nm.length + 1; });
  let letters = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 1) letters++;
  const sa = new Int32Array(letters);
  for (let i = 0, j = 0; i < bytes.length; i++) if (bytes[i] !== 1) sa[j++] = i;
  sa.sort((a, b) => {
    for (;;) {
      const x = bytes[a], y = bytes[b];
      if (x !== y) return x - y;
      if (x === 1) return 0;
      a++; b++;
    }
  });
  return { bytes, text, starts, sa };
}
function rowOfPos(ix: NameIndex, pos: number): number {
  let lo = 0, hi = ix.starts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ix.starts[m] <= pos) lo = m; else hi = m - 1; }
  return lo;
}
function cmpAt(ix: NameIndex, p: number, q: string): number {
  for (let j = 0; j < q.length; j++) {
    const x = p + j < ix.bytes.length ? ix.bytes[p + j] : 0;
    const y = q.charCodeAt(j);
    if (x !== y) return x - y;
  }
  return 0;
}
/** Rows whose normalizedName contains q. q is non-empty. */
function namesContaining(ix: NameIndex, n: number, q: string): Bitmap {
  const b = newBitmap(n, false);
  // normalizedName holds only a-z; a query with any other character
  // (digits are kept by the search normalization) can never match.
  if (!/^[a-z]+$/.test(q)) return b;
  const sa = ix.sa;
  let lo = 0, hi = sa.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cmpAt(ix, sa[m], q) < 0) lo = m + 1; else hi = m; }
  const first = lo; hi = sa.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cmpAt(ix, sa[m], q) <= 0) lo = m + 1; else hi = m; }
  const count = lo - first;
  if (count > sa.length * 0.1) {
    // Hybrid: very common query, a scan is faster than listing every hit.
    let from = 0;
    for (;;) {
      const at = ix.text.indexOf(q, from);
      if (at < 0) break;
      const r = rowOfPos(ix, at);
      setBit(b, r);
      from = r + 1 < n ? ix.starts[r + 1] : ix.text.length;
    }
    return b;
  }
  for (let i = first; i < lo; i++) setBit(b, rowOfPos(ix, sa[i]));
  return b;
}

// ---- Sort ranks: computed once per column, then kept ----
type SortKey = { cls: Uint8Array; rank: Int32Array }; // cls: 0 value, 1 unparseable, 2 missing
function buildSortKey(rows: MasterRow[], column: string): SortKey {
  const type = COLUMN_TYPES[column] || 'text';
  const n = rows.length;
  const cls = new Uint8Array(n);
  const rank = new Int32Array(n);
  const num = new Float64Array(n);
  const valued: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = (rows[i] as any)[column];
    if (isMissingSortValue(v)) { cls[i] = 2; continue; }
    if (type === 'numeric') {
      const x = parseFloat(String(v).replace(/[$,]/g, ''));
      if (isNaN(x)) { cls[i] = 1; continue; }
      num[i] = x;
    } else if (type === 'date') {
      const x = parseMdyToTimestamp(String(v));
      if (isNaN(x)) { cls[i] = 1; continue; }
      num[i] = x;
    }
    valued.push(i);
  }
  const cmp = type === 'text'
    ? (a: number, b: number) => String((rows[a] as any)[column]).localeCompare(String((rows[b] as any)[column]), undefined, { numeric: true, sensitivity: 'base' })
    : (a: number, b: number) => num[a] - num[b];
  valued.sort(cmp);
  let r = 0;
  for (let k = 0; k < valued.length; k++) {
    if (k > 0 && cmp(valued[k - 1], valued[k]) !== 0) r++;
    rank[valued[k]] = r;
  }
  return { cls, rank };
}

// ---- Prepared table ----
type PreparedTable = {
  kind: TableKind;
  rows: MasterRow[];
  n: number;
  names: NameIndex;
  cols: Record<string, DictColumn>;
  payment: Float64Array;
  sortKeys: Map<string, SortKey>;
};

const DICT_FIELDS = ['group', 'planName', 'anthemId', 'city', 'state', 'address1', 'address2',
  'email', 'phone', 'file', 'sourceSystem', 'coverageTier'] as const;

export function prepareTable(rows: MasterRow[], kind: TableKind): PreparedTable {
  const n = rows.length;
  const cols: Record<string, DictColumn> = {};
  for (const f of DICT_FIELDS) cols[f] = dictColumn(rows, r => String((r as any)[f]));
  if (kind === 'terminated') cols.terminationDate = dictColumn(rows, r => String(r.terminationDate || '').trim());
  if (kind === 'new') cols.effectiveDate = dictColumn(rows, r => String(r.effectiveDate || '').trim());
  const payment = new Float64Array(n);
  rows.forEach((r, i) => { payment[i] = parseFloat(String(r.payment).replace(/[$,]/g, '')); });
  return { kind, rows, n, names: buildNameIndex(rows.map(r => r.normalizedName)), cols, payment, sortKeys: new Map() };
}

/** Matching row indices, in the original order, then sorted as the browser sorted. */
export function indexedQueryIndices(t: PreparedTable, search: string, f: FilterState, sort: SortState): number[] {
  const n = t.n;
  const result = newBitmap(n, true);

  // Search bar: name contains every word (any order), OR file label contains.
  const q = search.trim().toLowerCase();
  if (q) {
    const words = searchWords(q);
    let hit: Bitmap;
    if (words.length === 0) hit = newBitmap(n, false);
    else {
      hit = namesContaining(t.names, n, words[0]);
      for (let k = 1; k < words.length; k++) andInto(hit, namesContaining(t.names, n, words[k]));
    }
    orInto(hit, rowsWhere(t.cols.file, n, v => v.toLowerCase().includes(q)));
    andInto(result, hit);
  }

  // Column filters. Each one narrows the result with a bitwise AND.
  const contains = (field: string, needle: string) => {
    const lower = needle.toLowerCase();
    andInto(result, rowsWhere(t.cols[field], n, v => v.toLowerCase().includes(lower)));
  };
  if (f.group) contains('group', f.group);
  if (f.planName) contains('planName', f.planName);
  if (f.anthemId) contains('anthemId', f.anthemId);
  if (f.payment.lt || f.payment.gt || f.payment.eq) {
    const b = newBitmap(n, false);
    const eq = parseFloat(f.payment.eq), lt = parseFloat(f.payment.lt), gt = parseFloat(f.payment.gt);
    for (let i = 0; i < n; i++) {
      const num = t.payment[i];
      if (isNaN(num)) continue;
      if (f.payment.eq) { if (!isNaN(eq) && num !== eq) continue; }
      else {
        if (f.payment.lt && !isNaN(lt) && num >= lt) continue;
        if (f.payment.gt && !isNaN(gt) && num <= gt) continue;
      }
      setBit(b, i);
    }
    andInto(result, b);
  }
  if (f.city) contains('city', f.city);
  if (f.state) andInto(result, rowsEqual(t.cols.state, n, f.state));
  if (f.address1) contains('address1', f.address1);
  if (f.address2) contains('address2', f.address2);
  if (f.email) contains('email', f.email);
  if (f.phone) {
    const digits = f.phone.replace(/[^0-9]/g, '');
    if (digits) andInto(result, rowsWhere(t.cols.phone, n, v => v.replace(/[^0-9]/g, '').includes(digits)));
  }
  if (f.file) andInto(result, rowsEqual(t.cols.file, n, f.file));
  if (f.sourceSystem) andInto(result, rowsEqual(t.cols.sourceSystem, n, f.sourceSystem));
  if (f.coverageTier) contains('coverageTier', f.coverageTier);
  if (t.kind === 'terminated' && f.terminationDate) andInto(result, rowsEqual(t.cols.terminationDate, n, ymdToMdy(f.terminationDate)));
  if (t.kind === 'new' && f.effectiveDate) andInto(result, rowsEqual(t.cols.effectiveDate, n, ymdToMdy(f.effectiveDate)));

  const list = bitsToList(result, n); // ascending = original order
  if (!sort) return list;

  let key = t.sortKeys.get(sort.column);
  if (!key) { key = buildSortKey(t.rows, sort.column); t.sortKeys.set(sort.column, key); }
  const { cls, rank } = key;
  const dir = sort.direction === 'asc' ? 1 : -1;
  return list.sort((a, b) =>
    (cls[a] - cls[b]) || (cls[a] === 0 ? dir * (rank[a] - rank[b]) : 0) || (a - b));
}

// ---- Prepared tables cache, per Master fingerprint ----
const prepared = new Map<string, Record<TableKind, PreparedTable>>();

export function getPreparedTables(fp: string, data: { activeMembers: MasterRow[]; terminatedMembers: MasterRow[]; newMembers: MasterRow[] }) {
  let p = prepared.get(fp);
  if (!p) {
    p = {
      active: prepareTable(data.activeMembers, 'active'),
      terminated: prepareTable(data.terminatedMembers, 'terminated'),
      new: prepareTable(data.newMembers, 'new'),
    };
    prepared.set(fp, p);
    while (prepared.size > 2) prepared.delete(prepared.keys().next().value as string);
  }
  return p;
}

export type MasterPage = { rows: MasterRow[]; matched: number; total: number; page: number; pageSize: number };

export function queryPage(t: PreparedTable, search: string, f: FilterState, sort: SortState, page: number, pageSize: number): MasterPage {
  const idx = indexedQueryIndices(t, search, f, sort);
  const size = Math.min(Math.max(1, Math.floor(pageSize) || 100), 500);
  const pages = Math.max(1, Math.ceil(idx.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return {
    rows: idx.slice((p - 1) * size, p * size).map(i => t.rows[i]),
    matched: idx.length,
    total: t.n,
    page: p,
    pageSize: size,
  };
}