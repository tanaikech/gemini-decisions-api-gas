/**
 * @fileoverview Use Case 3 (Benchmark) — One-Shot Fair 4-Method Gmail Labeling Benchmark
 * Compares Part 1 (Free-Text Prompt), Part 2 (Function Calling), Part 3 (JSON Schema)
 * on gemini-3.8-flash (thinkingLevel: "LOW") against Part 4 (Gemini Decisions API,
 * gemini-decision-1) on the exact same delivered Gmail emails and attachments.
 *
 * One-shot manual test: testUseCase3GmailBenchmark()
 */

const UC3B_BASELINE_MODEL = 'gemini-3.8-flash'; // Independent literal avoids GAS cross-file TDZ; switchable to 'gemini-4-hydrogen'
const UC3B_BASELINE_THINKING_LEVEL = 'LOW'; // Valid: LOW, MEDIUM, HIGH (NEVER MINIMAL or budget 0)
const UC3B_TEMPERATURE = 0.0;
const UC3B_MAX_OUTPUT_TOKENS = 512;
const UC3B_REPEATS = 2; // Reduce to 1 if switching baseline to gemini-4-hydrogen to stay within 6-min GAS limit
const UC3B_PACING_SLEEP_MS = 250;

/**
 * Returns 6 deterministic, ground-truth annotated sample emails (including 1 PDF attachment & 1 ambiguous case).
 * @param {string} runTag
 * @return {Array<Object>}
 */
function uc3bBuildBenchmarkCorpus_(runTag) {
  const invoicePdf = Utilities.newBlob(
    '<html><body><h2>INVOICE #INV-2026-8841</h2><p>Amount Due: $3,450.00</p>' +
      '<p>Due Date: Tomorrow (within 24 hours). Wire transfer confirmation required immediately.</p></body></html>',
    'text/html',
    'invoice_8841.html'
  )
    .getAs('application/pdf')
    .setName('invoice_8841.pdf');

  return [
    {
      id: 'E1_Academic',
      subject: runTag + ' Peer review invitation: JGR Space Physics manuscript',
      body: 'Dear Dr. Tanaike, We invite you to review manuscript #2026-JGR-0412 on ionospheric TEC anomalies. Please accept or decline within 7 days.',
      attachments: [],
      expectedCategory: 'Academic',
      expectedActionRequired: true,
      expectedUrgent: false,
      expectedPriorityBand: 1,
      isAmbiguous: false,
    },
    {
      id: 'E2_Finance',
      subject: runTag + ' Monthly cloud billing statement — October 2026',
      body: 'Your automated payment of $142.80 has been processed successfully. No action is required; this receipt is for your accounting records.',
      attachments: [],
      expectedCategory: 'Finance',
      expectedActionRequired: false,
      expectedUrgent: false,
      expectedPriorityBand: 0,
      isAmbiguous: false,
    },
    {
      id: 'E3_Advertisement',
      subject: runTag + ' Flash Sale: 50% off developer hoodies this weekend only!',
      body: 'Upgrade your wardrobe with our annual developer merch clearance! Use code DEV50 at checkout. Unsubscribe anytime.',
      attachments: [],
      expectedCategory: 'Advertisement',
      expectedActionRequired: false,
      expectedUrgent: false,
      expectedPriorityBand: 0,
      isAmbiguous: false,
    },
    {
      id: 'E4_Support',
      subject: runTag + ' Ticket #9104: Webhook returning HTTP 502 in production',
      body: 'Hello Support, our webhook endpoint started returning HTTP 502 errors 20 minutes ago and customer orders are blocked. Please investigate ASAP.',
      attachments: [],
      expectedCategory: 'Support',
      expectedActionRequired: true,
      expectedUrgent: true,
      expectedPriorityBand: 3,
      isAmbiguous: false,
    },
    {
      id: 'E5_Finance_MultiLabel_PDF',
      subject: runTag + ' Action required: Attached invoice due within 24 hours',
      body: 'Please review the attached PDF invoice and confirm wire settlement before tomorrow 17:00 UTC to avoid service suspension.',
      attachments: [invoicePdf],
      expectedCategory: 'Finance',
      expectedActionRequired: true,
      expectedUrgent: true,
      expectedPriorityBand: 3,
      isAmbiguous: false,
    },
    {
      id: 'E6_Ambiguous',
      subject: runTag + ' Quick note regarding Thursday',
      body: 'Hi, I glanced at the draft numbers and the seminar slides you mentioned. Let us touch base whenever convenient if anything needs adjustment.',
      attachments: [],
      expectedCategory: 'Other',
      expectedActionRequired: false,
      expectedUrgent: false,
      expectedPriorityBand: 1,
      isAmbiguous: true,
    },
  ];
}

