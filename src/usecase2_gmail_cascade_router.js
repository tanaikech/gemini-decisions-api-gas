/**
 * @fileoverview Use Case 2 — Gmail Trigger-Driven Model Cascade Router
 * (Vertical Escalation: System 1 gemini-decision-1 -> System 2 gemini-4-hydrogen).
 *
 * Production entry point: runGmailCascadeRouter(options)
 * One-shot manual test:   testUseCase2GmailCascadeRouter()
 */

const UC2_CONFIDENCE_THRESHOLD = 0.85;
const UC2_COMPLEXITY_CASCADE_THRESHOLD = 3; // Escalate if score >= 3 (on 0-4 rubric)
const UC2_ESCALATION_THINKING_LEVEL = 'HIGH'; // Valid for gemini-4-hydrogen: LOW, MEDIUM, HIGH, XHIGH
const UC2_FALLBACK_THINKING_LEVEL = 'MEDIUM'; // Valid for gemini-3.8-flash: LOW, MEDIUM, HIGH

const UC2_DEFAULT_LABELS = {
  ROOT: 'CascadeRouter',
  FAST_PATH: 'CascadeRouter/FastPath',
  ESCALATED: 'CascadeRouter/Escalated',
  PROCESSED: 'CascadeRouter/Processed',
};

/**
 * Builds the 3-axis Decisions API questions for Use Case 2 Cascade Routing.
 * @return {Object}
 */
function uc2BuildRouterQuestions_() {
  return {
    is_action_required: {
      type: 'noul',
      instructions: 'Does this email require a reply or operational action from our team?',
    },
    intent_category: {
      type: 'choice',
      instructions: 'Select the primary operational intent of this email.',
      criteria: {
        routine_inquiry: 'Standard FAQ, hours, password reset, or routine status check.',
        billing: 'Invoice, payment, refund, or contract billing dispute.',
        technical_escalation: 'Production outage, security incident, API bug, or architectural issue.',
        informational: 'Newsletter, automated receipt, or FYI notification requiring no reply.',
      },
    },
    complexity_risk: {
      type: 'score',
      instructions: 'Rate the technical, legal, or financial complexity and risk of this email.',
      criteria: [
        '0: Purely informational / no action needed',
        '1: Trivial routine request answerable with a standard template',
        '2: Moderate standard question with clear facts',
        '3: Complex multi-part technical, billing, or contract issue requiring deep analysis',
        '4: Critical incident, security breach, legal threat, or high-risk escalation',
      ],
    },
  };
}

/**
 * Escalates complex or low-confidence emails to gemini-4-hydrogen for deep reasoning + draft synthesis.
 * @param {string} emailText
 * @param {Array<Object>} attachments
 * @param {Object} decisionSummary
 * @param {boolean=} useFallbackFlash
 * @return {{ draftBody: string, apiLatencyMs: number, usage: Object, modelUsed: string }}
 */
function uc2CallReasoningEscalation_(emailText, attachments, decisionSummary, useFallbackFlash) {
  const modelId = useFallbackFlash
    ? GEMINI_DECISIONS_CONFIG.MODEL_FLASH_BASELINE
    : GEMINI_DECISIONS_CONFIG.MODEL_REASONING_ESCALATION;
  const thinkingLevel = useFallbackFlash
    ? UC2_FALLBACK_THINKING_LEVEL
    : UC2_ESCALATION_THINKING_LEVEL;

  const prompt =
    'You are a senior support and operations architect. A fast triage router escalated this email ' +
    '(category=' +
    decisionSummary.category +
    ', confidence=' +
    decisionSummary.confidence.toFixed(2) +
    ', complexityScore=' +
    decisionSummary.complexityScore.toFixed(2) +
    '). Analyze the email and any attached document carefully, then write a concise, accurate, ' +
    'professional reply draft addressing every issue and specifying next steps.\n\n' +
    emailText;

  const requestBody = {
    contents: [{ role: 'user', parts: buildGenerateContentParts_(prompt, attachments) }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096, // Budget covers both thinking tokens (HIGH) and draft text
      thinkingConfig: { thinkingLevel: thinkingLevel },
    },
  };

  const res = callGeminiGenerateContent_(modelId, requestBody);
  return {
    draftBody: res.text,
    apiLatencyMs: res.apiLatencyMs,
    usage: res.usage,
    modelUsed: modelId,
  };
}

/**
 * Production entry point: Routes matching Gmail threads via Decisions API -> Fast Path or Reasoning Cascade.
 * @param {{ searchQuery?: string, maxThreads?: number, labelNames?: Object, createDrafts?: boolean, startTimeMs?: number }=} options
 * @return {{ processed: Array<Object>, createdDrafts: Array<GoogleAppsScript.Gmail.GmailDraft> }}
 */
