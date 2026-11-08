import { analyzeHar, type AnalysisResult } from '../analyzer.js';

type HarRequest = {
  id: number;
  method: string;
  url: string;
  status: number | null;
  mimeType: string;
  time: number | null;
  size: number | null;
};

type WorkerResponse =
  | { ok: true; requests: HarRequest[]; totalTime: number; analysis: AnalysisResult }
  | { ok: false; error: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<File>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function displayText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '—';
}

workerScope.onmessage = async (event) => {
  try {
    const parsed: unknown = JSON.parse(await event.data.text());
    const log = record(record(parsed).log);
    const entries = log.entries;
    if (!Array.isArray(entries)) {
      workerScope.postMessage({
        ok: false,
        error:
          'This JSON does not contain a valid HAR log.entries array. Choose a HAR export and try again.',
      });
      return;
    }

    const requests = entries.map((rawEntry, id): HarRequest => {
      const entry = record(rawEntry);
      const request = record(entry.request);
      const response = record(entry.response);
      const content = record(response.content);
      const rawMimeType =
        typeof content.mimeType === 'string' ? content.mimeType.split(';')[0] : '';
      const rawTime = finiteNumber(entry.time);
      const contentSize = finiteNumber(content.size);
      const bodySize = finiteNumber(response.bodySize);
      return {
        id,
        method: displayText(request.method).toUpperCase(),
        url: displayText(request.url),
        status: finiteNumber(response.status),
        mimeType: rawMimeType || '—',
        time: rawTime !== null && rawTime >= 0 ? rawTime : null,
        size: contentSize !== null && contentSize >= 0 ? contentSize : bodySize,
      };
    });

    const totalTime = entries.reduce((total, rawEntry) => {
      const time = finiteNumber(record(rawEntry).time);
      return time === null || time < 0 ? total : total + time;
    }, 0);
    const pages = Array.isArray(log.pages) ? log.pages : [];
    const analysis = analyzeHar(entries, pages);
    workerScope.postMessage({ ok: true, requests, totalTime, analysis });
  } catch {
    workerScope.postMessage({
      ok: false,
      error:
        'We couldn’t read this file as JSON. Check that it is a complete, valid HAR recording.',
    });
  }
};

export {};
