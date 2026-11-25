/**
 * @fileoverview Production-Ready Operational Runners, Trigger Installers, and
 * Google Sheets Custom Menu for all 3 Gemini Decisions API Use Cases.
 *
 * Designed to coexist in the same GAS V8 project alongside:
 *   - decisions_client.js
 *   - usecase3_gmail_flexible_labeling.js  (Use Case 1 in article)
 *   - usecase2_gmail_cascade_router.js     (Use Case 2 in article)
 *   - usecase1_compliance_audit.js         (Use Case 3 in article)
 *
 * Production Entry Points:
 *   - Use Case 1 (Gmail Labeling):   runProductionGmailLabeling() / setupGmailLabelingTrigger(10)
 *   - Use Case 2 (Cascade Router):   runProductionCascadeRouter() / setupCascadeRouterTrigger(10)
 *   - Use Case 3 (Sheets Audit):     onOpen() (Sheets UI menu) / runProductionComplianceAudit()
 *   - Maintenance:                   removeProductionTriggers()
 */

const PRODUCTION_CONFIG = {
  // Use Case 1: Flexible Labeling for Gmail
  LABELING_PREFIX: 'GeminiDecisions',
  LABELING_SEARCH_QUERY: 'in:inbox -label:"GeminiDecisions/Processed" newer_than:7d',
  LABELING_MAX_THREADS: 20,

  // Use Case 2: Gmail Model Cascade Router
  CASCADE_SEARCH_QUERY: 'in:inbox -label:"CascadeRouter/Processed" newer_than:3d',
  CASCADE_MAX_THREADS: 10,
  CASCADE_CREATE_DRAFTS: true,

  // Use Case 3: Google Sheets Compliance Audit (Script Properties keys for standalone mode)
  PROP_AUDIT_PDF_FILE_ID: 'AUDIT_PDF_FILE_ID',
  PROP_AUDIT_SPREADSHEET_ID: 'AUDIT_SPREADSHEET_ID',
  PROP_AUDIT_SHEET_NAME: 'AUDIT_SHEET_NAME',
  DEFAULT_AUDIT_SHEET_NAME: 'ComplianceAudit',

  // Trigger & concurrency guards
  DEFAULT_TRIGGER_INTERVAL_MINUTES: 10,
  VALID_TRIGGER_INTERVALS: [1, 5, 10, 15, 30],
  LOCK_WAIT_MS: 5000,
};

/**
 * Extracts a Google Drive / Google Sheets file ID from either a raw ID or a full Google URL.
 * @param {string} rawInput
 * @return {string}
 */
function extractDriveFileId_(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    throw new Error('Drive file ID or URL is empty.');
  }
  const pathMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]{15,})/);
  if (pathMatch) {
    return pathMatch[1];
  }
  const queryMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{15,})/);
  if (queryMatch) {
    return queryMatch[1];
  }
  if (/^[a-zA-Z0-9_-]{15,}$/.test(trimmed)) {
    return trimmed;
  }
  throw new Error('Could not extract a valid Google Drive file ID from: ' + trimmed);
}

/**
 * Idempotently installs a time-driven minute trigger for a handler function.
 * Removes any existing triggers for the same handler first to prevent duplicates.
 * @param {string} handlerName
 * @param {number=} intervalMinutes One of 1, 5, 10, 15, 30 (default 10).
 * @return {GoogleAppsScript.Script.Trigger}
 */
function installIdempotentMinuteTrigger_(handlerName, intervalMinutes) {
  const mins =
    intervalMinutes === undefined || intervalMinutes === null
      ? PRODUCTION_CONFIG.DEFAULT_TRIGGER_INTERVAL_MINUTES
      : intervalMinutes;
  if (typeof mins !== 'number' || PRODUCTION_CONFIG.VALID_TRIGGER_INTERVALS.indexOf(mins) === -1) {
    throw new Error(
      'Invalid trigger interval: ' +
        mins +
        '. Google Apps Script everyMinutes() accepts only: ' +
        PRODUCTION_CONFIG.VALID_TRIGGER_INTERVALS.join(', ')
    );
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(t);
    }
  });

  const trigger = ScriptApp.newTrigger(handlerName).timeBased().everyMinutes(mins).create();
  console.log('[Trigger Installed] ' + handlerName + ' scheduled every ' + mins + ' minute(s).');
  return trigger;
}