/**
 * Shared taxonomy instruction text passed identically to Methods 1-3 so all 4 methods evaluate the exact same 3 axes.
 * @return {string}
 */
function uc3bBuildTaxonomyPromptText_() {
  return (
    'Evaluate the email (and any attached document) on these exact fields:\n' +
    '1. category: one of ["Academic", "Finance", "Advertisement", "Support", "Other"]\n' +
    '   - Academic: ' + UC3_TAXONOMY.categories.Academic + '\n' +
    '   - Finance: ' + UC3_TAXONOMY.categories.Finance + '\n' +
    '   - Advertisement: ' + UC3_TAXONOMY.categories.Advertisement + '\n' +
    '   - Support: ' + UC3_TAXONOMY.categories.Support + '\n' +
    '   - Other: ' + UC3_TAXONOMY.categories.Other + '\n' +
    '2. actionRequired: boolean (true if the recipient must reply or act)\n' +
    '3. urgent: boolean (true if attention is needed within 24 hours)\n' +
    '4. priorityBand: integer 0-3 (0=Low, 1=Medium, 2=High, 3=Critical)\n'
  );
}

/**
 * Method 1 (Part 1 Style): Prompt-based free-text generation + regex/key-value parsing.
 * @param {Object} emailPayload
 * @return {Object}
 */
function uc3bRunMethod1FreeText_(emailPayload) {
  const prompt =
    uc3bBuildTaxonomyPromptText_() +
    '\nReturn ONLY 4 plain text lines in this exact format:\n' +
    'category: <Academic|Finance|Advertisement|Support|Other>\n' +
    'actionRequired: <true|false>\n' +
    'urgent: <true|false>\n' +
    'priorityBand: <0|1|2|3>\n\n' +
    'From: ' + emailPayload.from + '\nSubject: ' + emailPayload.subject + '\n\n' + emailPayload.body;

  const res = callGeminiGenerateContent_(UC3B_BASELINE_MODEL, {
    contents: [{ role: 'user', parts: buildGenerateContentParts_(prompt, emailPayload.attachments) }],
    generationConfig: {
      temperature: UC3B_TEMPERATURE,
      maxOutputTokens: UC3B_MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingLevel: UC3B_BASELINE_THINKING_LEVEL },
    },
  });

  const tParse0 = Date.now();
  let parseFailed = false;
  const catMatch = res.text.match(/category\s*:\s*(Academic|Finance|Advertisement|Support|Other)/i);
  const actMatch = res.text.match(/actionRequired\s*:\s*(true|false)/i);
  const urgMatch = res.text.match(/urgent\s*:\s*(true|false)/i);
  const priMatch = res.text.match(/priorityBand\s*:\s*([0-3])/i);

  if (!catMatch || !actMatch || !urgMatch || !priMatch) {
    parseFailed = true;
  }

  return {
    category: catMatch ? uc3bNormalizeCategory_(catMatch[1]) : 'Other',
    actionRequired: actMatch ? actMatch[1].toLowerCase() === 'true' : false,
    urgent: urgMatch ? urgMatch[1].toLowerCase() === 'true' : false,
    priorityBand: priMatch ? parseInt(priMatch[1], 10) : 0,
    confidence: null,
    needsReview: false,
    parseFailed: parseFailed,
    apiLatencyMs: res.apiLatencyMs,
    parseMs: Date.now() - tParse0,
    usage: res.usage,
    retries: res.retries,
  };
}

/**
 * Method 2 (Part 2 Style): Function Calling with forced tool invocation.
 * @param {Object} emailPayload
 * @return {Object}
 */
