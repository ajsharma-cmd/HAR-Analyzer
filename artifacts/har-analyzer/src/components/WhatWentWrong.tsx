import type { AnalysisResult, AnalysisFinding } from '../analyzer.js';
import { AlertTriangle, Check, CircleAlert, Clock3, ExternalLink, Info, ShieldCheck } from 'lucide-react';
import './what-went-wrong.css';

type WhatWentWrongProps = { analysis: AnalysisResult };

function formatDuration(ms: number): string {
  const rounded = Math.round(Math.abs(ms));
  if (rounded < 1000) return `${rounded.toLocaleString()} ms`;
  return `${(rounded / 1000).toFixed(2)} s`;
}

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  }).format(date);
}

function rankFindings(findings: AnalysisFinding[]): AnalysisFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const severityOrder = (a.finding.severity === 'problem' ? 0 : 1)
        - (b.finding.severity === 'problem' ? 0 : 1);
      return severityOrder || a.index - b.index;
    })
    .map(({ finding }) => finding);
}

function Timeline({ analysis }: WhatWentWrongProps) {
  const { timeline } = analysis;
  const anchorName = timeline.anchor === 'page-load' ? 'Page load' : 'First request';
  const hasError = timeline.firstErrorAt !== null;
  const anchorTime = formatTimestamp(timeline.anchorAt);
  const errorTime = formatTimestamp(timeline.firstErrorAt);
  const offset = timeline.offsetMs;
  const total = timeline.totalMs;
  const position = offset !== null && total !== null && total > 0
    ? Math.max(0, Math.min(100, (offset / total) * 100))
    : 50;
  const offsetText = offset === null
    ? null
    : `${formatDuration(offset)} ${offset < 0 ? 'before' : 'after'} ${anchorName.toLowerCase()}`;

  return (
    <section className="ww-timeline" aria-labelledby="ww-timeline-title" data-testid="panel-error-timeline">
      <div className="ww-timeline-heading">
        <div>
          <div className="ww-section-kicker"><Clock3 size={13} aria-hidden="true" /> Timing context</div>
          <h3 id="ww-timeline-title">Timeline</h3>
        </div>
        {total !== null && (
          <span className="ww-total-time" data-testid="value-timeline-total">
            {formatDuration(total)} total
          </span>
        )}
      </div>

      {timeline.anchor === 'none' ? (
        <div className="ww-timeline-empty" role="status" data-testid="status-timeline-unavailable">
          <Info size={16} aria-hidden="true" />
          <span>
            {!hasError && 'No errors found in this recording. '}
            There isn’t enough timing data in this capture to place an error on the timeline.
          </span>
        </div>
      ) : (
        <>
          <div className={`ww-track${hasError ? ' has-error' : ' no-error'}`} aria-hidden="true">
            <span className="ww-track-line" />
            {hasError && <span className="ww-track-marker" style={{ left: `${position}%` }} />}
            <span className="ww-track-anchor" />
          </div>
          <div className="ww-track-labels">
            <span>
              <span className="ww-track-dot ww-dot-anchor" />
              {anchorName}{anchorTime && <time dateTime={timeline.anchorAt ?? undefined}> · {anchorTime}</time>}
            </span>
            {hasError ? (
              <span className="ww-error-time" data-testid="value-first-error-time">
                <span className="ww-track-dot ww-dot-error" />
                First error{errorTime && <time dateTime={timeline.firstErrorAt ?? undefined}> · {errorTime}</time>}
              </span>
            ) : (
              <span className="ww-no-error-label" data-testid="status-no-timeline-error">No errors found in this recording</span>
            )}
          </div>
          {hasError && (
            <div className="ww-timeline-summary" data-testid="text-first-error-offset">
              <span className="ww-offset-value">{offsetText ?? 'First error timing is unavailable'}</span>
              {timeline.requestUrl && (
                <span className="ww-timeline-url" title={timeline.requestUrl}>
                  <span>At</span> <code>{timeline.requestUrl}</code>
                </span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FindingCard({ finding, index }: { finding: AnalysisFinding; index: number }) {
  const isProblem = finding.severity === 'problem';
  const SeverityIcon = isProblem ? CircleAlert : AlertTriangle;

  return (
    <article
      className={`ww-finding ww-finding-${finding.severity}`}
      aria-labelledby={`ww-finding-title-${finding.id}`}
      data-testid={`finding-${finding.id}`}
    >
      <div className="ww-finding-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</div>
      <div className="ww-finding-content">
        <div className="ww-finding-topline">
          <span className={`ww-severity ww-severity-${finding.severity}`}>
            <SeverityIcon size={13} aria-hidden="true" />
            {isProblem ? 'Problem' : 'Warning'}
          </span>
          <h3 id={`ww-finding-title-${finding.id}`} data-testid={`text-finding-title-${finding.id}`}>
            {finding.title}
          </h3>
        </div>
        <p className="ww-explanation" data-testid={`text-finding-explanation-${finding.id}`}>
          {finding.explanation}
        </p>

        {finding.urls.length > 0 && (
          <section className="ww-detail-block" aria-label={`Affected URLs for ${finding.title}`}>
            <h4><ExternalLink size={13} aria-hidden="true" /> Affected URLs</h4>
            <ul className="ww-url-list">
              {finding.urls.map((url, urlIndex) => (
                <li key={`${url}-${urlIndex}`} data-testid={`url-finding-${finding.id}-${urlIndex}`}>
                  <code title={url}>{url}</code>
                </li>
              ))}
            </ul>
          </section>
        )}

        {finding.whatToRecheck.length > 0 && (
          <section className="ww-recheck" aria-label={`What to re-check for ${finding.title}`}>
            <h4>What to re-check</h4>
            <ul>
              {finding.whatToRecheck.map((item, itemIndex) => (
                <li key={`${item}-${itemIndex}`} data-testid={`recheck-${finding.id}-${itemIndex}`}>
                  <Check size={13} aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </article>
  );
}

export default function WhatWentWrong({ analysis }: WhatWentWrongProps) {
  const findings = rankFindings(analysis.findings);
  const hasProblems = findings.some((finding) => finding.severity === 'problem');
  const verdictClass = analysis.verdict === 'Healthy'
    ? 'healthy'
    : hasProblems ? 'problems' : 'warnings';
  const VerdictIcon = analysis.verdict === 'Healthy' ? ShieldCheck : hasProblems ? CircleAlert : AlertTriangle;

  return (
    <section
      className={`what-went-wrong ww-verdict-${verdictClass}`}
      aria-labelledby="ww-heading"
      data-testid="panel-what-went-wrong"
    >
      <header className="ww-verdict">
        <div className="ww-verdict-icon" aria-hidden="true"><VerdictIcon size={21} strokeWidth={1.9} /></div>
        <div className="ww-verdict-copy">
          <div className="ww-section-kicker">Capture diagnosis</div>
          <h2 id="ww-heading" data-testid="text-verdict">{analysis.verdict}</h2>
          <p data-testid="text-verdict-summary">
            {findings.length === 0
              ? 'No notable network issues were found in this recording.'
              : `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'} to review, ordered by severity.`}
          </p>
        </div>
        <div className="ww-finding-count" data-testid="value-finding-count">
          <strong>{findings.length}</strong>
          <span>{findings.length === 1 ? 'finding' : 'findings'}</span>
        </div>
      </header>

      {findings.length === 0 ? (
        <div className="ww-healthy-state" role="status" data-testid="status-healthy">
          <div className="ww-healthy-mark"><Check size={16} aria-hidden="true" /></div>
          <div>
            <h3>Nothing needs attention</h3>
            <p>Requests in this capture look healthy. You can still review the timeline and request list below.</p>
          </div>
        </div>
      ) : (
        <div className="ww-findings" aria-label="Findings, ranked by severity" data-testid="list-findings">
          {findings.map((finding, index) => (
            <FindingCard key={finding.id} finding={finding} index={index} />
          ))}
        </div>
      )}

      <Timeline analysis={analysis} />
    </section>
  );
}
