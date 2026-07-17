'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { CONSULTANT_ROWS, UNIQUE_CONSULTANTS, REPORT_MONTH, type ConsultantRow } from './data/consultantData';
import * as XLSX from 'xlsx';

// Group name -> consultant lookup (built once from the static consultant data).
// If a group appears under multiple consultants (rare), first one wins.
const GROUP_TO_CONSULTANT: Map<string, string> = new Map();
for (const r of CONSULTANT_ROWS) {
  if (r.normalizedGroup && !GROUP_TO_CONSULTANT.has(r.normalizedGroup)) {
    GROUP_TO_CONSULTANT.set(r.normalizedGroup, r.consultant);
  }
}

function normalizeGroupName(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getConsultantForGroup(group: string): string {
  if (!group || group === '-') return '-';
  const norm = normalizeGroupName(group);
  return GROUP_TO_CONSULTANT.get(norm) || '-';
}

type FileRow = {
  key: string;
  filename: string;
  size: number;
  lastModified: string;
};

type FileContent = {
  headers: string[];
  rows: string[][];
  totalRows: number;
  sheetName?: string;
};

type SearchMatch = {
  fileKey: string;
  filename: string;
  system: string;
  headers: string[];
  rows: string[][];
  matchedTermsPerRow: string[][];
  matchedColumns: string[];
  matchedColumnIndices: number[];
};

type SearchResponse = {
  query: string;
  filesScanned: number;
  filesWithMatches: number;
  totalMatches: number;
  results: SearchMatch[];
};

type TabKey = 'master' | 'all-info' | 'consultant' | 'billing';

type MemberRecord = {
  memberName: string;
  normalizedName: string;
  group: string;
  normalizedGroup: string;
  planName: string;
  anthemId: string;
  payment: string;
  city: string;
  state: string;
  address1: string;
  address2: string;
  email: string;
  phone: string;
  file: string;
  sourceSystem: string;
  coverageTier: string;
};
type ActiveRow = MemberRecord;
type TerminatedRow = MemberRecord & { terminationDate: string };
type NewRow = MemberRecord & { effectiveDate: string };
type FileTimelineEntry = { month: string; present: boolean };
type FileTimeline = { file: string; lastUpdatedMonth: string | null; history: FileTimelineEntry[] };
type MasterData = {
  monthsProcessed: string[];
  activeMembers: ActiveRow[];
  terminatedMembers: TerminatedRow[];
  newMembers: NewRow[];
  latestMonthLabel: string | null;
  previousMonthLabel: string | null;
  latestMonthMissingFiles: string[];
  previousMonthMissingFiles: string[];
  fileTimelines: FileTimeline[];
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_LOOKUP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function detectMonthYear(filename: string): { year: number; month: number } | null {
  const lower = filename.toLowerCase();
  const monthNamePattern = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s_\-]*(\d{4})/i;
  const m1 = lower.match(monthNamePattern);
  if (m1) {
    const month = MONTH_LOOKUP[m1[1].toLowerCase()];
    const year = parseInt(m1[2], 10);
    if (month !== undefined && year >= 2020 && year <= 2099) return { year, month };
  }
  const monthShortYearPattern = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s_\-]*(\d{2})(?!\d)/i;
  const m1b = lower.match(monthShortYearPattern);
  if (m1b) {
    const month = MONTH_LOOKUP[m1b[1].toLowerCase()];
    const yy = parseInt(m1b[2], 10);
    if (month !== undefined && yy >= 20 && yy <= 99) return { year: 2000 + yy, month };
  }
  const usDatePattern = /(\d{1,2})[\-_\/](\d{1,2})[\-_\/](\d{4})/;
  const m2 = filename.match(usDatePattern);
  if (m2) {
    const month = parseInt(m2[1], 10) - 1;
    const year = parseInt(m2[3], 10);
    if (month >= 0 && month <= 11 && year >= 2020 && year <= 2099) return { year, month };
  }
  // Period-separated MM.DD.YYYY (e.g. "All Refresh Enrollments 4.30.2026.csv")
  const usDotDatePattern = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;
  const m2b = filename.match(usDotDatePattern);
  if (m2b) {
    const month = parseInt(m2b[1], 10) - 1;
    const year = parseInt(m2b[3], 10);
    if (month >= 0 && month <= 11 && year >= 2020 && year <= 2099) return { year, month };
  }
  const isoPattern = /(\d{8})/;
  const m3 = filename.match(isoPattern);
  if (m3) {
    const s = m3[1];
    const year = parseInt(s.slice(0, 4), 10);
    const month = parseInt(s.slice(4, 6), 10) - 1;
    if (year >= 2020 && year <= 2099 && month >= 0 && month <= 11) return { year, month };
  }
  const isoDashPattern = /(\d{4})-(\d{1,2})-(\d{1,2})/;
  const m4 = filename.match(isoDashPattern);
  if (m4) {
    const year = parseInt(m4[1], 10);
    const month = parseInt(m4[2], 10) - 1;
    if (year >= 2020 && year <= 2099 && month >= 0 && month <= 11) return { year, month };
  }
  // YYYY-MM or YYYY_MM without a day (e.g. "2026-07 PIOPAC.xls").
  // Negative lookahead prevents this from swallowing full YYYY-MM-DD dates
  // (which are already handled above) or picking up part of a longer number.
  const yearMonthPattern = /(\d{4})[\-_](\d{1,2})(?![\d]|[\-_\/]\d)/;
  const m5 = filename.match(yearMonthPattern);
  if (m5) {
    const year = parseInt(m5[1], 10);
    const month = parseInt(m5[2], 10) - 1;
    if (year >= 2020 && year <= 2099 && month >= 0 && month <= 11) return { year, month };
  }
  return null;
}

// Fallback: detect just a month NAME in the filename (no year attached).
// Used by groupFiles to place files like "Enroll Confidently June.xls" into
// the right month when the year has to be inferred from the S3 upload date.
function detectMonthNameOnly(filename: string): number | null {
  // Standalone month name - word boundary on either side so we don't match
  // "May" inside a random word or "Jun" as part of "junior".
  const m = filename.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i);
  if (!m) return null;
  return MONTH_LOOKUP[m[1].toLowerCase()];
}

// Same strict classification logic as the backend. Returns 'unknown' if none of
// the canonical rules match. Duplicated here so the upload modal can filter the
// All Info files client-side (avoiding an extra S3 round-trip on modal open).
function classifyFile(filename: string): string {
  const lower = filename.toLowerCase();
  const hasRemittance = lower.includes('remittance');
  const hasCredits = lower.includes('credits');

  if (lower.includes('corechoice')) {
    if (lower.includes('t1')) return 'Corechoice T1';
    if (lower.includes('t3')) return 'Corechoice T3';
  }
  if (lower.includes('delta') && lower.includes('dental')) return 'Delta Dental';
  if (lower.includes('nyp') || lower.includes('ny-practice') || lower.includes('ny practice')) return 'NYP Remittance';
  if (lower.includes('enroll confidently') || lower.includes('piopac')) return 'Enroll Confidently or PIOPAC';

  if (lower.includes('cassena')) {
    if (hasCredits) return 'Cassena Credits';
    if (hasRemittance) return 'Cassena Remittance';
  }
  if (lower.includes('bdsb')) {
    if (hasCredits) return 'BDSB Credits';
    if (hasRemittance) return 'BDSB Remittance';
  }
  if (lower.includes('gwu3')) {
    if (hasCredits) return 'GWU3 Credits';
    if (hasRemittance) return 'GWU3 Remittance';
  }
  if (lower.includes('northstead')) {
    if (hasCredits) return 'Northstead Credits';
    if (hasRemittance) return 'Northstead Remittance';
  }
  if (lower.includes('ep6')) return 'EP6 Remittance';
  if (/\bgig\b/i.test(filename) || lower.includes('_gig_') || lower.startsWith('gig')) {
    if (hasCredits) return 'Gig Credits';
    if (hasRemittance) return 'Gig Remittance';
  }
  if (lower.includes('refresh')) return 'Refresh';
  return 'unknown';
}

