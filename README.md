# Gemini Decisions API (`gemini-decision-1`) for Google Apps Script

![Zero-Output-Token AI in Google Apps Script with Gemini Decisions API](images/hero_banner.png)

> **Companion Article**
>
> - **DEV.to**: [Zero-Output-Token AI in Google Apps Script with Gemini Decisions API](https://dev.to/gde/zero-output-token-ai-in-google-apps-script-with-gemini-decisions-api-2maj)
> - **Medium (Google Cloud - Community)**: [https://medium.com/google-cloud/zero-output-token-ai-in-google-apps-script-with-gemini-decisions-api-839c5a384fe1](https://medium.com/google-cloud/zero-output-token-ai-in-google-apps-script-with-gemini-decisions-api-839c5a384fe1)

Three self-contained, zero-dependency **[Google Apps Script (GAS)](https://workspace.google.com/products/apps-script/)** applications and a fair 4-method Gmail labeling latency benchmark demonstrating the **[Gemini Decisions API](https://aistudio.google.com/docs/decisions-api) (`gemini-decision-1`)** alongside **`gemini-3.8-flash`** and **`gemini-4-hydrogen`**.

All scripts in `src/` are statically verified for Google Apps Script V8 syntax (`node --check`) and are designed for direct copy-paste execution inside the Google Apps Script web editor with zero external dependencies.

---

## 1. Why Gemini Decisions API in Google Apps Script?

As described on the official [Google Apps Script](https://workspace.google.com/products/apps-script/) site, Apps Script is the only low-code platform that makes it quick and easy to integrate, automate, and extend Google Workspace—available to anyone with a Gmail account. Because GAS offers native affinity and fine-grained control across Gmail, Google Sheets, Google Drive, Docs, and Forms (via time-driven triggers, `onEdit`/`onFormSubmit` event triggers, and custom spreadsheet functions), pairing it with sub-second AI unlocks broad, low-cost Workspace automation.

Traditional autoregressive LLMs (`generateContent`) generate text or JSON one token at a time, which quickly runs into GAS's strict **[6-minute (360-second) hard execution limit](https://developers.google.com/apps-script/guides/services/quotas)** while accumulating output token charges and fragile parsing overhead. The **[Gemini Decisions API](https://aistudio.google.com/docs/decisions-api) (`POST https://generativelanguage.googleapis.com/v1beta/decisions`, model `gemini-decision-1`)** replaces text generation with a single forward-pass evaluation engine:

- **Mitigating GAS's 6-Minute Execution Limit**: Evaluates up to **1,000 independent questions** against a single shared multimodal input in one forward pass (documented server-side forward-pass latency ~150–250 ms in the [official documentation](https://aistudio.google.com/docs/decisions-api); actual end-to-end GAS `UrlFetchApp` RTT is measured directly in the included benchmark).
- **Zero Output Token Billing**: Output tokens are strictly `0` (`totalOutputTokens: 0`). Sending a large Drive PDF or email + attachment once as `input` incurs input token billing only once ($0.10 / 1M input tokens, $0.00 output tokens as of 2026-11-23).
- **Calibrated Probabilities & Zero JSON Parse Failures**: Directly returns calibrated probabilities (`0.01`–`0.99`) and `confidence` scores across `noul` (Yes/No), `choice` (2–255 classes), and `score` (ordinal rubric) modes—enabling deterministic confidence thresholds (e.g., auto-apply at `>= 0.85`, route to `NeedsReview` or `gemini-4-hydrogen` at `< 0.85`).
- **Native Multimodal Ingestion**: Accepts Drive PDFs, Gmail attachments, and images directly inside `input` blocks without OCR or pre-extraction pipelines.

---

## 2. Evolution of Flexible Labeling for Gmail in GAS (Part 1 to Part 4)

Use Case 3 directly extends three previously published Medium articles by Kanshi Tanaike:

- **Part 1 (Dec 19, 2023)**: [Flexible Labeling for Gmail using Gemini Pro API with Google Apps Script](https://medium.com/google-cloud/flexible-labeling-for-gmail-using-gemini-pro-api-with-google-apps-script-5bf2ee7c9f52) — Prompt-based free-text generation mapped via `labelObj`.
- **Part 2 (Jan 30, 2024)**: [Flexible Labeling for Gmail using Gemini Pro API with Google Apps Script Part 2](https://medium.com/google-cloud/flexible-labeling-for-gmail-using-gemini-pro-api-with-google-apps-script-part-2-08015af6b2e6) — Semantic Search (Gemini Corpora) and Function Calling.
- **Part 3 (Sep 19, 2024)**: [Flexible Labeling for Gmail using Gemini API with Google Apps Script Part 3](https://medium.com/google-cloud/flexible-labeling-for-gmail-using-gemini-api-with-google-apps-script-part-3-414a62749e65) — JSON Schema / Structured Outputs (`responseMimeType: "application/json"`) with batching.
- **Part 4 (Nov 2026 — This Repository)**: Gemini Decisions API (`gemini-decision-1`) with zero output tokens, single-pass multi-axis evaluation (`choice` + `noul` + `score`), calibrated confidence gating (`NeedsReview`), and native multimodal attachment ingestion.

### Table 1: Architectural Comparison Across Gmail Labeling Approaches in GAS

| Dimension                        | Part 1 (Prompt Free-Text)                       | Part 2 (Function Calling)                        | Part 3 (JSON Schema)                                      | Part 4 (Gemini Decisions API)                                    |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------- |
| **API Endpoint & Model**         | `generateContent` (`gemini-3.8-flash` baseline) | `generateContent` + `tools` (`gemini-3.8-flash`) | `generateContent` + `responseSchema` (`gemini-3.8-flash`) | `v1beta/decisions` (`gemini-decision-1`)                         |
| **Output Generation**            | Autoregressive free text                        | Autoregressive tool-call JSON                    | Autoregressive JSON tokens                                | **Single forward pass (0 output tokens)**                        |
| **Output Token Billing**         | Paid (output + thinking)                        | Paid (output + thinking)                         | Paid (output + thinking)                                  | **$0.00 (strictly 0 output tokens)**                             |
| **Multi-Axis 1-Pass Labeling**   | Fragile regex parsing                           | Single tool schema                               | Single JSON object                                        | **Native parallel `choice` + `noul` + `score` (up to 1,000 Qs)** |
| **Calibrated Confidence Gate**   | None                                            | None                                             | None                                                      | **Native `0.01`–`0.99` calibrated probability & `confidence`**   |
| **JSON / Format Parse Failures** | Possible (prose drift)                          | Low                                              | Very low                                                  | **Zero (structured probability map)**                            |
| **Multimodal Attachments**       | Supported via `inlineData`                      | Supported via `inlineData`                       | Supported via `inlineData`                                | **Native typed `document` / `image` blocks**                     |
| **GAS 6-Min Limit Resilience**   | Low–Medium                                      | Low–Medium                                       | Medium                                                    | **High (sub-second forward pass)**                               |

---

## 3. Repository Structure & 3-Axis Use Case Overview

All six `.js` files in `src/` share a single clean global namespace (`GEMINI_DECISIONS_CONFIG`, `PRODUCTION_CONFIG`, and `UC1_`/`UC2_`/`UC3_`/`UC3B_` prefixes) so they can be pasted together into one GAS project without collisions.

| File                                      | Role                                                                                                                                                                                                  | Entry Points                                                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/decisions_client.js`                 | Shared zero-dependency GAS client (`v1beta/decisions` & `generateContent`), `x-goog-api-key` auth, 429/5xx backoff, 35 MB inline guard, MIME whitelist, cleanup & stats utilities                     | Internal helpers (`*_`)                                                                                                                                                                                             |
| `src/usecase1_compliance_audit.js`        | **Use Case 1 (Horizontal Scale)**: 1 Drive PDF shared input x up to 1,000 parallel compliance criteria on Google Sheets (`setValues` + `setBackgrounds`)                                              | `runComplianceAudit(...)`<br>`testUseCase1ComplianceAudit()`                                                                                                                                                        |
| `src/usecase2_gmail_cascade_router.js`    | **Use Case 2 (Vertical Escalation)**: System 1 (`gemini-decision-1`) fast triage -> conditional escalation to System 2 (`gemini-4-hydrogen`, `thinkingLevel: "HIGH"`)                                 | `runGmailCascadeRouter(...)`<br>`testUseCase2GmailCascadeRouter()`                                                                                                                                                  |
| `src/usecase3_gmail_flexible_labeling.js` | **Use Case 3 (Production)**: Trigger-ready multi-axis Gmail labeling (`choice` + `noul` + `score` + `0.85` `NeedsReview` gate) with label caching                                                     | `labelGmailWithDecisions(...)`                                                                                                                                                                                      |
| `src/usecase3_gmail_benchmark.js`         | **Use Case 3 (Benchmark)**: One-shot fair 4-method latency, accuracy, Macro-F1, and cost benchmark (warm-up + Latin-square interleaving + SHA-256 provenance)                                         | `testUseCase3GmailBenchmark()`                                                                                                                                                                                      |
| `src/production_runners.js`               | **Production Operations**: Zero-argument `LockService`-guarded trigger runners, idempotent minute-trigger installers, Sheets custom UI menu (`onOpen`), and Script Properties standalone audit runner | `runProductionGmailLabeling()`<br>`setupGmailLabelingTrigger()`<br>`runProductionCascadeRouter()`<br>`setupCascadeRouterTrigger()`<br>`onOpen()` / `runProductionComplianceAudit()`<br>`removeProductionTriggers()` |
| `src/appsscript.json`                     | V8 manifest with explicit minimal OAuth scopes (incl. `script.scriptapp` for programmatic triggers)                                                                                                   | Manifest                                                                                                                                                                                                            |

### Why `appsscript.json` Uses `drive` Instead of `drive.file`

In Google Apps Script, `https://www.googleapis.com/auth/drive.file` only grants access to files created by the script itself and throws `Access denied: DriveApp` when `runComplianceAudit(fileId, ...)` opens a pre-existing PDF in Google Drive. Therefore `src/appsscript.json` declares `https://www.googleapis.com/auth/drive` alongside `https://www.googleapis.com/auth/userinfo.email` (required for `Session.getActiveUser().getEmail()`) and `https://www.googleapis.com/auth/script.send_mail` (required for `MailApp.getRemainingDailyQuota()` pre-flight checks in self-send Gmail tests).

---

## 4. Manual Setup & One-Shot Testing Procedures (GAS Web Editor)

### Step 1: Create a GAS Project & Paste Files

1. Open [script.google.com](https://script.google.com) and click **New project**.
2. In the left sidebar, click **Project Settings** (gear icon) and check **Show "appsscript.json" manifest file in editor**.
3. Return to the **Editor**, open `appsscript.json`, and replace its contents with `src/appsscript.json`.
4. Create six `.gs` script files in the editor (clicking **+** -> **Script**) and paste the exact contents of:
   - `src/decisions_client.js` -> `decisions_client.gs`
   - `src/usecase1_compliance_audit.js` -> `usecase1_compliance_audit.gs`
   - `src/usecase2_gmail_cascade_router.js` -> `usecase2_gmail_cascade_router.gs`
   - `src/usecase3_gmail_flexible_labeling.js` -> `usecase3_gmail_flexible_labeling.gs`
   - `src/usecase3_gmail_benchmark.js` -> `usecase3_gmail_benchmark.gs`
   - `src/production_runners.js` -> `production_runners.gs`
5. Click **Save** (`Ctrl+S` / `Cmd+S`).

### Step 2: Configure `GEMINI_API_KEY`

1. Obtain an API key from [Google AI Studio](https://aistudio.google.com/).
2. In the GAS editor, open **Project Settings** -> scroll to **Script Properties** -> click **Add script property**.
3. Set Property: `GEMINI_API_KEY`, Value: your API key, then click **Save script properties**.

### Step 3: Authorize OAuth Scopes (First Run Only)

1. Select any one-shot test function from the top toolbar dropdown and click **Run**.
2. When the Google OAuth consent dialog appears, click **Review permissions** -> select your Google account -> click **Advanced** -> **Go to \<Project Name\> (unsafe)** -> **Allow**.

### Step 4: Execute the One-Shot Test Functions

Each Use Case is tested by running **one function** in the GAS editor toolbar. Inspect the results in **Execution log** (`View -> Execution log`) or open the persistent Markdown + JSON log file automatically saved to Google Drive under **`GeminiDecisionsTestLogs/`** (the direct Google Drive URL is printed at the end of each run for easy sharing).

- **Test Use Case 1 (`testUseCase1ComplianceAudit`)**:
  - Creates a temporary sample compliance PDF and temporary Google Sheet (25 criteria by default), runs `runComplianceAudit()`, logs API latency, Sheets write latency, verdict agreement, and token savings, saves `GeminiDecisionsTestLogs/UC1_ComplianceAudit_Log_<runId>.md`, then moves both temporary Drive files to **Trash** in a `finally` block.
- **Test Use Case 2 (`testUseCase2GmailCascadeRouter`)**:
  - Creates temporary `UC2Cascade_<runId>/*` labels, sends 3 test emails (routine, complex with PDF attachment, ambiguous) to your own Gmail, polls Inbox until delivered, runs the cascade router (`gemini-decision-1` -> `gemini-4-hydrogen` on complex/low-confidence threads), logs Fast Path vs. Escalated routing metrics, saves `GeminiDecisionsTestLogs/UC2_CascadeRouter_Log_<runId>.md`, then deletes temporary drafts, moves test threads to **Trash**, and deletes temporary labels (deepest-first) in `finally`.
- **Test Use Case 3 (`testUseCase3GmailBenchmark`)**:
  - Creates temporary `GeminiBench_<runId>/*` labels, sends 6 ground-truth annotated emails (including a PDF invoice attachment and an ambiguous edge case) to your own Gmail, polls Inbox, runs 1 warm-up call per endpoint, evaluates all 4 methods in interleaved Latin-square order (`UC3B_REPEATS = 2`), verifies live Gmail label application, outputs the **Reproducibility Metadata Block**, copy-paste-ready **Markdown Table 2**, **Per-Trial Raw Breakdown**, and full machine-readable JSON to both Execution log and Google Drive (`GeminiDecisionsTestLogs/UC3_GmailBenchmark_Log_<runId>.md` + `UC3_GmailBenchmark_Log_<runId>.json`), then moves all test threads to **Trash** and deletes all temporary labels in `finally`.

> **Timeout & Cleanup Note**: Every test enforces a 4.5-minute soft wall-clock deadline (`SOFT_DEADLINE_MS = 270000`) so `finally` cleanup always executes before GAS's 6-minute hard kill. If you switch `UC3B_BASELINE_MODEL` in `usecase3_gmail_benchmark.js` from `gemini-3.8-flash` to `gemini-4-hydrogen`, reduce `UC3B_REPEATS` from `2` to `1` to stay comfortably within the 6-minute budget. Note that Google Drive and Gmail move trashed files/threads to **Trash** (auto-purged after 30 days), while temporary drafts and Gmail labels are deleted immediately.

---

## 5. Live GAS Execution Results (Measured on 2026-11-23)

All three one-shot test functions were executed live inside the Google Apps Script V8 web editor (`2026-11-23 UTC`).

### Use Case 1: Batch Compliance Audit

- **Workflow**: Reads all checklist criteria from **Column A (`A2:A`)** of Google Sheets, loads the target **Google Drive PDF once** as a shared `document` input, evaluates all rows in a single `gemini-decision-1` forward pass (`noul` probabilities returned directly by the API), and writes Columns B–D (`P(Compliant)`, `Confidence`, `Verdict` + conditional colors) in two batched Sheets RPCs (`setValues` + `setBackgrounds`).
- **Scale & Latency**: 25 criteria evaluated in **1 forward pass** against a Drive PDF in **687 ms** API round-trip latency + **130 ms** Sheets batch write = **817 ms** core audit (`6,455 ms` total wall-clock including temporary PDF/Sheet creation and cleanup).
- **Token & Cost Efficiency**: **2,440** shared input tokens (vs. **61,000** equivalent sequential 1-per-call input tokens — **96.0% reduction**), **0** output tokens, estimated cost **$0.000244**.
- **Verdicts & Calibration**: `PASS=9`, `FAIL=14`, `NEEDS_REVIEW=2`, with **20/22 (90.9%)** clear ground-truth agreement and zero false-certainty errors. Both `NEEDS_REVIEW` cases were legitimately nuanced wording matches (`q_0003`: 48h policy vs. 72h criterion, `P=0.3370`; `q_0010`: written opt-in vs. default exclusion, `P=0.8101`), safely routed to human review below the `0.85` confidence threshold.

### Use Case 2: Gmail Model Cascade Router

- **Routing Assertions**: **3/3 PASSED (100%)** across `29,067 ms` total wall-clock (including self-send & inbox polling).
- **Fast Path (`routine_inquiry`)**: Routed by `gemini-decision-1` (`conf=1.00`, `complexityScore=1.13`) in **357 ms** with **0 ms / 0 calls** to `gemini-4-hydrogen`.
- **Escalation Path (`gemini-4-hydrogen`, `thinkingLevel=HIGH`)**: Both the complex PDF incident (`conf=0.63`, `score=3.70`, Decisions **601 ms** -> Reasoning **9,821 ms**) and the ambiguous follow-up (`conf=0.55`, `score=2.59`, Decisions **403 ms** -> Reasoning **9,631 ms**) escalated accurately—demonstrating ~27x lower latency on Fast Path threads.

### Use Case 3: 4-Method Gmail Labeling Benchmark

- **Baseline Model Rationale**: Methods 1–3 are standardized on **`gemini-3.8-flash`** (`thinkingLevel: "LOW"`, `temperature: 0.0`) because the original Part 1–3 models (`gemini-pro`, `gemini-1.5-flash`) are deprecated and `gemini-3.8-flash` is the current fast, low-cost Flash-tier model used for high-frequency GAS classification—isolating architectural differences from model-generation differences.
- **Reproducibility Provenance**: `N=6` emails, `R=2` repeats (48 total API trials), 1 discarded warm-up/endpoint, interleaved Latin-square order, Corpus SHA-256 `21d71caeefee64724dd28435f14323826885756c6a751b04e953d6cb56a278b4`, Post-benchmark live Gmail label apply total: **3,750 ms** (6 threads).

| Method                                                      | Median (IQR) ms | Mean +/- SD ms  | p95 ms  | Paired Speedup vs M4 | Avg Input Tok | Avg Output Tok | Avg Think Tok | Est. Cost / 1k Emails | Cat Acc / Macro-F1 | Multi-Label F1 | Parse/HTTP Fails | Ambiguous NeedsReview    |
| ----------------------------------------------------------- | --------------- | --------------- | ------- | -------------------- | ------------- | -------------- | ------------- | --------------------- | ------------------ | -------------- | ---------------- | ------------------------ |
| Method 1 (Part 1: Free-Text, `gemini-3.8-flash` LOW)        | 2266 (1533)     | 2370 +/- 973    | 3771    | 6.30x                | 427           | 18             | 149           | $0.9466               | 100.0% / 1.00      | 1.00           | 0/12             | N/A (no calibrated conf) |
| Method 2 (Part 2: Function Calling, `gemini-3.8-flash` LOW) | 3259 (1572)     | 3231 +/- 1019   | 4550    | 10.33x               | 502           | 32             | 188           | $1.2009               | 100.0% / 1.00      | 1.00           | 0/12             | N/A (no calibrated conf) |
| Method 3 (Part 3: JSON Schema, `gemini-3.8-flash` LOW)      | 2276 (1148)     | 2390 +/- 885    | 3832    | 6.29x                | 380           | 19             | 109           | $0.7664               | 100.0% / 1.00      | 1.00           | 0/12             | N/A (no calibrated conf) |
| **Method 4 (Part 4: Decisions API, `gemini-decision-1`)**   | **305 (168)**   | **354 +/- 137** | **566** | **1.00x**            | **595**       | **0**          | **0**         | **$0.0595**           | **100.0% / 1.00**  | **1.00**       | **0/12**         | **2/2 (`conf=0.61`)**    |

---

## 6. Production Deployment Runbook (`src/production_runners.js`)

Once you have verified the one-shot tests, `src/production_runners.js` provides turnkey, `LockService`-guarded production entry points for all three Use Cases (configurable via `PRODUCTION_CONFIG` at the top of the file):

### Operating Gmail Flexible Labeling (Scheduled Automation)

1. _(Optional)_ Edit `PRODUCTION_CONFIG.LABELING_SEARCH_QUERY`, `LABELING_PREFIX`, or `LABELING_MAX_THREADS` in `production_runners.gs`.
2. Select **`setupGmailLabelingTrigger`** from the GAS editor toolbar and click **Run** once. This idempotently schedules `runProductionGmailLabeling()` every 10 minutes (passing `1`, `5`, `10`, `15`, or `30` is supported) with `LockService` concurrency protection.
3. To execute a single manual pass on your live inbox without installing a trigger, run **`runProductionGmailLabeling`**.

### Operating Gmail Model Cascade Router (Scheduled Automation)

1. _(Optional)_ Edit `PRODUCTION_CONFIG.CASCADE_SEARCH_QUERY`, `CASCADE_MAX_THREADS`, or `CASCADE_CREATE_DRAFTS` (`true`/`false`) in `production_runners.gs`.
2. Select **`setupCascadeRouterTrigger`** and click **Run** once to schedule `runProductionCascadeRouter()` every 10 minutes. Routine emails take the sub-second Fast Path (`CascadeRouter/FastPath`); complex or low-confidence emails escalate to `gemini-4-hydrogen` (`CascadeRouter/Escalated`) and save a reply draft.
3. To execute a single manual pass, run **`runProductionCascadeRouter`**.

### Operating 1,000-Item Parallel Compliance Audit in Google Sheets

- **Option A — Interactive Google Sheets Custom Menu (Recommended for Spreadsheet Users)**:
  1. Open your target Google Spreadsheet -> **Extensions -> Apps Script**, paste the six `.js` files + `appsscript.json`, and configure `GEMINI_API_KEY`.
  2. Reload the Google Spreadsheet; a **Gemini Decisions** menu appears automatically via `onOpen()`.
  3. Click **Gemini Decisions -> Initialize Audit Sheet Headers**, paste your checklist criteria into Column A (Row 2+), then click **Gemini Decisions -> Run Compliance Audit on Active Sheet...** and paste either a Google Drive PDF URL or File ID.
- **Option B — Standalone / Headless Execution**:
  1. In **Project Settings -> Script Properties**, set `AUDIT_PDF_FILE_ID` (Drive URL or File ID), `AUDIT_SPREADSHEET_ID` (Sheets URL or File ID), and optionally `AUDIT_SHEET_NAME` (defaults to `ComplianceAudit`).
  2. Run **`runProductionComplianceAudit`** manually or attach it to a daily/weekly time-driven trigger.

### Stopping All Production Triggers

- Select **`removeProductionTriggers`** from the GAS editor toolbar and click **Run** to cleanly delete all triggers created by `setupGmailLabelingTrigger()` and `setupCascadeRouterTrigger()`.

### Advanced Extensions

- **[GASADK](https://github.com/tanaikech/adk-gas) Planner-Executor-Synthesizer Routing**: Use `gemini-decision-1` as the low-latency routing gate inside multi-agent GAS workflows to select tools or sub-planners before invoking reasoning models.
- **[MCPApp](https://github.com/tanaikech/MCPApp) / [A2AApp](https://github.com/tanaikech/A2AApp) Security Guardrails**: Run `noul` policy-compliance checks on incoming tool payloads and outgoing agent actions in a single pass with zero output token overhead.
- **Google Forms Real-Time Attachment Validation**: Trigger `onFormSubmit` to evaluate uploaded PDF receipts or ID scans directly via `buildMultimodalDecisionInput_()` and flag low-confidence submissions for human verification.

---

## 7. References

- **Companion Article (DEV.to)**: [Zero-Output-Token AI in Google Apps Script with Gemini Decisions API](https://dev.to/gde/zero-output-token-ai-in-google-apps-script-with-gemini-decisions-api-2maj)
- **Google Apps Script Official Product Page**: [https://workspace.google.com/products/apps-script/](https://workspace.google.com/products/apps-script/)
- **Quotas for Google Services (Google Apps Script)**: [https://developers.google.com/apps-script/guides/services/quotas](https://developers.google.com/apps-script/guides/services/quotas)
- **Gemini Decisions API Official Documentation**: [https://aistudio.google.com/docs/decisions-api](https://aistudio.google.com/docs/decisions-api)
- **Gemini API Pricing & Documentation**: [https://ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing) (verified November 23, 2026)

---

## 8. Version History

- **v1.0.0** (2026-11-25): Initial release.
