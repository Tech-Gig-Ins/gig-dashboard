# GWU Internal Dashboard — Context, Decisions, Consequences

Internal operations dashboard for Gig Workers Universe. Next.js 16 on AWS
Amplify, backed by S3, Cognito and three Lambdas.

Live: `https://internaldashboard.gigworkersuniverse.com`
Repo: `Tech-Gig-Ins/gig-dashboard`
AWS account: `121710557801`, region `us-east-1`

This document records **why** things are the way they are. Where a decision has
a sharp edge, the edge is written down rather than left to be rediscovered.

---

## 1. The organising idea: the filename is the routing key

**Context.** Seven carriers deliver remittance and credits files monthly, by
SFTP and now by email. They arrive as `.xlsx`, `.xls` and `.csv` with
inconsistent naming.

**Decision.** Nothing inspects file *contents* to decide what a file is. Two
functions parse the **filename**:

- `classifyFile(name)` → one of 17 labels (`Cassena Remittance`, `GWU3 Credits`, …)
- `detectMonthYear(name)` → the coverage month

Everything downstream follows from those two.

**Consequences.**

- Renaming a file reclassifies it. That is what makes the *Move* feature a
  pure rename with no data migration.
- A carrier that changes its filename convention silently drops out. This has
  happened three times: EP6, Northstead and CoreChoice all changed between July
  and August. Handled with alias lists, not by guessing.
- A file with no date in the name is filed under its **upload date**, not its
  coverage month. The email ingest rejects such files for this reason; the
  manual upload button does not, because a human can see where it lands.
- The S3 prefix (`carrier=tpa/`, `carrier=gig/`) is **not** the routing signal
  and is inconsistent in practice — Cassena files live in both `carrier=gig/`
  and `carrier=tpa/`. Nothing depends on it.

---

## 2. Inclusion manifests

**Context.** Originally the Consultant Report had a 10-slot upload flow, and
the Master Dashboard counted every file it found. Two sources of truth.

**Decision.** One manifest per month at `manifests/{YYYY-MM}.json`, holding the
S3 keys a user explicitly included via the All Info tab. Both Master and
Consultant read it. The upload flow was deleted.

**Consequences.**

- Master shows **nothing** for a month with no manifest. That is the design,
  not a regression, and it surprises people the first time.
- Inclusion disambiguates carriers that ship several remittance files in one
  month. Cassena sends Invoice, Vision and the main remittance, all classifying
  identically; inclusion picks the real one.
- Credits are usually left *un*-included so they don't disturb the Consultant
  Report. The Welfare tab therefore reads credits **regardless** of inclusion —
  see §5.
- Manifest month keys are calendar-based (`2026-08` = August). The frontend's
  internal `monthKey()` is **zero-based** (August = `2026-07`). `manifestMonthKey()`
  is the single conversion point. Mixing them files everything one month early
  and Master still appears to work, because it unions all manifests.

---

## 3. Authentication

**Context.** Until recently the dashboard was publicly reachable and served
SSNs, DOB, addresses and plan data to anyone with the URL. A BAA is in place.

**Decision.** Cognito user pool `us-east-1_xP4jjV7wB` with **Google as the only
identity provider**, a PreSignUp Lambda restricting sign-in to
`gigworkersuniverse.com`, and `requireAuth` / `requireAdmin` on every API route.

**Consequences.**

- **First sign-in registers and logs in together.** No registration page, no
  email verification. `autoConfirmUser` in the PreSignUp trigger.
- The app client lists Google as its only supported IdP, so the Hosted UI never
  shows a password form. There is no native login path to attack.
- **The domain is re-checked on every request**, not just at sign-up. PreSignUp
  fires once per user and `PreAuthentication` does not fire for federated
  logins, so if someone's Google account moves off the domain the per-request
  check in `lib/auth.ts` is the only thing that stops them.
- Admins come from the `ADMIN_EMAILS` environment variable, not Cognito groups.
  Group assignment normally happens in `PostConfirmation`, which also does not
  fire for federated users. An env var is testable and needs no provisioning.
- **`proxy.ts`, not `middleware.ts`.** Next 16 renamed it. A file named
  `middleware.ts` is silently ignored — for an auth gate that means the app
  looks protected while being wide open.
- Proxy does an **optimistic cookie check only**, per the Next 16 docs. Real
  verification is in `lib/auth.ts`, called by every route. Do not remove those
  calls on the assumption the proxy covers them.
- `app/page.tsx` is a client component, so `/` would be prerendered to static
  HTML and served from the CDN, bypassing the proxy entirely. `layout.tsx` sets
  `dynamic = 'force-dynamic'` to prevent that, and the page also gates its own
  render on `/api/auth/me`.

