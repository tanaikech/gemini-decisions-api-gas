/**
 * @fileoverview Zero-dependency Google Apps Script (GAS) client for the
 * Gemini Decisions API (gemini-decision-1) and standard Gemini generateContent
 * endpoints (gemini-3.8-flash, gemini-4-hydrogen), plus shared test/cleanup helpers.
 *
 * Design notes:
 * - All 5 .js files in src/ are designed to coexist in a single GAS V8 project.
 * - Private helper functions end with "_" so they stay hidden in the GAS Run dropdown.
 * - GEMINI_API_KEY is loaded lazily from Script Properties and sent exclusively
 *   via the "x-goog-api-key" HTTP header (never in URLs or error messages).
 */

const GEMINI_DECISIONS_CONFIG = {
  API_KEY_PROPERTY: 'GEMINI_API_KEY',
  DECISIONS_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/decisions',
  GENERATE_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/models',
  MODEL_DECISION: 'gemini-decision-1',
  MODEL_FLASH_BASELINE: 'gemini-3.8-flash',
  MODEL_REASONING_ESCALATION: 'gemini-4-hydrogen',
  MAX_QUESTIONS_PER_BATCH: 1000,
  MAX_INLINE_BYTES: 35 * 1024 * 1024, // 35 MB raw guard (<50 MB UrlFetchApp body cap after Base64)
  MAX_RETRIES: 3,
  INITIAL_BACKOFF_MS: 1000,
  SOFT_DEADLINE_MS: 270000, // 4.5 minutes (leaves >=90s before GAS 6-min hard kill for finally cleanup)
  POLL_TIMEOUT_MS: 60000,
  POLL_INTERVAL_MS: 3000,
  ALLOWED_ATTACHMENT_MIMES: [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain',
  ],
  TEST_LOG_FOLDER_NAME: 'GeminiDecisionsTestLogs',
};

/**
 * Editable reference pricing (USD per 1M tokens) verified as of 2026-11-23.
 * Source: https://ai.google.dev/gemini-api/docs/pricing
 * Note: gemini-3.8-flash introductory pricing ($0.75 in / $3.75 out) applies
 * through 2026-12-31 ($1.50 in / $7.50 out starting 2027-01-01).
 */
const GEMINI_PRICING_CONFIG = {
  effectiveDate: '2026-11-23',
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  models: {
    'gemini-decision-1': { inputPer1M: 0.10, outputPer1M: 0.00 },
    'gemini-3.8-flash': { inputPer1M: 0.75, outputPer1M: 3.75 },
    'gemini-4-hydrogen': { inputPer1M: 1.50, outputPer1M: 7.50 },
  },
};

/**
 * Lazily retrieves GEMINI_API_KEY from Script Properties.
 * @return {string}
 */
function getGeminiApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty(
    GEMINI_DECISIONS_CONFIG.API_KEY_PROPERTY
  );
  if (!key || !String(key).trim()) {
    throw new Error(
      'Missing Script Property "' +
        GEMINI_DECISIONS_CONFIG.API_KEY_PROPERTY +
        '". Set it in Project Settings -> Script Properties.'
    );
  }
  return String(key).trim();
}

/**
 * Pre-flight validation executed before creating any temporary Drive/Gmail resources.
 * @param {number=} requiredEmailQuota Minimum remaining daily email quota needed (0 if none).
 * @return {{ apiKeyPresent: boolean, userEmail: string, remainingQuota: number }}
 */
function preflightCheck_(requiredEmailQuota) {
  getGeminiApiKey_();
  let userEmail = '';
  let remainingQuota = 0;

  if (requiredEmailQuota && requiredEmailQuota > 0) {
    userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) {
      throw new Error(
        'Session.getActiveUser().getEmail() returned empty. Ensure ' +
          '"https://www.googleapis.com/auth/userinfo.email" is in appsscript.json and re-authorize.'
      );
    }
    remainingQuota = MailApp.getRemainingDailyQuota();
    if (remainingQuota < requiredEmailQuota) {
      throw new Error(
        'Insufficient MailApp daily quota: remaining=' +
          remainingQuota +
          ', required=' +
          requiredEmailQuota
      );
    }
  }
  return { apiKeyPresent: true, userEmail: userEmail, remainingQuota: remainingQuota };
}

