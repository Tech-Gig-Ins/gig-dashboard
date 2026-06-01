'use client';

import { useEffect, useState } from 'react';

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

// Detect month/year from a filename. Returns { year, month } where month is 0-11.
// Returns null if no date detected.
function detectMonthYear(filename: string): { year: number; month: number } | null {
  const lower = filename.toLowerCase();

  // Pattern 1: Month name followed by 4-digit year (e.g., "April_2026", "April 2026", "april-2026")
  const monthNamePattern = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s_\-]*(\d{4})/i;
  const m1 = lower.match(monthNamePattern);
  if (m1) {
    const monthKey = m1[1].toLowerCase();
    const year = parseInt(m1[2], 10);
    const month = MONTH_LOOKUP[monthKey];
    if (month !== undefined && year >= 2020 && year <= 2099) {
      return { year, month };
    }
  }

  // Pattern 1b: Month name followed by 2-digit year (e.g., "March 26", "March26", "April 25")
  // Interpreted as 20YY
  const monthShortYearPattern = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s_\-]*(\d{2})(?!\d)/i;
  const m1b = lower.match(monthShortYearPattern);
  if (m1b) {
    const monthKey = m1b[1].toLowerCase();
    const yy = parseInt(m1b[2], 10);
    const month = MONTH_LOOKUP[monthKey];
    // Treat as 20YY (so "26" → 2026)
    const year = 2000 + yy;
    if (month !== undefined && yy >= 20 && yy <= 99) {
      return { year, month };
    }
  }

  // Pattern 2: MM-DD-YYYY or MM_DD_YYYY or MM/DD/YYYY (e.g., "05-25-2026")
  const usDatePattern = /(\d{1,2})[\-_\/](\d{1,2})[\-_\/](\d{4})/;
  const m2 = filename.match(usDatePattern);
  if (m2) {
    const month = parseInt(m2[1], 10) - 1;
    const year = parseInt(m2[3], 10);
    if (month >= 0 && month <= 11 && year >= 2020 && year <= 2099) {
      return { year, month };
    }
  }

  // Pattern 3: YYYYMMDD (e.g., "20260315")
  const isoPattern = /(\d{8})/;
  const m3 = filename.match(isoPattern);
  if (m3) {
    const s = m3[1];
    const year = parseInt(s.slice(0, 4), 10);
    const month = parseInt(s.slice(4, 6), 10) - 1;
    if (year >= 2020 && year <= 2099 && month >= 0 && month <= 11) {
      return { year, month };
    }
  }

  // Pattern 4: YYYY-MM-DD
  const isoDashPattern = /(\d{4})-(\d{1,2})-(\d{1,2})/;
  const m4 = filename.match(isoDashPattern);
  if (m4) {
    const year = parseInt(m4[1], 10);
    const month = parseInt(m4[2], 10) - 1;
    if (year >= 2020 && year <= 2099 && month >= 0 && month <= 11) {
      return { year, month };
    }
  }

  return null;
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

// Build a 2-level grouping: month → system → files
type DoubleGrouped = {
  [monthKey: string]: {
    label: string;
    year: number;
    month: number;
    systems: { [systemName: string]: FileRow[] };
  };
};

