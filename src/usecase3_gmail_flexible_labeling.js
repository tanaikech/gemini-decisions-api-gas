/**
 * @fileoverview Use Case 3 (Production) — Flexible Labeling for Gmail using Gemini Decisions API
 * (Part 4 evolution of the author's Dec 2023 / Jan 2024 / Sep 2024 Medium series).
 *
 * Production entry point: labelGmailWithDecisions(options)
 * Reused directly by Method 4 inside src/usecase3_gmail_benchmark.js.
 */

const UC3_CONFIDENCE_THRESHOLD = 0.85;
const UC3_BOOLEAN_THRESHOLD = 0.50;

const UC3_TAXONOMY = {
  categories: {
    Academic: 'Research papers, peer review, academic conferences, university seminars, or scholarly correspondence.',
    Finance: 'Invoices, receipts, bank statements, tax documents, payroll, or payment notifications.',
    Advertisement: 'Promotional newsletters, marketing campaigns, sales discounts, or product ads.',
    Support: 'Customer support tickets, technical troubleshooting, bug reports, or service help requests.',
    Other: 'General personal or miscellaneous messages that do not fit the categories above.',
  },
  priorityLevels: [
    '0: Low — No urgency; informational or promotional',
    '1: Medium — Standard follow-up within a few business days',
    '2: High — Time-sensitive request requiring attention within 24 hours',
    '3: Critical — Immediate operational, financial, or security urgency',
  ],
};

/**
 * Builds the canonical 3-axis Decisions API question map for Gmail Flexible Labeling.
 * @return {Object}
 */
function uc3BuildDecisionQuestions_() {
  return {
    category: {
      type: 'choice',
      instructions: 'Classify this email (including any attached documents) into the single best primary category.',
      criteria: UC3_TAXONOMY.categories,
    },
    is_action_required: {
      type: 'noul',
      instructions: 'Does this email require the recipient to take a specific action or reply?',
    },
    is_urgent: {
      type: 'noul',
      instructions: 'Is this email time-sensitive or urgent (requiring attention within 24 hours)?',
    },
    priority_score: {
      type: 'score',
      instructions: 'Rate the priority level of this email on the 0-3 rubric.',
      criteria: UC3_TAXONOMY.priorityLevels,
    },
  };
}

/**
 * Classifies a pre-extracted email payload using Gemini Decisions API (gemini-decision-1).
 * Shared directly between production labeling and Use Case 3 Benchmark Method 4.
 *
 * @param {{ subject: string, from: string, body: string, attachments: Array<Object> }} emailPayload
 * @return {{ category: string, confidence: number, needsReview: boolean, actionRequired: boolean, urgent: boolean, priorityBand: number, apiLatencyMs: number, parseMs: number, usage: Object, retries: number }}
 */
function uc3ClassifyEmailWithDecisions_(emailPayload) {
  const combinedText =
    'From: ' +
    (emailPayload.from || '') +
    '\nSubject: ' +
    (emailPayload.subject || '') +
    '\n\n' +
    String(emailPayload.body || '').slice(0, 12000);

  const inputBlocks = buildMultimodalDecisionInput_(combinedText, emailPayload.attachments || []);
  const questions = uc3BuildDecisionQuestions_();
  const res = callGeminiDecisionsApi_(inputBlocks, questions);

  const tParse0 = Date.now();
  const catAns = res.answers.category || {};
  const actionAns = res.answers.is_action_required || {};
  const urgentAns = res.answers.is_urgent || {};
  const scoreAns = res.answers.priority_score || {};

  const category = catAns.choice || 'Other';
  const confidence = catAns.confidence !== null ? catAns.confidence : 0.0;
  const needsReview = confidence < UC3_CONFIDENCE_THRESHOLD;
  const actionRequired = actionAns.noul !== null ? actionAns.noul >= UC3_BOOLEAN_THRESHOLD : false;
  const urgent = urgentAns.noul !== null ? urgentAns.noul >= UC3_BOOLEAN_THRESHOLD : false;
  const priorityBand = scoreAns.score !== null ? Math.round(scoreAns.score) : 0;
  const parseMs = Date.now() - tParse0;

  return {
    category: category,
    confidence: confidence,
    needsReview: needsReview,
    actionRequired: actionRequired,
    urgent: urgent,
    priorityBand: priorityBand,
    apiLatencyMs: res.apiLatencyMs,
    parseMs: parseMs,
    usage: res.usage,
    retries: res.retries,
  };
}

