export type FindingSeverity = 'problem' | 'warning';

export interface AnalysisFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  explanation: string;
  urls: string[];
  whatToRecheck: string[];
}

export interface AnalysisTimeline {
  anchor: 'page-load' | 'first-request' | 'none';
  anchorAt: string | null;
  firstErrorAt: string | null;
  offsetMs: number | null;
  requestUrl: string | null;
  totalMs: number | null;
}

export interface AnalysisResult {
  verdict: 'Healthy' | 'Warnings' | 'Problems found';
  findings: AnalysisFinding[];
  timeline: AnalysisTimeline;
}

export function analyzeHar(
  entries: unknown[],
  pages?: unknown[],
): AnalysisResult;
