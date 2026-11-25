/**
 * @fileoverview Use Case 1 — High-Speed 1,000-Item Batch Compliance Audit on Google Sheets
 * (Horizontal Scale: 1 Shared Drive PDF Input x up to 1,000 Parallel Criteria per Forward Pass).
 *
 * Production entry point: runComplianceAudit(fileId, spreadsheetId, sheetName)
 * One-shot manual test:   testUseCase1ComplianceAudit()
 */

const UC1_CONFIDENCE_THRESHOLD = 0.85;
const UC1_PASS_PROBABILITY_THRESHOLD = 0.50;
const UC1_TEST_CRITERIA_COUNT = 25; // Configurable up to 1,000+ (auto-chunked in batches of 1,000)

const UC1_COLORS = {
  PASS: '#E6F4EA',
  FAIL: '#FCE8E6',
  REVIEW: '#FEF7E0',
};

/**
 * Production function: Evaluates compliance audit criteria in Column A of a Google Sheet
 * against a single Drive PDF/document shared input in 1,000-question parallel batches.
 *
 * Sheet layout:
 * - Row 1: Headers (Criterion | P(Compliant) | Confidence | Verdict)
 * - Row 2+: Column A contains one compliance criterion per row.
 *
 * @param {string} fileId Google Drive File ID of the PDF/text policy document.
 * @param {string} spreadsheetId Target Google Spreadsheet ID.
 * @param {string=} sheetName Optional sheet name (defaults to first sheet).
 * @return {{ criteriaCount: number, batches: number, apiLatencyMs: number, sheetWriteMs: number, inputTokens: (number|null), verdicts: Array<Object> }}
 */
function runComplianceAudit(fileId, spreadsheetId, sheetName) {
  const startMs = Date.now();
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getSheets()[0];
  if (!sheet) {
    throw new Error('Sheet not found: ' + sheetName);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('No compliance criteria found in Column A (Row 2+).');
  }

  const criteriaRows = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const indexedCriteria = [];
  criteriaRows.forEach(function (r, rowOffset) {
    const text = String(r[0] || '').trim();
    if (text.length > 0) {
      indexedCriteria.push({ rowOffset: rowOffset, text: text });
    }
  });

  if (indexedCriteria.length === 0) {
    throw new Error('Column A contains no non-empty compliance criteria.');
  }

  // Load Drive file once as Shared Input
  const file = DriveApp.getFileById(fileId);
  const blob = file.getBlob();
  const mimeType = String(blob.getContentType() || '').split(';')[0].trim().toLowerCase();
  if (GEMINI_DECISIONS_CONFIG.ALLOWED_ATTACHMENT_MIMES.indexOf(mimeType) === -1) {
    throw new Error(
      'Unsupported Drive file MIME type "' +
        mimeType +
        '". Allowed types: ' +
        GEMINI_DECISIONS_CONFIG.ALLOWED_ATTACHMENT_MIMES.join(', ')
    );
  }
  const bytes = blob.getBytes();
  if (bytes.length > GEMINI_DECISIONS_CONFIG.MAX_INLINE_BYTES) {
    throw new Error(
      'Drive file exceeds 35 MB UrlFetchApp inline Base64 guard (' + bytes.length + ' bytes).'
    );
  }

  const sharedInput = buildMultimodalDecisionInput_(
    'Evaluate the attached corporate compliance document strictly against each audit criterion.',
    [
      {
        name: file.getName(),
        mimeType: mimeType,
        base64Data: Utilities.base64Encode(bytes),
        bytesLength: bytes.length,
      },
    ]
  );

  // Chunk criteria into batches of up to 1,000 questions while preserving exact row alignment
  const batchSize = GEMINI_DECISIONS_CONFIG.MAX_QUESTIONS_PER_BATCH;
  const totalBatches = Math.ceil(indexedCriteria.length / batchSize);
  const verdicts = [];
  const valuesMatrix = criteriaRows.map(function () {
    return ['', '', ''];
  });
  const bgMatrix = criteriaRows.map(function () {
    return ['#FFFFFF', '#FFFFFF', '#FFFFFF'];
  });
  let totalApiLatencyMs = 0;
  let totalInputTokens = 0;
  let hasTokenCount = false;

  for (let b = 0; b < totalBatches; b++) {
    assertTimeBudget_(startMs, GEMINI_DECISIONS_CONFIG.SOFT_DEADLINE_MS, 'UC1 batch ' + (b + 1));
    const sliceStart = b * batchSize;
    const chunk = indexedCriteria.slice(sliceStart, sliceStart + batchSize);
    const questions = {};

    chunk.forEach(function (entry, idx) {
      const qKey = 'q_' + String(sliceStart + idx + 1).padStart(4, '0');
      questions[qKey] = {
        type: 'noul',
        instructions: 'Does the document explicitly satisfy this compliance requirement? Criterion: ' + entry.text,
      };
    });

    const response = callGeminiDecisionsApi_(sharedInput, questions);
    totalApiLatencyMs += response.apiLatencyMs;
    if (response.usage.inputTokens !== null) {
      totalInputTokens += response.usage.inputTokens;
      hasTokenCount = true;
    }

    chunk.forEach(function (entry, idx) {
      const qKey = 'q_' + String(sliceStart + idx + 1).padStart(4, '0');
      const ans = response.answers[qKey] || {};
      const prob = ans.noul !== null ? ans.noul : 0.5;
      const conf = ans.confidence !== null ? ans.confidence : Math.max(prob, 1 - prob);

      let verdict = 'NEEDS_REVIEW';
      let bgColor = UC1_COLORS.REVIEW;
      if (conf >= UC1_CONFIDENCE_THRESHOLD) {
        if (prob >= UC1_PASS_PROBABILITY_THRESHOLD) {
          verdict = 'PASS';
          bgColor = UC1_COLORS.PASS;
        } else {
          verdict = 'FAIL';
          bgColor = UC1_COLORS.FAIL;
        }
      }

      verdicts.push({ qKey: qKey, criterion: entry.text, probability: prob, confidence: conf, verdict: verdict });
      valuesMatrix[entry.rowOffset] = [Number(prob.toFixed(4)), Number(conf.toFixed(4)), verdict];
      bgMatrix[entry.rowOffset] = [bgColor, bgColor, bgColor];
    });
  }

  // Single batch write for values and highlighting
  const tWrite0 = Date.now();
  const outRange = sheet.getRange(2, 2, valuesMatrix.length, 3);
  outRange.setValues(valuesMatrix);
  outRange.setBackgrounds(bgMatrix);
  SpreadsheetApp.flush();
  const sheetWriteMs = Date.now() - tWrite0;

  return {
    criteriaCount: indexedCriteria.length,
    batches: totalBatches,
    apiLatencyMs: totalApiLatencyMs,
    sheetWriteMs: sheetWriteMs,
    inputTokens: hasTokenCount ? totalInputTokens : null,
    verdicts: verdicts,
  };
}