/**
 * Enforces a soft wall-clock deadline so GAS enters finally cleanup before the 360s hard kill.
 * @param {number} startTimeMs Timestamp from Date.now().
 * @param {number=} maxMs Optional override (defaults to GEMINI_DECISIONS_CONFIG.SOFT_DEADLINE_MS).
 * @param {string=} stageLabel Context label for diagnostics.
 */
function assertTimeBudget_(startTimeMs, maxMs, stageLabel) {
  const limit = maxMs || GEMINI_DECISIONS_CONFIG.SOFT_DEADLINE_MS;
  const elapsed = Date.now() - startTimeMs;
  if (elapsed >= limit) {
    const err = new Error(
      'TimeBudgetExceededError at "' +
        (stageLabel || 'unknown') +
        '": elapsed ' +
        elapsed +
        'ms >= soft limit ' +
        limit +
        'ms. Aborting cleanly to guarantee finally cleanup.'
    );
    err.name = 'TimeBudgetExceededError';
    throw err;
  }
}

/**
 * Executes an HTTP POST to a Gemini endpoint with x-goog-api-key header,
 * muteHttpExceptions, and bounded exponential backoff on HTTP 429/5xx.
 * @param {string} url
 * @param {Object} payload
 * @return {{ statusCode: number, body: Object, apiLatencyMs: number, retries: number }}
 */
function postGeminiJsonWithRetry_(url, payload) {
  const apiKey = getGeminiApiKey_();
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  let retries = 0;
  for (let attempt = 0; attempt <= GEMINI_DECISIONS_CONFIG.MAX_RETRIES; attempt++) {
    const t0 = Date.now();
    const response = UrlFetchApp.fetch(url, options);
    const apiLatencyMs = Date.now() - t0;
    const statusCode = response.getResponseCode();
    const rawText = response.getContentText();

    if (statusCode >= 200 && statusCode < 300) {
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (parseErr) {
        throw new Error('Failed to parse JSON response (HTTP ' + statusCode + '): ' + parseErr.message);
      }
      return { statusCode: statusCode, body: parsed, apiLatencyMs: apiLatencyMs, retries: retries };
    }

    const isRetryable = statusCode === 429 || (statusCode >= 500 && statusCode < 600);
    if (isRetryable && attempt < GEMINI_DECISIONS_CONFIG.MAX_RETRIES) {
      retries += 1;
      const sleepMs = GEMINI_DECISIONS_CONFIG.INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      Utilities.sleep(sleepMs);
      continue;
    }

    const safeSnippet = String(rawText || '').slice(0, 600);
    throw new Error('Gemini API HTTP ' + statusCode + ' error: ' + safeSnippet);
  }
  throw new Error('Gemini API request exhausted all retry attempts.');
}

/**
 * Builds typed multimodal input blocks for POST /v1beta/decisions.
 * @param {string} textContent Primary text content.
 * @param {Array<{ name: string, mimeType: string, base64Data: string, bytesLength: number }>=} attachments
 * @return {string|Array<Object>}
 */
function buildMultimodalDecisionInput_(textContent, attachments) {
  if (!attachments || attachments.length === 0) {
    return String(textContent || '');
  }
  const blocks = [];
  if (textContent) {
    blocks.push({ type: 'text', text: String(textContent) });
  }
  attachments.forEach(function (att) {
    if (!att || !att.base64Data) return;
    if (att.mimeType === 'application/pdf') {
      blocks.push({
        type: 'document',
        data: att.base64Data,
        mime_type: att.mimeType,
      });
    } else if (att.mimeType.indexOf('image/') === 0) {
      blocks.push({
        type: 'image',
        data: att.base64Data,
        mime_type: att.mimeType,
        resolution: 'medium',
      });
    } else if (att.mimeType === 'text/plain') {
      const decoded = Utilities.newBlob(Utilities.base64Decode(att.base64Data)).getDataAsString('UTF-8');
      blocks.push({ type: 'text', text: '[Attachment: ' + att.name + ']\n' + decoded });
    }
  });
  return blocks;
}

/**
 * Builds standard generateContent parts array (text + inlineData) for Methods 1-3 and UC2 escalation.
 * @param {string} promptText
 * @param {Array<{ name: string, mimeType: string, base64Data: string, bytesLength: number }>=} attachments
 * @return {Array<Object>}
 */
