import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type MlOperatingMode = 'synthetic_demo' | 'validated_model' | 'production_prediction';

export interface MlReadyStatus {
  status: string;
  modelAvailable: boolean;
  operatingMode: MlOperatingMode | string;
  disclaimer: string;
  isSynthetic: boolean;
  modelVersion?: string;
  artifactOperatingMode?: string;
  versions?: string[];
}

export interface MlPredictionResult {
  modelVersion: string;
  prediction: string;
  targetDefinition: string;
  probabilityCalibrated: boolean;
  operatingMode: string;
  isSynthetic: boolean;
  disclaimer: string;
  probabilities?: Record<string, number>;
}

@Injectable()
export class MlClientService {
  private readonly logger = new Logger(MlClientService.name);

  constructor(private readonly config: ConfigService) {}

  private baseUrl(): string {
    return (this.config.get<string>('ML_SERVICE_URL') ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
  }

  private token(): string {
    return this.config.getOrThrow<string>('ML_SERVICE_TOKEN');
  }

  private timeoutMs(): number {
    const raw = Number(this.config.get<string | number>('ML_SERVICE_TIMEOUT_MS') ?? 3000);
    return Number.isFinite(raw) && raw >= 250 && raw <= 60000 ? raw : 3000;
  }

  private maxAttempts(): number {
    const raw = Number(this.config.get<string | number>('ML_SERVICE_RETRIES') ?? 2);
    // retries = additional attempts after the first; clamp 0..3 => 1..4 total attempts
    const retries = Number.isFinite(raw) ? Math.max(0, Math.min(3, Math.trunc(raw))) : 2;
    return retries + 1;
  }

  async getReadyStatus(): Promise<MlReadyStatus> {
    return this.requestJson<MlReadyStatus>('GET', '/health/ready', { auth: false });
  }

  async getModelMetadata(): Promise<Record<string, unknown>> {
    const body = await this.requestJson<{ data: Record<string, unknown> }>('GET', '/v1/model', { auth: true });
    return body.data;
  }

  /**
   * Low-level inference call for future gated use. Does not persist predictions.
   * Callers must refuse synthetic results for student-facing risk workflows.
   */
  async predict(features: Record<string, string | number | null>): Promise<MlPredictionResult> {
    const body = await this.requestJson<{ data: MlPredictionResult }>('POST', '/v1/predict', {
      auth: true,
      payload: { features },
    });
    return body.data;
  }

  async probe(): Promise<{ reachable: boolean; ready?: MlReadyStatus; error?: string }> {
    try {
      const ready = await this.getReadyStatus();
      return { reachable: true, ready };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ML service unavailable';
      return { reachable: false, error: message };
    }
  }

  private async requestJson<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { auth: boolean; payload?: unknown },
  ): Promise<T> {
    const url = `${this.baseUrl()}${path}`;
    const attempts = this.maxAttempts();
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs());
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (options.auth) headers['X-ML-Service-Token'] = this.token();
        if (options.payload !== undefined) headers['Content-Type'] = 'application/json';

        const response = await fetch(url, {
          method,
          headers,
          body: options.payload === undefined ? undefined : JSON.stringify(options.payload),
          signal: controller.signal,
        });

        if (response.status === 503) {
          throw new ServiceUnavailableException('ML service reported model or policy unavailable');
        }
        if (response.status === 401) {
          throw new ServiceUnavailableException('ML service authentication failed');
        }
        if (!response.ok) {
          throw new ServiceUnavailableException(`ML service returned HTTP ${response.status}`);
        }
        return (await response.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = lastError.name === 'AbortError' || /fetch failed|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i.test(lastError.message) || lastError.message.includes('HTTP 5');
        this.logger.warn(`ML request ${method} ${path} attempt ${attempt}/${attempts} failed: ${lastError.message}`);
        if (!retryable || attempt === attempts) break;
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw new ServiceUnavailableException(lastError?.message ?? 'ML service unavailable');
  }
}