// ============================================================================
// USE CASE 1 (Article): Production Gmail Flexible Labeling
// ============================================================================

/**
 * Zero-argument production runner for Use Case 1 (Flexible Labeling for Gmail).
 * Safe to invoke manually or via a time-driven trigger (protected by ScriptLock).
 * @return {Array<Object>}
 */
function runProductionGmailLabeling() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PRODUCTION_CONFIG.LOCK_WAIT_MS)) {
    console.warn('[Production Labeling] Skipped: another execution is still running.');
    return [];
  }

  try {
    const results = labelGmailWithDecisions({
      searchQuery: PRODUCTION_CONFIG.LABELING_SEARCH_QUERY,
      maxThreads: PRODUCTION_CONFIG.LABELING_MAX_THREADS,
      labelPrefix: PRODUCTION_CONFIG.LABELING_PREFIX,
    });
    const reviewCount = results.filter(function (r) {
      return r.needsReview;
    }).length;
    console.log(
      '[Production Labeling] Processed ' +
        results.length +
        ' thread(s) | NeedsReview: ' +
        reviewCount
    );
    return results;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Installs (or updates) a time-driven trigger for runProductionGmailLabeling().
 * @param {number=} intervalMinutes One of 1, 5, 10, 15, 30 (default 10).
 */
function setupGmailLabelingTrigger(intervalMinutes) {
  return installIdempotentMinuteTrigger_('runProductionGmailLabeling', intervalMinutes);
}

// ============================================================================
// USE CASE 2 (Article): Production Gmail Model Cascade Router
// ============================================================================

/**
 * Zero-argument production runner for Use Case 2 (Gmail Model Cascade Router).
 * Safe to invoke manually or via a time-driven trigger (protected by ScriptLock).
 * @return {Object}
 */
function runProductionCascadeRouter() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PRODUCTION_CONFIG.LOCK_WAIT_MS)) {
    console.warn('[Production Cascade] Skipped: another execution is still running.');
    return { processed: [], createdDrafts: [] };
  }

  try {
    const res = runGmailCascadeRouter({
      searchQuery: PRODUCTION_CONFIG.CASCADE_SEARCH_QUERY,
      maxThreads: PRODUCTION_CONFIG.CASCADE_MAX_THREADS,
      createDrafts: PRODUCTION_CONFIG.CASCADE_CREATE_DRAFTS,
    });
    const escalated = res.processed.filter(function (p) {
      return p.route === 'ESCALATED';
    }).length;
    const fastPath = res.processed.length - escalated;
    console.log(
      '[Production Cascade] Processed ' +
        res.processed.length +
        ' thread(s) | Fast Path: ' +
        fastPath +
        ' | Escalated to gemini-4-hydrogen: ' +
        escalated
    );
    return res;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Installs (or updates) a time-driven trigger for runProductionCascadeRouter().
 * @param {number=} intervalMinutes One of 1, 5, 10, 15, 30 (default 10).
 */
function setupCascadeRouterTrigger(intervalMinutes) {
  return installIdempotentMinuteTrigger_('runProductionCascadeRouter', intervalMinutes);
}

// ============================================================================
// USE CASE 3 (Article): Production Google Sheets Parallel Compliance Audit
// ============================================================================

/**
 * Adds a custom "Gemini Decisions" menu when this script is bound to a Google Spreadsheet.
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Gemini Decisions')
      .addItem('Initialize Audit Sheet Headers', 'initializeComplianceAuditSheet')
      .addItem('Run Compliance Audit on Active Sheet...', 'promptAndRunComplianceAudit')
      .addToUi();
  } catch (err) {
    // Ignore when executed from a standalone script without an active Sheets UI context
    console.warn('[onOpen] Sheets UI not available: ' + err.message);
  }
}

/**
 * Formats Row 1 of the active sheet with the required 4-column compliance audit header.
 */
function initializeComplianceAuditSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const headers = [['Audit Criterion', 'P(Compliant)', 'Confidence', 'Verdict']];
  const headerRange = sheet.getRange(1, 1, 1, 4);
  headerRange.setValues(headers);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#E2E8F0');
  sheet.setFrozenRows(1);
  SpreadsheetApp.flush();
}

