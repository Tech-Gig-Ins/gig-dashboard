# GWU Internal Dashboard — Testing Checklist

Every user-facing action, what to do, and what should happen.

**You need two accounts to test this properly**: an admin
(`tech@` or `andrewc@`) and any other `@gigworkersuniverse.com` account, which
will be a viewer. Use a private window for the second so sessions don't collide.

Legend: **A** = admin only · **V** = viewer · **BOTH** = either

---

## 1. Authentication

| # | Action | Expected | Who |
|---|---|---|---|
| 1.1 | Open the site in a private window | Redirected to Google, never the dashboard | BOTH |
| 1.2 | Sign in with an org Google account | Lands on Master Dashboard | BOTH |
| 1.3 | First-ever sign-in for a new org user | Straight in — no registration form, no email code | BOTH |
| 1.4 | Sign in with a personal gmail | `/access-denied`, "not logging in via an authorized organization" | — |
| 1.5 | Check the header | Your name, email, and **Admin** or **Viewer** badge | BOTH |
| 1.6 | Open `/api/auth/me` | JSON with `firstName`, `lastName`, correct `isAdmin` | BOTH |
| 1.7 | Click **Sign out** | Lands on "You have been signed out", **stays there** | BOTH |
| 1.8 | Signed out, open `/api/master` directly | `{"error":"Not authenticated"}`, not data | — |
| 1.9 | Delete the `gwu_id` cookie in DevTools, click a nav item | Silently renews, no login screen | BOTH |
| 1.10 | Leave a tab idle 2 hours, then use it | Still works — refresh token is 7 days | BOTH |
| 1.11 | Check the `gwu_rt` cookie expiry in DevTools | ~7 days out | BOTH |

**Verify the domain gate actually fired:**
```powershell
aws logs tail /aws/lambda/gig-dashboard-presignup --region us-east-1 --since 15m
```
Expect `ACCEPT` for org accounts, `REJECT - domain 'gmail.com' is not …` otherwise.

---

## 2. Navigation and chrome

| # | Action | Expected | Who |
|---|---|---|---|
| 2.1 | Look at the left rail as an admin | 5 items, Welfare last | A |
| 2.2 | Look at the left rail as a viewer | 4 items, **no Welfare** | V |
| 2.3 | Click each rail item | View switches; no tab bar anywhere | BOTH |
| 2.4 | Scroll down any long list | Navbar stays fixed at the top | BOTH |
| 2.5 | Check the navbar | Logo, then **GWU INTERNAL DASHBOARD** centred in caps | BOTH |
| 2.6 | Check the browser tab | Your logo, not the Next.js mark | BOTH |
| 2.7 | Deploy a new build with a tab open, wait 60s | Status dot turns red, "System Update Required" | BOTH |
| 2.8 | Click "System Update Required" | Page reloads, indicator returns to green | BOTH |
| 2.9 | Viewer opens `/api/welfare` directly | `403 Administrator access required` | V |

---

## 3. Master Dashboard

| # | Action | Expected | Who |
|---|---|---|---|
| 3.1 | Open with no manifest for the month | Empty — this is correct, not a bug | BOTH |
| 3.2 | Include files in All Info, return | Counts populate | BOTH |
| 3.3 | Search a member by name | Matching rows only | BOTH |
| 3.4 | Open **Filters** | Drawer opens from the **right**, rail still visible | BOTH |
| 3.5 | Apply a filter, then clear it | Rows narrow, then restore | BOTH |
| 3.6 | Check the File dropdown | Only files that produced records | BOTH |
| 3.7 | Find a Refresh row | Plan Name reads `Gig Medical - ASO Plan` | BOTH |
| 3.8 | Same row, Coverage Tier | Populated from the `Tier` column, not `-` | BOTH |
| 3.9 | Same row, Payment | Populated from `Price`, not `-` | BOTH |
| 3.10 | Compare a TPA file's count to its row count | Distinct members, normally lower | BOTH |

---

## 4. All Info

| # | Action | Expected | Who |
|---|---|---|---|
| 4.1 | Expand a month | Files grouped by carrier | BOTH |
| 4.2 | Click **Include** on a file | Turns to `✓ Included`, count rises | BOTH |
| 4.3 | Click it again | Reverts, count falls | BOTH |
| 4.4 | **Include all** on a month | All eligible files included | BOTH |
| 4.5 | **Exclude all** | Count returns to 0 | BOTH |
| 4.6 | Find a `.pdf` or `.zip` | `EXCLUDED` badge, **no Include button** | BOTH |
| 4.7 | Include a file, check Master | Counts change to match | BOTH |
| 4.8 | Look for **Upload Files** | Visible for admin, **hidden** for viewer | A |
| 4.9 | Look for **Move** on a row | Visible for admin, hidden for viewer | A |
| 4.10 | Upload a file as admin | Appears under the correct month | A |
| 4.11 | Click a file row | Preview opens | BOTH |
| 4.12 | **Download** a file | File downloads intact | BOTH |