/**
 * Generates deterministic sample policy HTML -> PDF blob and ground-truth criteria for UC1 testing.
 * @param {number} count
 * @return {{ pdfBlob: GoogleAppsScript.Base.Blob, criteria: Array<{ text: string, expected: string }> }}
 */
function uc1BuildSampleFixtures_(count) {
  const policyHtml =
    '<html><body style="font-family:sans-serif;">' +
    '<h1>Acme Cloud Services — Master Data Processing & Security Policy (v2.4)</h1>' +
    '<p>1. Encryption: All customer data is encrypted in transit via TLS 1.3 and at rest via AES-256.</p>' +
    '<p>2. Breach Notification: Security incidents impacting customer PII are reported within 48 hours.</p>' +
    '<p>3. Data Retention: Production logs are retained for 90 days and permanently purged afterward.</p>' +
    '<p>4. Access Control: Role-Based Access Control (RBAC) and hardware MFA are mandatory for all engineers.</p>' +
    '<p>5. Subprocessors: A 30-day advance written notice is provided before onboarding new subprocessors.</p>' +
    '<p>6. Backups: Automated encrypted daily backups are replicated across two geographic regions.</p>' +
    '<p>7. Vulnerability Scanning: Weekly automated SAST/DAST scans and annual third-party penetration tests are performed.</p>' +
    '<p>8. Audit Rights: Enterprise customers may request SOC 2 Type II reports once per calendar year.</p>' +
    '<p>9. Governing Law: This agreement is governed by the laws of the State of California.</p>' +
    '<p>10. AI Training: Customer data is never used to train foundation models without explicit written opt-in.</p>' +
    '<p>11. Service Continuity: Disaster recovery objectives are reviewed periodically as business needs evolve.</p>' +
    '</body></html>';

  const pdfBlob = Utilities.newBlob(policyHtml, 'text/html', 'uc1_sample_policy.html')
    .getAs('application/pdf')
    .setName('uc1_sample_policy.pdf');

  const baseCriteria = [
    { text: 'Data at rest is encrypted using AES-256.', expected: 'PASS' },
    { text: 'Data in transit uses TLS 1.3 encryption.', expected: 'PASS' },
    { text: 'Customer PII breach notifications are issued within 72 hours.', expected: 'PASS' },
    { text: 'Production logs are purged after 90 days.', expected: 'PASS' },
    { text: 'Hardware MFA is required for engineering personnel.', expected: 'PASS' },
    { text: 'At least 30 days advance notice is given for new subprocessors.', expected: 'PASS' },
    { text: 'Daily backups are replicated across multiple regions.', expected: 'PASS' },
    { text: 'Third-party penetration tests are conducted at least annually.', expected: 'PASS' },
    { text: 'SOC 2 Type II reports are available to enterprise customers.', expected: 'PASS' },
    { text: 'Customer data is excluded from AI model training by default.', expected: 'PASS' },
    { text: 'The policy guarantees ISO 27001 certification.', expected: 'FAIL' },
    { text: 'The policy specifies HIPAA Business Associate Agreement terms.', expected: 'FAIL' },
    { text: 'Data residency is strictly guaranteed within the European Union.', expected: 'FAIL' },
    { text: 'Customer-managed encryption keys (CMEK) are explicitly offered.', expected: 'FAIL' },
    { text: 'A 99.999% uptime SLA with financial service credits is committed.', expected: 'FAIL' },
    { text: 'The vendor commits to a 4-hour Recovery Time Objective (RTO).', expected: 'FAIL' },
    { text: 'Physical datacenter biometric access controls are documented.', expected: 'FAIL' },
    { text: 'Liability is capped at 12 months of fees paid.', expected: 'FAIL' },
    { text: 'Right-to-audit includes on-site physical facility inspections.', expected: 'FAIL' },
    { text: 'Background checks are required for all vendor employees.', expected: 'FAIL' },
    { text: 'The disaster recovery SLA satisfies strict financial-sector RTO targets.', expected: 'BORDERLINE' },
    { text: 'Governing law is compatible with EU GDPR standard contractual clauses.', expected: 'BORDERLINE' },
    { text: 'Subprocessor notice periods allow termination without penalty.', expected: 'BORDERLINE' },
    { text: 'Log retention complies with 1-year forensic audit expectations.', expected: 'FAIL' },
    { text: 'Role-Based Access Control (RBAC) is enforced for system access.', expected: 'PASS' },
  ];

  const criteria = [];
  for (let i = 0; i < count; i++) {
    const item = baseCriteria[i % baseCriteria.length];
    criteria.push({
      text: i < baseCriteria.length ? item.text : item.text + ' [Clause Check #' + (i + 1) + ']',
      expected: item.expected,
    });
  }
  return { pdfBlob: pdfBlob, criteria: criteria };
}

