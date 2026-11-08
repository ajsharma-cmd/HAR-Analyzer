const REDACTED = '[REDACTED]';
const SENSITIVE_NAME =
  /(?:^|[^a-z0-9])(?:authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|passphrase|secret|api[_-]?key|apikey|client[_-]?secret|session(?:[_-]?id)?|credential|jwt|signature|sig|code[_-]?verifier|oauth[_-]?code|auth[_-]?code)(?=$|[^a-z0-9])/i;

function isSensitiveName(value) {
  return SENSITIVE_NAME.test(String(value ?? '').replace(/[A-Z]/g, (letter) => letter));
}

function decodeQueryKey(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function redactUrl(value, state) {
  if (typeof value !== 'string') return value;
  let result = value;
  try {
    const parsed = new URL(value);
    if (parsed.username) {
      parsed.username = REDACTED;
      state.count += 1;
    }
    if (parsed.password) {
      parsed.password = REDACTED;
      state.count += 1;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) result = parsed.href;
  } catch {
    // Relative URLs are still handled by the query-string pass below.
  }

  const hashIndex = result.indexOf('#');
  const fragment = hashIndex >= 0 ? result.slice(hashIndex) : '';
  const withoutFragment = hashIndex >= 0 ? result.slice(0, hashIndex) : result;
  const queryIndex = withoutFragment.indexOf('?');
  if (queryIndex < 0) return withoutFragment + fragment;
  const prefix = withoutFragment.slice(0, queryIndex);
  const query = withoutFragment.slice(queryIndex + 1);
  const redactedQuery = query
    .split('&')
    .map((part) => {
      if (!part) return part;
      const equalsIndex = part.indexOf('=');
      const rawKey = equalsIndex >= 0 ? part.slice(0, equalsIndex) : part;
      if (!isSensitiveName(decodeQueryKey(rawKey))) return part;
      state.count += 1;
      return `${rawKey}=${REDACTED}`;
    })
    .join('&');
  return `${prefix}?${redactedQuery}${fragment}`;
}

function redactInlineSecrets(value, state) {
  let result = value;
  const beforeBearer = result;
  result = result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`);
  if (result !== beforeBearer) state.count += 1;

  const beforeJwt = result;
  result = result.replace(
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    REDACTED,
  );
  if (result !== beforeJwt) state.count += 1;

  const secretAssignment =
    /(["']?)(authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|passphrase|secret|api[_-]?key|apikey|client[_-]?secret|session(?:[_-]?id)?|credential|jwt|signature|sig|code[_-]?verifier|oauth[_-]?code|auth[_-]?code)(["']?\s*[:=]\s*["']?)([^"'&\s,;}]+)(["']?)/gi;
  result = result.replace(secretAssignment, (_match, leadingQuote, name, separator, _secret, trailingQuote) => {
    state.count += 1;
    return `${leadingQuote}${name}${separator}${REDACTED}${trailingQuote}`;
  });
  return result;
}

function redactBodyText(value, state, mimeType = '') {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return JSON.stringify(redactNode(parsed, state, '', null));
    }
  } catch {
    // HAR bodies are often form-encoded or plain text rather than JSON.
  }

  if (
    /application\/x-www-form-urlencoded/i.test(mimeType) ||
    /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(value.trim())
  ) {
    const params = new URLSearchParams(value);
    let changed = false;
    for (const key of [...params.keys()]) {
      if (!isSensitiveName(key)) continue;
      params.set(key, REDACTED);
      state.count += 1;
      changed = true;
    }
    if (changed) return params.toString();
  }
  return redactInlineSecrets(value, state);
}

function redactHeaderArray(headers, state) {
  if (!Array.isArray(headers)) return headers;
  return headers
    .filter((header) => {
      const name = header && typeof header === 'object' ? header.name : '';
      if (!isSensitiveName(name)) return true;
      state.count += 1;
      return false;
    })
    .map((header) => redactNode(header, state, '', null));
}

function redactNamedParams(params, state) {
  if (!Array.isArray(params)) return params;
  return params.map((param) => {
    if (!param || typeof param !== 'object' || Array.isArray(param)) {
      return redactNode(param, state, '', null);
    }
    const copy = {};
    for (const [key, value] of Object.entries(param)) {
      if (key.toLowerCase() === 'value' && isSensitiveName(param.name)) {
        copy[key] = REDACTED;
        state.count += 1;
      } else {
        copy[key] = redactNode(value, state, key, param);
      }
    }
    return copy;
  });
}

function redactNode(value, state, key, parent) {
  if (typeof value === 'string') {
    if (key === 'url' || key === 'redirectURL' || key === 'href') {
      return redactUrl(value, state);
    }
    if (key === 'text' && parent && (parent.mimeType || key === 'text')) {
      return redactBodyText(value, state, String(parent.mimeType ?? ''));
    }
    if (isSensitiveName(key)) {
      state.count += 1;
      return REDACTED;
    }
    return redactInlineSecrets(value, state);
  }
  if (Array.isArray(value)) return value.map((item) => redactNode(item, state, '', null));
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const normalizedKey = childKey.toLowerCase();
    if (normalizedKey === 'headers') {
      output[childKey] = redactHeaderArray(childValue, state);
    } else if (normalizedKey === 'cookies') {
      const count = Array.isArray(childValue) ? childValue.length : childValue ? 1 : 0;
      state.count += count;
      output[childKey] = [];
    } else if (normalizedKey === 'querystring' || normalizedKey === 'params') {
      output[childKey] = redactNamedParams(childValue, state);
    } else if (
      normalizedKey === 'url' ||
      normalizedKey === 'redirecturl' ||
      normalizedKey === 'href'
    ) {
      output[childKey] = redactUrl(String(childValue ?? ''), state);
    } else if (isSensitiveName(childKey)) {
      state.count += 1;
      output[childKey] = REDACTED;
    } else if (normalizedKey === 'text' && typeof childValue === 'string') {
      if (String(value.encoding ?? '').toLowerCase() === 'base64') {
        state.count += 1;
        output[childKey] = '[REDACTED: encoded body removed]';
      } else {
        output[childKey] = redactBodyText(childValue, state, String(value.mimeType ?? ''));
      }
    } else {
      output[childKey] = redactNode(childValue, state, childKey, value);
    }
  }
  return output;
}

export function redactHar(har) {
  if (!har || typeof har !== 'object' || Array.isArray(har)) {
    throw new Error('The HAR data could not be sanitized.');
  }
  const state = { count: 0 };
  const sanitized = redactNode(har, state, '', null);
  return { har: sanitized, redactedCount: state.count };
}

function redactDisplayUrl(value) {
  const state = { count: 0 };
  return redactUrl(String(value ?? ''), state);
}

function formatDuration(ms) {
  const safeMs = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  return safeMs < 1000 ? `${Math.round(safeMs)} ms` : `${(safeMs / 1000).toFixed(2)} s`;
}

function makeReportData({ fileName, requests, totalTime, failedCount, analysis }) {
  return {
    fileName: String(fileName ?? ''),
    requestCount: requests.length,
    failedCount,
    totalTime: formatDuration(totalTime),
    verdict: analysis.verdict,
    timeline: analysis.timeline,
    findings: analysis.findings.map((finding) => ({
      ...finding,
      urls: finding.urls.map(redactDisplayUrl),
    })),
  };
}

function formatTimeline(timeline) {
  if (!timeline || timeline.anchor === 'none') return 'Timing information is not available.';
  if (timeline.offsetMs === null) return 'No error timing is recorded.';
  const anchorName = timeline.anchor === 'page-load' ? 'page load' : 'first recorded request';
  const amount = formatDuration(Math.abs(timeline.offsetMs));
  return `${amount} ${timeline.offsetMs < 0 ? 'before' : 'after'} ${anchorName}`;
}

export function buildSummaryText(options) {
  const data = makeReportData(options);
  const lines = [
    'HAR Analyzer support summary',
    `File: ${data.fileName}`,
    `Verdict: ${data.verdict}`,
    `Requests: ${data.requestCount}`,
    `Failed requests: ${data.failedCount}`,
    `Total request time: ${data.totalTime}`,
    `Timeline: ${formatTimeline(data.timeline)}`,
  ];
  if (data.findings.length) {
    lines.push('', 'Findings:');
    for (const finding of data.findings) {
      lines.push(
        '',
        `[${finding.severity === 'problem' ? 'Problem' : 'Warning'}] ${finding.title}`,
        finding.explanation,
      );
      if (finding.urls.length) {
        lines.push('Affected URLs:', ...finding.urls.map((url) => `- ${url}`));
      }
      if (finding.whatToRecheck.length) {
        lines.push('What to re-check:', ...finding.whatToRecheck.map((item) => `- ${item}`));
      }
    }
  } else {
    lines.push('', 'No notable network issues were found in this recording.');
  }
  lines.push('', 'Sensitive headers, query values, and common token/password fields are redacted in this summary.');
  return lines.join('\n');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildReportHtml(options) {
  const data = makeReportData(options);
  const findings = data.findings.length
    ? data.findings
        .map(
          (finding) => `
            <article class="finding ${escapeHtml(finding.severity)}">
              <p class="severity">${finding.severity === 'problem' ? 'Problem' : 'Warning'}</p>
              <h2>${escapeHtml(finding.title)}</h2>
              <p>${escapeHtml(finding.explanation)}</p>
              ${
                finding.urls.length
                  ? `<h3>Affected URLs</h3><ul>${finding.urls.map((url) => `<li><code>${escapeHtml(url)}</code></li>`).join('')}</ul>`
                  : ''
              }
              ${
                finding.whatToRecheck.length
                  ? `<h3>What to re-check</h3><ul>${finding.whatToRecheck.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
                  : ''
              }
            </article>`
        )
        .join('')
    : '<p class="healthy">No notable network issues were found in this recording.</p>';
  const summary = buildSummaryText(options);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>HAR Analyzer report</title>
  <style>
    :root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#26363a;background:#f7f6f1}
    body{max-width:900px;margin:0 auto;padding:40px 24px;line-height:1.6}
    header,.finding,.healthy{background:#fffefa;border:1px solid #e5e0d7;border-radius:12px;padding:22px;margin:0 0 16px}
    h1{font-size:28px;margin:0 0 4px}.subtitle,.privacy{color:#687771;font-size:13px}
    .verdict{font-size:20px;font-weight:700;color:${data.verdict === 'Problems found' ? '#a53c34' : data.verdict === 'Warnings' ? '#856013' : '#287267'}}
    .stats{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.stats span{background:#f2f2eb;border-radius:7px;padding:8px 11px;font-size:13px}
    .finding{border-left:4px solid ${'#c45145'}}.finding.warning{border-left-color:#c5942b}
    .severity{font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin:0;color:#a53c34}.warning .severity{color:#856013}
    h2{font-size:18px;margin:5px 0}.finding h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:16px 0 5px;color:#53645d}
    ul{padding-left:20px;margin:6px 0}.finding li{margin:4px 0}code{font-size:12px;overflow-wrap:anywhere}
    .timeline{padding:12px;background:#eff3ec;border-radius:8px}.privacy{margin-top:22px}
    @media print{body{padding:0;background:#fff}header,.finding,.healthy{break-inside:avoid;box-shadow:none}}
  </style>
</head>
<body>
  <header>
    <h1>HAR Analyzer report</h1>
    <p class="subtitle">${escapeHtml(data.fileName)}</p>
    <p class="verdict">${escapeHtml(data.verdict)}</p>
    <div class="stats"><span>${data.requestCount.toLocaleString()} requests</span><span>${data.failedCount.toLocaleString()} failed</span><span>${escapeHtml(data.totalTime)} total request time</span></div>
    <p class="timeline"><strong>Timeline:</strong> ${escapeHtml(formatTimeline(data.timeline))}</p>
  </header>
  ${findings}
  <p class="privacy">Privacy note: this report is created in your browser. Common sensitive headers, query values, and token/password fields are redacted from URLs shown here. Review it before sharing.</p>
  <details><summary>Copyable text version</summary><pre>${escapeHtml(summary)}</pre></details>
</body>
</html>`;
}

export function downloadTextFile(fileName, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
