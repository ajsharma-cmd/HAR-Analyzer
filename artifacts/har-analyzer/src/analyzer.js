const TWO_MEGABYTES = 2 * 1024 * 1024;
const LARGE_UNCOMPRESSED_BYTES = 100 * 1024;

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requestUrl(entry) {
  return asText(asRecord(asRecord(entry).request).url);
}

function responseStatus(entry) {
  return finite(asRecord(asRecord(entry).response).status);
}

function requestMethod(entry) {
  return asText(asRecord(asRecord(entry).request).method).toUpperCase();
}

function responseSize(entry) {
  const response = asRecord(asRecord(entry).response);
  const contentSize = finite(asRecord(response.content).size);
  const bodySize = finite(response.bodySize);
  return contentSize !== null && contentSize >= 0 ? contentSize : bodySize;
}

function blockedDuration(entry) {
  const record = asRecord(entry);
  const timings = asRecord(record.timings);
  const values = [finite(timings.blocked), finite(record.blockedTime)].filter(
    (value) => value !== null && value >= 0,
  );
  return values.length ? Math.max(...values) : null;
}

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  const found = Array.isArray(headers)
    ? headers.find((header) => asText(asRecord(header).name).toLowerCase() === wanted)
    : undefined;
  return asText(asRecord(found).value).trim();
}

function requestHeaders(entry) {
  return asRecord(asRecord(entry).request).headers;
}

function responseHeaders(entry) {
  return asRecord(asRecord(entry).response).headers;
}

function entryErrorText(entry) {
  const record = asRecord(entry);
  const response = asRecord(record.response);
  const request = asRecord(record.request);
  return [
    record._error,
    record.error,
    response._error,
    response.error,
    request._error,
    request.error,
    record._blockedReason,
    response._blockedReason,
  ]
    .map(asText)
    .filter(Boolean)
    .join(' ');
}

function isCertificateError(entry) {
  const record = asRecord(entry);
  const response = asRecord(record.response);
  const text = [
    entryErrorText(entry),
    record._securityState,
    record._securityDetails,
    response._securityState,
    response._securityDetails,
  ]
    .map(asText)
    .join(' ');
  return /(certificate|cert[_ -]|err_cert|ssl|tls|secure connection|unknown issuer|handshake|sec_error)/i.test(
    text,
  );
}

function isCorsError(entry) {
  return /\b(cors|cross-origin|access-control|preflight)\b/i.test(entryErrorText(entry));
}

function networkFailure(entry) {
  const record = asRecord(entry);
  const response = asRecord(record.response);
  const status = responseStatus(entry);
  const timings = asRecord(record.timings);
  const blockedTime = blockedDuration(entry);
  const hasResponse =
    record.response !== null &&
    typeof record.response === 'object' &&
    !Array.isArray(record.response) &&
    Object.keys(response).length > 0;
  const errorText = entryErrorText(entry);
  return (
    status === 0 ||
    status === null ||
    !hasResponse ||
    Boolean(errorText) ||
    /\b(net::|dns|name not resolved|connection reset|connection refused|network error|failed to fetch|blocked by|blocked request)\b/i.test(
      errorText,
    ) ||
    (blockedTime !== null && blockedTime >= 3000 && (status === null || status === 0))
  );
}

function isFailedEntry(entry) {
  const status = responseStatus(entry);
  return (
    (status !== null && status >= 400) ||
    networkFailure(entry) ||
    isCertificateError(entry) ||
    isCorsError(entry) ||
    failedPreflight(entry) ||
    hasMissingCorsPermission(entry)
  );
}

function uniqueUrls(items) {
  return [...new Set(items.map(requestUrl).filter(Boolean))];
}

function addFinding(findings, finding) {
  const urls = [...new Set((finding.urls || []).filter(Boolean))];
  if (!urls.length) return;
  if (findings.some((existing) => existing.id === finding.id)) return;
  findings.push({ ...finding, urls });
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function endpointKey(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split('?')[0];
  }
}