function runGmailCascadeRouter(options) {
  const opts = options || {};
  const labelsCfg = opts.labelNames || UC2_DEFAULT_LABELS;
  const query = opts.searchQuery || 'in:inbox -label:"' + labelsCfg.PROCESSED + '"';
  const maxThreads = opts.maxThreads || 10;
  const createDrafts = opts.createDrafts !== false;
  const startTimeMs = opts.startTimeMs || Date.now();

  const labelCache = new Map();
  const fastLabel = getOrCreateCachedLabel_(labelsCfg.FAST_PATH, labelCache);
  const escalatedLabel = getOrCreateCachedLabel_(labelsCfg.ESCALATED, labelCache);
  const processedLabel = getOrCreateCachedLabel_(labelsCfg.PROCESSED, labelCache);

  const threads = GmailApp.search(query, 0, maxThreads);
  const questions = uc2BuildRouterQuestions_();
  const processed = [];
  const createdDrafts = [];

  threads.forEach(function (thread) {
    assertTimeBudget_(startTimeMs, GEMINI_DECISIONS_CONFIG.SOFT_DEADLINE_MS, 'UC2 thread loop');
    const msg = thread.getMessages()[thread.getMessageCount() - 1];
    const emailText =
      'From: ' +
      msg.getFrom() +
      '\nSubject: ' +
      msg.getSubject() +
      '\n\n' +
      msg.getPlainBody().slice(0, 12000);
    const attachments = extractSafeGmailAttachments_(msg);
    const decisionInput = buildMultimodalDecisionInput_(emailText, attachments);

    // Stage 1: System 1 Fast Triage (gemini-decision-1, zero output tokens)
    const decRes = callGeminiDecisionsApi_(decisionInput, questions);
    const actionAns = decRes.answers.is_action_required;
    const catAns = decRes.answers.intent_category;
    const scoreAns = decRes.answers.complexity_risk;

    const category = catAns.choice || 'routine_inquiry';
    const confidence = catAns.confidence !== null ? catAns.confidence : 0.0;
    const complexityScore = scoreAns.score !== null ? scoreAns.score : 4.0;
    const actionRequired = actionAns.noul !== null ? actionAns.noul >= 0.5 : true;

    // Deterministic Cascade Predicate
    const shouldEscalate =
      confidence < UC2_CONFIDENCE_THRESHOLD || complexityScore >= UC2_COMPLEXITY_CASCADE_THRESHOLD;

    let reasoningLatencyMs = 0;
    let reasoningModel = null;
    let route = 'FAST_PATH';

    if (shouldEscalate) {
      route = 'ESCALATED';
      const escRes = uc2CallReasoningEscalation_(emailText, attachments, {
        category: category,
        confidence: confidence,
        complexityScore: complexityScore,
      });
      reasoningLatencyMs = escRes.apiLatencyMs;
      reasoningModel = escRes.modelUsed;
      thread.addLabel(escalatedLabel);
      if (createDrafts) {
        createdDrafts.push(thread.createDraftReply(escRes.draftBody));
      }
    } else {
      thread.addLabel(fastLabel);
      if (createDrafts && actionRequired) {
        const canned =
          'Thank you for contacting us regarding your ' +
          category.replace(/_/g, ' ') +
          ' request. Our automated triage has logged your ticket and a team member will follow up shortly.';
        createdDrafts.push(thread.createDraftReply(canned));
      }
    }

    thread.addLabel(processedLabel);
    processed.push({
      subject: msg.getSubject(),
      route: route,
      category: category,
      confidence: confidence,
      complexityScore: complexityScore,
      actionRequired: actionRequired,
      decisionsApiLatencyMs: decRes.apiLatencyMs,
      reasoningApiLatencyMs: reasoningLatencyMs,
      reasoningModel: reasoningModel,
    });
  });

  return { processed: processed, createdDrafts: createdDrafts };
}

/**
 * One-shot self-contained test for Use Case 2.
 * Creates temporary labels, sends 3 sample emails (routine, complex+PDF, ambiguous),
 * polls inbox, runs cascade router, asserts Fast Path vs Escalation routing,
 * and cleans up all temporary drafts, threads, and nested labels in finally.
 */