function uc3bRunMethod2FunctionCalling_(emailPayload) {
  const prompt =
    uc3bBuildTaxonomyPromptText_() +
    '\nCall the apply_gmail_labels function with your classification.\n\n' +
    'From: ' + emailPayload.from + '\nSubject: ' + emailPayload.subject + '\n\n' + emailPayload.body;

  const res = callGeminiGenerateContent_(UC3B_BASELINE_MODEL, {
    contents: [{ role: 'user', parts: buildGenerateContentParts_(prompt, emailPayload.attachments) }],
    tools: [
      {
        functionDeclarations: [
          {
            name: 'apply_gmail_labels',
            description: 'Apply structured category, action, urgency, and priority labels to a Gmail message.',
            parameters: {
              type: 'OBJECT',
              properties: {
                category: {
                  type: 'STRING',
                  enum: ['Academic', 'Finance', 'Advertisement', 'Support', 'Other'],
                },
                actionRequired: { type: 'BOOLEAN' },
                urgent: { type: 'BOOLEAN' },
                priorityBand: { type: 'INTEGER' },
              },
              required: ['category', 'actionRequired', 'urgent', 'priorityBand'],
            },
          },
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['apply_gmail_labels'],
      },
    },
    generationConfig: {
      temperature: UC3B_TEMPERATURE,
      maxOutputTokens: UC3B_MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingLevel: UC3B_BASELINE_THINKING_LEVEL },
    },
  });

  const tParse0 = Date.now();
  const args = res.functionCall && res.functionCall.args ? res.functionCall.args : null;
  const parseFailed = !args || typeof args.category !== 'string';

  return {
    category: args ? uc3bNormalizeCategory_(args.category) : 'Other',
    actionRequired: args ? Boolean(args.actionRequired) : false,
    urgent: args ? Boolean(args.urgent) : false,
    priorityBand: args && typeof args.priorityBand === 'number' ? Math.round(args.priorityBand) : 0,
    confidence: null,
    needsReview: false,
    parseFailed: parseFailed,
    apiLatencyMs: res.apiLatencyMs,
    parseMs: Date.now() - tParse0,
    usage: res.usage,
    retries: res.retries,
  };
}

/**
 * Method 3 (Part 3 Style): JSON Schema / Structured Output.
 * @param {Object} emailPayload
 * @return {Object}
 */
function uc3bRunMethod3JsonSchema_(emailPayload) {
  const prompt =
    uc3bBuildTaxonomyPromptText_() +
    '\nReturn a JSON object matching the required schema.\n\n' +
    'From: ' + emailPayload.from + '\nSubject: ' + emailPayload.subject + '\n\n' + emailPayload.body;

  const res = callGeminiGenerateContent_(UC3B_BASELINE_MODEL, {
    contents: [{ role: 'user', parts: buildGenerateContentParts_(prompt, emailPayload.attachments) }],
    generationConfig: {
      temperature: UC3B_TEMPERATURE,
      maxOutputTokens: UC3B_MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          category: {
            type: 'STRING',
            enum: ['Academic', 'Finance', 'Advertisement', 'Support', 'Other'],
          },
          actionRequired: { type: 'BOOLEAN' },
          urgent: { type: 'BOOLEAN' },
          priorityBand: { type: 'INTEGER' },
        },
        required: ['category', 'actionRequired', 'urgent', 'priorityBand'],
      },
      thinkingConfig: { thinkingLevel: UC3B_BASELINE_THINKING_LEVEL },
    },
  });

  const tParse0 = Date.now();
  let obj = null;
  let parseFailed = false;
  try {
    obj = JSON.parse(res.text);
    if (!obj || typeof obj.category !== 'string') parseFailed = true;
  } catch (e) {
    parseFailed = true;
  }

  return {
    category: obj ? uc3bNormalizeCategory_(obj.category) : 'Other',
    actionRequired: obj ? Boolean(obj.actionRequired) : false,
    urgent: obj ? Boolean(obj.urgent) : false,
    priorityBand: obj && typeof obj.priorityBand === 'number' ? Math.round(obj.priorityBand) : 0,
    confidence: null,
    needsReview: false,
    parseFailed: parseFailed,
    apiLatencyMs: res.apiLatencyMs,
    parseMs: Date.now() - tParse0,
    usage: res.usage,
    retries: res.retries,
  };
}