function buildGenerateContentParts_(promptText, attachments) {
  const parts = [{ text: String(promptText || '') }];
  if (!attachments || attachments.length === 0) {
    return parts;
  }
  attachments.forEach(function (att) {
    if (!att || !att.base64Data) return;
    if (att.mimeType === 'text/plain') {
      const decoded = Utilities.newBlob(Utilities.base64Decode(att.base64Data)).getDataAsString('UTF-8');
      parts.push({ text: '[Attachment: ' + att.name + ']\n' + decoded });
    } else {
      parts.push({
        inlineData: {
          mimeType: att.mimeType,
          data: att.base64Data,
        },
      });
    }
  });
  return parts;
}

/**
 * Extracts whitelisted, size-guarded inline Base64 attachments from a GmailMessage.
 * @param {GoogleAppsScript.Gmail.GmailMessage} message
 * @return {Array<{ name: string, mimeType: string, base64Data: string, bytesLength: number }>}
 */
function extractSafeGmailAttachments_(message) {
  const out = [];
  let totalBytes = 0;
  const rawAttachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
  rawAttachments.forEach(function (blob) {
    const mimeType = String(blob.getContentType() || '').split(';')[0].trim().toLowerCase();
    const name = blob.getName() || 'attachment';
    if (GEMINI_DECISIONS_CONFIG.ALLOWED_ATTACHMENT_MIMES.indexOf(mimeType) === -1) {
      console.warn('Skipping unsupported attachment MIME type "' + mimeType + '" (' + name + ').');
      return;
    }
    const bytes = blob.getBytes();
    if (totalBytes + bytes.length > GEMINI_DECISIONS_CONFIG.MAX_INLINE_BYTES) {
      console.warn(
        'Skipping oversized attachment "' +
          name +
          '" (' +
          bytes.length +
          ' bytes). Exceeds 35 MB UrlFetchApp inline guard; use Gemini Files API for larger files.'
      );
      return;
    }
    totalBytes += bytes.length;
    out.push({
      name: name,
      mimeType: mimeType,
      base64Data: Utilities.base64Encode(bytes),
      bytesLength: bytes.length,
    });
  });
  return out;
}

/**
 * Normalizes a single answer entry from POST /v1beta/decisions across proto-JSON variants.
 * @param {Object} rawAnswer
 * @return {{ noul: (number|null), choice: (string|null), score: (number|null), probabilities: (Object|null), confidence: (number|null), raw: Object }}
 */
function normalizeDecisionAnswer_(rawAnswer) {
  const ans = rawAnswer || {};
  const noulVal =
    typeof ans.noul === 'number'
      ? ans.noul
      : typeof ans.probability === 'number'
      ? ans.probability
      : null;
  const choiceVal =
    typeof ans.choice === 'string'
      ? ans.choice
      : typeof ans.selected === 'string'
      ? ans.selected
      : typeof ans.value === 'string'
      ? ans.value
      : null;
  const scoreVal =
    typeof ans.score === 'number'
      ? ans.score
      : typeof ans.expected_score === 'number'
      ? ans.expected_score
      : typeof ans.expectedScore === 'number'
      ? ans.expectedScore
      : null;
  let confidenceVal = typeof ans.confidence === 'number' ? ans.confidence : null;
  if (confidenceVal === null && noulVal !== null) {
    confidenceVal = Math.max(noulVal, 1 - noulVal);
  }
  if (
    confidenceVal === null &&
    choiceVal !== null &&
    ans.probabilities &&
    typeof ans.probabilities[choiceVal] === 'number'
  ) {
    confidenceVal = ans.probabilities[choiceVal];
  }
  return {
    noul: noulVal,
    choice: choiceVal,
    score: scoreVal,
    probabilities: ans.probabilities || null,
    confidence: confidenceVal,
    raw: ans,
  };
}

/**
 * Calls POST https://generativelanguage.googleapis.com/v1beta/decisions (gemini-decision-1).
 * @param {string|Array<Object>} sharedInput Text string or multimodal blocks array.
 * @param {Object<string, Object>} questions Map of questionId -> { type, instructions, criteria? }.
 * @param {string=} modelOverride Defaults to GEMINI_DECISIONS_CONFIG.MODEL_DECISION.
 * @return {{ answers: Object, usage: Object, apiLatencyMs: number, retries: number, raw: Object }}
 */