function testUseCase2GmailCascadeRouter() {
  const startMs = Date.now();
  const preflight = preflightCheck_(3);
  const runId = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd_HHmmss');
  const runTag = '[UC2Cascade:' + runId + ']';
  const labelPrefix = 'UC2Cascade_' + runId;
  const labelNames = {
    ROOT: labelPrefix,
    FAST_PATH: labelPrefix + '/FastPath',
    ESCALATED: labelPrefix + '/Escalated',
    PROCESSED: labelPrefix + '/Processed',
  };
  const trackedDrafts = [];

  try {
    // 1. Send 3 deterministic sample emails to self
    const incidentPdf = Utilities.newBlob(
      '<html><body><h2>Incident Report #409</h2><p>Production API returning HTTP 500 across EU-West ' +
        'with suspected invoice overcharge of $42,000 and SLA breach penalty clause triggered.</p></body></html>',
      'text/html',
      'incident_409.html'
    )
      .getAs('application/pdf')
      .setName('incident_409.pdf');

    const samples = [
      {
        key: 'routine',
        expectedRoute: 'FAST_PATH',
        subject: runTag + ' Password reset link question',
        body: 'Hi team, could you please tell me where I can reset my account password? Thanks!',
        attachments: [],
      },
      {
        key: 'complex_pdf',
        expectedRoute: 'ESCALATED',
        subject: runTag + ' URGENT: Production outage + $42k billing SLA dispute',
        body: 'Our production integration has been down for 3 hours and our legal team attached the SLA breach and billing dispute PDF. Please escalate immediately.',
        attachments: [incidentPdf],
      },
      {
        key: 'ambiguous',
        expectedRoute: 'ESCALATED',
        subject: runTag + ' Re: Following up on our discussion',
        body: 'Per our brief chat yesterday, please confirm whether the revised terms and technical workaround are acceptable before Friday.',
        attachments: [],
      },
    ];

    samples.forEach(function (s) {
      assertTimeBudget_(startMs, GEMINI_DECISIONS_CONFIG.SOFT_DEADLINE_MS, 'UC2 sendEmail ' + s.key);
      GmailApp.sendEmail(preflight.userEmail, s.subject, s.body, { attachments: s.attachments });
    });

    // 2. Poll Inbox until all 3 sample emails arrive (excluded from API latency)
    pollInboxBySubjectTag_(runTag, samples.length, startMs);

    // 3. Execute production cascade router on test threads
    const res = runGmailCascadeRouter({
      searchQuery: 'in:inbox subject:"' + runTag + '"',
      maxThreads: samples.length + 2,
      labelNames: labelNames,
      createDrafts: true,
      startTimeMs: startMs,
    });
    res.createdDrafts.forEach(function (d) {
      trackedDrafts.push(d);
    });

    // 4. Verify Fast Path vs Escalation assertions against expectedRoute & save Drive log
    const logLines = [
      '# Use Case 2: Gmail Model Cascade Router Test Log',
      '',
      '- **UTC Timestamp**: ' + new Date().toISOString(),
      '- **Run ID**: `' + runId + '`',
      '- **Stage 1 Model**: `' + GEMINI_DECISIONS_CONFIG.MODEL_DECISION + '`',
      '- **Stage 2 Escalation Model**: `' +
        GEMINI_DECISIONS_CONFIG.MODEL_REASONING_ESCALATION +
        '` (`thinkingLevel=' +
        UC2_ESCALATION_THINKING_LEVEL +
        '`)',
      '',
      '| Assertion | Expected | Actual | Category | Confidence | Complexity Score | Decisions ms | Reasoning ms | Model | Subject |',
      '|---|---|---|---|---|---|---|---|---|---|',
    ];
    let fastCount = 0;
    let escalatedCount = 0;
    let assertionsPassed = 0;
    const detailedRows = [];

    res.processed.forEach(function (item) {
      if (item.route === 'FAST_PATH') fastCount++;
      else escalatedCount++;
      const matchedSample = samples.find(function (s) {
        return item.subject.indexOf(s.subject) !== -1;
      });
      const expectedRoute = matchedSample ? matchedSample.expectedRoute : 'UNKNOWN';
      const passed = item.route === expectedRoute;
      if (passed) assertionsPassed++;
      detailedRows.push({
        passed: passed,
        expectedRoute: expectedRoute,
        actualRoute: item.route,
        category: item.category,
        confidence: item.confidence,
        complexityScore: item.complexityScore,
        decisionsApiLatencyMs: item.decisionsApiLatencyMs,
        reasoningApiLatencyMs: item.reasoningApiLatencyMs,
        reasoningModel: item.reasoningModel,
        subject: item.subject,
      });
      logLines.push(
        '| ' +
          (passed ? 'PASS' : 'FAIL') +
          ' | ' +
          expectedRoute +
          ' | ' +
          item.route +
          ' | ' +
          item.category +
          ' | ' +
          item.confidence.toFixed(2) +
          ' | ' +
          item.complexityScore.toFixed(2) +
          ' | ' +
          item.decisionsApiLatencyMs +
          ' | ' +
          item.reasoningApiLatencyMs +
          ' | ' +
          (item.reasoningModel || 'None') +
          ' | ' +
          item.subject.replace(/\|/g, '\\|') +
          ' |'
      );
    });

    logLines.push('');
    logLines.push(
      '- **Routing Assertions**: ' +
        assertionsPassed +
        '/' +
        res.processed.length +
        ' PASSED | Fast Path: ' +
        fastCount +
        ' (reasoning calls=0), Escalated: ' +
        escalatedCount +
        ' | Total Wall-Clock: ' +
        (Date.now() - startMs) +
        'ms'
    );

    const reportText = logLines.join('\n');
    console.log(reportText);
    saveTestLogToDrive_('UC2_CascadeRouter_Log_' + runId, reportText, {
      runId: runId,
      assertionsPassed: assertionsPassed,
      totalSamples: res.processed.length,
      fastPathCount: fastCount,
      escalatedCount: escalatedCount,
      totalWallClockMs: Date.now() - startMs,
      results: detailedRows,
    });
  } finally {
    cleanupGmailTestArtifacts_(runTag, labelPrefix, trackedDrafts);
    console.log('UC2 cleanup completed for tag ' + runTag + ' and label prefix ' + labelPrefix + '.');
  }
}