function isPreflight(entry) {
  return (
    requestMethod(entry) === 'OPTIONS' &&
    Boolean(headerValue(requestHeaders(entry), 'access-control-request-method'))
  );
}

function failedPreflight(entry) {
  if (!isPreflight(entry)) return false;
  const status = responseStatus(entry);
  if (status === null || status < 200 || status >= 300) return true;

  const requestedMethod = headerValue(
    requestHeaders(entry),
    'access-control-request-method',
  ).toUpperCase();
  const allowedMethods = headerValue(
    responseHeaders(entry),
    'access-control-allow-methods',
  )
    .split(',')
    .map((method) => method.trim().toUpperCase())
    .filter(Boolean);
  if (
    requestedMethod &&
    !allowedMethods.includes(requestedMethod) &&
    !allowedMethods.includes('*')
  ) {
    return true;
  }

  const requestedHeaders = headerValue(
    requestHeaders(entry),
    'access-control-request-headers',
  )
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const allowedHeaders = headerValue(
    responseHeaders(entry),
    'access-control-allow-headers',
  )
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (
    requestedHeaders.some(
      (name) => !allowedHeaders.includes(name) && !allowedHeaders.includes('*'),
    )
  ) {
    return true;
  }

  return hasMissingCorsPermission(entry);
}

function hasMissingCorsPermission(entry) {
  const url = requestUrl(entry);
  const requestHeaderList = requestHeaders(entry);
  const origin = headerValue(requestHeaderList, 'origin');
  if (!url || !origin) return false;
  try {
    const destination = new URL(url);
    const source = new URL(origin);
    if (destination.origin === source.origin) return false;
    const status = responseStatus(entry);
    if (status === null || status === 0) return false;
    const allowOrigin = headerValue(responseHeaders(entry), 'access-control-allow-origin');
    const hasCredentials =
      Boolean(headerValue(requestHeaderList, 'authorization')) ||
      Boolean(headerValue(requestHeaderList, 'cookie'));
    const originNotAllowed =
      !allowOrigin ||
      (allowOrigin !== '*' && allowOrigin !== origin) ||
      (hasCredentials && allowOrigin === '*');
    const credentialsNotAllowed =
      hasCredentials &&
      headerValue(responseHeaders(entry), 'access-control-allow-credentials').toLowerCase() !==
        'true';
    return originNotAllowed || credentialsNotAllowed;
  } catch {
    return false;
  }
}

function timingPhase(entry) {
  const timings = asRecord(asRecord(entry).timings);
  const phases = [
    ['blocked', 'Waiting for the browser to start the request'],
    ['dns', 'DNS lookup'],
    ['connect', 'Connecting to the site'],
    ['ssl', 'Setting up a secure connection'],
    ['wait', 'Waiting for the site to reply'],
    ['receive', 'Receiving the response'],
  ];
  let slowest = null;
  for (const [key, label] of phases) {
    const duration = finite(timings[key]);
    if (duration !== null && duration > 0 && (!slowest || duration > slowest.duration)) {
      slowest = { key, label, duration };
    }
  }
  return slowest;
}

function resolveRedirectTarget(entry) {
  const response = asRecord(asRecord(entry).response);
  const location = asText(response.redirectURL) || headerValue(responseHeaders(entry), 'location');
  if (!location) return '';
  try {
    return new URL(location, requestUrl(entry)).href;
  } catch {
    return location;
  }
}