### Move / reclassify (admin)

| # | Action | Expected |
|---|---|---|
| 4.13 | Click **Move** | Dialog opens, pre-filled from the current filename |
| 4.14 | Read the preview line | Green, e.g. `Cassena Remittance August 2026.xlsx` |
| 4.15 | Change type and month | Preview updates live |
| 4.16 | Confirm the move | Old name gone, new name under the new month |
| 4.17 | Move an **included** file | Still included after the move |
| 4.18 | Move onto an existing name | Blocked; button becomes **Replace existing file** |
| 4.19 | Click Replace | Overwrites; old version still in S3 versioning |
| 4.20 | Leave everything unchanged | Move button disabled |

---

## 5. Consultant Report

| # | Action | Expected | Who |
|---|---|---|---|
| 5.1 | Select a month | Included-file count and list shown | BOTH |
| 5.2 | Select a month with 0 included | Prompt to include files; Generate disabled | BOTH |
| 5.3 | **Generate Report** with fewer than 10 files | Runs — there is no count gate | A |
| 5.4 | Generate as a viewer | Button hidden; direct API call gives 403 | V |
| 5.5 | Check the log's first line | `version: 2026-…` matching what you deployed | A |
| 5.6 | Check the per-source lines | Each shows a filename and enrolment count, or `[MISSING]` | A |
| 5.7 | Open a consultant tab in the output | Companies table, then **ENROLLED MEMBERS** with names | BOTH |
| 5.8 | Compare the two tables | `TOTAL MEMBERS` ties to the count above | BOTH |
| 5.9 | Open the Download dropdown | Full report + one entry per consultant | BOTH |
| 5.10 | Download the full report | All sheets present | BOTH |
| 5.11 | Download a single consultant | One sheet, formatting intact | BOTH |
| 5.12 | Download **FNA** | One file, **five** sheets, original names | BOTH |
| 5.13 | Check the dropdown for `FNA Full Report` | Absent — shared tabs stay in the full workbook | BOTH |
| 5.14 | Include a Credits file, regenerate | Its source still resolves to the Remittance file | A |
| 5.15 | Include a Refresh file with no `Vendor` column | Skipped with an error line, not parsed | A |

---

## 6. Billing

| # | Action | Expected | Who |
|---|---|---|---|
| 6.1 | Select a month | Report renders if one exists | BOTH |
| 6.2 | Look for **Upload Files** | Admin only | A |
| 6.3 | Upload CardConnect + Refresh | Both stored; report generates automatically | A |
| 6.4 | Upload only one of the two | Rejected — both are required | A |
| 6.5 | Check the log's month line | `Reconciling September 2026 (sources under billing-sources/2026-09/)` | A |
| 6.6 | Check the output filename | Matches the **selected** month, not today's date | A |
| 6.7 | Generate for a month with no sources | Clear error naming the month; no report written | A |
| 6.8 | Post an update with a file | Succeeds | **BOTH** |
| 6.9 | Look for **Approve** on an update | Admin only | A |
| 6.10 | Click **Approve** | One click, no passcode; display switches to that file | A |
| 6.11 | Watch other rows while approving | Only the clicked row says "Approving…" | A |
| 6.12 | Look for **Reset to Default** | Appears only when a file is approved | A |
| 6.13 | Click Reset | Reverts to the generated report; button disappears | A |
| 6.14 | Approve, then Generate | Generate wins — the new report is displayed | A |
| 6.15 | Check Q1's second table | Last column is **CardPointe Last 4** | BOTH |
| 6.16 | Check a group like KWSE | Matched, with all its payers aggregated | BOTH |

---

## 7. Welfare (admin only)