/**
 * Interactive Sheets UI runner: Prompts for a Google Drive PDF URL or File ID
 * and evaluates all criteria in Column A (Row 2+) of the active sheet.
 */
function promptAndRunComplianceAudit() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Gemini Decisions Compliance Audit',
    'Paste the Google Drive PDF URL or File ID to audit against Column A (Row 2+):',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  try {
    const fileId = extractDriveFileId_(response.getResponseText());
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getActiveSheet();
    const result = runComplianceAudit(fileId, ss.getId(), sheet.getName());

    let passCount = 0;
    let failCount = 0;
    let reviewCount = 0;
    result.verdicts.forEach(function (v) {
      if (v.verdict === 'PASS') passCount++;
      else if (v.verdict === 'FAIL') failCount++;
      else reviewCount++;
    });

    ui.alert(
      'Compliance Audit Complete',
      'Evaluated ' +
        result.criteriaCount +
        ' criteria in ' +
        result.batches +
        ' pass(es).\n' +
        'PASS: ' +
        passCount +
        ' | FAIL: ' +
        failCount +
        ' | NEEDS_REVIEW: ' +
        reviewCount +
        '\nAPI Latency: ' +
        result.apiLatencyMs +
        ' ms | Sheet Write: ' +
        result.sheetWriteMs +
        ' ms',
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert('Compliance Audit Failed', err.message, ui.ButtonSet.OK);
  }
}

/**
 * Standalone / headless production runner for Use Case 3 (Batch Compliance Audit).
 * Reads AUDIT_PDF_FILE_ID, AUDIT_SPREADSHEET_ID, and optional AUDIT_SHEET_NAME
 * from Script Properties (accepts either raw Drive IDs or full Google Drive/Sheets URLs).
 * @return {Object}
 */
function runProductionComplianceAudit() {
  const props = PropertiesService.getScriptProperties();
  const rawPdf = props.getProperty(PRODUCTION_CONFIG.PROP_AUDIT_PDF_FILE_ID);
  const rawSheet = props.getProperty(PRODUCTION_CONFIG.PROP_AUDIT_SPREADSHEET_ID);
  const sheetName =
    props.getProperty(PRODUCTION_CONFIG.PROP_AUDIT_SHEET_NAME) ||
    PRODUCTION_CONFIG.DEFAULT_AUDIT_SHEET_NAME;

  if (!rawPdf || !rawSheet) {
    throw new Error(
      'Missing Script Properties: set ' +
        PRODUCTION_CONFIG.PROP_AUDIT_PDF_FILE_ID +
        ' and ' +
        PRODUCTION_CONFIG.PROP_AUDIT_SPREADSHEET_ID +
        ' in Project Settings -> Script Properties.'
    );
  }

  const pdfFileId = extractDriveFileId_(rawPdf);
  const spreadsheetId = extractDriveFileId_(rawSheet);
  const result = runComplianceAudit(pdfFileId, spreadsheetId, sheetName);

  console.log(
    '[Production Audit] Criteria: ' +
      result.criteriaCount +
      ' | Batches: ' +
      result.batches +
      ' | API: ' +
      result.apiLatencyMs +
      ' ms | Sheet Write: ' +
      result.sheetWriteMs +
      ' ms | Input Tokens: ' +
      (result.inputTokens !== null ? result.inputTokens : 'N/A')
  );
  return result;
}

// ============================================================================
// Maintenance Helper
// ============================================================================

/**
 * Removes all time-driven triggers installed by setupGmailLabelingTrigger()
 * and setupCascadeRouterTrigger().
 */
function removeProductionTriggers() {
  const targets = {
    runProductionGmailLabeling: true,
    runProductionCascadeRouter: true,
  };
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (targets[t.getHandlerFunction()]) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  console.log('[Triggers Removed] Deleted ' + removed + ' production trigger(s).');
  return removed;
}
