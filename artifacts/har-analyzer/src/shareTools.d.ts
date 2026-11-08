import type { AnalysisResult } from './analyzer.js';

export interface ShareRequest {
  method: string;
  url: string;
  status: number | null;
  mimeType: string;
  time: number | null;
  size: number | null;
}

export interface ReportOptions {
  fileName: string;
  requests: ShareRequest[];
  totalTime: number;
  failedCount: number;
  analysis: AnalysisResult;
}

export function redactHar(har: unknown): {
  har: unknown;
  redactedCount: number;
};

export function buildSummaryText(options: ReportOptions): string;
export function buildReportHtml(options: ReportOptions): string;
export function downloadTextFile(
  fileName: string,
  content: string,
  mimeType: string,
): void;