/**
 * Applies Gmail labels to a thread based on a UC3 classification result.
 * @param {GoogleAppsScript.Gmail.GmailThread} thread
 * @param {Object} classification
 * @param {string} labelPrefix Optional namespace prefix (empty string for top-level labels).
 * @param {Map<string, GoogleAppsScript.Gmail.GmailLabel>} labelCache
 * @return {{ appliedLabels: Array<string>, gmailLabelApplyMs: number }}
 */
function uc3ApplyLabelsFromDecision_(thread, classification, labelPrefix, labelCache) {
  const t0 = Date.now();
  const prefix = labelPrefix ? labelPrefix + '/' : '';
  const applied = [];

  const primaryName = classification.needsReview ? prefix + 'NeedsReview' : prefix + classification.category;
  thread.addLabel(getOrCreateCachedLabel_(primaryName, labelCache));
  applied.push(primaryName);

  if (classification.actionRequired) {
    const actName = prefix + 'ActionRequired';
    thread.addLabel(getOrCreateCachedLabel_(actName, labelCache));
    applied.push(actName);
  }
  if (classification.urgent) {
    const urgName = prefix + 'Urgent';
    thread.addLabel(getOrCreateCachedLabel_(urgName, labelCache));
    applied.push(urgName);
  }

  return { appliedLabels: applied, gmailLabelApplyMs: Date.now() - t0 };
}

/**
 * Production trigger-ready entry point: Labels recent unlabeled inbox emails via Gemini Decisions API.
 * @param {{ searchQuery?: string, maxThreads?: number, labelPrefix?: string, processedLabel?: string }=} options
 * @return {Array<Object>}
 */
function labelGmailWithDecisions(options) {
  const opts = options || {};
  const startMs = Date.now();
  const labelPrefix = typeof opts.labelPrefix === 'string' ? opts.labelPrefix : 'GeminiDecisions';
  const processedName = opts.processedLabel || (labelPrefix ? labelPrefix + '/Processed' : 'GeminiDecisionsProcessed');
  const query = opts.searchQuery || 'in:inbox -label:"' + processedName + '"';
  const maxThreads = opts.maxThreads || 20;

  const labelCache = new Map();
  const processedLabel = getOrCreateCachedLabel_(processedName, labelCache);
  const threads = GmailApp.search(query, 0, maxThreads);
  const results = [];

  threads.forEach(function (thread) {
    assertTimeBudget_(startMs, GEMINI_DECISIONS_CONFIG.SOFT_DEADLINE_MS, 'UC3 labelGmailWithDecisions');
    const msg = thread.getMessages()[thread.getMessageCount() - 1];
    const payload = {
      subject: msg.getSubject(),
      from: msg.getFrom(),
      body: msg.getPlainBody(),
      attachments: extractSafeGmailAttachments_(msg),
    };

    const cls = uc3ClassifyEmailWithDecisions_(payload);
    const applyRes = uc3ApplyLabelsFromDecision_(thread, cls, labelPrefix, labelCache);
    thread.addLabel(processedLabel);

    results.push({
      subject: payload.subject,
      category: cls.category,
      confidence: cls.confidence,
      needsReview: cls.needsReview,
      appliedLabels: applyRes.appliedLabels,
      apiLatencyMs: cls.apiLatencyMs,
      gmailLabelApplyMs: applyRes.gmailLabelApplyMs,
    });
  });

  console.log('UC3 labeled ' + results.length + ' thread(s).');
  return results;
}