// Files with these extensions are shown in All Info but excluded from Master
// Dashboard analysis (they show an "EXCLUDED" tag next to their size).
function isExcludedByExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.pdf') || lower.endsWith('.zip');
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`;
}

function prettifySystemName(raw: string): string {
  const map: Record<string, string> = {
    enrollconfidently: 'Enroll Confidently',
    deltadental: 'Delta Dental',
    tpa: 'TPA',
    ep6: 'EP6',
    gig: 'GIG',
    decisely: 'Decisely',
    northstead: 'Northstead',
    refresh: 'Refresh',
  };
  return map[raw.toLowerCase()] || raw.charAt(0).toUpperCase() + raw.slice(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

type DoubleGrouped = {
  [monthKey: string]: {
    label: string;
    year: number;
    month: number;
    systems: { [systemName: string]: FileRow[] };
  };
};

// System-first grouping used by the All Info browse view (Source -> Month -> Files).
type SystemGrouped = {
  [systemName: string]: {
    displayName: string;
    totalFiles: number;
    months: {
      [monthKey: string]: {
        label: string;
        year: number;
        month: number;
        files: FileRow[];
      };
    };
  };
};

function groupFilesBySystem(files: FileRow[]): SystemGrouped {
  const result: SystemGrouped = {};
  for (const file of files) {
    const sysMatch = file.key.match(/^carrier=([^/]+)\//);
    const system = sysMatch ? sysMatch[1] : 'unknown';
    const detected = detectMonthYear(file.filename);
    let year: number, month: number;
    if (detected) {
      year = detected.year;
      month = detected.month;
    } else {
      const d = new Date(file.lastModified);
      year = d.getFullYear();
      month = d.getMonth();
    }
    const label = monthLabel(year, month);
    const mKey = monthKey(year, month);
    if (!result[system]) {
      result[system] = { displayName: prettifySystemName(system), totalFiles: 0, months: {} };
    }
    if (!result[system].months[mKey]) {
      result[system].months[mKey] = { label, year, month, files: [] };
    }
    result[system].months[mKey].files.push(file);
    result[system].totalFiles++;
  }
  return result;
}

// Canonical list of the 17 files expected each month. Kept in sync with the
// backend list in app/api/master/route.ts. Used to group files in the All Info
// tab by their classified label, and by the upload modal.
const CANONICAL_FILES = [
  'Cassena Remittance',
  'Cassena Credits',
  'EP6 Remittance',
  'NYP Remittance',
  'BDSB Remittance',
  'BDSB Credits',
  'Corechoice T1',
  'Corechoice T3',
  'Gig Remittance',
  'Gig Credits',
  'Delta Dental',
  'GWU3 Remittance',
  'GWU3 Credits',
  'Northstead Remittance',
  'Northstead Credits',
  'Refresh',
  'Enroll Confidently or PIOPAC',
];

function groupFiles(files: FileRow[]): DoubleGrouped {
  const result: DoubleGrouped = {};
  for (const file of files) {
    // Group by canonical file label (Cassena Remittance, BDSB Credits, Refresh, etc.)
    // instead of the S3 carrier folder (gig, tpa, decisely, ...). Files that don't
    // classify cleanly land in 'unknown' and appear at the bottom under "Unclassified".
    const system = classifyFile(file.filename);
    const detected = detectMonthYear(file.filename);
    let year: number, month: number;
    if (detected) {
      year = detected.year;
      month = detected.month;
    } else {
      const uploadDate = new Date(file.lastModified);
      const monthOnly = detectMonthNameOnly(file.filename);
      if (monthOnly !== null) {
        // Filename mentions a month name but no year (e.g. "Enroll Confidently June.xls").
        // Infer the year from the upload date: usually the current year, but if the
        // detected month is later than the upload month, roll back a year (a "December"
        // file uploaded in February belongs to the previous December).
        month = monthOnly;
        year = uploadDate.getFullYear();
        if (month > uploadDate.getMonth()) year -= 1;
      } else {
        // Fall back to the S3 upload date so files with no date info still land in
        // some month block alongside dated files.
        year = uploadDate.getFullYear();
        month = uploadDate.getMonth();
      }
    }
    const label = monthLabel(year, month);
    const mKey = monthKey(year, month);
    if (!result[mKey]) result[mKey] = { label, year, month, systems: {} };
    if (!result[mKey].systems[system]) result[mKey].systems[system] = [];
    result[mKey].systems[system].push(file);
  }
  return result;
}

function highlight(text: string, terms: string[]): React.ReactNode {
  if (!terms || terms.length === 0 || !text) return text;
  const escaped = terms.filter(t => t && t.length > 0).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return text;
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) => {
        const isMatch = escaped.some(t => part.toLowerCase() === t.toLowerCase());
        if (isMatch) {
          return (
            <mark key={i} style={{ background: 'rgba(255, 220, 100, 0.4)', color: '#fff', padding: '0 2px', borderRadius: '3px' }}>
              {part}
            </mark>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  // All Info state (list of files)
  const [grouped, setGrouped] = useState<DoubleGrouped>({});
  const [allFilesRaw, setAllFilesRaw] = useState<FileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalFiles, setTotalFiles] = useState(0);

  const [activeTab, setActiveTab] = useState<TabKey>('all-info');

  const [selectedFile, setSelectedFile] = useState<FileRow | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  // All Info search state
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Master dashboard state
  const [masterData, setMasterData] = useState<MasterData | null>(null);
  const [masterLoading, setMasterLoading] = useState(false);
  const [masterError, setMasterError] = useState<string | null>(null);

  // Upload files modal state
  type UploadRowStatus =
    | { kind: 'idle' }
    | { kind: 'uploading' }
    | { kind: 'success'; renamedTo: string; overridden: boolean }
    | { kind: 'error'; message: string };
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const now = new Date();
  const [uploadMonth, setUploadMonth] = useState<number>(now.getMonth());
  const [uploadYear, setUploadYear] = useState<number>(now.getFullYear());
  const [uploadRowFiles, setUploadRowFiles] = useState<Record<string, File | null>>({});
  const [uploadRowStatus, setUploadRowStatus] = useState<Record<string, UploadRowStatus>>({});

  // Master search uses a "draft" input + a "committed" query (only updates on Search click / Enter)
  const [masterSearchInput, setMasterSearchInput] = useState('');
  const [masterSearch, setMasterSearch] = useState('');

  // Filter drawer
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);

  // Filter draft state (what user is editing in the drawer)
  type PaymentFilter = { lt: string; gt: string; eq: string };
  type FilterState = {
    group: string;
    planName: string;
    anthemId: string;
    payment: PaymentFilter;
    city: string;
    state: string;
    address1: string;
    address2: string;
    email: string;
    phone: string;
    file: string;
    sourceSystem: string;
    coverageTier: string;
    terminationDate: string;
    effectiveDate: string;
  };
  const emptyFilter: FilterState = {
    group: '', planName: '', anthemId: '', payment: { lt: '', gt: '', eq: '' },
    city: '', state: '', address1: '', address2: '', email: '', phone: '',
    file: '', sourceSystem: '', coverageTier: '', terminationDate: '', effectiveDate: '',
  };
  const [draftFilters, setDraftFilters] = useState<FilterState>(emptyFilter);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(emptyFilter);

  // Sort state per Master Dashboard table (independent for Active / Terminated / New).
  // null = unsorted (backend default order). Toggle cycles: unsorted -> default-dir -> reverse -> unsorted.
  type SortState = { column: string; direction: 'asc' | 'desc' } | null;
  const [activeSort, setActiveSort] = useState<SortState>(null);
  const [terminatedSort, setTerminatedSort] = useState<SortState>(null);
  const [newSort, setNewSort] = useState<SortState>(null);

  // Sort-in-progress spinner state per table. Set to true briefly on each sort click for visual feedback.
  const [activeSorting, setActiveSorting] = useState(false);
  const [terminatedSorting, setTerminatedSorting] = useState(false);
  const [newSorting, setNewSorting] = useState(false);

  // Consultant tab state
  const [consultantSearchInput, setConsultantSearchInput] = useState('');
  const [consultantSearch, setConsultantSearch] = useState('');
  const [consultantFilterOpen, setConsultantFilterOpen] = useState(false);
  type ConsultantFilterState = { consultant: string; group: string };
  const emptyConsultantFilter: ConsultantFilterState = { consultant: '', group: '' };
  const [draftConsultantFilters, setDraftConsultantFilters] = useState<ConsultantFilterState>(emptyConsultantFilter);
  const [appliedConsultantFilters, setAppliedConsultantFilters] = useState<ConsultantFilterState>(emptyConsultantFilter);

  // === NEW Consultant tab state (Lambda-driven report) ===
  // Same 10 required source-file slots the Python Lambda expects. Order = display order.
  const CONSULTANT_REQUIRED_SLOTS: Array<[string, string]> = [
    ['TPA_Cassena',           'Cassena (TPA)'],
    ['TPA_Northstead',        'Northstead (TPA)'],
    ['TPA_GWU3',              'GWU3 (TPA)'],
    ['TPA_GIG',               'GIG TPA.com'],
    ['TPA_BDSB',              'BDSB (TPA)'],
    ['426_EP6',               'EP6IX (426)'],
    ['PIOPAC',                'PIOPAC'],
    ['CoreChoice_Direct_T1',  'Decisely GWU2 (CoreChoice T1)'],
    ['CoreChoice_Direct_T3',  'Decisely GWU1 (CoreChoice T3)'],
    ['Gig_Workers',           'Refresh (Gig Workers)'],
  ];
  type ConsultantMonth = { prefix: string; label: string; hasReport: boolean; hasDirectory: boolean; complete: boolean; generatedAt: string | null };
  type ConsultantSlot = { slot: string; label: string; uploaded: boolean; filename: string | null; s3Key: string | null; size: number | null; lastModified: string | null };
  type ConsultantUploadStatus = {
    month: string; monthPrefix: string;
    slots: ConsultantSlot[];
    uploadedCount: number; requiredCount: number; complete: boolean;
    hasExistingUpload: boolean; totalFilesInPrefix: number;
  };
  type ConsultantSheetCell = {
    v: string;
    bg?: string; fg?: string; b?: boolean; i?: boolean;
    a?: 'left' | 'center' | 'right';
    bl?: string; br?: string; bt?: string; bb?: string;
    rs?: number; cs?: number; hidden?: boolean;
  };
  type ConsultantSheet = { name: string; cells: ConsultantSheetCell[][]; columnWidths: number[] };
  type ConsultantFileView = { s3Key: string; filename: string; lastModified: string | null; sheets: ConsultantSheet[] };
  type ConsultantReportResp = {
    month: string; monthPrefix: string;
    report: ConsultantFileView | null;
    directory: ConsultantFileView | null;
    message?: string;
  };

  const [consultantSelectedMonth, setConsultantSelectedMonth] = useState<string>('');
  const [consultantMonthsList, setConsultantMonthsList] = useState<ConsultantMonth[]>([]);
  const [consultantMonthsLoading, setConsultantMonthsLoading] = useState(false);
  const [consultantUploads, setConsultantUploads] = useState<ConsultantUploadStatus | null>(null);
  const [consultantUploadsLoading, setConsultantUploadsLoading] = useState(false);
  const [consultantReportView, setConsultantReportView] = useState<ConsultantReportResp | null>(null);
  const [consultantReportLoading, setConsultantReportLoading] = useState(false);
  const [consultantGenerating, setConsultantGenerating] = useState(false);
  const [consultantUploading, setConsultantUploading] = useState(false);
  const [consultantOpError, setConsultantOpError] = useState<string>('');
  const [consultantActiveReportSheet, setConsultantActiveReportSheet] = useState<string>('');
  const [consultantActiveDirectorySheet, setConsultantActiveDirectorySheet] = useState<string>('');
  const [showNewMonthDialog, setShowNewMonthDialog] = useState(false);
  const [newMonthDraft, setNewMonthDraft] = useState<{ monthIdx: number; year: number }>({
    monthIdx: new Date().getMonth(),
    year: new Date().getFullYear(),
  });
  const consultantFileInputRef = useRef<HTMLInputElement | null>(null);

  // Billing tab state
  // Rich sheet data with formatting - used by Billing tab.
  // Field names are short to keep the JSON payload small.
  type BillingCell = {
    v: string;
    bg?: string; fg?: string;
    b?: boolean; i?: boolean;
    a?: 'left' | 'center' | 'right';
    bl?: string; br?: string; bt?: string; bb?: string;
    rs?: number; cs?: number;
    hidden?: boolean;
  };
  type BillingSheet = { name: string; cells: BillingCell[][]; columnWidths: number[] };
  type BillingReport = {
    sourceFile: string | null;
    filename?: string;
    approvedKey: string | null;
    lastModified: string | null;
    sheets: BillingSheet[];
    message?: string;
  };
  type BillingUpdate = {
    id: string;
    name: string;
    comments: string;
    date: string;
    filename: string | null;
    s3Key: string | null;
    size: number | null;
  };
  const [updates, setUpdates] = useState<BillingUpdate[]>([]);
  const [updatesLoading, setUpdatesLoading] = useState(false);
  const [updatesError, setUpdatesError] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadComments, setUploadComments] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ==================== BILLING TAB STATE ====================
  // Report state - rich Excel data with formatting
  // 
  const [billingReport, setBillingReport] = useState<BillingReport | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingActiveSheet, setBillingActiveSheet] = useState<string>('');
  // Approval passcode modal
  const [approvalModalOpen, setApprovalModalOpen] = useState(false);
  const [approvalTargetKey, setApprovalTargetKey] = useState<string | null>(null);
  const [approvalTargetFilename, setApprovalTargetFilename] = useState<string | null>(null);
  const [approvalPasscode, setApprovalPasscode] = useState('');
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);

  // Load the All Info files listing. Extracted from useEffect so we can refresh
  // it after new files are uploaded via the upload modal.
  function loadAllFilesData() {
    setLoading(true);
    setError(null);
    fetch('/api/files')
      .then((res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        return res.json();
      })
      .then((data: FileRow[]) => {
        setGrouped(groupFiles(data));
        setAllFilesRaw(data);
        setTotalFiles(data.length);
        setLoading(false);
      })
      .catch((e: any) => {
        setError(e.message || 'Failed to load files');
        setLoading(false);
      });
  }

  useEffect(() => {
    setMounted(true);
    loadAllFilesData();
  }, []);

  async function handleDownload(fileKey: string, filename: string) {
    try {
      const res = await fetch(`/api/download?key=${encodeURIComponent(fileKey)}`);
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Download failed: ${res.status}`);
      }
      const data: { url: string; filename: string } = await res.json();
      const a = document.createElement('a');
      a.href = data.url;
      a.download = data.filename || filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e: any) {
      alert(`Download failed: ${e.message || 'Unknown error'}`);
    }
  }

  async function loadFileContent(file: FileRow) {
    setSelectedFile(file);
    setFileContent(null);
    setContentError(null);
    setContentLoading(true);
    try {
      const res = await fetch(`/api/file-content?key=${encodeURIComponent(file.key)}`);
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `API returned ${res.status}`);
      }
      const data: FileContent = await res.json();
      setFileContent(data);
    } catch (e: any) {
      setContentError(e.message || 'Failed to load file');
    } finally {
      setContentLoading(false);
    }
  }

  useEffect(() => {
    if (!searchQuery) return;
    setSearching(true);
    setSearchError(null);
    fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Search failed: ${res.status}`);
        return res.json();
      })
      .then((data: SearchResponse) => {
        setSearchResults(data);
        setSearching(false);
      })
      .catch((e: any) => {
        setSearchError(e.message || 'Search failed');
        setSearching(false);
      });
  }, [searchQuery]);

  // Triggered by clicking Search button or pressing Enter in All Info search input
  function triggerAllInfoSearch() {
    const q = searchInput.trim();
    if (q.length < 2) {
      setSearchQuery('');
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    setSearchQuery(q);
  }

  // Master data lazy load when master OR consultant tab becomes active
  // (Consultant tab's top table shows Active Members enriched with a Consultant column.)
  useEffect(() => {
    if (activeTab !== 'master' && activeTab !== 'consultant') return;
    if (masterData !== null) return;
    setMasterLoading(true);
    setMasterError(null);
    fetch('/api/master')
      .then((res) => {
        if (!res.ok) throw new Error(`Master API failed: ${res.status}`);
        return res.json();
      })
      .then((data: MasterData) => {
        setMasterData(data);
        setMasterLoading(false);
      })
      .catch((e: any) => {
        setMasterError(e.message || 'Failed to load master data');
        setMasterLoading(false);
      });
  }, [activeTab, masterData]);

  // Filter master rows by name and/or file (from the SEARCH bar)
  function filterMasterRows<T extends { normalizedName: string; file: string }>(rows: T[]): T[] {
    const q = masterSearch.trim().toLowerCase();
    if (!q) return rows;
    const normalizedQuery = q.replace(/[^a-z0-9]/g, '');
    return rows.filter(r => {
      const nameMatches = normalizedQuery.length > 0 && r.normalizedName.includes(normalizedQuery);
      const fileMatches = r.file.toLowerCase().includes(q);
      return nameMatches || fileMatches;
    });
  }

  // Apply the column filters (from the FILTER panel) to a row
  function applyColumnFilters<T extends MemberRecord>(row: T, isTerminatedTable: boolean, isNewTable: boolean): boolean {
    const f = appliedFilters;

    if (f.group && !row.group.toLowerCase().includes(f.group.toLowerCase())) return false;
    if (f.planName && !row.planName.toLowerCase().includes(f.planName.toLowerCase())) return false;
    if (f.anthemId && !row.anthemId.toLowerCase().includes(f.anthemId.toLowerCase())) return false;

    // Payment: parse cell value ($1,234.56 -> 1234.56)
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
      // Strip non-digits from both
      const phoneDigits = String(row.phone).replace(/[^0-9]/g, '');
      const filterDigits = f.phone.replace(/[^0-9]/g, '');
      if (filterDigits && !phoneDigits.includes(filterDigits)) return false;
    }
    if (f.file && row.file !== f.file) return false;
    if (f.sourceSystem && row.sourceSystem !== f.sourceSystem) return false;
    if (f.coverageTier && !row.coverageTier.toLowerCase().includes(f.coverageTier.toLowerCase())) return false;

    // Date filters only apply to relevant tables
    if (isTerminatedTable && f.terminationDate) {
      // Row date is MM/DD/YYYY; filter input is YYYY-MM-DD
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

  // Convert YYYY-MM-DD (date input format) to MM/DD/YYYY (data format)
  function ymdToMdy(ymd: string): string {
    if (!ymd) return '';
    const [y, m, d] = ymd.split('-');
    if (!y || !m || !d) return ymd;
    return `${m}/${d}/${y}`;
  }

  // Apply both search and filters to a row set
  function fullyFilter<T extends MemberRecord & { normalizedName: string; file: string }>(
    rows: T[],
    isTerminatedTable = false,
    isNewTable = false,
  ): T[] {
    const afterSearch = filterMasterRows(rows);
    return afterSearch.filter(r => applyColumnFilters(r, isTerminatedTable, isNewTable));
  }

  // ==================== SORT LOGIC ====================
  // Column type map: how to compare values in each column when sorting.
  type SortableType = 'numeric' | 'date' | 'text';
  const COLUMN_TYPES: Record<string, SortableType> = {
    memberName: 'text',
    group: 'text',
    planName: 'text',
    anthemId: 'text',       // treated as text (localeCompare with numeric option handles digit runs)
    payment: 'numeric',
    city: 'text',
    state: 'text',
    address1: 'text',
    address2: 'text',
    email: 'text',
    phone: 'text',          // formats vary, keep text
    file: 'text',
    sourceSystem: 'text',
    coverageTier: 'text',
    terminationDate: 'date',
    effectiveDate: 'date',
    consultant: 'text',     // used on Consultant Report tab
  };

  // Parse MM/DD/YYYY string into a comparable timestamp. Returns NaN if unparseable.
  function parseMdyToTimestamp(s: string): number {
    const parts = String(s).trim().split('/');
    if (parts.length !== 3) return NaN;
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    if (!m || !d || !y) return NaN;
    return new Date(y, m - 1, d).getTime();
  }

  // Return true if the value counts as "missing" (should sort to bottom in both directions).
  function isMissingSortValue(v: any): boolean {
    return v === undefined || v === null || v === '' || v === '-';
  }

  function sortRows<T extends Record<string, any>>(rows: T[], sortState: SortState): T[] {
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
      if (aMissing) return 1;    // missing always at bottom
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

      // text: case-insensitive with natural-number handling (so "abc10" > "abc2")
      return sign * String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  // Click handler: cycles unsorted -> default-direction -> reverse-direction -> unsorted.
  // Also briefly flips a "sorting" flag so the table shows a spinner for visual feedback,
  // since the actual sort finishes in milliseconds and would otherwise feel instantaneous with no signal.
  function toggleSort(
    column: string,
    current: SortState,
    setSortState: (s: SortState) => void,
    setSortingFlag: (b: boolean) => void,
  ) {
    const type = COLUMN_TYPES[column] || 'text';
    // Numeric and date columns default to descending (big/newest first). Text defaults to ascending (A-Z).
    const defaultDir: 'asc' | 'desc' = (type === 'numeric' || type === 'date') ? 'desc' : 'asc';

    // Show spinner IMMEDIATELY (synchronous state update triggers a render before sort runs).
    setSortingFlag(true);

    // Defer the sort itself to the next tick so React commits the spinner-visible render first.
    // Without this, React might batch both state updates and skip the intermediate "sorting" frame.
    setTimeout(() => {
      if (!current || current.column !== column) {
        setSortState({ column, direction: defaultDir });
      } else if (current.direction === defaultDir) {
        setSortState({ column, direction: defaultDir === 'asc' ? 'desc' : 'asc' });
      } else {
        setSortState(null);
      }
      // Hide spinner shortly after the sort is applied
      setTimeout(() => setSortingFlag(false), 250);
    }, 0);
  }

  // Small arrow indicator shown next to header text
  function SortArrow({ column, sortState }: { column: string; sortState: SortState }) {
    if (!sortState || sortState.column !== column) {
      return <span className="sort-arrow-empty">↕</span>;
    }
    return <span className="sort-arrow-active">{sortState.direction === 'asc' ? '↑' : '↓'}</span>;
  }

  // Count how many filters are active
  function countActiveFilters(f: FilterState): number {
    let count = 0;
    if (f.group) count++;
    if (f.planName) count++;
    if (f.anthemId) count++;
    if (f.payment.lt || f.payment.gt || f.payment.eq) count++;
    if (f.city) count++;
    if (f.state) count++;
    if (f.address1) count++;
    if (f.address2) count++;
    if (f.email) count++;
    if (f.phone) count++;
    if (f.file) count++;
    if (f.sourceSystem) count++;
    if (f.coverageTier) count++;
    if (f.terminationDate) count++;
    if (f.effectiveDate) count++;
    return count;
  }

  const activeFilterCount = countActiveFilters(appliedFilters);

  // Extract unique File and Source System values from master data
  function uniqueValues(data: MasterData | null, key: 'file' | 'sourceSystem'): string[] {
    if (!data) return [];
    const set = new Set<string>();
    for (const r of data.activeMembers) if (r[key]) set.add(r[key]);
    for (const r of data.terminatedMembers) if (r[key]) set.add(r[key]);
    for (const r of data.newMembers) if (r[key]) set.add(r[key]);
    return Array.from(set).sort();
  }
  const fileOptions = uniqueValues(masterData, 'file');
  const sourceSystemOptions = uniqueValues(masterData, 'sourceSystem');

  // US states
  const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];

  // Triggered by clicking Master search button or pressing Enter
  function triggerMasterSearch() {
    setMasterSearch(masterSearchInput.trim());
  }

  function applyFilters() {
    setAppliedFilters(draftFilters);
    setFilterDrawerOpen(false);
  }

  function clearAllFilters() {
    setDraftFilters(emptyFilter);
    setAppliedFilters(emptyFilter);
  }

  function openFilterDrawer() {
    // Initialize draft with currently applied filters when opening
    setDraftFilters(appliedFilters);
    setFilterDrawerOpen(true);
  }

  // ==================== CONSULTANT TAB HELPERS ====================
  function triggerConsultantSearch() {
    setConsultantSearch(consultantSearchInput.trim());
  }

  function applyConsultantFilters() {
    setAppliedConsultantFilters(draftConsultantFilters);
    setConsultantFilterOpen(false);
  }

  function clearAllConsultantFilters() {
    setDraftConsultantFilters(emptyConsultantFilter);
    setAppliedConsultantFilters(emptyConsultantFilter);
  }

  function openConsultantFilterDrawer() {
    setDraftConsultantFilters(appliedConsultantFilters);
    setConsultantFilterOpen(true);
  }

  // ==================== NEW CONSULTANT TAB (Lambda) ====================
  const MONTH_NAMES_LONG = ['January','February','March','April','May','June',
                            'July','August','September','October','November','December'];

  // Fetch the list of months that have a generated report/directory in S3.
  // Called on tab open and after generate finishes so the selector stays fresh.
  async function fetchConsultantMonths() {
    setConsultantMonthsLoading(true);
    try {
      const res = await fetch('/api/consultant/months');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load months');
      const months: ConsultantMonth[] = data.months || [];
      setConsultantMonthsList(months);
      // If nothing is selected yet and we have months, pick the newest
      if (!consultantSelectedMonth && months.length > 0) {
        setConsultantSelectedMonth(months[0].label);
      }
      return months;
    } catch (e: any) {
      setConsultantOpError(e.message || 'Failed to load months');
      return [];
    } finally {
      setConsultantMonthsLoading(false);
    }
  }

  // Fetch which of the 10 required slots are filled for the given month.
  async function fetchConsultantUploads(month: string) {
    if (!month) return;
    setConsultantUploadsLoading(true);
    try {
      const res = await fetch(`/api/consultant/check-uploads?month=${encodeURIComponent(month)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to check uploads');
      setConsultantUploads(data);
    } catch (e: any) {
      setConsultantOpError(e.message || 'Failed to check uploads');
      setConsultantUploads(null);
    } finally {
      setConsultantUploadsLoading(false);
    }
  }

  // Fetch the generated report + directory for the given month.
  async function fetchConsultantReport(month: string) {
    if (!month) return;
    setConsultantReportLoading(true);
    try {
      const res = await fetch(`/api/consultant/report?month=${encodeURIComponent(month)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load report');
      setConsultantReportView(data);
      // Default active sheet to first sheet of each viewer
      if (data.report?.sheets?.length > 0) setConsultantActiveReportSheet(data.report.sheets[0].name);
      if (data.directory?.sheets?.length > 0) setConsultantActiveDirectorySheet(data.directory.sheets[0].name);
    } catch (e: any) {
      setConsultantOpError(e.message || 'Failed to load report');
      setConsultantReportView(null);
    } finally {
      setConsultantReportLoading(false);
    }
  }

  // Upload one or more files for the current selected month. Server validates
  // each filename against the 10 required patterns and rejects unmatched files.
  async function handleConsultantUpload(files: FileList | File[]) {
    if (!consultantSelectedMonth) {
      setConsultantOpError('Pick or add a month first.');
      return;
    }
    const arr = Array.from(files);
    if (arr.length === 0) return;
    setConsultantUploading(true);
    setConsultantOpError('');
    try {
      const form = new FormData();
      form.set('month', consultantSelectedMonth);
      for (const f of arr) form.append('files', f);
      const res = await fetch('/api/consultant/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      // Report rejections to the user if any
      const rejected = (data.results || []).filter((r: any) => r.status === 'rejected');
      if (rejected.length > 0) {
        setConsultantOpError(
          `Rejected ${rejected.length} file(s) that didn't match any required slot: ` +
          rejected.map((r: any) => r.filename).join(', ')
        );
      }
      // Refresh upload status so the checklist updates
      await fetchConsultantUploads(consultantSelectedMonth);
    } catch (e: any) {
      setConsultantOpError(e.message || 'Upload failed');
    } finally {
      setConsultantUploading(false);
      if (consultantFileInputRef.current) consultantFileInputRef.current.value = '';
    }
  }

  // Invoke the Lambda for the selected month. Auto-derives prev_month.
  async function handleConsultantGenerate() {
    if (!consultantSelectedMonth) return;
    setConsultantGenerating(true);
    setConsultantOpError('');
    try {
      const res = await fetch('/api/consultant/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curr_month: consultantSelectedMonth }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Report generation failed');
      // Refresh months + report
      await fetchConsultantMonths();
      await fetchConsultantReport(consultantSelectedMonth);
    } catch (e: any) {
      setConsultantOpError(e.message || 'Report generation failed');
    } finally {
      setConsultantGenerating(false);
    }
  }

  // Create a new month entry from the "Add month" dialog.
  function confirmNewMonth() {
    const label = `${MONTH_NAMES_LONG[newMonthDraft.monthIdx]} ${newMonthDraft.year}`;
    setConsultantSelectedMonth(label);
    setShowNewMonthDialog(false);
    // check-uploads for a brand-new month returns 0/10 uploaded; report returns null
    setConsultantReportView(null);
  }

  function countActiveConsultantFilters(f: ConsultantFilterState): number {
    let c = 0;
    if (f.consultant) c++;
    if (f.group) c++;
    return c;
  }

  function filterConsultantRows(rows: ConsultantRow[]): ConsultantRow[] {
    const f = appliedConsultantFilters;
    const q = consultantSearch.trim().toLowerCase();
    const normalizedQ = q.replace(/[^a-z0-9]/g, '');

    return rows.filter(r => {
      // Search: matches consultant OR group (normalized substring)
      if (normalizedQ.length > 0) {
        const matchesConsultant = r.normalizedConsultant.includes(normalizedQ);
        const matchesGroup = r.normalizedGroup.includes(normalizedQ);
        if (!matchesConsultant && !matchesGroup) return false;
      }
      // Consultant filter: exact match
      if (f.consultant && r.consultant !== f.consultant) return false;
      // Group filter: contains
      if (f.group && !r.group.toLowerCase().includes(f.group.toLowerCase())) return false;
      return true;
    });
  }

  const activeConsultantFilterCount = countActiveConsultantFilters(appliedConsultantFilters);

  // ==================== BILLING TAB DATA + UPLOAD ====================
  // Manual refetch trigger for the Billing tab. Bumped after a successful
  // approval so the sheet viewer reloads with the newly-approved file.
  const [billingRefetchTick, setBillingRefetchTick] = useState(0);

  useEffect(() => {
    if (activeTab !== 'billing') return;
    // Load the chat updates if not already loaded (shared with Billing tab)
    if (updates.length === 0 && !updatesLoading && !updatesError) {
      loadUpdates();
    }
    setBillingLoading(true);
    setBillingError(null);
    fetch('/api/billing/report-file')
      .then(res => {
        if (!res.ok) throw new Error(`Load failed: ${res.status}`);
        return res.json();
      })
      .then((data: BillingReport) => {
        setBillingReport(data);
        // Default to the first sheet if the previously selected one no longer exists
        if (data.sheets && data.sheets.length > 0) {
          const hasCurrent = data.sheets.some(s => s.name === billingActiveSheet);
          if (!hasCurrent) setBillingActiveSheet(data.sheets[0].name);
        }
        setBillingLoading(false);
      })
      .catch((e: any) => {
        setBillingError(e.message || 'Failed to load report');
        setBillingLoading(false);
      });
  }, [activeTab, billingRefetchTick]);

  // Load consultant tab data whenever the tab is activated or the month changes.
  useEffect(() => {
    if (activeTab !== 'consultant') return;
    // Always refresh the list of months when the tab becomes active
    fetchConsultantMonths();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'consultant') return;
    if (!consultantSelectedMonth) return;
    fetchConsultantUploads(consultantSelectedMonth);
    fetchConsultantReport(consultantSelectedMonth);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, consultantSelectedMonth]);

  // ==================== APPROVAL FLOW ====================
  function openApprovalModal(u: BillingUpdate) {
    if (!u.s3Key) return;
    setApprovalTargetKey(u.s3Key);
    setApprovalTargetFilename(u.filename || u.s3Key.split('/').pop() || null);
    setApprovalPasscode('');
    setApprovalError(null);
    setApprovalModalOpen(true);
  }
  function closeApprovalModal() {
    if (approvalSubmitting) return; // don't close mid-submit
    setApprovalModalOpen(false);
    setApprovalTargetKey(null);
    setApprovalTargetFilename(null);
    setApprovalPasscode('');
    setApprovalError(null);
  }
  async function submitApproval() {
    if (!approvalTargetKey) {
      setApprovalError('No file selected');
      return;
    }
    if (!approvalPasscode) {
      setApprovalError('Enter the passcode');
      return;
    }
    setApprovalSubmitting(true);
    setApprovalError(null);
    try {
      const res = await fetch('/api/billing/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: approvalTargetKey, passcode: approvalPasscode }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setApprovalError(body.error || `Approval failed (${res.status})`);
        setApprovalSubmitting(false);
        return;
      }
      // Success - close modal, force refetch of the sheet viewer
      setApprovalSubmitting(false);
      setApprovalModalOpen(false);
      setApprovalTargetKey(null);
      setApprovalTargetFilename(null);
      setApprovalPasscode('');
      setBillingReport(null);
      setBillingRefetchTick(t => t + 1);
    } catch (err: any) {
      setApprovalError(err.message || 'Network error');
      setApprovalSubmitting(false);
    }
  }

  function loadUpdates() {
    setUpdatesLoading(true);
    setUpdatesError(null);
    fetch('/api/billing/updates')
      .then(res => {
        if (!res.ok) throw new Error(`Updates API failed: ${res.status}`);
        return res.json();
      })
      .then((data: { updates: BillingUpdate[] }) => {
        setUpdates(data.updates || []);
        setUpdatesLoading(false);
      })
      .catch((e: any) => {
        setUpdatesError(e.message || 'Failed to load updates');
        setUpdatesLoading(false);
      });
  }

  async function submitUpdate(e: React.FormEvent) {
    e.preventDefault();
    setUploadError(null);
    const name = uploadName.trim();
    const comments = uploadComments.trim();
    if (!name || !comments) {
      setUploadError('Name and comments are required');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('name', name);
      fd.append('comments', comments);
      if (uploadFile) fd.append('file', uploadFile);
      const res = await fetch('/api/billing/updates', { method: 'POST', body: fd });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Upload failed: ${res.status}`);
      }
      // Success - reset form and reload updates list
      setUploadName('');
      setUploadComments('');
      setUploadFile(null);
      // Reset the file input DOM element too so the filename display clears
      const fileInput = document.getElementById('billing-upload-file') as HTMLInputElement | null;
      if (fileInput) fileInput.value = '';
      loadUpdates();
    } catch (e: any) {
      setUploadError(e.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function formatUpdateDate(iso: string): string {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        + ', ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  }

  function formatFileSize(bytes: number | null): string {
    if (bytes === null || bytes === undefined) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  async function downloadUpdateFile(u: BillingUpdate) {
    if (!u.s3Key) return;
    try {
      const res = await fetch(`/api/download?key=${encodeURIComponent(u.s3Key)}`);
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Download failed: ${res.status}`);
      }
      const data: { url: string; filename: string } = await res.json();
      const a = document.createElement('a');
      a.href = data.url;
      a.download = u.filename || data.filename || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e: any) {
      alert(`Download failed: ${e.message || 'Unknown error'}`);
    }
  }

  // System-first grouping for the All Info browse view. Recomputes only when
  // the flat file list changes.
  const systemGrouped = useMemo(() => groupFilesBySystem(allFilesRaw), [allFilesRaw]);

  // Order sources by canonical carrier priority so the layout is predictable
  // regardless of upload order. Unknown carriers fall to the end alphabetically.
  const SYSTEM_ORDER = ['refresh', 'northstead', 'gig', 'tpa', 'deltadental', 'decisely', 'enrollconfidently'];
  const sortedSystemNames = Object.keys(systemGrouped).sort((a, b) => {
    const aIdx = SYSTEM_ORDER.indexOf(a);
    const bIdx = SYSTEM_ORDER.indexOf(b);
    if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });

  // Sort a system's months newest-first, keeping 'unknown-' entries at the end.
  function sortedMonthKeysForSystem(sysName: string): string[] {
    return Object.keys(systemGrouped[sysName].months).sort((a, b) => {
      const aUnknown = a.startsWith('unknown-');
      const bUnknown = b.startsWith('unknown-');
      if (aUnknown && !bUnknown) return 1;
      if (!aUnknown && bUnknown) return -1;
      return b.localeCompare(a);
    });
  }

  // Month-first ordering used by the All Info browse view. Newest month first.
  const sortedMonthKeys = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  // Define column lists for each master section
  const activeColumns: [keyof ActiveRow, string][] = [
    ['memberName', 'Member Name'],
    ['group', 'Group'],
    ['planName', 'Plan Name'],
    ['anthemId', 'Anthem ID'],
    ['payment', 'Payment'],
    ['city', 'City'],
    ['state', 'State'],
    ['address1', 'Address 1'],
    ['address2', 'Address 2'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['file', 'File'],
    ['sourceSystem', 'Source System'],
    ['coverageTier', 'Coverage Tier'],
  ];
  const terminatedColumns: [keyof TerminatedRow, string][] = [
    ['memberName', 'Member Name'],
    ['group', 'Group'],
    ['planName', 'Plan Name'],
    ['anthemId', 'Anthem ID'],
    ['payment', 'Payment'],
    ['city', 'City'],
    ['state', 'State'],
    ['address1', 'Address 1'],
    ['address2', 'Address 2'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['terminationDate', 'Termination Date'],
    ['file', 'File'],
    ['sourceSystem', 'Source System'],
    ['coverageTier', 'Coverage Tier'],
  ];
  const newColumns: [keyof NewRow, string][] = [
    ['memberName', 'Member Name'],
    ['group', 'Group'],
    ['planName', 'Plan Name'],
    ['anthemId', 'Anthem ID'],
    ['payment', 'Payment'],
    ['city', 'City'],
    ['state', 'State'],
    ['address1', 'Address 1'],
    ['address2', 'Address 2'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['effectiveDate', 'Effective Date'],
    ['file', 'File'],
    ['sourceSystem', 'Source System'],
    ['coverageTier', 'Coverage Tier'],
  ];

  function renderMasterTableCells<T extends MemberRecord>(row: T, columns: [keyof T, string][]): React.ReactNode {
    return columns.map(([key]) => {
      const val = String(row[key] ?? '-');
      if (key === 'memberName') return <td key={String(key)} className="cell-name">{val}</td>;
      if (key === 'group') return <td key={String(key)} className="cell-group">{val}</td>;
      if (key === 'planName') return <td key={String(key)} className="cell-plan">{val}</td>;
      if (key === 'payment') return <td key={String(key)} className="cell-amount">{val}</td>;
      if (key === 'file') return <td key={String(key)}><span className="cell-pill">{val}</span></td>;
      if (key === 'sourceSystem') return <td key={String(key)}><span className="cell-pill cell-pill-alt">{val}</span></td>;
      return <td key={String(key)}>{val}</td>;
    });
  }

  // ==================== ACTIVE MEMBERS + CONSULTANT COLUMN (top table on Consultant tab) ====================
  // Same 14 columns as activeColumns, plus a leading "Consultant" column derived from the group lookup.
  const activeWithConsultantColumns: [string, string][] = [
    ['consultant', 'Consultant'],
    ['memberName', 'Member Name'],
    ['group', 'Group'],
    ['planName', 'Plan Name'],
    ['anthemId', 'Anthem ID'],
    ['payment', 'Payment'],
    ['city', 'City'],
    ['state', 'State'],
    ['address1', 'Address 1'],
    ['address2', 'Address 2'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['file', 'File'],
    ['sourceSystem', 'Source System'],
    ['coverageTier', 'Coverage Tier'],
  ];

  function renderActiveWithConsultantCells(row: ActiveRow): React.ReactNode {
    return activeWithConsultantColumns.map(([key]) => {
      if (key === 'consultant') {
        const c = getConsultantForGroup(row.group);
        return (
          <td key="consultant" className="cell-consultant-lookup">
            {c === '-' ? <span className="cell-consultant-empty">-</span> : <span className="cell-pill cell-pill-alt">{c}</span>}
          </td>
        );
      }
      const val = String((row as any)[key] ?? '-');
      if (key === 'memberName') return <td key={key} className="cell-name">{val}</td>;
      if (key === 'group') return <td key={key} className="cell-group">{val}</td>;
      if (key === 'planName') return <td key={key} className="cell-plan">{val}</td>;
      if (key === 'payment') return <td key={key} className="cell-amount">{val}</td>;
      if (key === 'file') return <td key={key}><span className="cell-pill">{val}</span></td>;
      if (key === 'sourceSystem') return <td key={key}><span className="cell-pill cell-pill-alt">{val}</span></td>;
      return <td key={key}>{val}</td>;
    });
  }

  // Filter for the top table on Consultant tab. Uses the consultant tab's own search + filters.
  function filteredActiveWithConsultant(rows: ActiveRow[]): ActiveRow[] {
    const f = appliedConsultantFilters;
    const q = consultantSearch.trim().toLowerCase();
    const normalizedQ = q.replace(/[^a-z0-9]/g, '');

    return rows.filter(r => {
      // Search: match consultant (from lookup), group, or member name
      if (normalizedQ.length > 0) {
        const consultantForRow = getConsultantForGroup(r.group);
        const matchesConsultant = consultantForRow !== '-' && normalizeGroupName(consultantForRow).includes(normalizedQ);
        const matchesGroup = r.normalizedGroup.includes(normalizedQ);
        const matchesMember = r.normalizedName.includes(normalizedQ);
        if (!matchesConsultant && !matchesGroup && !matchesMember) return false;
      }
      // Consultant filter: exact match against lookup value
      if (f.consultant) {
        const consultantForRow = getConsultantForGroup(r.group);
        if (consultantForRow !== f.consultant) return false;
      }
      // Group filter: contains
      if (f.group && !r.group.toLowerCase().includes(f.group.toLowerCase())) return false;
      return true;
    });
  }

  // Download both tables (top: Active Members with Consultant, bottom: Consultant/Group pairs)
  // as a single .xlsx with two sheets. Uses whatever the current filters + search yield.
  function downloadConsultantExcel() {
    if (!masterData) {
      alert('Master data still loading. Please wait a moment and try again.');
      return;
    }
    try {
      const wb = XLSX.utils.book_new();

      // Sheet 1: Active Members with Consultant
      const activeHeaders = activeWithConsultantColumns.map(c => c[1]);
      const activeRowsArr = filteredActiveWithConsultant(masterData.activeMembers).map(row =>
        activeWithConsultantColumns.map(([key]) => {
          if (key === 'consultant') return getConsultantForGroup(row.group);
          return String((row as any)[key] ?? '');
        })
      );
      const ws1 = XLSX.utils.aoa_to_sheet([activeHeaders, ...activeRowsArr]);
      XLSX.utils.book_append_sheet(wb, ws1, 'Active Members');

      // Sheet 2: Consultant/Group pairs
      const pairHeaders = ['Consultant', 'Group'];
      const pairRows = filterConsultantRows(CONSULTANT_ROWS).map(r => [r.consultant, r.group]);
      const ws2 = XLSX.utils.aoa_to_sheet([pairHeaders, ...pairRows]);
      XLSX.utils.book_append_sheet(wb, ws2, 'Consultant Groups');

      const today = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `consultant-report-${today}.xlsx`);
    } catch (e: any) {
      alert(`Excel export failed: ${e.message || 'Unknown error'}`);
    }
  }

  // ========== Upload modal handlers ==========
  function openUploadModal() {
    // Reset state each time so a re-open starts fresh
    setUploadRowFiles({});
    setUploadRowStatus({});
    setUploadModalOpen(true);
  }
  function closeUploadModal() {
    // If any row completed a successful upload, refresh downstream data:
    // - All Info tab (list of files in S3)
    // - Master Dashboard (identity + missing-files derived from those files)
    // Setting masterData to null causes the master useEffect to refetch next time
    // that tab is visited.
    const uploadedAny = Object.values(uploadRowStatus).some(s => s && s.kind === 'success');
    setUploadModalOpen(false);
    if (uploadedAny) {
      loadAllFilesData();
      setMasterData(null);
    }
  }
  function handleRowFileChange(label: string, file: File | null) {
    setUploadRowFiles(prev => ({ ...prev, [label]: file }));
    // Reset status when a new file is picked
    setUploadRowStatus(prev => ({ ...prev, [label]: { kind: 'idle' } }));
  }
  function extractExt(name: string): string {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '.xlsx';
  }
  async function doUpload(label: string, overrideKey?: string) {
    const file = uploadRowFiles[label];
    if (!file) return;
    setUploadRowStatus(prev => ({ ...prev, [label]: { kind: 'uploading' } }));
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('canonicalLabel', label);
      fd.append('month', String(uploadMonth));
      fd.append('year', String(uploadYear));
      // Always send override=true - the frontend has already shown the existing
      // files (client-side check), so a 409 from the backend would be redundant.
      // When overrideKey is provided, the backend deletes that specific file after
      // upload. When it's omitted, the new file is added without deleting anything.
      fd.append('override', 'true');
      if (overrideKey) fd.append('overrideKey', overrideKey);
      const res = await fetch('/api/master/upload', { method: 'POST', body: fd });
      const body = await res.json();
      if (!res.ok) {
        setUploadRowStatus(prev => ({ ...prev, [label]: { kind: 'error', message: body.error || 'Upload failed' } }));
        return;
      }
      setUploadRowStatus(prev => ({ ...prev, [label]: { kind: 'success', renamedTo: body.renamedTo, overridden: !!overrideKey } }));
    } catch (err: any) {
      setUploadRowStatus(prev => ({ ...prev, [label]: { kind: 'error', message: err.message || 'Network error' } }));
    }
  }
  function handleRowOverrideOne(label: string, overrideKey: string) {
    doUpload(label, overrideKey);
  }
  function handleRowAddNew(label: string) {
    doUpload(label, undefined);
  }
  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  // Client-side lookup of existing files that match a canonical label + month + year.
  // Uses the already-loaded All Info data instead of hitting S3, so the upload
  // modal can show existing files immediately when it opens.
  function existingFilesForRow(label: string): FileRow[] {
    if (!allFilesRaw || allFilesRaw.length === 0) return [];
    const matches: FileRow[] = [];
    for (const f of allFilesRaw) {
      // Skip files that aren't part of the analysis pipeline
      if (isExcludedByExtension(f.filename)) continue;
      const detected = detectMonthYear(f.filename);
      if (!detected) continue;
      if (detected.month !== uploadMonth || detected.year !== uploadYear) continue;
      if (classifyFile(f.filename) !== label) continue;
      matches.push(f);
    }
    matches.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
    return matches;
  }

  return (
    <main className="dashboard-root">
      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap');
        html, body { margin: 0; padding: 0; font-family: 'Inter', sans-serif; background: #051433; color: #ffffff; min-height: 100vh; overflow-x: hidden; }
        * { box-sizing: border-box; }

        /* Master Dashboard tables - kept in global scope so td/th descendant selectors work reliably */
        .master-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
        .master-table th {
          padding: 24px 30px !important;
          text-align: center;
          font-size: 10px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.7);
          font-weight: 600;
          background: rgba(5, 20, 51, 0.95);
          border-bottom: 2px solid rgba(107, 164, 255, 0.3);
          border-right: 1px dotted rgba(255, 255, 255, 0.1);
          position: sticky;
          top: 0;
          white-space: nowrap;
          z-index: 2;
          vertical-align: middle;
        }
        .master-table th:last-child { border-right: none; }
        .master-table th.col-name-header { text-align: left; }
        .master-table th.sortable-header {
          cursor: pointer;
          user-select: none;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .master-table th.sortable-header:hover {
          background: rgba(107, 164, 255, 0.18);
          color: #ffffff;
        }
        .sort-arrow-empty {
          opacity: 0.28;
          margin-left: 6px;
          font-size: 11px;
          display: inline-block;
        }
        .sort-arrow-active {
          color: #6ba4ff;
          margin-left: 6px;
          font-weight: 700;
          font-size: 13px;
          display: inline-block;
        }

        /* Sort spinner overlay: shown briefly on top of the table while sorting.
           The outer .sortable-outer div is position:relative and is a sibling of the scrolling
           master-table-wrapper, so the overlay covers the visible table area regardless of
           internal scroll position. */
        .sortable-outer { position: relative; }
        .sort-spinner-overlay {
          position: absolute;
          inset: 0;
          background: rgba(5, 20, 51, 0.55);
          backdrop-filter: blur(2px);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 14px;
          z-index: 5;
          border-radius: 16px;
          pointer-events: none;
        }
        @keyframes sortSpinnerFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .sort-spinner {
          width: 42px;
          height: 42px;
          border-radius: 50%;
          border: 3px solid rgba(107, 164, 255, 0.15);
          border-top-color: #6ba4ff;
          animation: sortSpinnerRotate 0.7s linear infinite;
        }
        @keyframes sortSpinnerRotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .sort-spinner-label {
          font-size: 11px;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: rgba(107, 164, 255, 0.9);
          font-weight: 500;
        }
        .master-table td {
          padding: 24px 30px !important;
          color: rgba(255, 255, 255, 0.85);
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
          border-right: 1px dotted rgba(255, 255, 255, 0.08);
          font-size: 13px;
          vertical-align: middle;
          line-height: 1.5;
          white-space: nowrap;
          text-align: center;
        }
        .master-table td:last-child { border-right: none; }
        .master-table tr:hover td { background: rgba(107, 164, 255, 0.05); }
        .master-table tr:last-child td { border-bottom: none; }
        .master-table td.cell-name {
          font-weight: 500;
          color: #ffffff;
          text-align: left;
          white-space: normal;
          word-wrap: break-word;
          min-width: 180px;
        }
        .master-table td.cell-group {
          text-align: left;
          white-space: normal;
          word-wrap: break-word;
          min-width: 200px;
          color: rgba(255, 255, 255, 0.9);
        }
        .master-table td.cell-plan {
          text-align: left;
          white-space: normal;
          word-wrap: break-word;
          min-width: 220px;
        }
        .master-table .cell-amount {
          font-family: 'JetBrains Mono', 'Courier New', monospace;
          color: #6ba4ff;
          white-space: nowrap;
        }
        .master-table .cell-pill {
          display: inline-block;
          padding: 5px 16px;
          background: rgba(107, 164, 255, 0.15);
          border: 1px solid rgba(107, 164, 255, 0.25);
          border-radius: 999px;
          font-size: 11px;
          font-weight: 500;
          color: #6ba4ff;
          white-space: nowrap;
        }
        .master-table .cell-pill-alt {
          background: rgba(180, 130, 255, 0.12);
          border-color: rgba(180, 130, 255, 0.25);
          color: #b482ff;
        }

        /* Consultant table styles */
        .consultant-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 14px; color: rgba(255, 255, 255, 0.9); font-family: 'Inter', sans-serif; }
        .consultant-table thead th {
          background: rgba(5, 20, 51, 0.95);
          color: rgba(255, 255, 255, 0.7);
          font-size: 11px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          font-weight: 600;
          text-align: left;
          padding: 18px 30px !important;
          border-bottom: 2px solid rgba(107, 164, 255, 0.3);
          position: sticky;
          top: 0;
          z-index: 2;
        }
        .consultant-table tbody tr {
          transition: background 0.15s ease;
        }
        .consultant-table tbody tr:hover td {
          background: rgba(107, 164, 255, 0.06);
        }
        .consultant-table td {
          padding: 14px 30px !important;
          vertical-align: middle;
          border-bottom: 1px dotted rgba(255, 255, 255, 0.06);
        }
        .consultant-table tr:last-child td { border-bottom: none; }
        .consultant-table td.cell-consultant {
          font-weight: 600;
          color: #ffffff;
          width: 30%;
          border-right: 1px dotted rgba(255, 255, 255, 0.08);
        }
        .consultant-table td.cell-c-group {
          color: rgba(255, 255, 255, 0.85);
        }
        .consultant-table .empty-c-row {
          text-align: center;
          color: rgba(255, 255, 255, 0.4);
          padding: 40px !important;
          font-style: italic;
        }

        /* Consultant lookup cell (in Active Members top table) */
        .master-table td.cell-consultant-lookup {
          text-align: left;
          min-width: 140px;
        }
        .cell-consultant-empty { color: rgba(255, 255, 255, 0.3); }
      `}</style>

      <style jsx>{`
        .dashboard-root {
          position: relative;
          min-height: 100vh;
          background:
            radial-gradient(ellipse at top left, rgba(50, 100, 220, 0.25), transparent 50%),
            radial-gradient(ellipse at bottom right, rgba(20, 60, 180, 0.3), transparent 50%),
            linear-gradient(180deg, #051433 0%, #0a1f4d 50%, #061a3f 100%);
          overflow: hidden;
        }
        .grain {
          position: fixed; inset: 0; pointer-events: none; opacity: 0.06; mix-blend-mode: overlay; z-index: 1;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
        }
        .header { position: relative; z-index: 10; padding: 32px 56px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
        .brand { display: flex; align-items: center; gap: 14px; }
        .brand-mark { width: 38px; height: 38px; border-radius: 10px; background: linear-gradient(135deg, #4d8eff 0%, #1546c4 100%); display: flex; align-items: center; justify-content: center; font-family: 'Fraunces', serif; font-weight: 700; font-size: 18px; box-shadow: 0 8px 24px rgba(77, 142, 255, 0.4); }
        .brand-text { font-size: 13px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(255, 255, 255, 0.7); font-weight: 500; }
        .header-meta { font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(255, 255, 255, 0.4); display: flex; gap: 24px; align-items: center; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 12px rgba(74, 222, 128, 0.6); animation: pulse 2s ease-in-out infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

        .hero { position: relative; z-index: 10; padding: 80px 56px 40px; max-width: 1400px; margin: 0 auto; }
        .eyebrow { font-size: 12px; letter-spacing: 0.3em; text-transform: uppercase; color: #6ba4ff; margin-bottom: 24px; opacity: 0; transform: translateY(20px); animation: ${mounted ? 'fadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards' : 'none'}; }
        .title { font-family: 'Fraunces', serif; font-size: clamp(40px, 6vw, 72px); font-weight: 500; letter-spacing: -0.03em; line-height: 0.95; margin: 0; color: #ffffff; opacity: 0; transform: translateY(30px); animation: ${mounted ? 'fadeUp 1s cubic-bezier(0.16, 1, 0.3, 1) 0.25s forwards' : 'none'}; }
        .title-accent { font-style: italic; color: #6ba4ff; font-weight: 400; }
        @keyframes fadeUp { to { opacity: 1; transform: translateY(0); } }

        .tabs-section { position: relative; z-index: 10; padding: 0 56px; max-width: 1400px; margin: 0 auto 24px; }
        .tabs-pill { display: inline-flex; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 999px; padding: 6px; gap: 4px; backdrop-filter: blur(20px); }
        .tab-btn { padding: 10px 24px; background: transparent; border: none; border-radius: 999px; color: rgba(255, 255, 255, 0.6); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s ease; font-family: 'Inter', sans-serif; }
        .tab-btn:hover { color: #ffffff; }
        .tab-btn.active { background: linear-gradient(135deg, #4d8eff 0%, #1546c4 100%); color: #ffffff; box-shadow: 0 4px 16px rgba(77, 142, 255, 0.3); }

        .search-bar { position: relative; max-width: 1400px; margin: 0 auto 32px; padding: 0 56px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .search-wrapper { position: relative; flex: 1; min-width: 280px; }
        .search-input { width: 100%; padding: 16px 24px 16px 56px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 16px; color: #ffffff; font-size: 15px; font-family: 'Inter', sans-serif; backdrop-filter: blur(20px); transition: all 0.2s ease; outline: none; }
        .search-input:focus { border-color: rgba(107, 164, 255, 0.5); background: rgba(255, 255, 255, 0.08); box-shadow: 0 0 0 4px rgba(107, 164, 255, 0.1); }
        .search-input::placeholder { color: rgba(255, 255, 255, 0.35); }
        .search-icon { position: absolute; left: 20px; top: 50%; transform: translateY(-50%); color: rgba(255, 255, 255, 0.4); pointer-events: none; }
        .search-clear { position: absolute; right: 16px; top: 50%; transform: translateY(-50%); background: rgba(255, 255, 255, 0.08); border: none; border-radius: 8px; padding: 6px 12px; color: rgba(255, 255, 255, 0.7); font-size: 12px; cursor: pointer; }
        .search-clear:hover { background: rgba(255, 255, 255, 0.15); color: #ffffff; }
        .search-btn { padding: 14px 24px; background: linear-gradient(135deg, #4d8eff 0%, #1546c4 100%); border: none; border-radius: 12px; color: #ffffff; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s ease; font-family: 'Inter', sans-serif; box-shadow: 0 4px 16px rgba(77, 142, 255, 0.25); white-space: nowrap; }
        .search-btn:hover { box-shadow: 0 6px 24px rgba(77, 142, 255, 0.45); transform: translateY(-1px); }
        .search-btn:active { transform: translateY(0); }
        .filter-btn { display: flex; align-items: center; gap: 8px; padding: 14px 20px; background: rgba(180, 130, 255, 0.12); border: 1px solid rgba(180, 130, 255, 0.3); border-radius: 12px; color: #b482ff; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s ease; font-family: 'Inter', sans-serif; white-space: nowrap; }
        .filter-btn:hover { background: rgba(180, 130, 255, 0.22); border-color: rgba(180, 130, 255, 0.5); color: #ffffff; }
        .filter-clear { padding: 14px 18px; background: transparent; border: 1px solid rgba(255, 100, 100, 0.3); border-radius: 12px; color: #ff8888; font-size: 13px; cursor: pointer; transition: all 0.2s ease; font-family: 'Inter', sans-serif; white-space: nowrap; }
        .filter-clear:hover { background: rgba(255, 100, 100, 0.1); color: #ffffff; }
        .download-excel-btn { display: flex; align-items: center; gap: 8px; padding: 14px 20px; background: rgba(74, 222, 128, 0.12); border: 1px solid rgba(74, 222, 128, 0.35); border-radius: 12px; color: #4ade80; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s ease; font-family: 'Inter', sans-serif; white-space: nowrap; }
        .download-excel-btn:hover { background: rgba(74, 222, 128, 0.22); border-color: rgba(74, 222, 128, 0.6); color: #ffffff; box-shadow: 0 4px 16px rgba(74, 222, 128, 0.2); }
        .download-excel-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .download-excel-btn:disabled:hover { background: rgba(74, 222, 128, 0.12); border-color: rgba(74, 222, 128, 0.35); color: #4ade80; box-shadow: none; }

        /* Filter drawer */
        .filter-overlay { position: fixed; inset: 0; background: rgba(5, 20, 51, 0.6); backdrop-filter: blur(4px); z-index: 100; animation: fadeIn 0.2s ease; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .filter-drawer { position: fixed; top: 0; left: 0; bottom: 0; width: 420px; max-width: 90vw; background: linear-gradient(180deg, #0a1f4d 0%, #061a3f 100%); border-right: 1px solid rgba(107, 164, 255, 0.2); box-shadow: 8px 0 40px rgba(0, 0, 0, 0.5); z-index: 101; display: flex; flex-direction: column; animation: slideInLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
        @keyframes slideInLeft { from { transform: translateX(-100%); } to { transform: translateX(0); } }
        .filter-drawer-header { padding: 24px 28px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); display: flex; justify-content: space-between; align-items: center; }
        .filter-drawer-header h3 { font-family: 'Fraunces', serif; font-size: 22px; font-weight: 500; color: #ffffff; margin: 0; letter-spacing: -0.01em; }
        .filter-drawer-body { flex: 1; overflow-y: auto; padding: 24px 28px; }
        .filter-drawer-footer { padding: 20px 28px; border-top: 1px solid rgba(255, 255, 255, 0.08); display: flex; gap: 12px; justify-content: flex-end; background: rgba(5, 20, 51, 0.5); }
        .filter-row { margin-bottom: 20px; }
        .filter-label { display: block; font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(255, 255, 255, 0.6); margin-bottom: 8px; font-weight: 500; }
        .filter-input { width: 100%; padding: 12px 14px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; color: #ffffff; font-size: 14px; font-family: 'Inter', sans-serif; outline: none; transition: all 0.15s ease; }
        .filter-input:focus { border-color: rgba(107, 164, 255, 0.5); background: rgba(255, 255, 255, 0.06); box-shadow: 0 0 0 3px rgba(107, 164, 255, 0.1); }
        .filter-input::placeholder { color: rgba(255, 255, 255, 0.3); }
        .filter-payment-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .filter-payment-cell { display: flex; align-items: center; gap: 6px; }
        .filter-payment-op { font-size: 16px; font-weight: 600; color: #6ba4ff; min-width: 14px; text-align: center; font-family: 'JetBrains Mono', monospace; }
        .filter-input-num { padding: 10px 12px; font-size: 13px; }
        .filter-hint { display: block; margin-top: 8px; font-size: 11px; color: rgba(255, 255, 255, 0.4); font-style: italic; }
        .filter-apply-btn { padding: 12px 22px; background: linear-gradient(135deg, #4d8eff 0%, #1546c4 100%); border: none; border-radius: 10px; color: #ffffff; font-size: 14px; font-weight: 500; cursor: pointer; font-family: 'Inter', sans-serif; }
        .filter-apply-btn:hover { box-shadow: 0 4px 16px rgba(77, 142, 255, 0.4); }
        .filter-reset-btn { padding: 12px 22px; background: transparent; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 10px; color: rgba(255, 255, 255, 0.7); font-size: 14px; cursor: pointer; font-family: 'Inter', sans-serif; }
        .filter-reset-btn:hover { background: rgba(255, 255, 255, 0.05); color: #ffffff; }

        /* Style for native date input dark mode */
        input[type="date"].filter-input::-webkit-calendar-picker-indicator { filter: invert(0.8); cursor: pointer; }
        select.filter-input { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='rgba(255,255,255,0.5)' d='M6 8L0 0h12z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 14px center; padding-right: 40px; }
        select.filter-input option { background: #0a1f4d; color: #ffffff; }

        .content-section { position: relative; z-index: 10; padding: 0 56px 200px; max-width: 1400px; margin: 0 auto; }

        .coming-soon { padding: 100px 40px; text-align: center; background: rgba(255, 255, 255, 0.02); border: 1px dashed rgba(255, 255, 255, 0.15); border-radius: 16px; }
        .coming-soon h2 { font-family: 'Fraunces', serif; font-size: 36px; font-weight: 500; color: rgba(255, 255, 255, 0.7); margin: 0 0 12px; }
        .coming-soon p { color: rgba(255, 255, 255, 0.4); margin: 0; font-size: 14px; }

        .master-dashboard { opacity: 0; transform: translateY(20px); animation: ${mounted ? 'fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards' : 'none'}; }
        .master-section { margin-bottom: 56px; }
        .master-section-heading { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 500; color: #ffffff; margin: 0 0 20px; letter-spacing: -0.02em; display: flex; align-items: baseline; gap: 20px; }
        .master-section-heading::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(107, 164, 255, 0.4) 0%, transparent 100%); }
        .master-section-count { font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(107, 164, 255, 0.8); font-weight: 500; }
        .master-meta-row { font-size: 12px; letter-spacing: 0.1em; color: rgba(255, 255, 255, 0.4); margin-bottom: 16px; }

        .master-missing-files { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; padding: 12px 16px; margin: 0 0 16px; background: rgba(255, 165, 0, 0.06); border: 1px solid rgba(255, 165, 0, 0.25); border-left: 3px solid rgba(255, 165, 0, 0.7); border-radius: 8px; font-size: 13px; color: rgba(255, 220, 180, 0.9); }
        .master-missing-label { font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; color: rgba(255, 180, 100, 0.95); }
        .master-missing-list { color: rgba(255, 235, 210, 0.85); }
        .master-missing-files-none { background: rgba(80, 200, 120, 0.05); border-color: rgba(80, 200, 120, 0.25); border-left-color: rgba(80, 200, 120, 0.7); color: rgba(180, 240, 200, 0.9); font-style: italic; font-size: 12px; }

        /* File timelines (Terminated + New Members tables) */
        .file-timelines { display: flex; flex-direction: column; gap: 10px; margin: 0 0 16px; padding: 14px 18px; background: rgba(255, 165, 0, 0.06); border: 1px solid rgba(255, 165, 0, 0.25); border-left: 3px solid rgba(255, 165, 0, 0.7); border-radius: 8px; }
        .file-timelines-heading { font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; color: rgba(255, 180, 100, 0.95); margin-bottom: 4px; }
        .file-timeline-row { display: flex; flex-direction: column; gap: 3px; padding: 8px 0; border-bottom: 1px dotted rgba(255, 255, 255, 0.06); }
        .file-timeline-row:last-child { border-bottom: none; padding-bottom: 0; }
        .file-timeline-row:first-of-type { padding-top: 0; }
        .file-timeline-header { font-size: 13px; color: rgba(255, 235, 210, 0.95); }
        .file-timeline-name { font-weight: 600; color: rgba(255, 255, 255, 0.95); }
        .file-timeline-last-label { color: rgba(255, 255, 255, 0.55); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
        .file-timeline-last { color: rgba(255, 220, 130, 1); font-weight: 600; }
        .file-timeline-history { font-size: 11px; color: rgba(255, 255, 255, 0.6); font-family: 'JetBrains Mono', 'Courier New', monospace; margin-left: 4px; }
        .file-timeline-entry { margin-right: 14px; white-space: nowrap; }
        .file-timeline-month { color: rgba(255, 255, 255, 0.6); }
        .file-timeline-check { color: #80d090; font-weight: 700; }
        .file-timeline-missing { color: #ff8888; font-style: italic; }

        /* Upload Files button lives in the All Info search bar */
        .upload-files-wrap { display: inline-flex; flex-direction: column; align-items: center; gap: 4px; margin-left: 8px; }
        .upload-files-btn { background: rgba(107, 164, 255, 0.15); color: #6ba4ff; border: 1px solid rgba(107, 164, 255, 0.4); padding: 8px 18px; border-radius: 6px; font-family: 'Inter', sans-serif; font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 600; cursor: pointer; transition: all 0.15s ease; white-space: nowrap; }
        .upload-files-btn:hover { background: rgba(107, 164, 255, 0.25); border-color: rgba(107, 164, 255, 0.7); }
        .upload-files-hint { font-size: 10px; color: rgba(255, 255, 255, 0.4); letter-spacing: 0.03em; font-style: italic; text-align: center; }
        .upload-modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(3px); z-index: 90; animation: fadeIn 0.2s ease; }
        .upload-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(1000px, 92vw); max-height: 88vh; background: #0a1e42; border: 1px solid rgba(107, 164, 255, 0.3); border-radius: 16px; z-index: 100; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); animation: fadeIn 0.2s ease; }
        .upload-modal-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 26px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
        .upload-modal-header h3 { margin: 0; font-family: 'Fraunces', serif; font-size: 22px; font-weight: 500; color: #ffffff; }
        .upload-modal-controls { display: flex; align-items: center; gap: 12px; padding: 16px 26px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); background: rgba(107, 164, 255, 0.04); }
        .upload-month-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.15em; color: rgba(255, 255, 255, 0.6); font-weight: 600; }
        .upload-select { background: rgba(5, 20, 51, 0.9); color: #ffffff; border: 1px solid rgba(107, 164, 255, 0.3); padding: 6px 10px; border-radius: 4px; font-family: 'Inter', sans-serif; font-size: 13px; cursor: pointer; }
        .upload-hint { font-size: 11px; color: rgba(255, 255, 255, 0.4); font-style: italic; margin-left: 8px; }
        .upload-modal-body { padding: 8px 26px 8px; overflow-y: auto; flex: 1; }
        .upload-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .upload-table thead th { text-align: left; padding: 12px 8px; color: rgba(255, 255, 255, 0.6); font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 600; border-bottom: 1px solid rgba(255, 255, 255, 0.1); position: sticky; top: 0; background: #0a1e42; z-index: 1; }
        .upload-table tbody td { padding: 10px 8px; border-bottom: 1px dotted rgba(255, 255, 255, 0.05); vertical-align: middle; }
        .upload-table tbody tr:last-child td { border-bottom: none; }
        .upload-col-name { width: 22%; color: rgba(255, 255, 255, 0.9); font-weight: 500; }
        .upload-col-file { width: 33%; white-space: nowrap; }
        .file-picker-btn { display: inline-block; background: #ffffff; color: #051433; padding: 6px 14px; border-radius: 4px; font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 600; letter-spacing: 0.05em; cursor: pointer; border: 1px solid rgba(0, 0, 0, 0.15); transition: background 0.15s ease, box-shadow 0.15s ease; white-space: nowrap; vertical-align: middle; }
        .file-picker-btn:hover { background: #f0f0f0; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); }
        .file-picker-btn:has(input:disabled) { opacity: 0.5; cursor: not-allowed; }
        .file-picker-name { display: inline-block; margin-left: 10px; font-size: 11px; color: rgba(255, 255, 255, 0.85); font-family: 'JetBrains Mono', 'Courier New', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px; vertical-align: middle; }
        .file-picker-cancel { display: inline-block; margin-left: 8px; background: transparent; color: rgba(255, 136, 136, 0.85); border: 1px solid rgba(255, 136, 136, 0.4); padding: 3px 10px; border-radius: 3px; font-family: 'Inter', sans-serif; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; cursor: pointer; vertical-align: middle; transition: all 0.15s ease; }
        .file-picker-cancel:hover:not(:disabled) { background: rgba(255, 136, 136, 0.15); border-color: rgba(255, 136, 136, 0.7); }
        .file-picker-cancel:disabled { opacity: 0.3; cursor: not-allowed; }
        .upload-col-action { width: 45%; }
        .upload-row-btn { background: rgba(107, 164, 255, 0.15); color: #6ba4ff; border: 1px solid rgba(107, 164, 255, 0.4); padding: 5px 14px; border-radius: 4px; font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; cursor: pointer; transition: all 0.15s ease; margin-right: 6px; }
        .upload-row-btn:hover:not(:disabled) { background: rgba(107, 164, 255, 0.25); }
        .upload-row-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .upload-override-btn { background: rgba(255, 165, 0, 0.15); color: #ffb055; border-color: rgba(255, 165, 0, 0.4); }
        .upload-override-btn:hover { background: rgba(255, 165, 0, 0.25); }
        .upload-cancel-btn { background: rgba(255, 100, 100, 0.1); color: #ff8888; border-color: rgba(255, 100, 100, 0.35); }
        .upload-cancel-btn:hover { background: rgba(255, 100, 100, 0.2); }
        .upload-status-muted { color: rgba(255, 255, 255, 0.3); font-size: 12px; }
        .upload-status-progress { color: #ffb055; font-size: 12px; font-style: italic; }
        .upload-status-success { color: #80d090; font-size: 12px; }
        .upload-status-error { color: #ff8888; font-size: 12px; }
        .upload-exists-prompt { display: flex; flex-direction: column; gap: 6px; }
        .upload-exists-msg { font-size: 12px; color: rgba(255, 220, 180, 0.95); background: rgba(255, 165, 0, 0.08); border: 1px solid rgba(255, 165, 0, 0.3); padding: 6px 10px; border-radius: 4px; }
        .upload-existing-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
        .upload-existing-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 4px; }
        .upload-existing-size { font-size: 11px; color: rgba(255, 255, 255, 0.5); font-family: 'JetBrains Mono', 'Courier New', monospace; margin-right: auto; }
        .upload-existing-link { color: #6ba4ff; text-decoration: underline; font-size: 12px; font-family: 'JetBrains Mono', 'Courier New', monospace; word-break: break-all; }
        .upload-existing-link:hover { color: #90c0ff; }
        .upload-exists-actions { display: flex; gap: 6px; margin-top: 4px; }
        .upload-add-new-row { margin-top: 6px; }
        .upload-addnew-btn { background: rgba(80, 200, 120, 0.15); color: #80d090; border: 1px solid rgba(80, 200, 120, 0.4); }
        .upload-addnew-btn:hover { background: rgba(80, 200, 120, 0.25); border-color: rgba(80, 200, 120, 0.7); }
        .upload-notice { padding: 12px 16px; margin-bottom: 14px; background: rgba(80, 200, 120, 0.08); border: 1px solid rgba(80, 200, 120, 0.3); border-left: 3px solid rgba(80, 200, 120, 0.7); border-radius: 6px; font-size: 12px; color: rgba(200, 240, 210, 0.95); }

        /* ==================== BILLING TAB ==================== */
        .bt-sheet-viewer { background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; overflow: hidden; margin-bottom: 32px; backdrop-filter: blur(20px); }
        .bt-sheet-tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 8px 8px 0; background: rgba(77, 142, 255, 0.06); border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
        .bt-sheet-tab { background: rgba(255, 255, 255, 0.04); color: rgba(255, 255, 255, 0.6); border: 1px solid rgba(255, 255, 255, 0.08); border-bottom: none; padding: 8px 16px; border-radius: 6px 6px 0 0; font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
        .bt-sheet-tab:hover { background: rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.85); }
        .bt-sheet-tab.active { background: rgba(107, 164, 255, 0.2); color: #6ba4ff; border-color: rgba(107, 164, 255, 0.5); }
        .bt-sheet-scroll { max-height: 640px; overflow: auto; background: #ffffff; }
        .bt-sheet-table { border-collapse: collapse; font-size: 12px; font-family: 'Calibri', 'Segoe UI', Arial, sans-serif; color: #000000; background: #ffffff; }
        .bt-sheet-table td { padding: 3px 6px; border: 1px solid #d4d4d4; white-space: nowrap; vertical-align: middle; overflow: hidden; text-overflow: ellipsis; }

        /* Approve button on chat entries (Billing tab only) */
        .update-approve-btn { background: rgba(255, 100, 140, 0.15); color: #ff6b8f; border: 1px solid rgba(255, 100, 140, 0.5); padding: 6px 14px; border-radius: 5px; font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; cursor: pointer; margin-left: 6px; transition: all 0.15s ease; }
        .update-approve-btn:hover { background: rgba(255, 100, 140, 0.28); border-color: rgba(255, 100, 140, 0.85); }
        .update-approved-tag { display: inline-block; background: rgba(80, 200, 120, 0.15); color: #80d090; border: 1px solid rgba(80, 200, 120, 0.5); padding: 6px 14px; border-radius: 5px; font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; margin-left: 6px; cursor: default; user-select: none; }

        /* Approval passcode modal */
        .approval-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 440px; max-width: 90vw; background: rgba(15, 25, 55, 0.96); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px; backdrop-filter: blur(20px); z-index: 1001; box-shadow: 0 20px 80px rgba(0, 0, 0, 0.6); }
        .approval-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 18px 26px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
        .approval-modal-header h3 { margin: 0; font-family: 'Fraunces', serif; font-size: 20px; color: #ffffff; font-weight: 500; }
        .approval-modal-body { padding: 22px 26px; }
        .approval-modal-info { margin: 0 0 20px; font-size: 13px; color: rgba(255, 255, 255, 0.7); line-height: 1.5; }
        .approval-modal-info strong { color: rgba(255, 255, 255, 0.95); }
        .approval-modal-label { display: block; margin-bottom: 8px; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255, 255, 255, 0.55); font-weight: 600; }
        .approval-passcode-input { width: 100%; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.15); color: #ffffff; padding: 10px 14px; border-radius: 6px; font-family: 'Inter', sans-serif; font-size: 14px; outline: none; transition: border-color 0.15s ease; }
        .approval-passcode-input:focus { border-color: rgba(107, 164, 255, 0.6); }
        .approval-error { margin-top: 10px; color: #ff8888; font-size: 12px; }
        .approval-modal-footer { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 26px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
        .approval-submit-btn { background: rgba(255, 100, 140, 0.2); color: #ff6b8f; border: 1px solid rgba(255, 100, 140, 0.6); padding: 8px 22px; border-radius: 6px; font-family: 'Inter', sans-serif; font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 700; cursor: pointer; transition: all 0.15s ease; }
        .approval-submit-btn:hover:not(:disabled) { background: rgba(255, 100, 140, 0.35); border-color: rgba(255, 100, 140, 0.85); }
        .approval-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .approval-passcode-input:disabled { opacity: 0.5; cursor: not-allowed; }
        .upload-modal-footer { padding: 16px 26px; border-top: 1px solid rgba(255, 255, 255, 0.08); display: flex; justify-content: flex-end; }

        .master-table-wrapper { background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; overflow: auto; max-height: 65vh; backdrop-filter: blur(20px); }

        /* Consultant tab specific containers */
        .consultant-dashboard { opacity: 0; transform: translateY(20px); animation: ${mounted ? 'fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards' : 'none'}; }
        .consultant-meta-row { font-size: 12px; letter-spacing: 0.1em; color: rgba(255, 255, 255, 0.4); margin-bottom: 16px; }
        .consultant-count-line { color: rgba(255, 255, 255, 0.55); font-size: 13px; margin-bottom: 16px; padding-left: 4px; }
        .consultant-count-line strong { color: #6ba4ff; font-weight: 600; }
        .consultant-table-wrapper { background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; overflow: auto; max-height: 70vh; backdrop-filter: blur(20px); }
        .consultant-section { margin-bottom: 56px; }
        .consultant-section-heading { font-family: 'Fraunces', serif; font-size: 28px; font-weight: 500; color: #ffffff; margin: 0 0 20px; letter-spacing: -0.02em; display: flex; align-items: baseline; gap: 20px; }
        .consultant-section-heading::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(107, 164, 255, 0.4) 0%, transparent 100%); }
        .consultant-section-count { font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(107, 164, 255, 0.8); font-weight: 500; }

        /* Billing tab */
        .billing-dashboard { opacity: 0; transform: translateY(20px); animation: ${mounted ? 'fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards' : 'none'}; }
        .billing-header-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 32px; flex-wrap: wrap; }
        .billing-title-block h2 { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 500; color: #ffffff; margin: 0 0 6px; letter-spacing: -0.02em; }
        .billing-title-block .billing-subtitle { font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(107, 164, 255, 0.8); }
        .billing-download-btn { background: rgba(107, 164, 255, 0.15); color: #6ba4ff; border: 1px solid rgba(107, 164, 255, 0.4); padding: 10px 20px; border-radius: 6px; font-family: 'Inter', sans-serif; font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 600; cursor: pointer; transition: all 0.15s ease; white-space: nowrap; display: inline-flex; align-items: center; }
        .billing-download-btn:hover { background: rgba(107, 164, 255, 0.28); border-color: rgba(107, 164, 255, 0.7); }

        /* ==================== CONSULTANT TAB (Lambda-driven) ==================== */
        .consultant-dashboard { padding: 32px 40px; max-width: 1600px; margin: 0 auto; }
        .consultant-header-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
        .consultant-title-block h2 { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 500; color: #ffffff; margin: 0 0 6px; letter-spacing: -0.02em; }
        .consultant-title-block .consultant-subtitle { font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(107, 164, 255, 0.8); }
        .consultant-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        .consultant-month-select { background: rgba(255, 255, 255, 0.05); color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.15); padding: 9px 14px; border-radius: 6px; font-family: 'Inter', sans-serif; font-size: 13px; cursor: pointer; min-width: 200px; }
        .consultant-month-select:focus { outline: none; border-color: rgba(107, 164, 255, 0.6); }
        .consultant-new-month-btn { background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.85); border: 1px solid rgba(255, 255, 255, 0.15); padding: 9px 16px; border-radius: 6px; font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s ease; white-space: nowrap; }
        .consultant-new-month-btn:hover { background: rgba(255, 255, 255, 0.1); border-color: rgba(255, 255, 255, 0.3); }

        .consultant-error { background: rgba(255, 100, 140, 0.1); border: 1px solid rgba(255, 100, 140, 0.4); color: #ff9db4; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
        .consultant-error-dismiss { background: none; border: none; color: #ff9db4; font-size: 12px; cursor: pointer; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; }

        .consultant-empty-state { padding: 60px 32px; text-align: center; background: rgba(255, 255, 255, 0.02); border: 1px dashed rgba(255, 255, 255, 0.1); border-radius: 12px; }
        .consultant-empty-state h3 { color: #ffffff; font-family: 'Fraunces', serif; font-weight: 500; font-size: 22px; margin: 0 0 8px; }
        .consultant-empty-state p { color: rgba(255, 255, 255, 0.6); margin: 0 0 20px; }

        .consultant-primary-btn { background: rgba(107, 164, 255, 0.2); color: #6ba4ff; border: 1px solid rgba(107, 164, 255, 0.5); padding: 10px 22px; border-radius: 6px; font-family: 'Inter', sans-serif; font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 700; cursor: pointer; transition: all 0.15s ease; white-space: nowrap; }
        .consultant-primary-btn:hover:not(:disabled) { background: rgba(107, 164, 255, 0.32); border-color: rgba(107, 164, 255, 0.8); }
        .consultant-primary-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .consultant-secondary-btn { background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.85); border: 1px solid rgba(255, 255, 255, 0.15); padding: 10px 22px; border-radius: 6px; font-family: 'Inter', sans-serif; font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 600; cursor: pointer; transition: all 0.15s ease; }
        .consultant-secondary-btn:hover { background: rgba(255, 255, 255, 0.1); }

        .consultant-upload-panel { background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
        .consultant-upload-header { margin-bottom: 20px; }
        .consultant-upload-header h3 { color: #ffffff; font-family: 'Fraunces', serif; font-weight: 500; font-size: 20px; margin: 0 0 6px; }
        .consultant-upload-progress { color: rgba(255, 255, 255, 0.6); font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; }
        .consultant-warning-inline { color: #f5c86e; font-weight: 600; }
        .consultant-upload-actions { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
        .consultant-upload-hint { color: rgba(255, 255, 255, 0.4); font-size: 12px; font-style: italic; }
        .consultant-slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
        .consultant-slot { display: flex; gap: 12px; padding: 12px 14px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.02); }
        .consultant-slot.filled { border-color: rgba(80, 200, 120, 0.35); background: rgba(80, 200, 120, 0.06); }
        .consultant-slot.empty { border-color: rgba(255, 100, 140, 0.25); background: rgba(255, 100, 140, 0.04); }
        .consultant-slot-status { flex-shrink: 0; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; }
        .consultant-slot.filled .consultant-slot-status { background: rgba(80, 200, 120, 0.25); color: #80d090; }
        .consultant-slot.empty .consultant-slot-status { background: rgba(255, 100, 140, 0.2); color: #ff9db4; }
        .consultant-slot-body { flex: 1; min-width: 0; }
        .consultant-slot-label { color: #ffffff; font-weight: 600; font-size: 13px; margin-bottom: 2px; }
        .consultant-slot-substring { color: rgba(255, 255, 255, 0.5); font-size: 11px; }
        .consultant-slot-substring code { background: rgba(107, 164, 255, 0.1); color: #6ba4ff; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-family: 'JetBrains Mono', monospace; }
        .consultant-slot-filename { color: rgba(255, 255, 255, 0.75); font-size: 11px; margin-top: 4px; font-family: 'JetBrains Mono', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .consultant-generate-panel { display: flex; justify-content: space-between; align-items: center; gap: 20px; background: rgba(107, 164, 255, 0.05); border: 1px solid rgba(107, 164, 255, 0.2); border-radius: 12px; padding: 20px 24px; margin-bottom: 24px; flex-wrap: wrap; }
        .consultant-generate-msg { color: rgba(255, 255, 255, 0.75); font-size: 13px; flex: 1; }

        .consultant-viewer-block { margin-bottom: 32px; }
        .consultant-viewer-header { margin-bottom: 12px; }
        .consultant-viewer-header h3 { color: #ffffff; font-family: 'Fraunces', serif; font-weight: 500; font-size: 20px; margin: 0 0 4px; }
        .consultant-viewer-sub { color: rgba(255, 255, 255, 0.5); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }

        .consultant-modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 200; }
        .consultant-modal { background: #0a1a3e; border: 1px solid rgba(107, 164, 255, 0.3); border-radius: 12px; padding: 28px 32px; max-width: 480px; width: 90%; }
        .consultant-modal h3 { color: #ffffff; font-family: 'Fraunces', serif; margin: 0 0 8px; font-size: 22px; font-weight: 500; }
        .consultant-modal p { color: rgba(255, 255, 255, 0.65); font-size: 13px; margin: 0 0 20px; }
        .consultant-modal p code { background: rgba(107, 164, 255, 0.15); color: #6ba4ff; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-family: 'JetBrains Mono', monospace; }
        .consultant-modal-row { display: flex; gap: 12px; align-items: center; margin-bottom: 20px; flex-wrap: wrap; }
        .consultant-modal-row label { color: rgba(255, 255, 255, 0.7); font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; }
        .consultant-modal-row select, .consultant-modal-row input { background: rgba(255, 255, 255, 0.05); color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.15); padding: 8px 12px; border-radius: 6px; font-family: 'Inter', sans-serif; font-size: 13px; }
        .consultant-modal-row select:focus, .consultant-modal-row input:focus { outline: none; border-color: rgba(107, 164, 255, 0.6); }
        .consultant-modal-row input[type='number'] { width: 100px; }
        .consultant-modal-actions { display: flex; gap: 12px; justify-content: flex-end; }
        .billing-section { margin-bottom: 48px; }
        .billing-section-heading { font-family: 'Fraunces', serif; font-size: 24px; font-weight: 500; color: #ffffff; margin: 0 0 18px; letter-spacing: -0.01em; display: flex; align-items: baseline; gap: 16px; }
        .billing-section-heading::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(107, 164, 255, 0.4) 0%, transparent 100%); }
        .billing-section-pill { font-family: 'Inter', sans-serif; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(107, 164, 255, 0.9); font-weight: 500; padding: 3px 10px; background: rgba(107, 164, 255, 0.1); border: 1px solid rgba(107, 164, 255, 0.25); border-radius: 999px; }
        .billing-section-warning-pill { color: #ff8888; background: rgba(255, 100, 100, 0.1); border-color: rgba(255, 100, 100, 0.3); }
        .billing-card { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; padding: 24px 28px; backdrop-filter: blur(20px); margin-bottom: 16px; }
        .billing-card-title { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(255, 255, 255, 0.5); font-weight: 500; margin-bottom: 12px; }
        .billing-metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
        .billing-metric-card { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 20px 22px; backdrop-filter: blur(20px); }
        .billing-metric-card .label { font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(255, 255, 255, 0.55); font-weight: 500; margin-bottom: 10px; }
        .billing-metric-card .value { font-family: 'Fraunces', serif; font-size: 26px; font-weight: 500; color: #ffffff; letter-spacing: -0.01em; }
        .billing-metric-card .value.money { font-family: 'JetBrains Mono', 'Courier New', monospace; color: #6ba4ff; font-size: 22px; }
        .billing-notes { font-size: 12px; color: rgba(255, 255, 255, 0.5); font-style: italic; line-height: 1.6; margin-top: 12px; }
        .billing-notes .note-heading { color: rgba(255, 255, 255, 0.7); font-weight: 500; font-style: normal; margin-bottom: 4px; }
        .billing-verdict { padding: 18px 22px; background: rgba(107, 164, 255, 0.07); border-left: 3px solid #6ba4ff; border-radius: 8px; color: rgba(255, 255, 255, 0.85); font-size: 13px; font-style: italic; line-height: 1.6; margin-top: 16px; }
        .billing-warning-banner { padding: 12px 18px; background: rgba(255, 100, 100, 0.08); border-left: 3px solid #ff8888; border-radius: 8px; color: #ff8888; font-size: 13px; margin-bottom: 16px; }
        .billing-count-callout { font-size: 13px; color: rgba(255, 255, 255, 0.7); margin-bottom: 16px; }
        .billing-count-callout strong { color: #6ba4ff; font-weight: 600; font-family: 'JetBrains Mono', monospace; }
        .billing-table-wrapper { background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; overflow: auto; max-height: 60vh; backdrop-filter: blur(20px); }
        .billing-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; color: rgba(255, 255, 255, 0.9); font-family: 'Inter', sans-serif; }
        .billing-table thead th { background: rgba(5, 20, 51, 0.95); color: rgba(255, 255, 255, 0.7); font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 600; text-align: left; padding: 14px 18px; border-bottom: 2px solid rgba(107, 164, 255, 0.3); position: sticky; top: 0; z-index: 2; white-space: nowrap; }
        .billing-table tbody tr:hover td { background: rgba(107, 164, 255, 0.05); }
        .billing-table td { padding: 11px 18px; border-bottom: 1px dotted rgba(255, 255, 255, 0.06); vertical-align: middle; }
        .billing-table tbody tr:last-child td { border-bottom: none; }
        .billing-table td.money { font-family: 'JetBrains Mono', 'Courier New', monospace; color: #6ba4ff; white-space: nowrap; text-align: right; }
        .billing-table th.col-centered, .billing-table td.col-centered { text-align: center; }
        .billing-table tr.total-row td { font-weight: 600; background: rgba(107, 164, 255, 0.08); color: #ffffff; }
        .billing-table tr.total-row td.money { color: #6ba4ff; font-weight: 700; }

        /* Report Updates chat */
        .report-updates-section { margin-top: 56px; padding-top: 32px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
        .report-updates-heading { font-family: 'Fraunces', serif; font-size: 28px; font-weight: 500; color: #ffffff; margin: 0 0 8px; letter-spacing: -0.01em; }
        .report-updates-subheading { font-size: 12px; letter-spacing: 0.1em; color: rgba(255, 255, 255, 0.4); margin-bottom: 24px; }
        .updates-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 32px; }
        .update-card { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 18px 22px; backdrop-filter: blur(20px); }
        .update-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
        .update-name { font-family: 'Fraunces', serif; font-size: 16px; color: #ffffff; font-weight: 500; }
        .update-date { font-size: 11px; letter-spacing: 0.1em; color: rgba(255, 255, 255, 0.4); font-family: 'Inter', sans-serif; }
        .update-comments { font-size: 13px; color: rgba(255, 255, 255, 0.8); line-height: 1.55; margin-bottom: 12px; white-space: pre-wrap; }
        .update-file-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: rgba(107, 164, 255, 0.06); border: 1px solid rgba(107, 164, 255, 0.15); border-radius: 8px; }
        .update-filename { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: rgba(255, 255, 255, 0.85); flex: 1; word-break: break-all; }
        .update-filesize { font-size: 11px; color: rgba(255, 255, 255, 0.4); white-space: nowrap; }
        .update-download-btn { display: flex; align-items: center; gap: 6px; padding: 6px 14px; background: rgba(107, 164, 255, 0.15); border: 1px solid rgba(107, 164, 255, 0.3); border-radius: 8px; color: #6ba4ff; font-size: 12px; font-family: 'Inter', sans-serif; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
        .update-download-btn:hover { background: rgba(107, 164, 255, 0.25); color: #ffffff; }

        .upload-form { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 24px 28px; backdrop-filter: blur(20px); }
        .upload-form-title { font-family: 'Fraunces', serif; font-size: 18px; color: #ffffff; margin: 0 0 18px; font-weight: 500; }
        .upload-form-row { margin-bottom: 16px; }
        .upload-form-row label { display: block; font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(255, 255, 255, 0.6); margin-bottom: 8px; font-weight: 500; }
        .upload-form-row label .required { color: #ff8888; margin-left: 4px; }
        .upload-form-row label .optional { color: rgba(255, 255, 255, 0.35); margin-left: 6px; font-size: 10px; text-transform: none; letter-spacing: 0.05em; }
        .upload-input { width: 100%; padding: 12px 14px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; color: #ffffff; font-size: 14px; font-family: 'Inter', sans-serif; outline: none; transition: all 0.15s ease; }
        .upload-input:focus { border-color: rgba(107, 164, 255, 0.5); background: rgba(255, 255, 255, 0.06); box-shadow: 0 0 0 3px rgba(107, 164, 255, 0.1); }
        textarea.upload-input { resize: vertical; min-height: 80px; font-family: 'Inter', sans-serif; }
        .upload-file-row { display: flex; align-items: center; gap: 12px; }
        .upload-file-row input[type="file"] { flex: 1; color: rgba(255, 255, 255, 0.7); font-size: 13px; }
        .upload-file-row input[type="file"]::file-selector-button { padding: 8px 16px; background: rgba(107, 164, 255, 0.15); border: 1px solid rgba(107, 164, 255, 0.3); border-radius: 8px; color: #6ba4ff; font-size: 12px; font-family: 'Inter', sans-serif; cursor: pointer; margin-right: 12px; }
        .upload-file-row input[type="file"]::file-selector-button:hover { background: rgba(107, 164, 255, 0.25); color: #ffffff; }
        .upload-submit-btn { padding: 14px 26px; background: linear-gradient(135deg, #4d8eff 0%, #1546c4 100%); border: none; border-radius: 10px; color: #ffffff; font-size: 14px; font-weight: 500; cursor: pointer; font-family: 'Inter', sans-serif; box-shadow: 0 4px 16px rgba(77, 142, 255, 0.25); transition: all 0.2s ease; }
        .upload-submit-btn:hover:not(:disabled) { box-shadow: 0 6px 24px rgba(77, 142, 255, 0.45); transform: translateY(-1px); }
        .upload-submit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .upload-error { padding: 12px 16px; background: rgba(255, 100, 100, 0.1); border: 1px solid rgba(255, 100, 100, 0.3); border-radius: 8px; color: #ff8888; font-size: 13px; margin-bottom: 16px; }
        .upload-clear-file-btn { background: transparent; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 8px; padding: 6px 12px; color: rgba(255, 255, 255, 0.6); font-size: 12px; cursor: pointer; font-family: 'Inter', sans-serif; }
        .upload-clear-file-btn:hover { color: #ffffff; border-color: rgba(255, 255, 255, 0.3); }

        .month-block { margin-bottom: 56px; }
        .month-heading { font-family: 'Fraunces', serif; font-size: 36px; font-weight: 500; color: #ffffff; margin: 0 0 24px; letter-spacing: -0.02em; display: flex; align-items: baseline; gap: 20px; }
        .month-heading::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(107, 164, 255, 0.4) 0%, transparent 100%); }
        .month-count { font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(107, 164, 255, 0.8); font-weight: 500; }

        /* Source-first browse view (All Info): outer = source, inner box = month */
        .source-block { margin-bottom: 64px; }
        .source-heading { font-family: 'Fraunces', serif; font-size: 36px; font-weight: 500; color: #ffffff; margin: 0 0 24px; letter-spacing: -0.02em; display: flex; align-items: baseline; gap: 20px; }
        .source-heading::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(107, 164, 255, 0.4) 0%, transparent 100%); }
        .source-total-count { font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(107, 164, 255, 0.8); font-weight: 500; }
        .month-subgroup { margin-bottom: 20px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; overflow: hidden; backdrop-filter: blur(20px); }
        .month-subgroup-heading { padding: 16px 26px; background: rgba(77, 142, 255, 0.08); border-bottom: 1px solid rgba(255, 255, 255, 0.06); display: flex; justify-content: space-between; align-items: center; }
        .month-subgroup-heading h3 { font-family: 'Fraunces', serif; font-size: 18px; font-weight: 500; color: #ffffff; margin: 0; }
        .month-subgroup-count { font-family: 'Inter', sans-serif; font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(255, 255, 255, 0.5); }

        .system-group { margin-bottom: 24px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; overflow: hidden; backdrop-filter: blur(20px); }
        .system-name { padding: 18px 28px; background: rgba(77, 142, 255, 0.08); border-bottom: 1px solid rgba(255, 255, 255, 0.06); display: flex; justify-content: space-between; align-items: center; }
        .system-name h3 { font-family: 'Fraunces', serif; font-size: 20px; font-weight: 500; color: #ffffff; margin: 0; }
        .system-count { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(107, 164, 255, 0.9); font-weight: 500; }
        .file-list { list-style: none; margin: 0; padding: 0; }
        .file-item-wrapper { list-style: none; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
        .file-item-wrapper:last-child { border-bottom: none; }
        .file-item { padding: 14px 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; cursor: pointer; transition: background 0.15s ease; }
        .file-item:hover { background: rgba(107, 164, 255, 0.06); }
        .file-item.selected { background: rgba(107, 164, 255, 0.14); border-left: 3px solid #6ba4ff; padding-left: 25px; }
        .file-item-name { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 13px; color: #ffffff; flex: 1; word-break: break-all; }
        .file-item-actions { display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
        .file-item-meta { font-size: 12px; color: rgba(255, 255, 255, 0.4); white-space: nowrap; }
        .file-item-excluded { font-size: 10px; letter-spacing: 0.15em; font-weight: 700; color: #ff8888; background: rgba(255, 136, 136, 0.1); border: 1px solid rgba(255, 136, 136, 0.3); padding: 2px 8px; border-radius: 3px; text-transform: uppercase; white-space: nowrap; }
        .download-btn { display: flex; align-items: center; gap: 6px; padding: 6px 14px; background: rgba(107, 164, 255, 0.12); border: 1px solid rgba(107, 164, 255, 0.25); border-radius: 8px; color: #6ba4ff; font-size: 12px; font-family: 'Inter', sans-serif; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
        .download-btn:hover { background: rgba(107, 164, 255, 0.22); border-color: rgba(107, 164, 255, 0.5); color: #ffffff; }
        .download-btn:active { transform: scale(0.96); }

        .empty-state, .loading-state, .error-state { padding: 60px 28px; text-align: center; color: rgba(255, 255, 255, 0.4); font-size: 14px; }
        .error-state { color: #ff8888; }

        .content-viewer { margin: 8px 28px 16px; background: rgba(10, 30, 70, 0.6); border: 1px solid rgba(107, 164, 255, 0.25); border-radius: 12px; overflow: hidden; animation: slideOpen 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
        @keyframes slideOpen { from { opacity: 0; transform: translateY(-8px); max-height: 0; } to { opacity: 1; transform: translateY(0); max-height: 800px; } }
        .content-header { padding: 20px 24px; background: rgba(107, 164, 255, 0.1); border-bottom: 1px solid rgba(255, 255, 255, 0.08); display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
        .content-header-info h4 { font-family: 'Fraunces', serif; font-size: 18px; font-weight: 500; color: #ffffff; margin: 0 0 6px; word-break: break-all; }
        .content-header-info p { margin: 0; font-size: 11px; color: rgba(255, 255, 255, 0.45); }
        .close-btn { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; padding: 8px 14px; color: rgba(255, 255, 255, 0.7); font-size: 12px; cursor: pointer; }
        .close-btn:hover { background: rgba(255, 255, 255, 0.1); color: #ffffff; }
        .table-scroll { overflow-x: auto; max-height: 600px; overflow-y: auto; }
        table.content-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        table.content-table th { padding: 12px 16px; text-align: left; font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(255, 255, 255, 0.7); font-weight: 600; background: rgba(0, 0, 0, 0.3); border-bottom: 1px solid rgba(255, 255, 255, 0.08); position: sticky; top: 0; white-space: nowrap; }
        table.content-table td { padding: 10px 16px; color: rgba(255, 255, 255, 0.85); border-bottom: 1px solid rgba(255, 255, 255, 0.04); white-space: nowrap; font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 12px; }
        .content-footer { padding: 14px 28px; background: rgba(0, 0, 0, 0.2); border-top: 1px solid rgba(255, 255, 255, 0.05); font-size: 11px; color: rgba(255, 255, 255, 0.4); text-align: center; }

        .search-results-section { margin-bottom: 40px; }
        .search-results-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 24px; }
        .search-results-title { font-family: 'Fraunces', serif; font-size: 28px; font-weight: 500; color: #ffffff; margin: 0; }
        .search-results-meta { font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(107, 164, 255, 0.8); }
        .search-result-card { margin-bottom: 24px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; overflow: hidden; }
        .search-file-block { border-top: 1px solid rgba(255, 255, 255, 0.04); }
        .search-file-block:first-of-type { border-top: none; }
        .search-file-header { padding: 12px 28px; background: rgba(0, 0, 0, 0.15); display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
        .search-file-name { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 12px; color: rgba(255, 255, 255, 0.85); word-break: break-all; }
        .search-file-count { font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(107, 164, 255, 0.9); white-space: nowrap; font-weight: 500; }

        .wave-container { position: absolute; bottom: 0; left: 0; right: 0; height: 60vh; pointer-events: none; z-index: 2; }
        .wave { position: absolute; bottom: 0; left: 0; width: 200%; height: 100%; }
        @keyframes waveSlow { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @keyframes waveMid { from { transform: translateX(-50%); } to { transform: translateX(0); } }
        @keyframes waveFast { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .wave-1 svg { animation: waveSlow 25s linear infinite; }
        .wave-2 svg { animation: waveMid 18s linear infinite; }
        .wave-3 svg { animation: waveFast 12s linear infinite; }

        @media (max-width: 768px) {
          .header { padding: 24px; }
          .hero { padding: 40px 24px 24px; }
          .tabs-section, .search-bar, .content-section { padding-left: 24px; padding-right: 24px; }
          .search-icon { left: 44px; }
          .search-clear { right: 40px; }
        }
      `}</style>

      <div className="grain" />

      <header className="header">
        <div className="brand">
          <div className="brand-mark">G</div>
          <span className="brand-text">Gig Insurance</span>
        </div>
        <div className="header-meta">
          <span className="status-dot" />
          <span>System Operational</span>
        </div>
      </header>

      <section className="hero">
        <div className="eyebrow">Internal Operations</div>
        <h1 className="title">
          Gig Insurance <span className="title-accent">Internal Dashboard</span>
        </h1>
      </section>

      {/* Tabs */}
      <section className="tabs-section">
        <div className="tabs-pill">
          <button className={`tab-btn ${activeTab === 'master' ? 'active' : ''}`} onClick={() => setActiveTab('master')}>Master Dashboard</button>
          <button className={`tab-btn ${activeTab === 'all-info' ? 'active' : ''}`} onClick={() => setActiveTab('all-info')}>All Info</button>
          <button className={`tab-btn ${activeTab === 'consultant' ? 'active' : ''}`} onClick={() => setActiveTab('consultant')}>Consultant Report</button>
          <button className={`tab-btn ${activeTab === 'billing' ? 'active' : ''}`} onClick={() => setActiveTab('billing')}>Billing</button>
        </div>
      </section>

      <section className="content-section">
        {/* ALL INFO TAB */}
        {activeTab === 'all-info' && (
          <>
            <div className="search-bar">
              <div className="search-wrapper">
                <svg className="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  className="search-input"
                  type="text"
                  placeholder="Search member by name (first, last, or full name)..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') triggerAllInfoSearch(); }}
                />
                {searchInput && (
                  <button className="search-clear" onClick={() => { setSearchInput(''); setSearchQuery(''); setSearchResults(null); }}>Clear</button>
                )}
              </div>
              <button className="search-btn" onClick={triggerAllInfoSearch}>Search</button>
              <div className="upload-files-wrap">
                <button className="upload-files-btn" onClick={openUploadModal}>
                  Upload Files
                </button>
                <div className="upload-files-hint">access only to admin - Andrew</div>
              </div>
            </div>

            {/* SEARCH RESULTS in All Info */}
            {searchQuery && (
              <div className="search-results-section">
                <div className="search-results-header">
                  <h2 className="search-results-title">Search results for &ldquo;{searchQuery}&rdquo;</h2>
                  {searchResults && (
                    <span className="search-results-meta">
                      {searchResults.totalMatches} match{searchResults.totalMatches !== 1 ? 'es' : ''} in {searchResults.filesWithMatches} of {searchResults.filesScanned} files
                    </span>
                  )}
                </div>

                {searching && <div className="search-result-card"><div className="loading-state">Searching all files...</div></div>}
                {searchError && <div className="search-result-card"><div className="error-state">Error: {searchError}</div></div>}
                {!searching && !searchError && searchResults && searchResults.results.length === 0 && (
                  <div className="search-result-card"><div className="empty-state">No matches found.</div></div>
                )}

                {!searching && !searchError && searchResults && searchResults.results.length > 0 && (() => {
                  type GroupedSearch = { [monthKey: string]: { label: string; systems: { [system: string]: SearchMatch[] }; }; };
                  const groupedResults: GroupedSearch = {};
                  for (const r of searchResults.results) {
                    const detected = detectMonthYear(r.filename);
                    let mKey: string, label: string;
                    if (detected) {
                      mKey = monthKey(detected.year, detected.month);
                      label = monthLabel(detected.year, detected.month);
                    } else {
                      mKey = 'unknown';
                      label = 'Date Unknown';
                    }
                    if (!groupedResults[mKey]) groupedResults[mKey] = { label, systems: {} };
                    if (!groupedResults[mKey].systems[r.system]) groupedResults[mKey].systems[r.system] = [];
                    groupedResults[mKey].systems[r.system].push(r);
                  }
                  const monthOrder = Object.keys(groupedResults).sort((a, b) => {
                    if (a === 'unknown') return 1;
                    if (b === 'unknown') return -1;
                    return b.localeCompare(a);
                  });
                  const buildSearchTerms = (q: string): string[] => {
                    const words = q.trim().split(/\s+/).filter(w => w.length > 0);
                    if (words.length === 1) return words;
                    return [...words, words.join(' ')];
                  };
                  const highlightTerms = buildSearchTerms(searchQuery);

                  return monthOrder.map((mKey) => {
                    const monthBlock = groupedResults[mKey];
                    const totalInMonth = Object.values(monthBlock.systems).reduce((sum, arr) => sum + arr.reduce((s, r) => s + r.rows.length, 0), 0);
                    return (
                      <div key={mKey} className="month-block">
                        <h2 className="month-heading">
                          {monthBlock.label}
                          <span className="month-count">{totalInMonth} match{totalInMonth !== 1 ? 'es' : ''}</span>
                        </h2>
                        {Object.keys(monthBlock.systems).sort().map((system) => {
                          const filesForSystem = monthBlock.systems[system];
                          const totalInSystem = filesForSystem.reduce((s, r) => s + r.rows.length, 0);
                          return (
                            <div key={system} className="system-group">
                              <div className="system-name">
                                <h3>{prettifySystemName(system)}</h3>
                                <span className="system-count">{totalInSystem} match{totalInSystem !== 1 ? 'es' : ''} across {filesForSystem.length} file{filesForSystem.length !== 1 ? 's' : ''}</span>
                              </div>
                              {filesForSystem.map((result) => (
                                <div key={result.fileKey} className="search-file-block">
                                  <div className="search-file-header">
                                    <span className="search-file-name">{result.filename}</span>
                                    <span className="search-file-count">{result.rows.length} match{result.rows.length !== 1 ? 'es' : ''}</span>
                                  </div>
                                  <div className="table-scroll">
                                    <table className="content-table">
                                      <thead>
                                        <tr>{result.headers.map((h, i) => (<th key={i}>{h || `Column ${i + 1}`}</th>))}</tr>
                                      </thead>
                                      <tbody>
                                        {result.rows.map((row, i) => (
                                          <tr key={i}>
                                            {result.headers.map((_, j) => {
                                              const cellValue = row[j] || '';
                                              const isNameColumn = result.matchedColumnIndices.includes(j);
                                              return (<td key={j}>{isNameColumn ? highlight(cellValue, highlightTerms) : cellValue}</td>);
                                            })}
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    );
                  });
                })()}
              </div>
            )}

            {/* BROWSE VIEW (no search) */}
            {!searchQuery && (
              <>
                {loading && <div className="system-group"><div className="loading-state">Loading files...</div></div>}
                {error && <div className="system-group"><div className="error-state">Error: {error}</div></div>}
                {!loading && !error && sortedMonthKeys.length === 0 && (
                  <div className="system-group"><div className="empty-state">No files uploaded yet.</div></div>
                )}
                {!loading && !error && sortedMonthKeys.map((mKey) => {
                  const monthBlock = grouped[mKey];
                  const fileCount = Object.values(monthBlock.systems).reduce((sum, files) => sum + files.length, 0);
                  return (
                    <div key={mKey} className="month-block">
                      <h2 className="month-heading">
                        {monthBlock.label}
                        <span className="month-count">{fileCount} file{fileCount !== 1 ? 's' : ''}</span>
                      </h2>
                      {Object.keys(monthBlock.systems).sort((a, b) => {
                        // Sort in canonical order; unknown/unclassified last
                        const aIdx = CANONICAL_FILES.indexOf(a);
                        const bIdx = CANONICAL_FILES.indexOf(b);
                        if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
                        if (aIdx === -1) return 1;
                        if (bIdx === -1) return -1;
                        return aIdx - bIdx;
                      }).map((system) => (
                        <div key={system} className="system-group">
                          <div className="system-name">
                            <h3>{system === 'unknown' ? 'Unclassified' : system}</h3>
                            <span className="system-count">{monthBlock.systems[system].length} file{monthBlock.systems[system].length !== 1 ? 's' : ''}</span>
                          </div>
                          <ul className="file-list">
                            {monthBlock.systems[system].map((file) => (
                              <li key={file.key} className="file-item-wrapper">
                                <div
                                  className={`file-item ${selectedFile?.key === file.key ? 'selected' : ''}`}
                                  onClick={() => {
                                    if (selectedFile?.key === file.key) { setSelectedFile(null); setFileContent(null); }
                                    else { loadFileContent(file); }
                                  }}
                                >
                                  <span className="file-item-name">{file.filename}</span>
                                  <div className="file-item-actions">
                                    {isExcludedByExtension(file.filename) && (
                                      <span className="file-item-excluded" title="Excluded from Master Dashboard analysis">EXCLUDED</span>
                                    )}
                                    <span className="file-item-meta">{formatBytes(file.size)} · {formatDate(file.lastModified)}</span>
                                    <button
                                      className="download-btn"
                                      onClick={(e) => { e.stopPropagation(); handleDownload(file.key, file.filename); }}
                                      title="Download this file"
                                    >
                                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                        <polyline points="7 10 12 15 17 10" />
                                        <line x1="12" y1="15" x2="12" y2="3" />
                                      </svg>
                                      Download
                                    </button>
                                  </div>
                                </div>
                                {selectedFile?.key === file.key && (
                                  <div className="content-viewer">
                                    <div className="content-header">
                                      <div className="content-header-info">
                                        <h4>{file.filename}</h4>
                                        <p>
                                          {fileContent?.sheetName ? `Sheet: ${fileContent.sheetName} · ` : ''}
                                          {fileContent ? `${fileContent.totalRows.toLocaleString()} rows · ${fileContent.headers.length} columns` : ''}
                                        </p>
                                      </div>
                                      <button className="close-btn" onClick={(e) => { e.stopPropagation(); setSelectedFile(null); setFileContent(null); }}>Close</button>
                                    </div>
                                    {contentLoading && <div className="loading-state">Loading file contents...</div>}
                                    {contentError && <div className="error-state">Error: {contentError}</div>}
                                    {fileContent && (
                                      <>
                                        <div className="table-scroll">
                                          <table className="content-table">
                                            <thead><tr>{fileContent.headers.map((h, i) => (<th key={i}>{h || `Column ${i + 1}`}</th>))}</tr></thead>
                                            <tbody>
                                              {fileContent.rows.map((row, i) => (
                                                <tr key={i}>{fileContent.headers.map((_, j) => (<td key={j}>{row[j] ?? ''}</td>))}</tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                        {fileContent.rows.length < fileContent.totalRows && (
                                          <div className="content-footer">Showing first {fileContent.rows.length.toLocaleString()} of {fileContent.totalRows.toLocaleString()} rows</div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}

        {/* MASTER DASHBOARD TAB */}
        {activeTab === 'master' && (
          <>
            <div className="search-bar">
              <div className="search-wrapper">
                <svg className="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  className="search-input"
                  type="text"
                  placeholder="Search member by name (first, last, or full name)..."
                  value={masterSearchInput}
                  onChange={(e) => setMasterSearchInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') triggerMasterSearch(); }}
                />
                {masterSearchInput && (
                  <button className="search-clear" onClick={() => { setMasterSearchInput(''); setMasterSearch(''); }}>Clear</button>
                )}
              </div>
              <button className="search-btn" onClick={triggerMasterSearch}>Search</button>
              <button className="filter-btn" onClick={openFilterDrawer}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
              </button>
              {activeFilterCount > 0 && (
                <button className="filter-clear" onClick={clearAllFilters}>Clear all filters</button>
              )}
            </div>

            <div className="master-dashboard">
              {masterLoading && <div className="loading-state">Loading master data, this may take 10-30 seconds...</div>}
              {masterError && <div className="error-state">Error: {masterError}</div>}
              {!masterLoading && !masterError && masterData && (
                <>
                  <div className="master-meta-row">
                    <span>Months processed: {masterData.monthsProcessed.join(' · ')}</span>
                  </div>

                  {/* ACTIVE MEMBERS */}
                  <div className="master-section">
                    <h2 className="master-section-heading">
                      Active Members
                      <span className="master-section-count">{fullyFilter(masterData.activeMembers, false, false).length} of {masterData.activeMembers.length}</span>
                    </h2>
                    {masterData.latestMonthLabel && (
                      masterData.latestMonthMissingFiles.length > 0 ? (
                        <div className="file-timelines">
                          <div className="file-timelines-heading">
                            Files missing in {masterData.latestMonthLabel} (active data falls back to their last available month):
                          </div>
                          {masterData.fileTimelines
                            .filter(t => masterData.latestMonthMissingFiles.includes(t.file))
                            .map(t => (
                              <div key={t.file} className="file-timeline-row">
                                <div className="file-timeline-header">
                                  <span className="file-timeline-name">{t.file}:</span>{' '}
                                  <span className="file-timeline-last-label">Last Updated Month:</span>{' '}
                                  <span className="file-timeline-last">{t.lastUpdatedMonth || 'Never uploaded'}</span>
                                </div>
                                <div className="file-timeline-history">
                                  {t.history.map((entry, i) => (
                                    <span key={i} className="file-timeline-entry">
                                      <span className="file-timeline-month">{entry.month}</span>{' '}
                                      {entry.present ? (
                                        <span className="file-timeline-check">✓</span>
                                      ) : (
                                        <span className="file-timeline-missing">(Missing)</span>
                                      )}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                        </div>
                      ) : (
                        <div className="master-missing-files master-missing-files-none">
                          All {masterData.fileTimelines.length} files present for {masterData.latestMonthLabel}.
                        </div>
                      )
                    )}
                    {fullyFilter(masterData.activeMembers, false, false).length === 0 ? (
                      <div className="empty-state">No active members match the filter.</div>
                    ) : (
                      <div className="sortable-outer">
                        {activeSorting && (
                          <div className="sort-spinner-overlay">
                            <div className="sort-spinner" />
                            <div className="sort-spinner-label">Sorting...</div>
                          </div>
                        )}
                        <div className="master-table-wrapper">
                          <table className="master-table">
                          <thead>
                            <tr>{activeColumns.map(([key, label]) => (
                              <th
                                key={String(key)}
                                className={`sortable-header ${key === 'memberName' || key === 'group' || key === 'planName' ? 'col-name-header' : ''}`}
                                onClick={() => toggleSort(String(key), activeSort, setActiveSort, setActiveSorting)}
                              >
                                {label}
                                <SortArrow column={String(key)} sortState={activeSort} />
                              </th>
                            ))}</tr>
                          </thead>
                          <tbody>
                            {sortRows(fullyFilter(masterData.activeMembers, false, false), activeSort).map((row, i) => (
                              <tr key={i}>{renderMasterTableCells(row, activeColumns)}</tr>
                            ))}
                          </tbody>
                        </table>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* TERMINATED MEMBERS */}
                  <div className="master-section">
                    <h2 className="master-section-heading">
                      Terminated Members
                      <span className="master-section-count">{fullyFilter(masterData.terminatedMembers, true, false).length} of {masterData.terminatedMembers.length}</span>
                    </h2>
                    {masterData.latestMonthLabel && (
                      masterData.latestMonthMissingFiles.length > 0 ? (
                        <div className="file-timelines">
                          <div className="file-timelines-heading">
                            Files missing in {masterData.latestMonthLabel}:
                          </div>
                          {masterData.fileTimelines
                            .filter(t => masterData.latestMonthMissingFiles.includes(t.file))
                            .map(t => (
                              <div key={t.file} className="file-timeline-row">
                                <div className="file-timeline-header">
                                  <span className="file-timeline-name">{t.file}:</span>{' '}
                                  <span className="file-timeline-last-label">Last Updated Month:</span>{' '}
                                  <span className="file-timeline-last">{t.lastUpdatedMonth || 'Never uploaded'}</span>
                                </div>
                                <div className="file-timeline-history">
                                  {t.history.map((entry, i) => (
                                    <span key={i} className="file-timeline-entry">
                                      <span className="file-timeline-month">{entry.month}</span>{' '}
                                      {entry.present ? (
                                        <span className="file-timeline-check">✓</span>
                                      ) : (
                                        <span className="file-timeline-missing">(Missing)</span>
                                      )}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                        </div>
                      ) : (
                        <div className="master-missing-files master-missing-files-none">
                          All {masterData.fileTimelines.length} files present for {masterData.latestMonthLabel}.
                        </div>
                      )
                    )}
                    {fullyFilter(masterData.terminatedMembers, true, false).length === 0 ? (
                      <div className="empty-state">No terminated members match the filter.</div>
                    ) : (
                      <div className="sortable-outer">
                        {terminatedSorting && (
                          <div className="sort-spinner-overlay">
                            <div className="sort-spinner" />
                            <div className="sort-spinner-label">Sorting...</div>
                          </div>
                        )}
                        <div className="master-table-wrapper">
                          <table className="master-table">
                          <thead>
                            <tr>{terminatedColumns.map(([key, label]) => (
                              <th
                                key={String(key)}
                                className={`sortable-header ${key === 'memberName' || key === 'group' || key === 'planName' ? 'col-name-header' : ''}`}
                                onClick={() => toggleSort(String(key), terminatedSort, setTerminatedSort, setTerminatedSorting)}
                              >
                                {label}
                                <SortArrow column={String(key)} sortState={terminatedSort} />
                              </th>
                            ))}</tr>
                          </thead>
                          <tbody>
                            {sortRows(fullyFilter(masterData.terminatedMembers, true, false), terminatedSort).map((row, i) => (
                              <tr key={i}>{renderMasterTableCells(row, terminatedColumns)}</tr>
                            ))}
                          </tbody>
                        </table>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* NEW MEMBERS */}
                  <div className="master-section">
                    <h2 className="master-section-heading">
                      New Members
                      <span className="master-section-count">{fullyFilter(masterData.newMembers, false, true).length} of {masterData.newMembers.length}</span>
                    </h2>
                    {masterData.latestMonthLabel && (
                      masterData.latestMonthMissingFiles.length > 0 ? (
                        <div className="file-timelines">
                          <div className="file-timelines-heading">
                            Files missing in {masterData.latestMonthLabel}:
                          </div>
                          {masterData.fileTimelines
                            .filter(t => masterData.latestMonthMissingFiles.includes(t.file))
                            .map(t => (
                              <div key={t.file} className="file-timeline-row">
                                <div className="file-timeline-header">
                                  <span className="file-timeline-name">{t.file}:</span>{' '}
                                  <span className="file-timeline-last-label">Last Updated Month:</span>{' '}
                                  <span className="file-timeline-last">{t.lastUpdatedMonth || 'Never uploaded'}</span>
                                </div>
                                <div className="file-timeline-history">
                                  {t.history.map((entry, i) => (
                                    <span key={i} className="file-timeline-entry">
                                      <span className="file-timeline-month">{entry.month}</span>{' '}
                                      {entry.present ? (
                                        <span className="file-timeline-check">✓</span>
                                      ) : (
                                        <span className="file-timeline-missing">(Missing)</span>
                                      )}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                        </div>
                      ) : (
                        <div className="master-missing-files master-missing-files-none">
                          All {masterData.fileTimelines.length} files present for {masterData.latestMonthLabel}.
                        </div>
                      )
                    )}
                    {fullyFilter(masterData.newMembers, false, true).length === 0 ? (
                      <div className="empty-state">No new members match the filter.</div>
                    ) : (
                      <div className="sortable-outer">
                        {newSorting && (
                          <div className="sort-spinner-overlay">
                            <div className="sort-spinner" />
                            <div className="sort-spinner-label">Sorting...</div>
                          </div>
                        )}
                        <div className="master-table-wrapper">
                          <table className="master-table">
                          <thead>
                            <tr>{newColumns.map(([key, label]) => (
                              <th
                                key={String(key)}
                                className={`sortable-header ${key === 'memberName' || key === 'group' || key === 'planName' ? 'col-name-header' : ''}`}
                                onClick={() => toggleSort(String(key), newSort, setNewSort, setNewSorting)}
                              >
                                {label}
                                <SortArrow column={String(key)} sortState={newSort} />
                              </th>
                            ))}</tr>
                          </thead>
                          <tbody>
                            {sortRows(fullyFilter(masterData.newMembers, false, true), newSort).map((row, i) => (
                              <tr key={i}>{renderMasterTableCells(row, newColumns)}</tr>
                            ))}
                          </tbody>
                        </table>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* FILTER DRAWER */}
            {filterDrawerOpen && (
              <>
                <div className="filter-overlay" onClick={() => setFilterDrawerOpen(false)} />
                <aside className="filter-drawer">
                  <div className="filter-drawer-header">
                    <h3>Filter Members</h3>
                    <button className="close-btn" onClick={() => setFilterDrawerOpen(false)}>Close</button>
                  </div>

                  <div className="filter-drawer-body">
                    <div className="filter-row">
                      <label className="filter-label">Group</label>
                      <input
                        className="filter-input"
                        type="text"
                        placeholder="Contains..."
                        value={draftFilters.group}
                        onChange={(e) => setDraftFilters({ ...draftFilters, group: e.target.value })}
                      />
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">Plan Name</label>
                      <input
                        className="filter-input"
                        type="text"
                        placeholder="Contains..."
                        value={draftFilters.planName}
                        onChange={(e) => setDraftFilters({ ...draftFilters, planName: e.target.value })}
                      />
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">Anthem ID</label>
                      <input
                        className="filter-input"
                        type="text"
                        placeholder="Contains..."
                        value={draftFilters.anthemId}
                        onChange={(e) => setDraftFilters({ ...draftFilters, anthemId: e.target.value })}
                      />
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">Payment</label>
                      <div className="filter-payment-row">
                        <div className="filter-payment-cell">
                          <span className="filter-payment-op">&gt;</span>
                          <input
                            className="filter-input filter-input-num"
                            type="number"
                            placeholder="Min"
                            value={draftFilters.payment.gt}
                            onChange={(e) => setDraftFilters({ ...draftFilters, payment: { ...draftFilters.payment, gt: e.target.value } })}
                          />
                        </div>
                        <div className="filter-payment-cell">
                          <span className="filter-payment-op">&lt;</span>
                          <input
                            className="filter-input filter-input-num"
                            type="number"
                            placeholder="Max"
                            value={draftFilters.payment.lt}
                            onChange={(e) => setDraftFilters({ ...draftFilters, payment: { ...draftFilters.payment, lt: e.target.value } })}
                          />
                        </div>
                        <div className="filter-payment-cell">
                          <span className="filter-payment-op">=</span>
                          <input
                            className="filter-input filter-input-num"
                            type="number"
                            placeholder="Exact"
                            value={draftFilters.payment.eq}
                            onChange={(e) => setDraftFilters({ ...draftFilters, payment: { ...draftFilters.payment, eq: e.target.value } })}
                          />
                        </div>
                      </div>
                      <span className="filter-hint">Tip: &ldquo;=&rdquo; overrides the range filters when set.</span>
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">City</label>
                      <input
                        className="filter-input"
                        type="text"
                        placeholder="Contains..."
                        value={draftFilters.city}
                        onChange={(e) => setDraftFilters({ ...draftFilters, city: e.target.value })}
                      />
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">State</label>
                      <select
                        className="filter-input"
                        value={draftFilters.state}
                        onChange={(e) => setDraftFilters({ ...draftFilters, state: e.target.value })}
                      >
                        <option value="">All states</option>
                        {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">Address 1</label>
                      <input
                        className="filter-input"
                        type="text"
                        placeholder="Contains..."
                        value={draftFilters.address1}
                        onChange={(e) => setDraftFilters({ ...draftFilters, address1: e.target.value })}
                      />
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">Address 2</label>
                      <input
                        className="filter-input"
                        type="text"
                        placeholder="Contains..."
                        value={draftFilters.address2}
                        onChange={(e) => setDraftFilters({ ...draftFilters, address2: e.target.value })}
                      />
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">Email</label>
                      <input
                        className="filter-input"
                        type="text"
                        placeholder="Contains..."
                        value={draftFilters.email}
                        onChange={(e) => setDraftFilters({ ...draftFilters, email: e.target.value })}
                      />
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">Phone</label>
                      <input
                        className="filter-input"
                        type="tel"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="Numbers only..."
                        value={draftFilters.phone}
                        onChange={(e) => setDraftFilters({ ...draftFilters, phone: e.target.value.replace(/[^0-9]/g, '') })}
                      />
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">File</label>
                      <select
                        className="filter-input"
                        value={draftFilters.file}
                        onChange={(e) => setDraftFilters({ ...draftFilters, file: e.target.value })}
                      >
                        <option value="">All files</option>
                        {fileOptions.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">Source System</label>
                      <select
                        className="filter-input"
                        value={draftFilters.sourceSystem}
                        onChange={(e) => setDraftFilters({ ...draftFilters, sourceSystem: e.target.value })}
                      >
                        <option value="">All source systems</option>
                        {sourceSystemOptions.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">Coverage Tier</label>
                      <input
                        className="filter-input"
                        type="text"
                        placeholder="Contains..."
                        value={draftFilters.coverageTier}
                        onChange={(e) => setDraftFilters({ ...draftFilters, coverageTier: e.target.value })}
                      />
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">Termination Date</label>
                      <input
                        className="filter-input"
                        type="date"
                        value={draftFilters.terminationDate}
                        onChange={(e) => setDraftFilters({ ...draftFilters, terminationDate: e.target.value })}
                      />
                      <span className="filter-hint">Only filters Terminated Members table.</span>
                    </div>

                    <div className="filter-row">
                      <label className="filter-label">Effective Date</label>
                      <input
                        className="filter-input"
                        type="date"
                        value={draftFilters.effectiveDate}
                        onChange={(e) => setDraftFilters({ ...draftFilters, effectiveDate: e.target.value })}
                      />
                      <span className="filter-hint">Only filters New Members table.</span>
                    </div>
                  </div>

                  <div className="filter-drawer-footer">
                    <button className="filter-reset-btn" onClick={() => setDraftFilters(emptyFilter)}>Reset</button>
                    <button className="filter-apply-btn" onClick={applyFilters}>Apply Filters</button>
                  </div>
                </aside>
              </>
            )}
          </>
        )}

        {/* ==================== CONSULTANT REPORT TAB ==================== */}
        {activeTab === 'consultant' && (
          <div className="consultant-dashboard">
            {/* Header: title + month selector + actions */}
            <div className="consultant-header-row">
              <div className="consultant-title-block">
                <h2>Consultant Report</h2>
                <div className="consultant-subtitle">
                  {consultantSelectedMonth ? (
                    <>
                      {consultantSelectedMonth}
                      {consultantUploads && (
                        <> · {consultantUploads.uploadedCount} / {consultantUploads.requiredCount} files uploaded</>
                      )}
                      {consultantReportView?.report && (
                        <> · <span style={{ color: '#80d090', fontWeight: 600 }}>REPORT GENERATED</span></>
                      )}
                    </>
                  ) : (
                    <>Select or add a month to begin</>
                  )}
                </div>
              </div>
              <div className="consultant-actions">
                {consultantMonthsList.length > 0 && (
                  <select
                    className="consultant-month-select"
                    value={consultantSelectedMonth}
                    onChange={(e) => setConsultantSelectedMonth(e.target.value)}
                    disabled={consultantMonthsLoading}
                  >
                    {/* If the current selection isn't in the list yet (fresh month), keep it visible */}
                    {consultantSelectedMonth && !consultantMonthsList.some(m => m.label === consultantSelectedMonth) && (
                      <option value={consultantSelectedMonth}>{consultantSelectedMonth} (new)</option>
                    )}
                    {consultantMonthsList.map(m => (
                      <option key={m.prefix} value={m.label}>{m.label}{m.complete ? '' : ' (incomplete)'}</option>
                    ))}
                  </select>
                )}
                <button
                  className="consultant-new-month-btn"
                  onClick={() => setShowNewMonthDialog(true)}
                  title="Add a new month to upload files for"
                >
                  + New Month
                </button>
                {consultantReportView?.report && (
                  <button
                    className="billing-download-btn"
                    onClick={() => {
                      const r = consultantReportView.report!;
                      handleDownload(r.s3Key, r.filename);
                      if (consultantReportView.directory) {
                        // Small delay so both downloads fire cleanly in the same user gesture window
                        const d = consultantReportView.directory;
                        setTimeout(() => handleDownload(d.s3Key, d.filename), 300);
                      }
                    }}
                    title="Download both the report and the directory"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8, verticalAlign: '-2px' }}>
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Download Excel
                  </button>
                )}
              </div>
            </div>

            {consultantOpError && (
              <div className="consultant-error">
                {consultantOpError}
                <button className="consultant-error-dismiss" onClick={() => setConsultantOpError('')}>Dismiss</button>
              </div>
            )}

            {/* No month selected yet */}
            {!consultantSelectedMonth && !consultantMonthsLoading && (
              <div className="consultant-empty-state">
                <h3>No reports yet</h3>
                <p>Add a month to start uploading source files and generate the first report.</p>
                <button className="consultant-primary-btn" onClick={() => setShowNewMonthDialog(true)}>+ Add Month</button>
              </div>
            )}

            {/* Upload panel - shows whenever a month is selected and uploads aren't complete */}
            {consultantSelectedMonth && consultantUploads && !consultantUploads.complete && (
              <div className="consultant-upload-panel">
                <div className="consultant-upload-header">
                  <h3>Upload source files for {consultantSelectedMonth}</h3>
                  <div className="consultant-upload-progress">
                    {consultantUploads.uploadedCount} of {consultantUploads.requiredCount} required files uploaded
                    {consultantUploads.hasExistingUpload && (
                      <span className="consultant-warning-inline"> · re-uploading will overwrite matching slots</span>
                    )}
                  </div>
                </div>
                <div className="consultant-upload-actions">
                  <input
                    ref={consultantFileInputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => { if (e.target.files) handleConsultantUpload(e.target.files); }}
                  />
                  <button
                    className="consultant-primary-btn"
                    onClick={() => consultantFileInputRef.current?.click()}
                    disabled={consultantUploading}
                  >
                    {consultantUploading ? 'Uploading...' : 'Choose Files'}
                  </button>
                  <div className="consultant-upload-hint">
                    Filenames must contain one of the required patterns (e.g. TPA_Cassena, PIOPAC, CoreChoice_Direct_T1)
                  </div>
                </div>

                <div className="consultant-slot-grid">
                  {consultantUploads.slots.map(s => (
                    <div key={s.slot} className={`consultant-slot ${s.uploaded ? 'filled' : 'empty'}`}>
                      <div className="consultant-slot-status">
                        {s.uploaded ? (
                          <span className="consultant-slot-check">✓</span>
                        ) : (
                          <span className="consultant-slot-x">—</span>
                        )}
                      </div>
                      <div className="consultant-slot-body">
                        <div className="consultant-slot-label">{s.label}</div>
                        <div className="consultant-slot-substring">Match: <code>{s.slot}</code></div>
                        {s.uploaded && (
                          <div className="consultant-slot-filename" title={s.filename || ''}>
                            {s.filename}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Generate button - shows whenever all 10 uploaded. Every click
                overwrites the report for this month in S3. */}
            {consultantSelectedMonth && consultantUploads?.complete && (
              <div className="consultant-generate-panel">
                <div className="consultant-generate-msg">
                  All 10 files uploaded for {consultantSelectedMonth}. Click Generate to run the report.
                  {consultantReportView?.report && (
                    <> Any existing report for this month will be overwritten.</>
                  )}
                </div>
                <button
                  className="consultant-primary-btn"
                  onClick={handleConsultantGenerate}
                  disabled={consultantGenerating}
                >
                  {consultantGenerating ? 'Generating (may take up to 30s)...' : 'Generate Report'}
                </button>
              </div>
            )}

            {/* Loading spinner while report loads */}
            {consultantReportLoading && (
              <div className="loading-state">Loading report...</div>
            )}

            {/* Report viewer */}
            {consultantReportView?.report && (
              <div className="consultant-viewer-block">
                <div className="consultant-viewer-header">
                  <h3>Consultant Report</h3>
                  <div className="consultant-viewer-sub">
                    {consultantReportView.report.filename}
                    {consultantReportView.report.lastModified && (
                      <> · updated {new Date(consultantReportView.report.lastModified).toLocaleString()}</>
                    )}
                  </div>
                </div>
                {consultantReportView.report.sheets.length === 0 ? (
                  <div className="empty-state" style={{ padding: 24 }}>No sheets in the report file.</div>
                ) : (
                  <div className="bt-sheet-viewer">
                    <div className="bt-sheet-tabs">
                      {consultantReportView.report.sheets.map(s => (
                        <button
                          key={s.name}
                          className={`bt-sheet-tab ${consultantActiveReportSheet === s.name ? 'active' : ''}`}
                          onClick={() => setConsultantActiveReportSheet(s.name)}
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                    {(() => {
                      const active = consultantReportView.report!.sheets.find(s => s.name === consultantActiveReportSheet)
                        || consultantReportView.report!.sheets[0];
                      if (!active) return null;
                      const cells = active.cells;
                      const columnWidths = active.columnWidths || [];
                      const maxCols = cells.reduce((m, r) => Math.max(m, r.length), 0);
                      return (
                        <div className="bt-sheet-scroll">
                          <table className="bt-sheet-table" style={{ tableLayout: 'fixed' }}>
                            <colgroup>
                              {Array.from({ length: maxCols }).map((_, i) => (
                                <col key={i} style={{ width: `${columnWidths[i] || 96}px` }} />
                              ))}
                            </colgroup>
                            <tbody>
                              {cells.map((row, ri) => (
                                <tr key={ri}>
                                  {row.map((cell, ci) => {
                                    if (cell.hidden) return null;
                                    const style: React.CSSProperties = {};
                                    if (cell.bg) style.backgroundColor = cell.bg;
                                    if (cell.fg) style.color = cell.fg;
                                    if (cell.b) style.fontWeight = 700;
                                    if (cell.i) style.fontStyle = 'italic';
                                    if (cell.a) style.textAlign = cell.a;
                                    if (cell.bl) style.borderLeft = cell.bl;
                                    if (cell.br) style.borderRight = cell.br;
                                    if (cell.bt) style.borderTop = cell.bt;
                                    if (cell.bb) style.borderBottom = cell.bb;
                                    return (
                                      <td
                                        key={ci}
                                        style={style}
                                        rowSpan={cell.rs}
                                        colSpan={cell.cs}
                                      >
                                        {cell.v}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* Directory viewer */}
            {consultantReportView?.directory && (
              <div className="consultant-viewer-block">
                <div className="consultant-viewer-header">
                  <h3>Consultant Directory</h3>
                  <div className="consultant-viewer-sub">
                    {consultantReportView.directory.filename}
                    {consultantReportView.directory.lastModified && (
                      <> · updated {new Date(consultantReportView.directory.lastModified).toLocaleString()}</>
                    )}
                  </div>
                </div>
                {consultantReportView.directory.sheets.length === 0 ? (
                  <div className="empty-state" style={{ padding: 24 }}>No sheets in the directory file.</div>
                ) : (
                  <div className="bt-sheet-viewer">
                    <div className="bt-sheet-tabs">
                      {consultantReportView.directory.sheets.map(s => (
                        <button
                          key={s.name}
                          className={`bt-sheet-tab ${consultantActiveDirectorySheet === s.name ? 'active' : ''}`}
                          onClick={() => setConsultantActiveDirectorySheet(s.name)}
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                    {(() => {
                      const active = consultantReportView.directory!.sheets.find(s => s.name === consultantActiveDirectorySheet)
                        || consultantReportView.directory!.sheets[0];
                      if (!active) return null;
                      const cells = active.cells;
                      const columnWidths = active.columnWidths || [];
                      const maxCols = cells.reduce((m, r) => Math.max(m, r.length), 0);
                      return (
                        <div className="bt-sheet-scroll">
                          <table className="bt-sheet-table" style={{ tableLayout: 'fixed' }}>
                            <colgroup>
                              {Array.from({ length: maxCols }).map((_, i) => (
                                <col key={i} style={{ width: `${columnWidths[i] || 96}px` }} />
                              ))}
                            </colgroup>
                            <tbody>
                              {cells.map((row, ri) => (
                                <tr key={ri}>
                                  {row.map((cell, ci) => {
                                    if (cell.hidden) return null;
                                    const style: React.CSSProperties = {};
                                    if (cell.bg) style.backgroundColor = cell.bg;
                                    if (cell.fg) style.color = cell.fg;
                                    if (cell.b) style.fontWeight = 700;
                                    if (cell.i) style.fontStyle = 'italic';
                                    if (cell.a) style.textAlign = cell.a;
                                    if (cell.bl) style.borderLeft = cell.bl;
                                    if (cell.br) style.borderRight = cell.br;
                                    if (cell.bt) style.borderTop = cell.bt;
                                    if (cell.bb) style.borderBottom = cell.bb;
                                    return (
                                      <td key={ci} style={style} rowSpan={cell.rs} colSpan={cell.cs}>
                                        {cell.v}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* New Month dialog */}
            {showNewMonthDialog && (
              <div className="consultant-modal-overlay" onClick={() => setShowNewMonthDialog(false)}>
                <div className="consultant-modal" onClick={(e) => e.stopPropagation()}>
                  <h3>Add a New Month</h3>
                  <p>Pick the month you're uploading source files for. Files will be stored at <code>consultant-inputs/YYYY-MM/</code>.</p>
                  <div className="consultant-modal-row">
                    <label>Month</label>
                    <select
                      value={newMonthDraft.monthIdx}
                      onChange={(e) => setNewMonthDraft(d => ({ ...d, monthIdx: parseInt(e.target.value, 10) }))}
                    >
                      {MONTH_NAMES_LONG.map((n, i) => (
                        <option key={i} value={i}>{n}</option>
                      ))}
                    </select>
                    <label>Year</label>
                    <input
                      type="number"
                      min={2020}
                      max={2099}
                      value={newMonthDraft.year}
                      onChange={(e) => setNewMonthDraft(d => ({ ...d, year: parseInt(e.target.value, 10) || d.year }))}
                    />
                  </div>
                  <div className="consultant-modal-actions">
                    <button className="consultant-secondary-btn" onClick={() => setShowNewMonthDialog(false)}>Cancel</button>
                    <button className="consultant-primary-btn" onClick={confirmNewMonth}>Add Month</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ==================== BILLING TAB ==================== */}
        {activeTab === 'billing' && (
          <div className="billing-dashboard">
            {billingLoading && <div className="loading-state">Loading file...</div>}
            {billingError && <div className="error-state">Error: {billingError}</div>}
            {!billingLoading && !billingError && billingReport && (
              <>
                <div className="billing-header-row">
                  <div className="billing-title-block">
                    <h2>Billing</h2>
                    <div className="billing-subtitle">
                      Displaying: {billingReport.filename || (billingReport.sourceFile ? billingReport.sourceFile.split('/').pop() : 'no file loaded')}
                      {billingReport.approvedKey && (
                        <> · <span style={{ color: '#80d090', fontWeight: 600 }}>APPROVED FILE</span></>
                      )}
                    </div>
                  </div>
                  {billingReport.sourceFile && (
                    <button
                      className="billing-download-btn"
                      onClick={() => handleDownload(
                        billingReport.sourceFile!,
                        billingReport.filename || billingReport.sourceFile!.split('/').pop() || 'billing.xlsx'
                      )}
                      title="Download the currently displayed Excel file"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8, verticalAlign: '-2px' }}>
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      Download Excel
                    </button>
                  )}
                </div>

                {billingReport.sheets.length === 0 ? (
                  <div className="empty-state" style={{ padding: 32 }}>{billingReport.message || 'No sheets in this file.'}</div>
                ) : (
                  <div className="bt-sheet-viewer">
                    <div className="bt-sheet-tabs">
                      {billingReport.sheets.map(s => (
                        <button
                          key={s.name}
                          className={`bt-sheet-tab ${billingActiveSheet === s.name ? 'active' : ''}`}
                          onClick={() => setBillingActiveSheet(s.name)}
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                    {(() => {
                      const active = billingReport.sheets.find(s => s.name === billingActiveSheet)
                        || billingReport.sheets[0];
                      if (!active) return null;
                      const cells = active.cells;
                      const columnWidths = active.columnWidths || [];
                      const maxCols = cells.reduce((m, r) => Math.max(m, r.length), 0);
                      return (
                        <div className="bt-sheet-scroll">
                          <table className="bt-sheet-table" style={{ tableLayout: 'fixed' }}>
                            <colgroup>
                              {Array.from({ length: maxCols }).map((_, i) => (
                                <col key={i} style={{ width: `${columnWidths[i] || 96}px` }} />
                              ))}
                            </colgroup>
                            <tbody>
                              {cells.map((row, ri) => (
                                <tr key={ri}>
                                  {row.map((cell, ci) => {
                                    if (cell.hidden) return null; // slave cell in a merge - master handles spans
                                    const style: React.CSSProperties = {};
                                    if (cell.bg) style.backgroundColor = cell.bg;
                                    if (cell.fg) style.color = cell.fg;
                                    if (cell.b) style.fontWeight = 700;
                                    if (cell.i) style.fontStyle = 'italic';
                                    if (cell.a) style.textAlign = cell.a;
                                    if (cell.bl) style.borderLeft = cell.bl;
                                    if (cell.br) style.borderRight = cell.br;
                                    if (cell.bt) style.borderTop = cell.bt;
                                    if (cell.bb) style.borderBottom = cell.bb;
                                    return (
                                      <td
                                        key={ci}
                                        style={style}
                                        rowSpan={cell.rs}
                                        colSpan={cell.cs}
                                      >
                                        {cell.v}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Report Updates section - SAME chat data as Billing tab, with Approve button */}
                <div className="report-updates-section">
                  <h3 className="report-updates-heading">Report Updates</h3>
                  <div className="report-updates-subheading">
                    Post follow-ups, corrections, or attachments about this report. Attached files can be approved to replace the display above.
                    {updates.length > 0 && ` · ${updates.length} update${updates.length === 1 ? '' : 's'}`}
                  </div>

                  {updatesLoading && <div className="loading-state">Loading updates...</div>}
                  {updatesError && <div className="error-state">Error: {updatesError}</div>}

                  {!updatesLoading && !updatesError && (
                    <>
                      <div className="updates-list">
                        {updates.length === 0 ? (
                          <div className="empty-state" style={{ padding: 32 }}>No updates yet. Be the first to post.</div>
                        ) : (
                          updates.map((u) => (
                            <div key={u.id} className="update-card">
                              <div className="update-card-head">
                                <span className="update-name">{u.name}</span>
                                <span className="update-date">{formatUpdateDate(u.date)}</span>
                              </div>
                              <div className="update-comments">{u.comments}</div>
                              {u.filename && u.s3Key && (
                                <div className="update-file-row">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'rgba(107,164,255,0.7)' }}>
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <polyline points="14 2 14 8 20 8" />
                                  </svg>
                                  <span className="update-filename">{u.filename}</span>
                                  {u.size !== null && <span className="update-filesize">{formatFileSize(u.size)}</span>}
                                  <button className="update-download-btn" onClick={() => downloadUpdateFile(u)}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                      <polyline points="7 10 12 15 17 10" />
                                      <line x1="12" y1="15" x2="12" y2="3" />
                                    </svg>
                                    Download
                                  </button>
                                  {billingReport?.approvedKey === u.s3Key ? (
                                    <span
                                      className="update-approved-tag"
                                      title="This file is the currently approved display"
                                    >
                                      ✓ Approved
                                    </span>
                                  ) : (
                                    <button
                                      className="update-approve-btn"
                                      onClick={() => openApprovalModal(u)}
                                      title="Approve this file to replace the display above (requires passcode)"
                                    >
                                      Approve
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>

                      <form className="upload-form" onSubmit={submitUpdate}>
                        <div className="upload-form-title">Post a new update</div>
                        {uploadError && <div className="upload-error">{uploadError}</div>}

                        <div className="upload-form-row">
                          <label>Your name <span className="required">*</span></label>
                          <input
                            className="upload-input"
                            type="text"
                            value={uploadName}
                            onChange={(e) => setUploadName(e.target.value)}
                            placeholder="e.g. Kowshik B"
                            disabled={uploading}
                            maxLength={100}
                          />
                        </div>

                        <div className="upload-form-row">
                          <label>Comments <span className="required">*</span></label>
                          <textarea
                            className="upload-input"
                            value={uploadComments}
                            onChange={(e) => setUploadComments(e.target.value)}
                            placeholder="What's this update about?"
                            disabled={uploading}
                            maxLength={2000}
                            rows={3}
                          />
                        </div>

                        <div className="upload-form-row">
                          <label>Attachment (optional)</label>
                          <input
                            id="billing-upload-file-test"
                            className="upload-file-input"
                            type="file"
                            onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                            disabled={uploading}
                          />
                        </div>

                        <div className="upload-form-actions">
                          <button className="upload-submit-btn" type="submit" disabled={uploading}>
                            {uploading ? 'Posting...' : 'Post update'}
                          </button>
                        </div>
                      </form>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <div className="wave-container">
        <div className="wave wave-1">
          <svg viewBox="0 0 2400 320" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
            <path d="M0,160 C200,100 400,220 600,160 C800,100 1000,220 1200,160 C1400,100 1600,220 1800,160 C2000,100 2200,220 2400,160 L2400,320 L0,320 Z" fill="rgba(30, 80, 200, 0.25)" />
          </svg>
        </div>
        <div className="wave wave-2">
          <svg viewBox="0 0 2400 320" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
            <path d="M0,200 C300,140 500,260 800,200 C1100,140 1300,260 1600,200 C1900,140 2100,260 2400,200 L2400,320 L0,320 Z" fill="rgba(50, 110, 230, 0.3)" />
          </svg>
        </div>
        <div className="wave wave-3">
          <svg viewBox="0 0 2400 320" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
            <path d="M0,240 C250,180 450,300 700,240 C950,180 1150,300 1400,240 C1650,180 1850,300 2100,240 C2200,220 2300,260 2400,240 L2400,320 L0,320 Z" fill="rgba(90, 150, 255, 0.4)" />
          </svg>
        </div>
      </div>

      {/* APPROVAL PASSCODE MODAL - Billing tab, rendered at root level */}
      {approvalModalOpen && (
        <>
          <div className="upload-modal-overlay" onClick={closeApprovalModal} />
          <div className="approval-modal">
            <div className="approval-modal-header">
              <h3>Approve File</h3>
              <button className="close-btn" onClick={closeApprovalModal}>Close</button>
            </div>
            <div className="approval-modal-body">
              <p className="approval-modal-info">
                Approving <strong>{approvalTargetFilename || 'this file'}</strong> will replace the file currently displayed at the top of the Billing tab.
              </p>
              <label className="approval-modal-label">Passcode</label>
              <input
                type="password"
                className="approval-passcode-input"
                value={approvalPasscode}
                onChange={e => { setApprovalPasscode(e.target.value); setApprovalError(null); }}
                onKeyDown={e => { if (e.key === 'Enter' && !approvalSubmitting) submitApproval(); }}
                autoFocus
                placeholder="Enter passcode..."
                disabled={approvalSubmitting}
              />
              {approvalError && <div className="approval-error">{approvalError}</div>}
            </div>
            <div className="approval-modal-footer">
              <button className="close-btn" onClick={closeApprovalModal} disabled={approvalSubmitting}>Cancel</button>
              <button className="approval-submit-btn" onClick={submitApproval} disabled={approvalSubmitting}>
                {approvalSubmitting ? 'Approving...' : 'Approve'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* UPLOAD FILES MODAL - rendered at root level so it's available from any tab */}
      {uploadModalOpen && (
        <>
          <div className="upload-modal-overlay" onClick={closeUploadModal} />
          <div className="upload-modal">
            <div className="upload-modal-header">
              <h3>Upload Files to S3</h3>
              <button className="close-btn" onClick={closeUploadModal}>Close</button>
            </div>

            <div className="upload-modal-controls">
              <label className="upload-month-label">Month &amp; Year:</label>
              <select
                className="upload-select"
                value={uploadMonth}
                onChange={e => setUploadMonth(parseInt(e.target.value, 10))}
              >
                {MONTH_NAMES.map((n, i) => (
                  <option key={i} value={i}>{n}</option>
                ))}
              </select>
              <select
                className="upload-select"
                value={uploadYear}
                onChange={e => setUploadYear(parseInt(e.target.value, 10))}
              >
                {[2024, 2025, 2026, 2027, 2028].map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <span className="upload-hint">Applies to all files below</span>
            </div>

            <div className="upload-modal-body">
              {Object.values(uploadRowStatus).some(s => s && s.kind === 'success') && (
                <div className="upload-notice">
                  Upload complete. Please switch to the <strong>All Info</strong> tab and verify the uploaded file(s) appear in the correct month. If any file is missing, refresh the page.
                </div>
              )}
              <table className="upload-table">
                <thead>
                  <tr>
                    <th className="upload-col-name">File</th>
                    <th className="upload-col-file">Choose file</th>
                    <th className="upload-col-action">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {CANONICAL_FILES.map(label => {
                    const file = uploadRowFiles[label] || null;
                    const status: UploadRowStatus = uploadRowStatus[label] || { kind: 'idle' };
                    const existingFiles = existingFilesForRow(label);
                    const isBusy = status.kind === 'uploading';
                    return (
                      <tr key={label}>
                        <td className="upload-col-name">{label}</td>
                        <td className="upload-col-file">
                          <label className="file-picker-btn">
                            Choose file
                            <input
                              type="file"
                              accept=".xlsx,.xls,.csv"
                              onChange={e => handleRowFileChange(label, e.target.files?.[0] || null)}
                              disabled={isBusy}
                              style={{ display: 'none' }}
                            />
                          </label>
                          {file && (
                            <>
                              <span className="file-picker-name" title={file.name}>{file.name}</span>
                              <button
                                className="file-picker-cancel"
                                onClick={() => handleRowFileChange(label, null)}
                                disabled={isBusy}
                                title="Clear the selected file"
                              >
                                Cancel
                              </button>
                            </>
                          )}
                        </td>
                        <td className="upload-col-action">
                          {/* Existing matches shown inline, always visible when present */}
                          {existingFiles.length > 0 && status.kind !== 'success' && (
                            <div className="upload-exists-prompt">
                              <div className="upload-exists-msg">
                                {existingFiles.length} existing file{existingFiles.length === 1 ? '' : 's'} for {MONTH_NAMES[uploadMonth]} {uploadYear}:
                              </div>
                              <ul className="upload-existing-list">
                                {existingFiles.map(f => (
                                  <li key={f.key} className="upload-existing-row">
                                    <a
                                      href={`/api/master/download-existing?key=${encodeURIComponent(f.key)}`}
                                      download
                                      className="upload-existing-link"
                                      title={f.key}
                                    >
                                      {f.filename}
                                    </a>
                                    <span className="upload-existing-size">({formatBytes(f.size)})</span>
                                    <button
                                      className="upload-row-btn upload-override-btn"
                                      onClick={() => handleRowOverrideOne(label, f.key)}
                                      disabled={!file || isBusy}
                                      title={!file ? 'Select a file first' : 'Replace this file with your new upload'}
                                    >
                                      Override this
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {/* Add-new button - shows once a file has been picked, regardless of existing matches */}
                          {file && status.kind === 'idle' && (
                            <div className="upload-add-new-row">
                              <button className="upload-row-btn upload-addnew-btn" onClick={() => handleRowAddNew(label)}>
                                {existingFiles.length > 0 ? 'Add new (do not override)' : 'Upload'}
                              </button>
                            </div>
                          )}
                          {!file && existingFiles.length === 0 && status.kind === 'idle' && (
                            <span className="upload-status-muted">-</span>
                          )}
                          {status.kind === 'uploading' && (
                            <span className="upload-status-progress">Uploading...</span>
                          )}
                          {status.kind === 'success' && (
                            <span className="upload-status-success">
                              ✓ {status.overridden ? 'Replaced' : 'Uploaded'} as {status.renamedTo}
                            </span>
                          )}
                          {status.kind === 'error' && (
                            <span className="upload-status-error">
                              Error: {status.message}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="upload-modal-footer">
              <button className="close-btn" onClick={closeUploadModal}>Close</button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}