function groupFiles(files: FileRow[]): DoubleGrouped {
  const result: DoubleGrouped = {};

  for (const file of files) {
    // Detect system from S3 key
    const sysMatch = file.key.match(/^carrier=([^/]+)\//);
    const system = sysMatch ? sysMatch[1] : 'unknown';

    // Detect month from filename, fallback to lastModified date
    const detected = detectMonthYear(file.filename);
    let year: number, month: number, label: string, mKey: string;

    if (detected) {
      year = detected.year;
      month = detected.month;
      label = monthLabel(year, month);
      mKey = monthKey(year, month);
    } else {
      const d = new Date(file.lastModified);
      year = d.getFullYear();
      month = d.getMonth();
      label = `${monthLabel(year, month)} (from upload date)`;
      mKey = `unknown-${monthKey(year, month)}`;
    }

    if (!result[mKey]) {
      result[mKey] = { label, year, month, systems: {} };
    }
    if (!result[mKey].systems[system]) {
      result[mKey].systems[system] = [];
    }
    result[mKey].systems[system].push(file);
  }

  return result;
}

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const [grouped, setGrouped] = useState<DoubleGrouped>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalFiles, setTotalFiles] = useState(0);

  const [selectedFile, setSelectedFile] = useState<FileRow | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);

    async function fetchFiles() {
      try {
        const res = await fetch('/api/files');
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const data: FileRow[] = await res.json();
        setGrouped(groupFiles(data));
        setTotalFiles(data.length);
        setLoading(false);
      } catch (e: any) {
        setError(e.message || 'Failed to load files');
        setLoading(false);
      }
    }

    fetchFiles();
  }, []);

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

  // Sort month keys: newest first, "unknown-*" keys at the bottom
  const sortedMonthKeys = Object.keys(grouped).sort((a, b) => {
    const aUnknown = a.startsWith('unknown-');
    const bUnknown = b.startsWith('unknown-');
    if (aUnknown && !bUnknown) return 1;
    if (!aUnknown && bUnknown) return -1;
    return b.localeCompare(a);
  });

  return (
    <main className="dashboard-root">
      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap');

        html, body {
          margin: 0;
          padding: 0;
          font-family: 'Inter', sans-serif;
          background: #051433;
          color: #ffffff;
          min-height: 100vh;
          overflow-x: hidden;
        }

        * { box-sizing: border-box; }
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
          position: fixed;
          inset: 0;
          pointer-events: none;
          opacity: 0.06;
          mix-blend-mode: overlay;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
          z-index: 1;
        }

        .header {
          position: relative;
          z-index: 10;
          padding: 32px 56px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }

        .brand { display: flex; align-items: center; gap: 14px; }

        .brand-mark {
          width: 38px;
          height: 38px;
          border-radius: 10px;
          background: linear-gradient(135deg, #4d8eff 0%, #1546c4 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Fraunces', serif;
          font-weight: 700;
          font-size: 18px;
          letter-spacing: -0.02em;
          box-shadow: 0 8px 24px rgba(77, 142, 255, 0.4);
        }

        .brand-text {
          font-size: 13px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.7);
          font-weight: 500;
        }

        .header-meta {
          font-size: 12px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.4);
          display: flex;
          gap: 24px;
          align-items: center;
        }

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #4ade80;
          box-shadow: 0 0 12px rgba(74, 222, 128, 0.6);
          animation: pulse 2s ease-in-out infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }

        .hero {
          position: relative;
          z-index: 10;
          padding: 100px 56px 60px;
          max-width: 1400px;
          margin: 0 auto;
        }

        .eyebrow {
          font-size: 12px;
          letter-spacing: 0.3em;
          text-transform: uppercase;
          color: #6ba4ff;
          margin-bottom: 32px;
          opacity: 0;
          transform: translateY(20px);
          animation: ${mounted ? 'fadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards' : 'none'};
        }

        .title {
          font-family: 'Fraunces', serif;
          font-size: clamp(48px, 7vw, 88px);
          font-weight: 500;
          letter-spacing: -0.03em;
          line-height: 0.95;
          margin: 0;
          color: #ffffff;
          opacity: 0;
          transform: translateY(30px);
          animation: ${mounted ? 'fadeUp 1s cubic-bezier(0.16, 1, 0.3, 1) 0.25s forwards' : 'none'};
        }

        .title-accent {
          font-style: italic;
          color: #6ba4ff;
          font-weight: 400;
        }

        .subtitle {
          font-size: 17px;
          color: rgba(255, 255, 255, 0.55);
          margin: 32px 0 0;
          max-width: 540px;
          line-height: 1.6;
          opacity: 0;
          transform: translateY(20px);
          animation: ${mounted ? 'fadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.5s forwards' : 'none'};
        }

        @keyframes fadeUp {
          to { opacity: 1; transform: translateY(0); }
        }

        .stats {
          position: relative;
          z-index: 10;
          padding: 0 56px;
          max-width: 1400px;
          margin: 0 auto 60px;
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 24px;
          opacity: 0;
          transform: translateY(30px);
          animation: ${mounted ? 'fadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.7s forwards' : 'none'};
        }

        .stat-card {
          padding: 28px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          backdrop-filter: blur(20px);
          transition: all 0.3s ease;
        }

        .stat-card:hover {
          background: rgba(255, 255, 255, 0.05);
          border-color: rgba(107, 164, 255, 0.3);
          transform: translateY(-2px);
        }

        .stat-label {
          font-size: 11px;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.5);
          margin-bottom: 12px;
        }

        .stat-value {
          font-family: 'Fraunces', serif;
          font-size: 42px;
          font-weight: 500;
          letter-spacing: -0.02em;
          color: #ffffff;
        }

        .stat-meta {
          font-size: 13px;
          color: rgba(255, 255, 255, 0.4);
          margin-top: 8px;
        }

        .files-section {
          position: relative;
          z-index: 10;
          padding: 0 56px 200px;
          max-width: 1400px;
          margin: 0 auto;
          opacity: 0;
          transform: translateY(30px);
          animation: ${mounted ? 'fadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.9s forwards' : 'none'};
        }

        .files-section-header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          margin-bottom: 32px;
        }

        .section-title {
          font-family: 'Fraunces', serif;
          font-size: 28px;
          font-weight: 500;
          color: #ffffff;
          margin: 0;
        }

        .month-block {
          margin-bottom: 56px;
        }

        .month-heading {
          font-family: 'Fraunces', serif;
          font-size: 36px;
          font-weight: 500;
          color: #ffffff;
          margin: 0 0 24px;
          letter-spacing: -0.02em;
          display: flex;
          align-items: baseline;
          gap: 20px;
        }

        .month-heading::after {
          content: '';
          flex: 1;
          height: 1px;
          background: linear-gradient(90deg, rgba(107, 164, 255, 0.4) 0%, transparent 100%);
        }

        .month-count {
          font-family: 'Inter', sans-serif;
          font-size: 11px;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: rgba(107, 164, 255, 0.8);
          font-weight: 500;
        }

        .system-group {
          margin-bottom: 24px;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          overflow: hidden;
          backdrop-filter: blur(20px);
        }

        .system-name {
          padding: 18px 28px;
          background: rgba(77, 142, 255, 0.08);
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .system-name h3 {
          font-family: 'Fraunces', serif;
          font-size: 20px;
          font-weight: 500;
          color: #ffffff;
          margin: 0;
          letter-spacing: -0.01em;
        }

        .system-count {
          font-size: 11px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: rgba(107, 164, 255, 0.9);
          font-weight: 500;
        }

        .file-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }

        .file-item-wrapper {
          list-style: none;
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }

        .file-item-wrapper:last-child {
          border-bottom: none;
        }

        .file-item {
          padding: 14px 28px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          cursor: pointer;
          transition: background 0.15s ease;
        }

        .file-item:hover {
          background: rgba(107, 164, 255, 0.06);
        }

        .file-item.selected {
          background: rgba(107, 164, 255, 0.14);
          border-left: 3px solid #6ba4ff;
          padding-left: 25px;
        }

        .file-item-name {
          font-family: 'JetBrains Mono', 'Courier New', monospace;
          font-size: 13px;
          color: #ffffff;
          flex: 1;
          word-break: break-all;
        }

        .file-item-meta {
          font-size: 12px;
          color: rgba(255, 255, 255, 0.4);
          letter-spacing: 0.05em;
          white-space: nowrap;
        }

        .empty-state, .loading-state, .error-state {
          padding: 60px 28px;
          text-align: center;
          color: rgba(255, 255, 255, 0.4);
          font-size: 14px;
          letter-spacing: 0.05em;
        }

        .error-state { color: #ff8888; }

        .content-viewer {
          margin: 8px 28px 16px;
          background: rgba(10, 30, 70, 0.6);
          border: 1px solid rgba(107, 164, 255, 0.25);
          border-radius: 12px;
          overflow: hidden;
          backdrop-filter: blur(20px);
          animation: slideOpen 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes slideOpen {
          from {
            opacity: 0;
            transform: translateY(-8px);
            max-height: 0;
          }
          to {
            opacity: 1;
            transform: translateY(0);
            max-height: 800px;
          }
        }

        .content-header {
          padding: 24px 28px;
          background: rgba(107, 164, 255, 0.1);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
        }

        .content-header-info h4 {
          font-family: 'Fraunces', serif;
          font-size: 20px;
          font-weight: 500;
          color: #ffffff;
          margin: 0 0 6px;
          word-break: break-all;
        }

        .content-header-info p {
          margin: 0;
          font-size: 12px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.45);
        }

        .close-btn {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          padding: 8px 14px;
          color: rgba(255, 255, 255, 0.7);
          font-size: 12px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .close-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          color: #ffffff;
        }

        .table-scroll {
          overflow-x: auto;
          max-height: 600px;
          overflow-y: auto;
        }

        table.content-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }

        table.content-table th {
          padding: 12px 16px;
          text-align: left;
          font-size: 10px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.7);
          font-weight: 600;
          background: rgba(0, 0, 0, 0.3);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          position: sticky;
          top: 0;
          white-space: nowrap;
        }

        table.content-table td {
          padding: 10px 16px;
          color: rgba(255, 255, 255, 0.85);
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
          white-space: nowrap;
          font-family: 'JetBrains Mono', 'Courier New', monospace;
          font-size: 12px;
        }

        table.content-table tr:hover td {
          background: rgba(107, 164, 255, 0.04);
        }

        .content-footer {
          padding: 14px 28px;
          background: rgba(0, 0, 0, 0.2);
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          font-size: 11px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.4);
          text-align: center;
        }

        .wave-container {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          height: 60vh;
          pointer-events: none;
          z-index: 2;
        }

        .wave {
          position: absolute;
          bottom: 0;
          left: 0;
          width: 200%;
          height: 100%;
        }

        @keyframes waveSlow {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }

        @keyframes waveMid {
          from { transform: translateX(-50%); }
          to { transform: translateX(0); }
        }

        @keyframes waveFast {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }

        .wave-1 svg { animation: waveSlow 25s linear infinite; }
        .wave-2 svg { animation: waveMid 18s linear infinite; }
        .wave-3 svg { animation: waveFast 12s linear infinite; }

        @media (max-width: 768px) {
          .header { padding: 24px; }
          .hero { padding: 60px 24px 40px; }
          .stats { padding: 0 24px; margin-bottom: 40px; }
          .files-section { padding: 0 24px 200px; }
          .month-heading { font-size: 26px; }
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
          Gig Insurance<br />
          <span className="title-accent">Internal Dashboard</span>
        </h1>
        <p className="subtitle">
          Centralized view of remittance files arriving through the secure file transfer system. Files are organized by month, then by enrollment system. Click any file to preview its contents.
        </p>
      </section>

      <section className="stats">
        <div className="stat-card">
          <div className="stat-label">Enrollment Systems</div>
          <div className="stat-value">8</div>
          <div className="stat-meta">All active</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Files</div>
          <div className="stat-value">{loading ? '—' : totalFiles}</div>
          <div className="stat-meta">{loading ? 'Loading…' : 'Across all systems'}</div>
        </div>
      </section>

      <section className="files-section">
        <div className="files-section-header">
          <h2 className="section-title">Uploaded Files</h2>
        </div>

        {loading && (
          <div className="system-group">
            <div className="loading-state">Loading files...</div>
          </div>
        )}

        {error && (
          <div className="system-group">
            <div className="error-state">Error: {error}</div>
          </div>
        )}

        {!loading && !error && sortedMonthKeys.length === 0 && (
          <div className="system-group">
            <div className="empty-state">No files uploaded yet.</div>
          </div>
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

              {Object.keys(monthBlock.systems).sort().map((system) => (
                <div key={system} className="system-group">
                  <div className="system-name">
                    <h3>{prettifySystemName(system)}</h3>
                    <span className="system-count">{monthBlock.systems[system].length} file{monthBlock.systems[system].length !== 1 ? 's' : ''}</span>
                  </div>
                  <ul className="file-list">
                    {monthBlock.systems[system].map((file) => (
                      <li key={file.key} className="file-item-wrapper">
                        <div
                          className={`file-item ${selectedFile?.key === file.key ? 'selected' : ''}`}
                          onClick={() => {
                            if (selectedFile?.key === file.key) {
                              setSelectedFile(null);
                              setFileContent(null);
                            } else {
                              loadFileContent(file);
                            }
                          }}
                        >
                          <span className="file-item-name">{file.filename}</span>
                          <span className="file-item-meta">
                            {formatBytes(file.size)} · {formatDate(file.lastModified)}
                          </span>
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
                              <button
                                className="close-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedFile(null);
                                  setFileContent(null);
                                }}
                              >
                                Close
                              </button>
                            </div>

                            {contentLoading && (
                              <div className="loading-state">Loading file contents...</div>
                            )}

                            {contentError && (
                              <div className="error-state">Error: {contentError}</div>
                            )}

                            {fileContent && (
                              <>
                                <div className="table-scroll">
                                  <table className="content-table">
                                    <thead>
                                      <tr>
                                        {fileContent.headers.map((h, i) => (
                                          <th key={i}>{h || `Column ${i + 1}`}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {fileContent.rows.map((row, i) => (
                                        <tr key={i}>
                                          {fileContent.headers.map((_, j) => (
                                            <td key={j}>{row[j] ?? ''}</td>
                                          ))}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                {fileContent.rows.length < fileContent.totalRows && (
                                  <div className="content-footer">
                                    Showing first {fileContent.rows.length.toLocaleString()} of {fileContent.totalRows.toLocaleString()} rows
                                  </div>
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
    </main>
  );
}