function callGeminiDecisionsApi_(sharedInput, questions, modelOverride) {
  const questionKeys = Object.keys(questions || {});
  if (questionKeys.length === 0) {
    throw new Error('callGeminiDecisionsApi_: questions map must not be empty.');
  }
  if (questionKeys.length > GEMINI_DECISIONS_CONFIG.MAX_QUESTIONS_PER_BATCH) {
    throw new Error(
      'callGeminiDecisionsApi_: question count (' +
        questionKeys.length +
        ') exceeds limit of ' +
        GEMINI_DECISIONS_CONFIG.MAX_QUESTIONS_PER_BATCH +
        '. Chunk questions before calling.'
    );
  }

  const payload = {
    model: modelOverride || GEMINI_DECISIONS_CONFIG.MODEL_DECISION,
    input: sharedInput,
    questions: questions,
  };

  const res = postGeminiJsonWithRetry_(GEMINI_DECISIONS_CONFIG.DECISIONS_ENDPOINT, payload);
  const rawAnswers = res.body.answers || res.body.decisions || {};
  const normalizedAnswers = {};
  questionKeys.forEach(function (qId) {
    normalizedAnswers[qId] = normalizeDecisionAnswer_(rawAnswers[qId]);
  });

  const usageRaw = res.body.usage || res.body.usageMetadata || {};
  const inputTokens =
    typeof usageRaw.totalInputTokens === 'number'
      ? usageRaw.totalInputTokens
      : typeof usageRaw.total_input_tokens === 'number'
      ? usageRaw.total_input_tokens
      : typeof usageRaw.promptTokenCount === 'number'
      ? usageRaw.promptTokenCount
      : null;

  const usage = {
    inputTokens: inputTokens,
    outputTokens: 0, // Gemini Decisions API strictly produces 0 output tokens
    thinkingTokens: 0,
    cachedTokens: null,
  };

  return {
    answers: normalizedAnswers,
    usage: usage,
    apiLatencyMs: res.apiLatencyMs,
    retries: res.retries,
    raw: res.body,
  };
}

/**
 * Calls standard Gemini generateContent endpoint with explicit thinkingLevel control.
 * @param {string} modelId e.g. 'gemini-3.8-flash' or 'gemini-4-hydrogen'
 * @param {Object} requestBody Standard generateContent payload.
 * @return {{ text: string, functionCall: (Object|null), usage: Object, apiLatencyMs: number, retries: number, raw: Object }}
 */
function callGeminiGenerateContent_(modelId, requestBody) {
  const url = GEMINI_DECISIONS_CONFIG.GENERATE_BASE_URL + '/' + encodeURIComponent(modelId) + ':generateContent';
  const res = postGeminiJsonWithRetry_(url, requestBody);
  const candidates = res.body.candidates || [];
  const firstCandidate = candidates[0] || {};
  const parts = (firstCandidate.content && firstCandidate.content.parts) || [];

  let textOut = '';
  let fnCall = null;
  parts.forEach(function (part) {
    if (part.functionCall && !fnCall) {
      fnCall = part.functionCall;
    } else if (typeof part.text === 'string' && !part.thought) {
      textOut += part.text;
    }
  });

  const u = res.body.usageMetadata || {};
  const usage = {
    inputTokens: typeof u.promptTokenCount === 'number' ? u.promptTokenCount : null,
    outputTokens: typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : null,
    thinkingTokens: typeof u.thoughtsTokenCount === 'number' ? u.thoughtsTokenCount : null,
    cachedTokens: typeof u.cachedContentTokenCount === 'number' ? u.cachedContentTokenCount : null,
  };

  return {
    text: textOut.trim(),
    functionCall: fnCall,
    usage: usage,
    apiLatencyMs: res.apiLatencyMs,
    retries: res.retries,
    raw: res.body,
  };
}

/**
 * Estimates USD cost from token counts using GEMINI_PRICING_CONFIG.
 * Returns null if required token counts or model pricing are unavailable.
 * @param {string} modelId
 * @param {{ inputTokens: (number|null), outputTokens: (number|null), thinkingTokens: (number|null) }} usage
 * @return {(number|null)}
 */
function estimateCostUsd_(modelId, usage) {
  const rate = GEMINI_PRICING_CONFIG.models[modelId];
  if (!rate || !usage || usage.inputTokens === null) return null;
  const billedOutput =
    (usage.outputTokens !== null ? usage.outputTokens : 0) +
    (usage.thinkingTokens !== null ? usage.thinkingTokens : 0);
  const inputCost = (usage.inputTokens / 1e6) * rate.inputPer1M;
  const outputCost = (billedOutput / 1e6) * rate.outputPer1M;
  return inputCost + outputCost;
}