/**
 * Normalizes category casing against UC3_TAXONOMY keys.
 * @param {string} rawCat
 * @return {string}
 */
function uc3bNormalizeCategory_(rawCat) {
  const lower = String(rawCat || '').trim().toLowerCase();
  const keys = Object.keys(UC3_TAXONOMY.categories);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === lower) return keys[i];
  }
  return 'Other';
}

/**
 * Computes Macro-F1 across primary categories for a method's prediction list.
 * @param {Array<{ expected: string, predicted: string }>} pairs
 * @return {number}
 */
function uc3bComputeMacroF1_(pairs) {
  const classes = Object.keys(UC3_TAXONOMY.categories);
  let f1Sum = 0;
  let activeClasses = 0;
  classes.forEach(function (cls) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    pairs.forEach(function (p) {
      if (p.expected === cls && p.predicted === cls) tp++;
      else if (p.expected !== cls && p.predicted === cls) fp++;
      else if (p.expected === cls && p.predicted !== cls) fn++;
    });
    if (tp + fn > 0) {
      activeClasses++;
      const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
      const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
      f1Sum += prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
    }
  });
  return activeClasses > 0 ? f1Sum / activeClasses : 0;
}

/**
 * One-shot self-contained benchmark for Use Case 3.
 * Creates temporary labels -> sends 6 annotated emails -> polls inbox -> pre-fetches payloads ->
 * warm-up -> Latin-square interleaved 4-method evaluation -> verifies live label application ->
 * outputs Reproducibility Metadata + copy-paste-ready Markdown Table 2 -> cleans up all resources.
 */