### Sessions

- id/access tokens: 60 minutes (Cognito clamps to 24h if units are misapplied)
- refresh token: **7 days**
- `/api/auth/refresh` trades the refresh token for new tokens; the page calls it
  on 401 **and** on load. Without the load-time call, an idle tab bounced the
  user to Google even with a valid refresh token.
- Logout lands on `/signed-out`, **not** `/`. Returning to `/` meant the proxy
  redirected to login, Google silently re-authenticated, and sign-out appeared
  to do nothing.

---

## 4. Consultant Report

**Context.** A Python Lambda (`consultant-report-lambda`) parses the included
files and produces a per-consultant workbook.

**Decisions and their edges.**

- **Ten sources, 17 canonical labels.** Credits files, Delta Dental and NYP have
  no parser here; they affect Master only.
- **`find_file` matches a normalised substring** and breaks ties by *shortest
  filename*. `TPA_Cassena_Credits_…` is shorter than `TPA_Cassena_Remittance_…`
  and both contain `tpacassena`, so Credits silently won and the source parsed
  to zero. Credits are now rejected outright for non-Credits sources.
- **`SOURCE_ALIASES`** carries alternate filename patterns per source. Required
  because conventions changed mid-year.
- **Refresh is filtered**: Vendor must be `Gig Medical`, and rows effective
  *after* the report month are dropped. A Refresh file with no `Vendor` or
  `Consultant` column is **rejected**, not parsed, because it is the wrong export.
- **`LAMBDA_VERSION` must be bumped on every change.** It sat stale at
  `v5-safety` for over a week while corrected code was deployed underneath,
  which made "is my fix live?" unanswerable and cost a full debugging session.
  The first line of the log is the only trustworthy deploy signal.

### Sheet selection

CoreChoice T1/T3 and Decisely GWU1/GWU2 read **only** the `Anthem Medical`
sheet. `norm()` must be applied to the sheet name, not the search string, or the
filter never matches and silently falls back to reading every sheet.

---

## 5. Welfare tab (NYP wire payments)

**Context.** Replaces a manual spreadsheet. Admin only.

**Formulas**, from `GIG_NYP_Payments_TEMPLATE.xlsx`:

```
GIG Cap Fee = Enrolled     x fee rate
Credit Fees = Credit Count x fee rate
NYP Wire    = Remittance Amount - GIG Cap Fee - Credit Amount + Credit Fees
```

**Decisions.**

- **Fee rates come from the template's `K20:L29` block only.** The Source Detail
  tab documents a different Cassena rate (131 vs 94) and is deliberately ignored.
  Refresh uses 142 for both cap fee and credit fee; the template's 141 in one
  column is an error its own notes flag.
- **Remittances: included files only. Credits: any file, prior month.** Two
  different rules, for the reasons in §2. Credits lag because remittances cover
  the current coverage month and credits cover the prior work period.
- **Remittance Amount sums every row; Enrolled is de-duplicated.** A member on
  two plans pays two premiums, so money and headcount legitimately differ.
- **Credit Amount is taken as a positive magnitude.** Credits files store
  negatives, and the formula already subtracts, so a negative would *add* to the
  wire. This was a live bug: one row was inflated by $33,002.
- **Hartford is not a file.** It is the rows of the Corechoice T3 remittance
  whose Group is `HARTFORD FUNDING, LTD.`
- **GIG Credit Cards has no associated file** and renders blank, not zero.

---

## 6. Billing

**Context.** `reconcile-billing` matches Refresh enrollments against CardPointe
card transactions.

**Decisions.**

- **The month comes from the request, not the clock.** It previously used
  `datetime.now()`, so every run in August wrote `..._August_2026.xlsx` whatever
  month was selected. September never appeared and the real August report was
  overwritten. Recovered from S3 versioning.
- **Sources are scoped to that month's folder.** It previously scanned all of
  `billing-sources/` and took the newest by timestamp, which paired September
  enrollments with August transactions.
- **Matching**: Client Group name, or `First + Last` for individuals
  (blank / `null` / `[Sole Props]` group), normalised and scored. Threshold 0.85.
- **Fallback**: when a Client Group does not match, retry using **every** person
  inside it, and aggregate payments from all matching payers. Groups whose
  members pay under personal names — KWSE, REAL, New Jersey Realtors — were
  otherwise reported as unpaid. This moved missing from 39 to 5.