function timelineFor(entries, pages) {
  const pageStarts = (Array.isArray(pages) ? pages : [])
    .map((page) => ({
      id: asText(asRecord(page).id),
      time: parseDate(asRecord(page).startedDateTime),
    }))
    .filter((page) => page.time !== null);
  const pageById = new Map(pageStarts.map((page) => [page.id, page]));
  const starts = entries.map((entry, index) => ({
    entry,
    index,
    time: parseDate(asRecord(entry).startedDateTime),
  }));
  const entryTimes = starts.map((item) => item.time).filter((time) => time !== null);
  const earliestTime = (times) =>
    times.length ? times.reduce((earliest, time) => Math.min(earliest, time), Infinity) : null;
  const firstError = starts
    .filter((item) => isFailedEntry(item.entry))
    .sort((left, right) => {
      if (left.time !== null && right.time !== null) return left.time - right.time || left.index - right.index;
      if (left.time !== null) return -1;
      if (right.time !== null) return 1;
      return left.index - right.index;
    })[0];
  const errorPageRef = firstError ? asText(asRecord(firstError.entry).pageref) : '';
  const selectedPage =
    (errorPageRef && pageById.get(errorPageRef)) ||
    pageStarts.reduce(
      (earliest, page) => (!earliest || page.time < earliest.time ? page : earliest),
      null,
    );
  const anchorTime = selectedPage?.time ?? earliestTime(entryTimes);
  const anchor = selectedPage ? 'page-load' : anchorTime !== null ? 'first-request' : 'none';
  const datedEnds = starts
    .filter(
      (item) =>
        !selectedPage ||
        !asText(asRecord(item.entry).pageref) ||
        asText(asRecord(item.entry).pageref) === selectedPage.id,
    )
    .filter((item) => item.time !== null)
    .map((item) => {
      const duration = finite(asRecord(item.entry).time) ?? 0;
      return item.time + Math.max(0, duration);
    });
  const latest = datedEnds.length
    ? datedEnds.reduce((latestTime, time) => Math.max(latestTime, time), -Infinity)
    : null;

  return {
    anchor,
    anchorAt: anchorTime === null ? null : new Date(anchorTime).toISOString(),
    firstErrorAt:
      firstError?.time === null || firstError?.time === undefined
        ? null
        : new Date(firstError.time).toISOString(),
    offsetMs:
      anchorTime !== null && firstError?.time !== null && firstError?.time !== undefined
        ? firstError.time - anchorTime
        : null,
    requestUrl: firstError ? requestUrl(firstError.entry) || null : null,
    totalMs: anchorTime !== null && latest !== null ? Math.max(0, latest - anchorTime) : null,
  };
}

