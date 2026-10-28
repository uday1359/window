import { Injectable } from '@nestjs/common';
import { loadConfig } from '../config/config';
import { redactString } from '../common/redact';

export class AiServiceError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /** Temporary condition (AI service down, models offline): worth retrying later. */
    public readonly retryable = false,
    /** Machine-readable cause from the AI service (e.g. POLICY_DENIED, TIMEOUT). */
    public readonly code?: string,
    /** The AI service did not answer in time: a forwarded call may or may not have happened. */
    public readonly timedOut = false,
  ) {
    super(message);
  }
}

export interface ModelInfo {
  name: string;
  provider: string;
  model: string;
  endpoint: string;
  isLocal: boolean;
  enabled: boolean;
  maxComplexity: number;
  latencyClass: number;
  costPer1kTokens: number;
  capabilities: string[];
  secretRef: string | null;
}

export interface PlanRequest {
  instruction: string;
  privacyLevel: 'LOCAL_ONLY' | 'CLOUD_REDACTED' | 'CLOUD_ALLOWED';
  models: ModelInfo[];
  roots: string[];
  apps: string[];
  operations: Array<{ name: string; description: string; risk: string }>;
  costLimitUsd: number;
  resources?: Record<string, unknown> | null;
  /** Screenshots attached to the task (FR-01), sent only to vision-capable models. */
  images?: Array<{ mediaType: 'image/png' | 'image/jpeg'; data: string }>;
}

export interface IntegrationConfig {
  name: string;
  kind: 'REST' | 'MCP';
  baseUrl: string;
  allowedPaths: string[];
  allowedTools: string[];
  authHeader: string | null;
  authScheme: string | null;
  secretRef: string | null;
}

export interface ResearchSource {
  id: string;
  url: string;
  title: string;
  domain: string;
  trust: 'official' | 'reference' | 'general';
  text: string;
}

export interface ResearchFindings {
  claims: Array<{ text: string; sources: string[]; status: 'verified' | 'single-source' }>;
  model: string | null;
  note: string;
  warnings?: string[];
}

export interface PlanResponse {
  plan: unknown;
  source: string;
  routing: { model: string | null; cloud: boolean; reason: string; redacted: boolean };
  warnings: string[];
}

/** Thin authenticated client for the local Python AI service. */
@Injectable()
export class AiClientService {
  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, timeoutMs = 90_000): Promise<T> {
    const cfg = loadConfig();
    let res: Response;
    try {
      res = await fetch(`${cfg.AI_SERVICE_URL}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-service-token': cfg.AI_SERVICE_TOKEN },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new AiServiceError(`AI service unreachable: ${timedOut ? 'timed out' : 'connection failed'}`, undefined, true, timedOut ? 'TIMEOUT' : 'UNAVAILABLE', timedOut);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail: unknown = text.slice(0, 300);
      try {
        detail = JSON.parse(text).detail ?? detail;
      } catch {
        /* non-JSON error body */
      }
      // The planner reports { message, retryable } when no model is available.
      const structured = typeof detail === 'object' && detail !== null && 'message' in detail ? (detail as { message: unknown; retryable?: unknown; code?: unknown }) : null;
      const message = structured ? String(structured.message) : typeof detail === 'string' ? detail : JSON.stringify(detail);
      const code = typeof structured?.code === 'string' ? structured.code : undefined;
      throw new AiServiceError(redactString(`AI service error ${res.status}: ${message}`), res.status, structured?.retryable === true, code, code === 'TIMEOUT');
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  plan(req: PlanRequest): Promise<PlanResponse> {
    return this.call('POST', '/v1/plan', req);
  }

  integrationRest(req: { integration: IntegrationConfig; method: 'GET' | 'POST'; path: string; query?: Record<string, unknown>; body?: unknown }): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/integrations/rest', req, 40_000);
  }

  integrationMcpCall(req: { integration: IntegrationConfig; tool: string; arguments: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/integrations/mcp/call', req, 40_000);
  }

  integrationMcpTools(integration: IntegrationConfig): Promise<{ tools: Array<{ name: string; description: string }> }> {
    return this.call('POST', '/v1/integrations/mcp/tools', { integration }, 40_000);
  }

  synthesize(req: { question: string; sources: ResearchSource[]; privacyLevel: PlanRequest['privacyLevel']; models: ModelInfo[]; costLimitUsd: number }): Promise<ResearchFindings> {
    return this.call('POST', '/v1/research/synthesize', req);
  }

  health(): Promise<Record<string, unknown>> {
    return this.call('GET', '/health', undefined, 5_000);
  }

  route(req: Omit<PlanRequest, 'instruction' | 'roots' | 'apps' | 'operations'> & { complexity: number; capability: string }): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/route', req, 10_000);
  }

  listSecrets(): Promise<{ names: string[] }> {
    return this.call('GET', '/v1/secrets', undefined, 10_000);
  }

  putSecret(name: string, value: string): Promise<{ ok: boolean }> {
    return this.call('PUT', `/v1/secrets/${encodeURIComponent(name)}`, { value }, 10_000);
  }

  deleteSecret(name: string): Promise<{ ok: boolean }> {
    return this.call('DELETE', `/v1/secrets/${encodeURIComponent(name)}`, undefined, 10_000);
  }
}
