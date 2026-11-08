import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Clock3,
  Copy,
  Download,
  FileText,
  Fingerprint,
  Gauge,
  HardDrive,
  ListFilter,
  LockKeyhole,
  Moon,
  Search,
  ShieldCheck,
  Sun,
  Upload,
  X,
} from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';
import type { AnalysisResult } from './analyzer.js';
import sampleHealthy from '@/samples/sample-healthy.har?raw';
import sampleIssues from '@/samples/sample-issues.har?raw';
import WhatWentWrong from '@/components/WhatWentWrong';
import {
  buildReportHtml,
  buildSummaryText,
  downloadTextFile,
} from './shareTools.js';

const queryClient = new QueryClient();

type HarRequest = {
  id: number;
  method: string;
  url: string;
  status: number | null;
  mimeType: string;
  time: number | null;
  size: number | null;
};
type SortKey = 'method' | 'url' | 'status' | 'type' | 'time' | 'size';
type SortDirection = 'asc' | 'desc';
type WorkerResponse =
  | { ok: true; kind: 'analysis'; requests: HarRequest[]; totalTime: number; analysis: AnalysisResult }
  | { ok: true; kind: 'redaction'; sanitizedJson: string; redactedCount: number }
  | { ok: false; kind: 'error'; error: string };
const MAX_BYTES = 100 * 1024 * 1024;

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const sourceFileRef = useRef<File | null>(null);
  const [requests, setRequests] = useState<HarRequest[] | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [totalTime, setTotalTime] = useState(0);
  const [error, setError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [darkMode, setDarkMode] = useState(() => {
    try {
      return window.localStorage.getItem('har-analyzer-theme') === 'dark';
    } catch {
      return false;
    }
  });
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const failedCount = requests?.filter((request) => request.status !== null && request.status >= 400).length ?? 0;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    try {
      window.localStorage.setItem('har-analyzer-theme', darkMode ? 'dark' : 'light');
    } catch {
      // The theme still works for this session when storage is unavailable.
    }
  }, [darkMode]);

  function readFile(file?: File) {
    if (!file) return;
    workerRef.current?.terminate();
    workerRef.current = null;
    setParsing(false);
    setRedacting(false);
    setActionMessage('');
    setError('');
    if (file.size === 0) {
      setError('This file is empty. Choose a HAR file that contains a network recording.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.har')) {
      setError('Unsupported file type. Please choose a file with the .har extension.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('This file is larger than 100 MB. Choose a smaller HAR recording to continue.');
      return;
    }
    try {
      setParsing(true);
      const worker = new Worker(new URL('./workers/har-parser.worker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (workerRef.current !== worker) return;
        worker.terminate();
        workerRef.current = null;
        setParsing(false);
        const result = event.data;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (result.kind !== 'analysis') return;
        sourceFileRef.current = file;
        setRequests(result.requests);
        setAnalysis(result.analysis);
        setFileName(file.name);
        setTotalTime(result.totalTime);
        setSearch('');
      };
      worker.onerror = () => {
        if (workerRef.current !== worker) return;
        worker.terminate();
        workerRef.current = null;
        setParsing(false);
        setError('We couldn’t read this file as JSON. Check that it is a complete, valid HAR recording.');
      };
      worker.postMessage({ kind: 'analysis', file });
    } catch {
      workerRef.current?.terminate();
      workerRef.current = null;
      setParsing(false);
      setError('We couldn’t start the local parser. Try again in a modern browser.');
    }
  }

  function redactAndDownload() {
    const file = sourceFileRef.current;
    if (!file) {
      setActionMessage('Choose a HAR file before creating a sanitized copy.');
      return;
    }
    workerRef.current?.terminate();
    setActionMessage('');
    setRedacting(true);
    try {
      const worker = new Worker(new URL('./workers/har-parser.worker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (workerRef.current !== worker) return;
        worker.terminate();
        workerRef.current = null;
        setRedacting(false);
        const result = event.data;
        if (!result.ok) {
          setActionMessage(result.error);
          return;
        }
        if (result.kind !== 'redaction') {
          setActionMessage('The sanitized copy could not be created. Try again.');
          return;
        }
        const baseName = file.name.replace(/\.har$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100) || 'capture';
        downloadTextFile(`${baseName}.redacted.har`, result.sanitizedJson, 'application/json');
        setActionMessage(
          result.redactedCount
            ? `${result.redactedCount} sensitive item${result.redactedCount === 1 ? '' : 's'} redacted. Review the file before sharing.`
            : 'A sanitized copy was downloaded. No common sensitive fields were found; review it before sharing.',
        );
      };
      worker.onerror = () => {
        if (workerRef.current !== worker) return;
        worker.terminate();
        workerRef.current = null;
        setRedacting(false);
        setActionMessage('The sanitized copy could not be created. Try again.');
      };
      worker.postMessage({ kind: 'redaction', file });
    } catch {
      workerRef.current?.terminate();
      workerRef.current = null;
      setRedacting(false);
      setActionMessage('The local redactor could not start in this browser.');
    }
  }

  function reportOptions() {
    if (!requests || !analysis) return null;
    return { fileName, requests, totalTime, failedCount, analysis };
  }

  function downloadHtmlReport() {
    const options = reportOptions();
    if (!options) return;
    const html = buildReportHtml(options);
    const date = new Date().toISOString().slice(0, 10);
    downloadTextFile(`har-report-${date}.html`, html, 'text/html;charset=utf-8');
    setActionMessage('A privacy-conscious HTML report was downloaded.');
  }

  function printPdfReport() {
    const options = reportOptions();
    if (!options) return;
    const reportWindow = window.open('', '_blank', 'width=920,height=760');
    if (!reportWindow) {
      setActionMessage('Allow pop-ups for this page to print or save the report as a PDF.');
      return;
    }
    reportWindow.document.open();
    reportWindow.document.write(buildReportHtml(options));
    reportWindow.document.close();
    reportWindow.focus();
    window.setTimeout(() => reportWindow.print(), 350);
    setActionMessage('Use the print dialog to save the report as a PDF.');
  }

  async function copySupportSummary() {
    const options = reportOptions();
    if (!options) return;
    const summary = buildSummaryText(options);
    try {
      await navigator.clipboard.writeText(summary);
      setActionMessage('A summary with sensitive URL values redacted was copied.');
      return;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = summary;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      setActionMessage(
        copied
          ? 'A summary with sensitive URL values redacted was copied.'
          : 'The summary could not be copied. Try selecting the text manually.',
      );
    }
  }

  function updateSort(key: SortKey) {
    if (sortKey === key) setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDirection(key === 'url' || key === 'method' || key === 'type' ? 'asc' : 'desc');
    }
  }

  const visibleRequests = useMemo(() => {
    if (!requests) return [];
    const query = search.trim().toLowerCase();
    const filtered = requests.filter((item) => !query || [
      item.method, item.url, item.status === null ? '' : String(item.status),
      item.mimeType, item.time === null ? '' : String(item.time),
      item.size === null ? '' : String(item.size),
    ].some((value) => value.toLowerCase().includes(query)));
    return filtered.sort((a, b) => {
      const left = sortKey === 'type' ? a.mimeType : a[sortKey];
      const right = sortKey === 'type' ? b.mimeType : b[sortKey];
      let comparison = 0;
      if (left === null || right === null) {
        if (left !== right) return left === null ? 1 : -1;
      } else if (typeof left === 'number' || typeof right === 'number') {
        const leftNum = typeof left === 'number' ? left : Number.NEGATIVE_INFINITY;
        const rightNum = typeof right === 'number' ? right : Number.NEGATIVE_INFINITY;
        comparison = leftNum - rightNum;
      } else comparison = String(left).localeCompare(String(right), undefined, { sensitivity: 'base' });
      return (sortDirection === 'asc' ? comparison : -comparison) || a.id - b.id;
    });
  }, [requests, search, sortKey, sortDirection]);

  const sortIcon = (key: SortKey) => sortKey !== key
    ? <ArrowUpDown size={12} aria-hidden="true" />
    : sortDirection === 'asc'
      ? <ArrowUp size={12} aria-hidden="true" />
      : <ArrowDown size={12} aria-hidden="true" />;
  const sortableHeader = (label: string, key: SortKey) => (
    <th scope="col" aria-sort={sortKey === key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className="sort-button" type="button" onClick={() => updateSort(key)}
        aria-label={`Sort by ${label}${sortKey === key ? `, ${sortDirection === 'asc' ? 'ascending' : 'descending'}` : ''}`}
        data-testid={`sort-${key}`}>
        {label}{sortIcon(key)}
      </button>
    </th>
  );

  return (
    <div className="app-shell" aria-busy={parsing || redacting}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="HAR Analyzer home">
          <span className="brand-mark"><Fingerprint size={19} strokeWidth={2.2} /></span>
          <span>HAR Analyzer</span>
        </a>
        <div className="topbar-actions">
          <div className="top-meta"><span className="privacy-dot" /><span>Private by design</span></div>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setDarkMode((current) => !current)}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-pressed={darkMode}
            data-testid="button-theme-toggle"
          >
            {darkMode ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
            <span>{darkMode ? 'Light mode' : 'Dark mode'}</span>
          </button>
        </div>
      </header>
      <main className="workspace">
        <section className="intro" aria-labelledby="page-title">
          <div>
            <div className="eyebrow">Local network inspector</div>
            <h1 id="page-title">See what your browser sees.</h1>
            <p>Read a network recording without sending it anywhere. Drop in a HAR file to inspect request timings, response types, and failures — right here in your browser.</p>
          </div>
          <div className="local-note"><LockKeyhole size={14} /> Stays on this device</div>
        </section>

        <aside className="privacy-banner" role="note" data-testid="banner-local-analysis">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>Your file is analyzed locally in your browser and never uploaded</span>
        </aside>

        <section aria-label="Import HAR file">
          <div className={`dropzone${dragging ? ' dragging' : ''}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
            onDrop={(event) => { event.preventDefault(); setDragging(false); void readFile(event.dataTransfer.files[0]); }}
            data-testid="dropzone-har">
            <div className="drop-inner">
              <div className="upload-symbol"><Upload size={20} /></div>
              <div className="drop-title">Drop your .har file here</div>
              <div className="drop-hint">or browse your device to choose a recording</div>
              <button className="upload-button" type="button" onClick={() => inputRef.current?.click()} data-testid="button-choose-file">
                <FileText size={14} /> Choose HAR file
              </button>
              <input ref={inputRef} className="file-input" type="file" accept=".har" aria-label="Choose a HAR file"
                data-testid="input-har-file" onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
              <div className="size-hint">.har files · up to 100 MB · processed locally</div>
              <div className="sample-row" aria-label="Sample HAR files">
                <span>Try a sample:</span>
                <button
                  type="button"
                  className="sample-button"
                  onClick={() => readFile(new File([sampleHealthy], 'sample-healthy.har', { type: 'application/json' }))}
                  data-testid="button-sample-healthy"
                >
                  Healthy capture
                </button>
                <button
                  type="button"
                  className="sample-button"
                  onClick={() => readFile(new File([sampleIssues], 'sample-issues.har', { type: 'application/json' }))}
                  data-testid="button-sample-issues"
                >
                  Issues capture
                </button>
              </div>
              {parsing && <div className="parsing-status" role="status" data-testid="status-parsing">Analyzing locally…</div>}
              {fileName && <div className="file-name" data-testid="text-filename"><FileText size={14} />{fileName}</div>}
            </div>
          </div>
          {error && (
            <div className="error-box" role="alert" data-testid="status-file-error">
              <ShieldCheck size={17} aria-hidden="true" />
              <div><strong>Couldn’t open that file</strong>{error}</div>
            </div>
          )}
        </section>

        {requests && (
          <>
            <section className="stats" aria-label="Capture summary">
              <div className="stat"><div className="stat-label"><ListFilter size={13} /> Requests</div><div className="stat-value" data-testid="value-request-count">{requests.length.toLocaleString()}</div></div>
              <div className="stat"><div className="stat-label"><Clock3 size={13} /> Total request time</div><div className="stat-value" data-testid="value-total-time">{formatDuration(totalTime)}</div></div>
              <div className="stat"><div className="stat-label"><Gauge size={13} /> Failed requests</div><div className={`stat-value${failedCount ? ' danger' : ''}`} data-testid="value-failed-count">{failedCount.toLocaleString()}</div></div>
            </section>
            {analysis && <WhatWentWrong analysis={analysis} />}
            {analysis && (
              <section className="share-tools" aria-label="Privacy and sharing tools">
                <div className="share-tools-actions">
                  <button
                    type="button"
                    className="share-button share-button-redact"
                    onClick={redactAndDownload}
                    disabled={redacting || parsing}
                    data-testid="button-redact-sensitive"
                  >
                    <ShieldCheck size={15} aria-hidden="true" />
                    {redacting ? 'Redacting locally…' : 'Redact sensitive data'}
                  </button>
                  <button
                    type="button"
                    className="share-button"
                    onClick={downloadHtmlReport}
                    disabled={redacting || parsing}
                    data-testid="button-download-html-report"
                  >
                    <Download size={15} aria-hidden="true" /> Download report (HTML)
                  </button>
                  <button
                    type="button"
                    className="share-button"
                    onClick={printPdfReport}
                    disabled={redacting || parsing}
                    data-testid="button-download-pdf-report"
                  >
                    <FileText size={15} aria-hidden="true" /> Print / save as PDF
                  </button>
                  <button
                    type="button"
                    className="share-button"
                    onClick={() => void copySupportSummary()}
                    disabled={redacting || parsing}
                    data-testid="button-copy-summary"
                  >
                    <Copy size={15} aria-hidden="true" /> Copy summary
                  </button>
                </div>
                <p className="share-note">
                  Redaction removes common sensitive headers, cookies, query values, and token/password fields.
                  Review the downloaded file before sharing.
                </p>
                {actionMessage && (
                  <div className="share-status" role="status" data-testid="status-share-action">
                    {actionMessage}
                  </div>
                )}
              </section>
            )}
            <section className="results" aria-labelledby="requests-title">
              <div className="results-head">
                <div>
                  <h2 className="results-title" id="requests-title">Requests</h2>
                  <div className="results-caption" data-testid="text-visible-count">
                    {visibleRequests.length === requests.length ? `${requests.length} ${requests.length === 1 ? 'request' : 'requests'}` : `${visibleRequests.length} of ${requests.length} requests`}
                  </div>
                </div>
                <div className="table-tools">
                  <label className="search-wrap">
                    <Search className="search-icon" size={15} aria-hidden="true" />
                    <input className="search-input" type="search" placeholder="Filter requests…" value={search}
                      onChange={(event) => setSearch(event.target.value)} aria-label="Filter requests"
                      data-testid="input-search-requests" />
                  </label>
                  {search && <button type="button" className="clear-button" onClick={() => setSearch('')} data-testid="button-clear-search"><X size={14} /> Clear</button>}
                </div>
              </div>
              {requests.length === 0 ? (
                <div className="empty-state" data-testid="empty-no-requests">
                  <div className="empty-icon"><FileText size={19} /></div>
                  <div className="empty-title">A quiet recording.</div>
                  <div className="empty-copy">This HAR file is valid, but it contains no network requests.</div>
                </div>
              ) : visibleRequests.length === 0 ? (
                <div className="empty-state" data-testid="empty-no-matches">
                  <div className="empty-icon"><Search size={18} /></div>
                  <div className="empty-title">No matching requests</div>
                  <div className="empty-copy">Try another URL, method, status, or response type.</div>
                </div>
              ) : (
                <div className="table-scroll">
                  <table className="request-table">
                    <thead><tr>
                      {sortableHeader('Method', 'method')}
                      {sortableHeader('URL', 'url')}
                      {sortableHeader('Status', 'status')}
                      {sortableHeader('Type', 'type')}
                      {sortableHeader('Time', 'time')}
                      {sortableHeader('Size', 'size')}
                    </tr></thead>
                    <tbody>
                      {visibleRequests.map((item) => {
                        const failed = item.status !== null && item.status >= 400;
                        const redirect = item.status !== null && item.status >= 300 && item.status < 400;
                        const slow = item.time !== null && item.time > 3000;
                        const rowClass = ['request-row', failed && 'row-failed', redirect && 'row-redirect', slow && 'row-slow'].filter(Boolean).join(' ');
                        return (
                          <tr className={rowClass} key={item.id} data-testid={`row-request-${item.id}`}>
                            <td><span className="method" data-testid={`text-method-${item.id}`}>{item.method}</span></td>
                            <td className="url-cell" title={item.url} data-testid={`text-url-${item.id}`}>{item.url}</td>
                            <td><span className={`status-pill${failed ? ' failed' : redirect ? ' redirect' : ''}`} data-testid={`status-http-${item.id}`}>{item.status ?? '—'}</span></td>
                            <td><span className="type-tag" title={item.mimeType} data-testid={`text-type-${item.id}`}>{item.mimeType}</span></td>
                            <td className="mono" data-testid={`text-time-${item.id}`}>{item.time === null ? '—' : `${item.time.toLocaleString()} ms`}</td>
                            <td className="mono" data-testid={`text-size-${item.id}`}>{formatBytes(item.size)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <div className="privacy-strip"><ShieldCheck size={14} /> Your recording stays in this tab. Nothing is uploaded or stored.</div>
          </>
        )}

        {!requests && <div className="privacy-strip"><ShieldCheck size={14} /> Files are parsed in your browser and never leave your device.</div>}

        <section className="guide" aria-labelledby="guide-title">
          <div className="guide-heading">
            <h2 id="guide-title">How to capture a HAR file</h2>
            <p>Export a browser network recording, then open it above.</p>
          </div>
          <div className="guide-grid">
            <article className="guide-card"><div className="guide-card-head"><span className="browser-mark">CH</span>Chrome</div><p>Open DevTools → Network. Reload the page, then right-click the request list and choose <strong>Save all as HAR with content</strong>.</p></article>
            <article className="guide-card"><div className="guide-card-head"><span className="browser-mark">ED</span>Microsoft Edge</div><p>Open DevTools → Network. Refresh the page, then select <strong>Export HAR</strong> from the toolbar or context menu.</p></article>
            <article className="guide-card"><div className="guide-card-head"><span className="browser-mark">FF</span>Firefox</div><p>Open Developer Tools → Network. Reload the page, right-click the request list, then choose <strong>Save All As HAR</strong>.</p></article>
            <article className="guide-card"><div className="guide-card-head"><span className="browser-mark">SF</span>Safari</div><p>Enable Develop menu in Safari Settings → Advanced. Open Web Inspector → Network, reload, then use <strong>Export</strong>.</p></article>
          </div>
        </section>
        <footer className="footer">
          <span className="footer-brand">HAR ANALYZER · LOCAL INSPECTION</span>
          <span className="footer-privacy"><HardDrive size={12} aria-hidden="true" />Your file is analyzed locally and never uploaded.</span>
          <span className="footer-credit" data-testid="text-footer-credit">Built by Ajay</span>
        </footer>
      </main>
    </div>
  );
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