/**
 * One-shot self-contained test for Use Case 1.
 * Creates temporary Drive PDF + temporary Google Sheet, runs batch audit, logs metrics,
 * and trashes all temporary Drive files in a finally block.
 */
function testUseCase1ComplianceAudit() {
  const startMs = Date.now();
  preflightCheck_(0);

  const createdFileIds = [];
  const runId = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd_HHmmss');

  try {
    const fixtures = uc1BuildSampleFixtures_(UC1_TEST_CRITERIA_COUNT);

    // 1. Create temporary Drive PDF
    const pdfFile = DriveApp.createFile(fixtures.pdfBlob.setName('UC1_TempPolicy_' + runId + '.pdf'));
    createdFileIds.push(pdfFile.getId());

    // 2. Create temporary Spreadsheet and populate criteria
    const ss = SpreadsheetApp.create('UC1_TempAuditSheet_' + runId);
    createdFileIds.push(ss.getId());
    const sheet = ss.getSheets()[0];
    sheet.setName('ComplianceAudit');

    const rows = [['Audit Criterion', 'P(Compliant)', 'Confidence', 'Verdict']];
    fixtures.criteria.forEach(function (c) {
      rows.push([c.text, '', '', '']);
    });
    sheet.getRange(1, 1, rows.length, 4).setValues(rows);
    SpreadsheetApp.flush();

    // 3. Execute production audit
    const result = runComplianceAudit(pdfFile.getId(), ss.getId(), 'ComplianceAudit');

    // 4. Evaluate deterministic ground-truth checks & token savings formula
    let passCount = 0;
    let failCount = 0;
    let reviewCount = 0;
    let clearCorrect = 0;
    let clearTotal = 0;

    result.verdicts.forEach(function (v, idx) {
      if (v.verdict === 'PASS') passCount++;
      else if (v.verdict === 'FAIL') failCount++;
      else reviewCount++;

      const exp = fixtures.criteria[idx].expected;
      if (exp === 'PASS' || exp === 'FAIL') {
        clearTotal++;
        if (v.verdict === exp) clearCorrect++;
      }
    });

    const decisionsCost = estimateCostUsd_(GEMINI_DECISIONS_CONFIG.MODEL_DECISION, {
      inputTokens: result.inputTokens,
      outputTokens: 0,
      thinkingTokens: 0,
    });

    const sequentialEstimatedInputTokens =
      result.inputTokens !== null ? result.inputTokens * result.criteriaCount : null;

    const summaryLines = [
      '# Use Case 1: Batch Compliance Audit Test Log',
      '',
      '- **UTC Timestamp**: ' + new Date().toISOString(),
      '- **Run ID**: `' + runId + '`',
      '- **Model**: `' + GEMINI_DECISIONS_CONFIG.MODEL_DECISION + '`',
      '- **Criteria Evaluated**: ' + result.criteriaCount + ' (Batches: ' + result.batches + ')',
      '- **API Round-Trip Latency (ms)**: ' + result.apiLatencyMs,
      '- **Sheets Batch Write Latency (ms)**: ' + result.sheetWriteMs,
      '- **Total Wall-Clock Test Time (ms)**: ' + (Date.now() - startMs),
      '- **Verdicts**: PASS=' + passCount + ', FAIL=' + failCount + ', NEEDS_REVIEW=' + reviewCount,
      '- **Clear Ground-Truth Agreement**: ' +
        clearCorrect +
        '/' +
        clearTotal +
        ' (' +
        ((clearCorrect / Math.max(clearTotal, 1)) * 100).toFixed(1) +
        '%)',
      '- **Decisions Shared Input Tokens**: ' +
        (result.inputTokens !== null ? result.inputTokens : 'N/A') +
        ' | **Output Tokens**: 0 | **Est. Cost (USD)**: ' +
        (decisionsCost !== null ? '$' + decisionsCost.toFixed(6) : 'N/A'),
      '- **Sequential 1-per-call Equivalent Input Tokens (K x shared_input)**: ' +
        (sequentialEstimatedInputTokens !== null ? sequentialEstimatedInputTokens : 'N/A'),
      '',
      '## Per-Criterion Verdicts',
      '',
      '| Key | Expected | P(Compliant) | Confidence | Verdict | Criterion |',
      '|---|---|---|---|---|---|',
    ];
    result.verdicts.forEach(function (v, idx) {
      summaryLines.push(
        '| ' +
          v.qKey +
          ' | ' +
          fixtures.criteria[idx].expected +
          ' | ' +
          v.probability.toFixed(4) +
          ' | ' +
          v.confidence.toFixed(4) +
          ' | ' +
          v.verdict +
          ' | ' +
          v.criterion.replace(/\|/g, '\\|') +
          ' |'
      );
    });

    const reportText = summaryLines.join('\n');
    console.log(reportText);
    saveTestLogToDrive_('UC1_ComplianceAudit_Log_' + runId, reportText, {
      runId: runId,
      model: GEMINI_DECISIONS_CONFIG.MODEL_DECISION,
      criteriaCount: result.criteriaCount,
      batches: result.batches,
      apiLatencyMs: result.apiLatencyMs,
      sheetWriteMs: result.sheetWriteMs,
      totalWallClockMs: Date.now() - startMs,
      verdictsSummary: { pass: passCount, fail: failCount, needsReview: reviewCount },
      clearGroundTruthAgreement: { correct: clearCorrect, total: clearTotal },
      inputTokens: result.inputTokens,
      outputTokens: 0,
      estimatedCostUsd: decisionsCost,
      sequentialEquivalentInputTokens: sequentialEstimatedInputTokens,
    });
  } finally {
    // Guaranteed cleanup: trash all temporary Drive files
    createdFileIds.forEach(function (id) {
      try {
        DriveApp.getFileById(id).setTrashed(true);
      } catch (e) {
        console.warn('UC1 cleanup warning (fileId=' + id + '): ' + e.message);
      }
    });
    console.log('UC1 cleanup completed: trashed ' + createdFileIds.length + ' temporary Drive file(s).');
  }
}
