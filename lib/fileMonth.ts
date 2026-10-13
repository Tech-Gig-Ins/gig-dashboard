// Located at: lib/fileMonth.ts
//
// How All Records sorts a carrier file: the month block it sits in and its
// label (Cassena Remittance, Refresh, ...). Exact copies of detectMonthYear(),
// detectMonthNameOnly() and classifyFile() in app/page.tsx, and of the month
// logic in its groupFiles(), so the assistant sees each file exactly as All
// Records shows it (including which month's Include list applies). Keep in step.

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

export function detectMonthYear(filename: string): { year: number; month: number } | null {
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

export function detectMonthNameOnly(filename: string): number | null {
  // Standalone month name - word boundary on either side so we don't match
  // "May" inside a random word or "Jun" as part of "junior".
  const m = filename.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i);
  if (!m) return null;
  return MONTH_LOOKUP[m[1].toLowerCase()];
}

export function classifyFile(filename: string): string {
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

/** The month block All Records shows a file under (same order of rules as groupFiles()). */
export function allRecordsMonth(filename: string, lastModified: string): { year: number; month: number } {
  const detected = detectMonthYear(filename);
  if (detected) return detected;
  const uploaded = new Date(lastModified);
  const monthOnly = detectMonthNameOnly(filename);
  if (monthOnly !== null) {
    // Month name without a year: the upload year, or the year before when that
    // month is later than the upload month (a "December" file sent in February).
    let year = uploaded.getFullYear();
    if (monthOnly > uploaded.getMonth()) year -= 1;
    return { year, month: monthOnly };
  }
  return { year: uploaded.getFullYear(), month: uploaded.getMonth() };
}