/**
 * Gets or creates a GmailLabel using a per-run Map cache to avoid redundant RPCs.
 * @param {string} labelName
 * @param {Map<string, GoogleAppsScript.Gmail.GmailLabel>} cacheMap
 * @return {GoogleAppsScript.Gmail.GmailLabel}
 */
function getOrCreateCachedLabel_(labelName, cacheMap) {
  if (cacheMap.has(labelName)) {
    return cacheMap.get(labelName);
  }
  let label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    label = GmailApp.createLabel(labelName);
  }
  cacheMap.set(labelName, label);
  return label;
}

/**
 * Polls Gmail Inbox until expectedCount self-sent threads with subjectTag arrive.
 * @param {string} subjectTag Unique tag embedded in test email subjects.
 * @param {number} expectedCount
 * @param {number} testStartMs Overall test start timestamp for soft deadline enforcement.
 * @return {Array<GoogleAppsScript.Gmail.GmailThread>}
 */
function pollInboxBySubjectTag_(subjectTag, expectedCount, testStartMs) {
  const pollStart = Date.now();
  const query = 'in:inbox subject:"' + subjectTag + '"';
  let threads = [];

  while (Date.now() - pollStart < GEMINI_DECISIONS_CONFIG.POLL_TIMEOUT_MS) {
    assertTimeBudget_(testStartMs, GEMINI_DECISIONS_CONFIG.SOFT_DEADLINE_MS, 'pollInboxBySubjectTag_');
    threads = GmailApp.search(query, 0, Math.max(expectedCount * 2, 20));
    if (threads.length >= expectedCount) {
      return threads;
    }
    Utilities.sleep(GEMINI_DECISIONS_CONFIG.POLL_INTERVAL_MS);
  }
  throw new Error(
    'Timed out waiting for ' +
      expectedCount +
      ' test email(s) matching ' +
      query +
      ' (found ' +
      threads.length +
      ' after ' +
      GEMINI_DECISIONS_CONFIG.POLL_TIMEOUT_MS +
      'ms).'
  );
}

/**
 * Safely cleans up temporary Gmail drafts, threads (Sent+Inbox), and nested labels.
 * Each step is isolated in its own try/catch so one error never aborts remaining cleanup.
 * @param {string} runTag Unique tag embedded in test email subjects.
 * @param {string} labelPrefix Prefix of temporary labels created for this run.
 * @param {Array<GoogleAppsScript.Gmail.GmailDraft>=} trackedDrafts
 */
function cleanupGmailTestArtifacts_(runTag, labelPrefix, trackedDrafts) {
  // 1. Delete tracked drafts first
  (trackedDrafts || []).forEach(function (draft) {
    try {
      if (draft) draft.deleteDraft();
    } catch (e) {
      console.warn('Cleanup warning (tracked draft): ' + e.message);
    }
  });

  // 2. Sweep any remaining drafts matching runTag via GmailApp.getDrafts()
  try {
    const allDrafts = GmailApp.getDrafts();
    allDrafts.forEach(function (draft) {
      try {
        const subj = draft.getMessage().getSubject() || '';
        if (subj.indexOf(runTag) !== -1) {
          draft.deleteDraft();
        }
      } catch (innerErr) {
        console.warn('Cleanup warning (draft sweep): ' + innerErr.message);
      }
    });
  } catch (e) {
    console.warn('Cleanup warning (draft list): ' + e.message);
  }

  // 3. Brief pause for in-flight self-sent emails, then trash all matching threads across Sent+Inbox
  try {
    Utilities.sleep(2000);
    const allThreads = GmailApp.search('in:anywhere "' + runTag + '"', 0, 100);
    if (allThreads.length > 0) {
      GmailApp.moveThreadsToTrash(allThreads);
    }
  } catch (e) {
    console.warn('Cleanup warning (threads moveToTrash): ' + e.message);
  }

  // 4. Delete nested labels deepest-first (child sublabels before parent label)
  if (labelPrefix) {
    try {
      const matchingLabels = GmailApp.getUserLabels().filter(function (lbl) {
        const name = lbl.getName();
        return name === labelPrefix || name.indexOf(labelPrefix + '/') === 0;
      });
      matchingLabels.sort(function (a, b) {
        const depthA = a.getName().split('/').length;
        const depthB = b.getName().split('/').length;
        if (depthB !== depthA) return depthB - depthA;
        return b.getName().length - a.getName().length;
      });
      matchingLabels.forEach(function (lbl) {
        try {
          lbl.deleteLabel();
        } catch (innerErr) {
          console.warn('Cleanup warning (label "' + lbl.getName() + '"): ' + innerErr.message);
        }
      });
    } catch (e) {
      console.warn('Cleanup warning (label sweep): ' + e.message);
    }
  }
}