| # | Action | Expected |
|---|---|---|
| 7.1 | Open the tab | Table plus the calculation notes above it |
| 7.2 | Check the subtitle | `August 2026 · credits from July 2026` |
| 7.3 | Check the month dropdown | June 2026 onwards only |
| 7.4 | Count the rows | 10, ending with EP6 and PIOPAC |
| 7.5 | Find **GIG Credit Cards** | Greyed, all figures blank — not zero |
| 7.6 | Check **Credit Amount** | Positive, no brackets, no minus |
| 7.7 | Verify one row by hand | `Amount − Cap Fee − Credit + Credit Fees` = NYP Wire |
| 7.8 | Check Cap Fee | `Enrolled × rate` using the rate in the notes |
| 7.9 | Look for the unused-files banner | Lists any eligible file mapping to no row |
| 7.10 | Exclude a remittance file, reload | That row's figures go to zero |
| 7.11 | Un-include a **credits** file, reload | Credit figures **unchanged** — credits ignore inclusion |
| 7.12 | **Download Excel** | `NYP Wire August 2026.xlsx`, notes above the table |
| 7.13 | Compare the download to the screen | Identical figures |

---

## 8. Email ingest

| # | Action | Expected |
|---|---|---|
| 8.1 | Email a correctly named file to `reminders@` | Appears in All Info within seconds |
| 8.2 | Check the log | `allowed=True` then `[ok] … -> carrier=…` |
| 8.3 | Email a file named `abcd.xlsx` | Quarantined to `email-rejected/unclassified/` |
| 8.4 | Email `TPA_Cassena_Remittance.xlsx` (no date) | Quarantined to `email-rejected/no-date/` |
| 8.5 | Check your inbox after 8.3 or 8.4 | SNS alert naming the file and the reason |
| 8.6 | Read the alert | States **both** requirements and lists valid date formats |
| 8.7 | Email a `.pdf` | Quarantined to `email-rejected/bad-extension/` |
| 8.8 | Email from a non-allowlisted domain | Rejected; raw mail saved; alert sent |
| 8.9 | Send several attachments, one bad | Good ones stored, only the bad one quarantined |
| 8.10 | Confirm both SNS subscribers | `tech@` and `andrewc@` both `Confirmed` |

```powershell
aws logs tail /aws/lambda/gig-email-ingest --region us-east-1 --since 15m
aws s3 ls s3://gig-remittance-raw-prod/email-rejected/ --recursive --region us-east-1
aws sns list-subscriptions-by-topic --topic-arn arn:aws:sns:us-east-1:121710557801:gig-ingest-alerts --region us-east-1
```

---

## 9. Infrastructure

| # | Check | Command | Expected |
|---|---|---|---|
| 9.1 | Encryption at rest | `aws s3api head-object --bucket gig-remittance-raw-prod --key "<a real key>" --query '[ServerSideEncryption,SSEKMSKeyId]'` | `aws:kms` + key ARN |
| 9.2 | TLS enforced | `aws s3api get-bucket-policy --bucket gig-remittance-raw-prod` | `DenyInsecureTransport` present |
| 9.3 | Object-level audit | `aws cloudtrail get-event-selectors --trail-name audit-trail-prod` | A `Data` selector for the bucket |
| 9.4 | Versioning | `aws s3api get-bucket-versioning --bucket gig-remittance-raw-prod` | `Enabled` |
| 9.5 | Public access | `aws s3api get-public-access-block --bucket gig-remittance-raw-prod` | All four `true` |
| 9.6 | Consultant Lambda version | `aws lambda get-function-configuration --function-name consultant-report-lambda --query 'CodeSha256'` | Matches your last deploy |
| 9.7 | Session policy | `aws cognito-idp describe-user-pool-client --user-pool-id us-east-1_xP4jjV7wB --client-id g801e6h7gk9qma8ucunn17h5l --query 'UserPoolClient.[RefreshTokenValidity,TokenValidityUnits]'` | `7`, `days` |

---

## 10. Release smoke test

Five minutes after any deploy.

1. Private window → redirected to Google
2. Sign in as admin → Master Dashboard loads with data
3. All Info → toggle one file → Master count changes
4. Consultant Report → open a month with a report → sheets render
5. Billing → select a month → report renders
6. Welfare → figures present, TOTAL row ties
7. Private window → `/api/master` → 401
8. Sign in as viewer → 4 rail items, no Upload/Move/Approve buttons

If 1, 7 or 8 fail, **stop and roll back** — those are the PHI exposure paths.

---

## Recurring failure modes

When something behaves oddly, check these before debugging logic:

- **A Lambda change had no effect** → the staged copy is stale, or the zip
  written by `Compress-Archive` isn't the one `fileb://` read. Verify
  `CodeSha256` changed.
- **An env var change had no effect** → Amplify needs a *new build*, and the
  variable must be in the `amplify.yml` grep.
- **A file vanished from a month** → the filename lost its date, or the carrier
  changed its naming convention.
- **Figures differ between Master, Consultant and Welfare** → expected. Each
  applies different filters. See ARCHITECTURE.md §5.
- **An element is invisible or won't stick** → an ancestor has `overflow: hidden`.