- **Three actions compete for what is displayed.** Approve pins a file;
  Generate and Reset both clear the pin. Whichever you click last wins. Without
  Generate clearing the pin, a fresh report was written and never seen.
- **Posting an update needs only sign-in; approving needs admin.**

---

## 7. Email ingest

**Context.** Carriers email files to `reminders@gigworkersuniverse.com`.

**Decision.** `reminders@` is an alias on `tech@`, so a **Gmail filter** forwards
to `inbox@mail.gigworkersuniverse.com`, an SES-verified subdomain. SES writes the
raw mail to `email-inbox/`, and `gig-email-ingest` extracts attachments,
classifies by filename, and writes to the matching `carrier=` prefix.

**Consequences.**

- Google Workspace **routing rules match the envelope recipient**, which for an
  alias is rewritten to the primary address. A routing rule on `reminders@`
  never fires. A Gmail *filter* matches the alias correctly.
- The subdomain keeps the main domain's MX on Google Workspace, untouched.
- **A file must have both a recognised carrier and a month/year**, or it is
  quarantined to `email-rejected/` and an SNS alert is sent. This is stricter
  than the manual upload button, deliberately.
- `ALLOWED_SENDERS` **fails closed**: unset means reject everything.
- Sender checking is on the `From:` header, which can be forged. It stops
  accidents, not a determined attacker.

---

## 8. Security posture

| Control | State |
|---|---|
| S3 encryption at rest | SSE-KMS, customer-managed key `549abb55-…` |
| TLS in transit | Bucket policy denies `aws:SecureTransport: false` |
| Versioning | Enabled — this recovered the overwritten August report |
| Public access block | All four settings on |
| CloudTrail | Multi-region, **plus S3 object-level data events** |
| Auth | Google SSO, domain-restricted, all 23 handlers guarded |

**Known gaps, honestly stated.**

- **Long-lived IAM keys.** `dashboard-reader`'s access key sits in Amplify env
  vars and `.env.local`. It has been exposed at least once in a screenshot and
  should be rotated. The Amplify SSR compute role removes the credential entirely.
- **No application-level access audit.** CloudTrail records S3 object reads, but
  not which user viewed which member in the UI.
- **Consultant reports containing PHI are downloaded and emailed to external
  consultants.** That disclosure path has no controls on it.
- **Amplify Hosting's HIPAA eligibility** should be verified against AWS's
  current list rather than assumed.
- **None of this makes the system HIPAA compliant.** Compliance is an
  organisational determination covering risk analysis, training, sanction
  policies, incident response and vendor BAAs. What exists here is a subset of
  the technical safeguards.

---

## 9. Deployment traps

Each of these cost real time. They are listed because they recur.

1. **Staged copies go stale.** Both Python Lambdas build from a subfolder
   (`staging/`, `build/`). Editing the root file and zipping the folder ships
   the old code. Always copy, then verify the copy contains your change.
2. **`Compress-Archive` with a relative `-DestinationPath` inside
   `Push-Location`** writes somewhere unexpected, and `fileb://` then reads a
   different, older zip. Use absolute paths and check `LastWriteTime`.
3. **Amplify env vars need a *new build*.** "Redeploy this version" reuses
   artifacts. `amplify.yml` writes them to `.env.production` so they reach the
   SSR runtime; **every** variable the app reads must be in that grep, and a
   miss fails at runtime rather than build.
4. **`app/favicon.ico` beats `app/icon.png`.** create-next-app ships one.
5. **`overflow: hidden` on an ancestor** breaks `position: sticky` and clips
   absolutely positioned children. Cost several iterations on both the navbar
   and the Move button.
6. **`sheet_to_json({header:1})` returns sparse arrays.** `.map()` preserves
   holes and `.findIndex()` then visits them as `undefined`. Use `defval: ''`.

---

## 10. Environment variables

```
MY_AWS_ACCESS_KEY_ID / MY_AWS_SECRET_ACCESS_KEY / MY_AWS_REGION
S3_RAW_BUCKET                 gig-remittance-raw-prod
CONSULTANT_LAMBDA_NAME        consultant-report-lambda
BILLING_LAMBDA_NAME           reconcile-billing
COGNITO_REGION / COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID / COGNITO_DOMAIN
APP_URL                       https://internaldashboard.gigworkersuniverse.com
ALLOWED_EMAIL_DOMAIN          gigworkersuniverse.com
ADMIN_EMAILS                  andrewc@…, tech@…
BUILD_ID                      written by amplify.yml, drives the update banner
```

Keep in sync with:
`grep -rho "process\.env\.[A-Z_0-9]*" app/ lib/ | sort -u`
