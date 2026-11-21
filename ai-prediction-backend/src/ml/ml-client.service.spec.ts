import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MlClientService } from './ml-client.service';

describe('MlClientService', () => {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'ML_SERVICE_URL') return 'http://127.0.0.1:8000';
      if (key === 'ML_SERVICE_TIMEOUT_MS') return 1000;
      if (key === 'ML_SERVICE_RETRIES') return 1;
      return undefined;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'ML_SERVICE_TOKEN') return 'z'.repeat(32);
      throw new Error(`missing ${key}`);
    }),
  } as unknown as ConfigService;

  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns ready status from the ML health endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'model_required',
        modelAvailable: false,
        operatingMode: 'synthetic_demo',
        disclaimer: 'Synthetic demo mode only.',
        isSynthetic: true,
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new MlClientService(config);
    await expect(client.getReadyStatus()).resolves.toEqual(expect.objectContaining({
      status: 'model_required',
      operatingMode: 'synthetic_demo',
      isSynthetic: true,
    }));
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8000/health/ready', expect.objectContaining({ method: 'GET' }));
  });

  it('retries then surfaces service unavailable on connection failure', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('fetch failed'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new MlClientService(config);
    await expect(client.getReadyStatus()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('sends the internal service token on protected routes', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { modelVersion: 'synthetic-1', isSynthetic: true } }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new MlClientService(config);
    await expect(client.getModelMetadata()).resolves.toEqual(expect.objectContaining({ modelVersion: 'synthetic-1' }));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/model',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-ML-Service-Token': 'z'.repeat(32) }),
      }),
    );
  });
});