function testUseCase3GmailBenchmark() {
  const startMs = Date.now();
  const preflight = preflightCheck_(6);
  const runId = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd_HHmmss');
  const runTag = '[GeminiBench:' + runId + ']';
  const labelPrefix = 'GeminiBench_' + runId;
  const corpus = uc3bBuildBenchmarkCorpus_(runTag);

  const userEmail = preflight.userEmail;
  const labelCache = new Map();

  try {
    // 1. Pre-create isolated namespaced labels
    ['Academic', 'Finance', 'Advertisement', 'Support', 'Other', 'ActionRequired', 'Urgent', 'NeedsReview'].forEach(
      function (name) {
        getOrCreateCachedLabel_(labelPrefix + '/' + name, labelCache);
      }
    );

    // 2. Send all deterministic sample emails to self
    corpus.forEach(function (item) {
      assertTimeBudget_(startMs, GEMINI_DECISIONS_CONFIG.SOFT_DEADLINE_MS, 'UC3B send ' + item.id);
      GmailApp.sendEmail(userEmail, item.subject, item.body, { attachments: item.attachments });
    });

    // 3. Poll inbox until all emails arrive (excluded from API timing)
    const threads = pollInboxBySubjectTag_(runTag, corpus.length, startMs);

    // 4. Freeze normalized multimodal payloads in memory before starting any timers
    const deliveredItems = [];
    corpus.forEach(function (spec) {
      const matchThread = threads.find(function (th) {
        return th.getFirstMessageSubject().indexOf(spec.subject) !== -1;
      });
      if (!matchThread) {
        throw new Error('Delivered thread not found for corpus item: ' + spec.id);
      }
      const msg = matchThread.getMessages()[0];
      deliveredItems.push({
        spec: spec,
        thread: matchThread,
        payload: {
          subject: msg.getSubject(),
          from: msg.getFrom(),
          body: msg.getPlainBody(),
          attachments: extractSafeGmailAttachments_(msg),
        },
      });
    });

    const corpusHash = sha256Hex_(
      JSON.stringify(
        corpus.map(function (c) {
          return { id: c.id, body: c.body, expectedCategory: c.expectedCategory };
        })
      )
    );

    // 5. Discarded warm-up calls (1 per endpoint) to remove DNS/TLS cold-start bias
    assertTimeBudget_(startMs, GEMINI_DECISIONS_CONFIG.SOFT_DEADLINE_MS, 'UC3B warmup');
    uc3bRunMethod3JsonSchema_(deliveredItems[0].payload);
    uc3ClassifyEmailWithDecisions_(deliveredItems[0].payload);

    // 6. Define the 4 methods (Method 4 calls production uc3ClassifyEmailWithDecisions_ directly)
    const methods = [
      { id: 'M1', name: 'Method 1 (Part 1: Free-Text)', model: UC3B_BASELINE_MODEL, fn: uc3bRunMethod1FreeText_ },
      { id: 'M2', name: 'Method 2 (Part 2: Function Calling)', model: UC3B_BASELINE_MODEL, fn: uc3bRunMethod2FunctionCalling_ },
      { id: 'M3', name: 'Method 3 (Part 3: JSON Schema)', model: UC3B_BASELINE_MODEL, fn: uc3bRunMethod3JsonSchema_ },
      {
        id: 'M4',
        name: 'Method 4 (Part 4: Decisions API)',
        model: GEMINI_DECISIONS_CONFIG.MODEL_DECISION,
        fn: function (payload) {
          const r = uc3ClassifyEmailWithDecisions_(payload);
          r.parseFailed = false;
          return r;
        },
      },
    ];

    const records = { M1: [], M2: [], M3: [], M4: [] };

    // 7. Interleaved Latin-square execution across UC3B_REPEATS x N emails
    for (let rep = 0; rep < UC3B_REPEATS; rep++) {
      for (let i = 0; i < deliveredItems.length; i++) {
        const entry = deliveredItems[i];
        const rotationOffset = (rep + i) % methods.length;
        for (let m = 0; m < methods.length; m++) {
          const method = methods[(m + rotationOffset) % methods.length];
          assertTimeBudget_(
            startMs,
            GEMINI_DECISIONS_CONFIG.SOFT_DEADLINE_MS,
            'UC3B rep=' + rep + ' item=' + entry.spec.id + ' ' + method.id
          );
          let out;
          let httpFailed = false;
          try {
            out = method.fn(entry.payload);
          } catch (apiErr) {
            httpFailed = true;
            out = {
              category: 'Other',
              actionRequired: false,
              urgent: false,
              priorityBand: 0,
              confidence: null,
              needsReview: false,
              parseFailed: true,
              apiLatencyMs: NaN,
              parseMs: NaN,
              usage: { inputTokens: null, outputTokens: null, thinkingTokens: null, cachedTokens: null },
              retries: 0,
              error: apiErr.message,
            };
          }
          records[method.id].push({
            rep: rep + 1,
            pairKey: rep + ':' + entry.spec.id,
            spec: entry.spec,
            out: out,
            httpFailed: httpFailed,
          });
          Utilities.sleep(UC3B_PACING_SLEEP_MS);
        }
      }
    }

    // 8. Post-benchmark live Gmail label application verification using Method 4's last pass
    let totalLabelApplyMs = 0;
    const labelVerificationRows = [];
    const m4LastPass = records.M4.slice(-deliveredItems.length);
    deliveredItems.forEach(function (entry, idx) {
      const applyRes = uc3ApplyLabelsFromDecision_(entry.thread, m4LastPass[idx].out, labelPrefix, labelCache);
      totalLabelApplyMs += applyRes.gmailLabelApplyMs;
      labelVerificationRows.push({
        emailId: entry.spec.id,
        appliedLabels: applyRes.appliedLabels,
        gmailLabelApplyMs: applyRes.gmailLabelApplyMs,
      });
    });

    // 9. Aggregate metrics (paired speedup, Multi-Label F1, separate thinking tokens, structured JSON)
    const m4ByPair = {};
    records.M4.forEach(function (r) {
      if (!r.httpFailed && r.out.retries === 0 && !isNaN(r.out.apiLatencyMs) && r.out.apiLatencyMs > 0) {
        m4ByPair[r.pairKey] = r.out.apiLatencyMs;
      }
    });

    const mdLines = [];
    mdLines.push('# Use Case 3: 4-Method Gmail Labeling Benchmark Report');
    mdLines.push('');
    mdLines.push('## Reproducibility Metadata');
    mdLines.push('- **UTC Timestamp**: ' + new Date().toISOString());
    mdLines.push('- **Run ID**: `' + runId + '`');
    mdLines.push('- **Baseline Model (M1-M3)**: `' + UC3B_BASELINE_MODEL + '` (`thinkingLevel=' + UC3B_BASELINE_THINKING_LEVEL + '`, `temperature=' + UC3B_TEMPERATURE + '`, `maxOutputTokens=' + UC3B_MAX_OUTPUT_TOKENS + '`)');
    mdLines.push('- **Decisions Model (M4)**: `' + GEMINI_DECISIONS_CONFIG.MODEL_DECISION + '`');
    mdLines.push('- **Corpus Size (N)**: ' + deliveredItems.length + ' | **Repeats (R)**: ' + UC3B_REPEATS + ' | **Warm-up**: 1/endpoint | **Order**: Interleaved Latin-Square');
    mdLines.push('- **Corpus SHA-256**: `' + corpusHash + '`');
    mdLines.push('- **Pricing Reference Date**: ' + GEMINI_PRICING_CONFIG.effectiveDate + ' (' + GEMINI_PRICING_CONFIG.sourceUrl + ')');
    mdLines.push('- **Post-Benchmark Gmail Label Apply Total (ms)**: ' + totalLabelApplyMs);
    mdLines.push('');
    mdLines.push('## Summary Table (Copy-Paste Ready for Table 2)');
    mdLines.push('');
    mdLines.push('| Method | Median (IQR) ms | Mean +/- SD ms | p95 ms | Paired Speedup vs M4 | Avg Input Tok | Avg Output Tok | Avg Think Tok | Est. Cost / 1k Emails | Cat Acc / Macro-F1 | Multi-Label F1 | Parse/HTTP Fails | Ambiguous NeedsReview |');
    mdLines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');

    const methodsSummary = [];
    const perTrialRecords = [];

    methods.forEach(function (method) {
      const list = records[method.id];
      const cleanList = list.filter(function (r) {
        return !r.httpFailed && r.out.retries === 0;
      });
      const stats = computeNumericStats_(cleanList.map(function (r) { return r.out.apiLatencyMs; }));

      // Paired speedup ratio: median(M_k / M_4) across matched (rep, email) pairs
      const pairedRatios = cleanList
        .filter(function (r) { return typeof m4ByPair[r.pairKey] === 'number'; })
        .map(function (r) { return r.out.apiLatencyMs / m4ByPair[r.pairKey]; });
      const pairedSpeedupNum = pairedRatios.length > 0 ? computeNumericStats_(pairedRatios).median : null;
      const pairedSpeedup = pairedSpeedupNum !== null ? pairedSpeedupNum.toFixed(2) + 'x' : 'N/A';

      const inToks = list.map(function (r) { return r.out.usage.inputTokens; }).filter(function (v) { return v !== null; });
      const candToks = list.map(function (r) { return r.out.usage.outputTokens; }).filter(function (v) { return v !== null; });
      const thinkToks = list.map(function (r) { return r.out.usage.thinkingTokens; }).filter(function (v) { return v !== null; });
      const cachedToks = list.map(function (r) { return r.out.usage.cachedTokens; }).filter(function (v) { return v !== null; });

      const avgIn = inToks.length > 0 ? computeNumericStats_(inToks).mean : null;
      const avgCand = candToks.length > 0 ? computeNumericStats_(candToks).mean : null;
      const avgThink = thinkToks.length > 0 ? computeNumericStats_(thinkToks).mean : null;
      const avgCached = cachedToks.length > 0 ? computeNumericStats_(cachedToks).mean : null;
      const costPer1k =
        avgIn !== null
          ? estimateCostUsd_(method.model, {
              inputTokens: avgIn * 1000,
              outputTokens: (avgCand || 0) * 1000,
              thinkingTokens: (avgThink || 0) * 1000,
            })
          : null;

      const clearList = list.filter(function (r) { return !r.spec.isAmbiguous; });
      const clearPairs = clearList.map(function (r) {
        return { expected: r.spec.expectedCategory, predicted: r.out.category };
      });
      const clearCorrect = clearPairs.filter(function (p) { return p.expected === p.predicted; }).length;
      const accNum = clearPairs.length > 0 ? (clearCorrect / clearPairs.length) * 100 : null;
      const accPct = accNum !== null ? accNum.toFixed(1) + '%' : 'N/A';
      const macroF1Num = uc3bComputeMacroF1_(clearPairs);
      const macroF1 = macroF1Num.toFixed(2);

      // Multi-Label micro-F1 over actionRequired + urgent boolean tags
      let mlTp = 0;
      let mlFp = 0;
      let mlFn = 0;
      clearList.forEach(function (r) {
        [
          [r.spec.expectedActionRequired, r.out.actionRequired],
          [r.spec.expectedUrgent, r.out.urgent],
        ].forEach(function (pair) {
          if (pair[0] && pair[1]) mlTp++;
          else if (!pair[0] && pair[1]) mlFp++;
          else if (pair[0] && !pair[1]) mlFn++;
        });
      });
      const mlPrec = mlTp + mlFp > 0 ? mlTp / (mlTp + mlFp) : 0;
      const mlRec = mlTp + mlFn > 0 ? mlTp / (mlTp + mlFn) : 0;
      const multiLabelF1Num = mlPrec + mlRec > 0 ? (2 * mlPrec * mlRec) / (mlPrec + mlRec) : 0;
      const multiLabelF1 = multiLabelF1Num.toFixed(2);

      const httpFailCount = list.filter(function (r) { return r.httpFailed; }).length;
      const parseFailCount = list.filter(function (r) { return !r.httpFailed && r.out.parseFailed; }).length;
      const failCount = httpFailCount + parseFailCount;
      const ambigList = list.filter(function (r) { return r.spec.isAmbiguous; });
      const ambigReview = ambigList.filter(function (r) { return r.out.needsReview; }).length;
      const ambigStr =
        method.id === 'M4'
          ? ambigReview + '/' + ambigList.length
          : 'N/A (no calibrated conf)';

      methodsSummary.push({
        methodId: method.id,
        methodName: method.name,
        model: method.model,
        cleanTrials: cleanList.length,
        totalTrials: list.length,
        medianMs: isNaN(stats.median) ? null : Number(stats.median.toFixed(1)),
        iqrMs: isNaN(stats.iqr) ? null : Number(stats.iqr.toFixed(1)),
        meanMs: isNaN(stats.mean) ? null : Number(stats.mean.toFixed(1)),
        sdMs: isNaN(stats.sd) ? null : Number(stats.sd.toFixed(1)),
        p95Ms: isNaN(stats.p95) ? null : Number(stats.p95.toFixed(1)),
        minMs: isNaN(stats.min) ? null : Number(stats.min.toFixed(1)),
        maxMs: isNaN(stats.max) ? null : Number(stats.max.toFixed(1)),
        pairedSpeedupVsM4: pairedSpeedupNum !== null ? Number(pairedSpeedupNum.toFixed(3)) : null,
        avgInputTokens: avgIn !== null ? Number(avgIn.toFixed(1)) : null,
        avgOutputTokens: avgCand !== null ? Number(avgCand.toFixed(1)) : null,
        avgThinkingTokens: avgThink !== null ? Number(avgThink.toFixed(1)) : null,
        avgCachedTokens: avgCached !== null ? Number(avgCached.toFixed(1)) : null,
        estCostPer1kEmailsUsd: costPer1k !== null ? Number(costPer1k.toFixed(6)) : null,
        categoryAccuracyPct: accNum !== null ? Number(accNum.toFixed(2)) : null,
        macroF1: Number(macroF1Num.toFixed(4)),
        multiLabelF1: Number(multiLabelF1Num.toFixed(4)),
        httpFailures: httpFailCount,
        parseFailures: parseFailCount,
        ambiguousNeedsReview: method.id === 'M4' ? ambigReview : null,
        ambiguousTotal: ambigList.length,
      });

      list.forEach(function (r) {
        perTrialRecords.push({
          rep: r.rep,
          emailId: r.spec.id,
          isAmbiguous: r.spec.isAmbiguous,
          methodId: method.id,
          apiLatencyMs: isNaN(r.out.apiLatencyMs) ? null : r.out.apiLatencyMs,
          parseMs: isNaN(r.out.parseMs) ? null : r.out.parseMs,
          retries: r.out.retries,
          httpFailed: r.httpFailed,
          parseFailed: r.out.parseFailed,
          expectedCategory: r.spec.expectedCategory,
          predictedCategory: r.out.category,
          confidence: r.out.confidence,
          needsReview: r.out.needsReview,
          expectedActionRequired: r.spec.expectedActionRequired,
          predictedActionRequired: r.out.actionRequired,
          expectedUrgent: r.spec.expectedUrgent,
          predictedUrgent: r.out.urgent,
          inputTokens: r.out.usage.inputTokens,
          outputTokens: r.out.usage.outputTokens,
          thinkingTokens: r.out.usage.thinkingTokens,
          error: r.out.error || null,
        });
      });

      mdLines.push(
        '| ' +
          method.name +
          ' | ' +
          (isNaN(stats.median) ? 'N/A' : Math.round(stats.median) + ' (' + Math.round(stats.iqr) + ')') +
          ' | ' +
          (isNaN(stats.mean) ? 'N/A' : Math.round(stats.mean) + ' +/- ' + Math.round(stats.sd)) +
          ' | ' +
          (isNaN(stats.p95) ? 'N/A' : Math.round(stats.p95)) +
          ' | ' +
          pairedSpeedup +
          ' | ' +
          (avgIn !== null ? Math.round(avgIn) : 'N/A') +
          ' | ' +
          (avgCand !== null ? Math.round(avgCand) : 'N/A') +
          ' | ' +
          (avgThink !== null ? Math.round(avgThink) : 'N/A') +
          ' | ' +
          (costPer1k !== null ? '$' + costPer1k.toFixed(4) : 'N/A') +
          ' | ' +
          accPct + ' / ' + macroF1 +
          ' | ' +
          multiLabelF1 +
          ' | ' +
          failCount + '/' + list.length +
          ' | ' +
          ambigStr +
          ' |'
      );
    });

    mdLines.push('');
    mdLines.push('## Per-Trial Raw Breakdown');
    mdLines.push('');
    mdLines.push('| Rep | Email ID | Method | API ms | Retries | Expected -> Predicted | Conf | Review | In / Out / Think Tok | Status |');
    mdLines.push('|---|---|---|---|---|---|---|---|---|---|');
    perTrialRecords.forEach(function (t) {
      mdLines.push(
        '| ' +
          t.rep +
          ' | ' +
          t.emailId +
          ' | ' +
          t.methodId +
          ' | ' +
          (t.apiLatencyMs !== null ? t.apiLatencyMs : 'ERR') +
          ' | ' +
          t.retries +
          ' | ' +
          t.expectedCategory + ' -> ' + t.predictedCategory +
          ' | ' +
          (t.confidence !== null ? t.confidence.toFixed(2) : 'N/A') +
          ' | ' +
          (t.needsReview ? 'YES' : 'no') +
          ' | ' +
          (t.inputTokens !== null ? t.inputTokens : 'N/A') + ' / ' +
          (t.outputTokens !== null ? t.outputTokens : 'N/A') + ' / ' +
          (t.thinkingTokens !== null ? t.thinkingTokens : 'N/A') +
          ' | ' +
          (t.httpFailed ? 'HTTP_ERR' : t.parseFailed ? 'PARSE_ERR' : 'OK') +
          ' |'
      );
    });

    const reportText = mdLines.join('\n');
    console.log(reportText);
    saveTestLogToDrive_(
      'UC3_GmailBenchmark_Log_' + runId,
      reportText,
      {
        schemaVersion: '1.0.0',
        utcTimestamp: new Date().toISOString(),
        runId: runId,
        baselineModel: UC3B_BASELINE_MODEL,
        baselineThinkingLevel: UC3B_BASELINE_THINKING_LEVEL,
        decisionsModel: GEMINI_DECISIONS_CONFIG.MODEL_DECISION,
        corpusSize: deliveredItems.length,
        repeats: UC3B_REPEATS,
        corpusSha256: corpusHash,
        pricingReference: GEMINI_PRICING_CONFIG,
        postBenchmarkLabelApplyTotalMs: totalLabelApplyMs,
        postBenchmarkLabelVerification: labelVerificationRows,
        totalWallClockMs: Date.now() - startMs,
        methodsSummary: methodsSummary,
        perTrialRecords: perTrialRecords,
      },
      true
    );
  } finally {
    cleanupGmailTestArtifacts_(runTag, labelPrefix, []);
    console.log('UC3B cleanup completed for tag ' + runTag + ' and label prefix ' + labelPrefix + '.');
  }
}