/**
 * Computes SHA-256 hex digest of a UTF-8 string using GAS Utilities.computeDigest.
 * @param {string} text
 * @return {string}
 */
function sha256Hex_(text) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text || ''),
    Utilities.Charset.UTF_8
  );
  return bytes
    .map(function (b) {
      const v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    })
    .join('');
}

/**
 * Saves a structured Markdown + JSON test log file to Google Drive under
 * GEMINI_DECISIONS_CONFIG.TEST_LOG_FOLDER_NAME so the user can easily inspect
 * and share manual GAS test results. Log files are intentionally preserved
 * after temporary test resources are cleaned up.
 *
 * @param {string} baseFileName File name without extension (e.g. 'UC3_GmailBenchmark_Log_20261123_120000').
 * @param {string} markdownReport Human-readable Markdown report (including tables).
 * @param {Object=} rawJsonSummary Optional structured JSON summary appended in a fenced block.
 * @return {{ fileId: string, fileName: string, fileUrl: string }}
 */
function saveTestLogToDrive_(baseFileName, markdownReport, rawJsonSummary, alsoSaveSeparateJson) {
  const folderName = GEMINI_DECISIONS_CONFIG.TEST_LOG_FOLDER_NAME;
  const folders = DriveApp.getFoldersByName(folderName);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);

  const fileName = baseFileName + '.md';
  let fullContent = String(markdownReport || '');
  if (rawJsonSummary) {
    fullContent +=
      '\n\n## Raw JSON Summary\n\n```json\n' +
      JSON.stringify(rawJsonSummary, null, 2) +
      '\n```\n';
  }

  const file = folder.createFile(fileName, fullContent, MimeType.PLAIN_TEXT);
  const info = {
    fileId: file.getId(),
    fileName: fileName,
    fileUrl: file.getUrl(),
    jsonFileUrl: null,
  };
  console.log('Saved Markdown log to Google Drive (' + folderName + '/' + fileName + '): ' + info.fileUrl);

  if (alsoSaveSeparateJson && rawJsonSummary) {
    const jsonName = baseFileName + '.json';
    const jsonFile = folder.createFile(
      jsonName,
      JSON.stringify(rawJsonSummary, null, 2),
      MimeType.PLAIN_TEXT
    );
    info.jsonFileUrl = jsonFile.getUrl();
    console.log('Saved JSON log to Google Drive (' + folderName + '/' + jsonName + '): ' + info.jsonFileUrl);
  }
  return info;
}

/**
 * Computes summary statistics (mean, sd, median, iqr, p95, min, max) for numeric values.
 * @param {Array<number>} values
 * @return {{ count: number, mean: number, sd: number, median: number, iqr: number, p95: number, min: number, max: number }}
 */
function computeNumericStats_(values) {
  const clean = (values || []).filter(function (v) {
    return typeof v === 'number' && !isNaN(v);
  });
  if (clean.length === 0) {
    return { count: 0, mean: NaN, sd: NaN, median: NaN, iqr: NaN, p95: NaN, min: NaN, max: NaN };
  }
  const sorted = clean.slice().sort(function (a, b) {
    return a - b;
  });
  const n = sorted.length;
  const mean =
    sorted.reduce(function (acc, v) {
      return acc + v;
    }, 0) / n;
  const variance =
    n > 1
      ? sorted.reduce(function (acc, v) {
          return acc + Math.pow(v - mean, 2);
        }, 0) /
        (n - 1)
      : 0;
  const percentile = function (p) {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  return {
    count: n,
    mean: mean,
    sd: Math.sqrt(variance),
    median: percentile(0.5),
    iqr: percentile(0.75) - percentile(0.25),
    p95: percentile(0.95),
    min: sorted[0],
    max: sorted[n - 1],
  };
}
