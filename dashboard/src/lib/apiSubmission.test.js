import { afterEach, expect, test, vi } from 'vitest';

import { submitBatchJob, submitProcessJob } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function okResponse(body) {
  return { ok: true, json: () => Promise.resolve(body) };
}

test('keyless process submission omits the Gemini header', async () => {
  const fetchMock = vi.fn().mockResolvedValue(okResponse({ job_id: 'offline' }));
  vi.stubGlobal('fetch', fetchMock);

  await submitProcessJob({ type: 'url', payload: 'https://example.com/video' }, '   ');

  const headers = fetchMock.mock.calls[0][1].headers;
  expect(headers['Content-Type']).toBe('application/json');
  expect(headers).not.toHaveProperty('X-Gemini-Key');
});

test('keyless batch submission omits the Gemini header', async () => {
  const fetchMock = vi.fn().mockResolvedValue(okResponse({ jobs: [], total: 0 }));
  vi.stubGlobal('fetch', fetchMock);

  await submitBatchJob({ urls: ['https://example.com/video'] }, '');

  expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
});