export function analyzeHar(entries = [], pages = []) {
  const safeEntries = Array.isArray(entries) ? entries.map(asRecord) : [];
  const safePages = Array.isArray(pages) ? pages : [];
  const findings = [];

  const statusGroups = [
    {
      id: 'auth-response',
      statuses: new Set([401, 403]),
      severity: 'warning',
      title: 'Some requests were not allowed',
      explanation:
        'Your sign-in may have expired, your account may not have access, or a security rule may have blocked these requests.',
      whatToRecheck: [
        'Sign in again and repeat the action.',
        'Check that this account has access to the affected pages.',
        'If access should be allowed, review the site’s security rules.',
      ],
    },
    {
      id: 'missing-page',
      statuses: new Set([404, 410]),
      severity: 'warning',
      title: 'Some requested pages or files could not be found',
      explanation:
        'The address may be incorrect, the resource may have been removed, or the latest site version may not be live yet.',
      whatToRecheck: [
        'Check the affected address and any links that lead to it.',
        'Confirm the resource still exists.',
        'If it was just added, confirm the latest site update is live.',
      ],
    },
    {
      id: 'request-limits',
      statuses: new Set([408, 429]),
      severity: 'warning',
      title: 'Some requests timed out or were sent too often',
      explanation:
        'The site may be busy, the connection may be slow, or it may be limiting how quickly these requests can be repeated.',
      whatToRecheck: [
        'Wait briefly and try the action again.',
        'Check whether the same action is being sent repeatedly.',
        'If this keeps happening, ask the site owner whether request limits changed.',
      ],
    },
  ];

  for (const group of statusGroups) {
    const affected = safeEntries.filter((entry) => group.statuses.has(responseStatus(entry)));
    if (affected.length) {
      addFinding(findings, {
        id: group.id,
        severity: group.severity,
        title: group.title,
        explanation: group.explanation,
        urls: uniqueUrls(affected),
        whatToRecheck: group.whatToRecheck,
      });
    }
  }

  const serverFailures = safeEntries.filter((entry) =>
    new Set([500, 502, 503, 504]).has(responseStatus(entry)),
  );
  if (serverFailures.length) {
    const endpoints = new Set(serverFailures.map((entry) => endpointKey(requestUrl(entry))));
    const widespread = endpoints.size > 1;
    addFinding(findings, {
      id: 'server-failures',
      severity: 'problem',
      title: widespread
        ? 'Server failures are affecting several parts of the site'
        : 'Server failure on one endpoint',
      explanation: widespread
        ? 'Several different parts of the site failed at once, which may mean the site is having a broader outage.'
        : 'The site could not complete a request at this one address. This may be a temporary problem limited to one part of the site.',
      urls: uniqueUrls(serverFailures),
      whatToRecheck: widespread
        ? [
            'Check the site’s service status or ask the site owner whether there is an outage.',
            'Try again after the site is available.',
            'If you manage the site, review recent service and deployment changes.',
          ]
        : [
            'Try the affected action again after a short pause.',
            'Check whether this part of the site is currently available.',
            'If you manage the site, review this endpoint and recent changes.',
          ],
    });
  }

  const failedRequests = safeEntries.filter((entry) => isFailedEntry(entry));
  const networkRequests = safeEntries.filter((entry) => networkFailure(entry));
  if (networkRequests.length) {
    addFinding(findings, {
      id: 'network-failures',
      severity: 'problem',
      title: 'Some requests could not reach a working response',
      explanation:
        'The connection may have dropped or the address may not have resolved. A VPN, firewall, ad blocker, or browser permission may also be in the way.',
      urls: uniqueUrls(networkRequests),
      whatToRecheck: [
        'Reload the page and check whether the connection is stable.',
        'Temporarily check whether a VPN, firewall, or ad blocker is blocking the site.',
        'If only one browser is affected, check its privacy and site permissions.',
      ],
    });
  }
  const delayedRequests = safeEntries.filter(
    (entry) =>
      !networkFailure(entry) &&
      (blockedDuration(entry) ?? 0) >= 3000,
  );
  if (delayedRequests.length) {
    addFinding(findings, {
      id: 'browser-queueing',
      severity: 'warning',
      title: 'The browser held some requests before starting them',
      explanation:
        'These requests waited for several seconds before the connection began. A busy page, browser extension, or limited connection may be involved.',
      urls: uniqueUrls(delayedRequests),
      whatToRecheck: [
        'Check whether the page starts many requests at the same time.',
        'Review browser extensions that may pause or filter requests.',
        'Try the page on a steady connection and compare the result.',
      ],
    });
  }

  const corsRequests = safeEntries.filter((entry) => {
    const status = responseStatus(entry);
    return isCorsError(entry) || failedPreflight(entry) || hasMissingCorsPermission(entry);
  });
  if (corsRequests.length) {
    addFinding(findings, {
      id: 'cors',
      severity: 'problem',
      title: 'The browser blocked a request between sites',
      explanation:
        'The destination may not have allowed this page to read its response. A site’s cross-site permission settings can also stop a request before it starts.',
      urls: uniqueUrls(corsRequests),
      whatToRecheck: [
        'Check that the destination allows requests from this page’s address.',
        'If a request uses a different site, ask its owner to allow this page.',
        'If the request uses sign-in cookies, check that the site permits them for this use.',
      ],
    });
  }

  const certificateRequests = safeEntries.filter((entry) => isCertificateError(entry));
  if (certificateRequests.length) {
    addFinding(findings, {
      id: 'certificate-errors',
      severity: 'problem',
      title: 'A secure connection could not be confirmed',
      explanation:
        'The browser reported a problem with the site’s security certificate or secure connection, so it may have stopped the request.',
      urls: uniqueUrls(certificateRequests),
      whatToRecheck: [
        'Check the device date and time.',
        'Open the affected site directly and review the browser’s security message.',
        'If you manage the site, check that its certificate is current and correctly installed.',
      ],
    });
  }

  const phases = new Map();
  for (const entry of safeEntries) {
    const duration = finite(asRecord(entry).time);
    if (duration === null || duration <= 3000) continue;
    const phase = timingPhase(entry);
    const key = phase?.key ?? 'unknown';
    if (!phases.has(key)) phases.set(key, { phase, entries: [] });
    phases.get(key).entries.push(entry);
  }
  for (const [key, group] of phases) {
    const explanation = group.phase
      ? `These requests took longer than 3 seconds. Most of the delay was ${group.phase.label.toLowerCase()}.`
      : 'These requests took longer than 3 seconds, but the recording does not include enough detail to tell which part took longest.';
    const advice = {
      dns: 'Check whether the site address is resolving slowly.',
      connect: 'Check the connection between the device and the site.',
      ssl: 'Check whether secure connection setup is taking longer than usual.',
      wait: 'Check whether the site is taking a long time to prepare its reply.',
      receive: 'Check the size of the response and the connection speed.',
      blocked: 'Check whether many requests start at once or a browser extension is holding them.',
      unknown: 'Capture a new recording with timing details included.',
    }[key];
    addFinding(findings, {
      id: `slow-${key}`,
      severity: 'warning',
      title: group.phase
        ? `Slow requests: ${group.phase.label.toLowerCase()} took longest`
        : 'Some requests took longer than 3 seconds',
      explanation,
      urls: uniqueUrls(group.entries),
      whatToRecheck: [advice, 'Try the same action on a steady connection and compare the result.'],
    });
  }

  const redirectEdges = new Map();
  for (const entry of safeEntries) {
    const status = responseStatus(entry);
    const from = requestUrl(entry);
    const to = resolveRedirectTarget(entry);
    if (status !== null && status >= 300 && status < 400 && from && to) {
      redirectEdges.set(from, to);
    }
  }
  const redirectLoops = new Map();
  const longChains = new Map();
  for (const start of redirectEdges.keys()) {
    let current = start;
    const chain = [start];
    const seen = new Map([[start, 0]]);
    let steps = 0;
    while (redirectEdges.has(current) && steps < 50) {
      const next = redirectEdges.get(current);
      steps += 1;
      if (seen.has(next)) {
        const loop = chain.slice(seen.get(next));
        const signature = [...new Set(loop)].sort().join('|');
        redirectLoops.set(signature, [...new Set([...loop, next])]);
        break;
      }
      chain.push(next);
      seen.set(next, chain.length - 1);
      current = next;
    }
    if (steps > 3 && ![...redirectLoops.values()].some((urls) => urls.includes(start))) {
      longChains.set([...chain].join('|'), chain);
    }
  }
  if (redirectLoops.size) {
    addFinding(findings, {
      id: 'redirect-loops',
      severity: 'problem',
      title: 'Some addresses keep sending the browser in a loop',
      explanation:
        'These addresses send visitors back and forth instead of opening the requested page.',
      urls: [...redirectLoops.values()].flat(),
      whatToRecheck: [
        'Check the forwarding rules for the affected addresses.',
        'Make sure the destination does not point back to an earlier address.',
        'After changing a rule, open the page again in a fresh tab.',
      ],
    });
  }
  if (longChains.size) {
    addFinding(findings, {
      id: 'long-redirect-chains',
      severity: 'warning',
      title: 'Some pages pass through several addresses first',
      explanation:
        'More than three forwards can make a page slower or stop it from opening in some browsers.',
      urls: [...longChains.values()].flat(),
      whatToRecheck: [
        'Remove any forwarding steps that are no longer needed.',
        'Point older addresses directly to the final page.',
        'Check that the forwarding rules do not send visitors back to an earlier step.',
      ],
    });
  }

  const htmlByPage = new Map();
  let fallbackHtml = null;
  for (const entry of safeEntries) {
    const response = asRecord(asRecord(entry).response);
    const mimeType = asText(asRecord(response.content).mimeType).toLowerCase();
    if (!mimeType.includes('text/html')) continue;
    const url = requestUrl(entry);
    if (!url) continue;
    const pageRef = asText(asRecord(entry).pageref);
    if (pageRef && !htmlByPage.has(pageRef)) htmlByPage.set(pageRef, url);
    if (!fallbackHtml) fallbackHtml = url;
  }
  const mixedContent = safeEntries.filter((entry) => {
    const pageRef = asText(asRecord(entry).pageref);
    const pageUrl = htmlByPage.get(pageRef) || fallbackHtml;
    if (!pageUrl) return false;
    try {
      return new URL(pageUrl).protocol === 'https:' && new URL(requestUrl(entry)).protocol === 'http:';
    } catch {
      return false;
    }
  });
  if (mixedContent.length) {
    addFinding(findings, {
      id: 'mixed-content',
      severity: 'problem',
      title: 'A secure page requested files without a secure connection',
      explanation:
        'The page opened securely, but some files were requested over an unprotected connection. The browser may block those files.',
      urls: uniqueUrls(mixedContent),
      whatToRecheck: [
        'Update the affected addresses to use a secure connection.',
        'Check whether the site still links to older, unsecured file addresses.',
        'Reload the page after the addresses are corrected.',
      ],
    });
  }

  const largeEntries = safeEntries.filter((entry) => responseSize(entry) > TWO_MEGABYTES);
  if (largeEntries.length) {
    addFinding(findings, {
      id: 'large-payloads',
      severity: 'warning',
      title: 'Some downloads are larger than 2 MB',
      explanation:
        'Large files can take longer to arrive, especially on a slower connection.',
      urls: uniqueUrls(largeEntries),
      whatToRecheck: [
        'Check whether the page needs to download the full file right away.',
        'Consider reducing the size of images, scripts, or other large files.',
        'Check whether a smaller version can be used on this page.',
      ],
    });
  }

  const uncompressedEntries = safeEntries.filter((entry) => {
    const size = responseSize(entry);
    if (size === null || size < LARGE_UNCOMPRESSED_BYTES) return false;
    if (headerValue(responseHeaders(entry), 'content-encoding')) return false;
    const response = asRecord(asRecord(entry).response);
    const mime = asText(asRecord(response.content).mimeType).toLowerCase();
    return /^(text\/|application\/(json|javascript|xml|svg\+xml))/.test(mime);
  });
  if (uncompressedEntries.length) {
    addFinding(findings, {
      id: 'uncompressed-responses',
      severity: 'warning',
      title: 'Some text files may be sent without compression',
      explanation:
        'These responses are sizable and do not show a compression setting, so they may take longer to download than necessary.',
      urls: uniqueUrls(uncompressedEntries),
      whatToRecheck: [
        'Check whether the site can compress text files before sending them.',
        'Compare the download size before and after compression.',
        'Keep images and other already-compressed files as they are.',
      ],
    });
  }

  const staticFiles = safeEntries.filter((entry) => {
    const status = responseStatus(entry);
    if (status === null || status < 200 || status >= 300) return false;
    const response = asRecord(asRecord(entry).response);
    const mime = asText(asRecord(response.content).mimeType).toLowerCase();
    const url = requestUrl(entry).toLowerCase();
    const isStatic =
      /^(text\/(css|javascript)|application\/(javascript|font|x-font|vnd\.ms-fontobject)|font\/|image\/)/.test(
        mime,
      ) || /\.(css|js|mjs|png|jpe?g|gif|svg|webp|woff2?|ttf|otf)(?:[?#]|$)/.test(url);
    if (!isStatic) return false;
    return ![
      'cache-control',
      'expires',
      'etag',
      'last-modified',
    ].some((name) => headerValue(responseHeaders(entry), name));
  });
  if (staticFiles.length) {
    addFinding(findings, {
      id: 'missing-cache-headers',
      severity: 'warning',
      title: 'Some reusable files have no cache guidance',
      explanation:
        'The browser was not given instructions for keeping these files, so it may need to download them again on the next visit.',
      urls: uniqueUrls(staticFiles),
      whatToRecheck: [
        'Check how long these files should be kept by the browser.',
        'Add suitable reuse instructions for files that rarely change.',
        'Use a new file address when a changed version needs to replace an old one.',
      ],
    });
  }

  const repeatedFailures = [...groupBy(
    failedRequests.filter((entry) => {
      const method = requestMethod(entry);
      const url = requestUrl(entry);
      return method && url;
    }),
    (entry) => `${requestMethod(entry)} ${requestUrl(entry)}`,
  ).values()].filter((group) => group.length >= 3);
  if (repeatedFailures.length) {
    const repeatedUrls = repeatedFailures.flatMap((group) => group.map(requestUrl));
    addFinding(findings, {
      id: 'retry-storms',
      severity: 'problem',
      title: 'The same failed requests were repeated several times',
      explanation:
        'Repeating the same unsuccessful request can slow the page down and put extra pressure on the site.',
      urls: repeatedUrls,
      whatToRecheck: [
        'Check what causes the first request to fail.',
        'Make sure the page does not retry continuously when it gets no answer.',
        'If retries are needed, add a pause between attempts and stop after a few tries.',
      ],
    });
  }

  const successfulLogins = safeEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      const status = responseStatus(entry);
      const url = requestUrl(entry);
      return (
        status !== null &&
        status >= 200 &&
        status < 300 &&
        /(login|log-in|signin|sign-in|session|auth|token)/i.test(url)
      );
    });
  const postLoginFailures = [];
  for (const login of successfulLogins) {
    const loginTime = parseDate(asRecord(login.entry).startedDateTime);
    for (const candidate of safeEntries.map((entry, index) => ({ entry, index }))) {
      if (candidate.index <= login.index) continue;
      if (!isFailedEntry(candidate.entry)) continue;
      const candidateTime = parseDate(asRecord(candidate.entry).startedDateTime);
      const immediatelyAfter =
        loginTime !== null && candidateTime !== null
          ? candidateTime >= loginTime && candidateTime - loginTime <= 30_000
          : candidate.index - login.index <= 5;
      if (immediatelyAfter) postLoginFailures.push(candidate.entry, login.entry);
    }
  }
  if (postLoginFailures.length) {
    addFinding(findings, {
      id: 'auth-flow-break',
      severity: 'problem',
      title: 'A request failed shortly after sign-in succeeded',
      explanation:
        'The sign-in request worked, but a following request failed soon afterward. The page may not be using the new sign-in details yet, or another part of the site may have a problem.',
      urls: uniqueUrls(postLoginFailures),
      whatToRecheck: [
        'Check that the page saves the new sign-in details before loading protected content.',
        'Check that session cookies or tokens are available to the affected page.',
        'Sign out, sign in again, and repeat the same steps.',
      ],
    });
  }

  findings.sort((left, right) => {
    const priority = { problem: 0, warning: 1 };
    return priority[left.severity] - priority[right.severity] || left.title.localeCompare(right.title);
  });
  const hasProblems = findings.some((finding) => finding.severity === 'problem');
  const verdict = hasProblems ? 'Problems found' : findings.length ? 'Warnings' : 'Healthy';

  return {
    verdict,
    findings,
    timeline: timelineFor(safeEntries, safePages),
  };
}
