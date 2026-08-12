import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchHealth } from './api';

describe('fetchHealth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns runtime diagnostics from the health endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'healthy', runtime: { selected_device: 'cpu' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchHealth()).resolves.toMatchObject({
      status: 'healthy',
      runtime: { selected_device: 'cpu' },
    });
    expect(fetchMock.mock.calls[0][0]).toContain('/api/health');
  });
});
