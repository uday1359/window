import { Injectable } from '@nestjs/common';
import type { Integration } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiClientService, AiServiceError, IntegrationConfig } from '../ai/ai-client.service';
import type { OperationResult } from '../realtime/agent-hub.service';
import type { IntegrationSummary } from '../operations/operations';

/** Outcome unknown: the request may have reached the external service. Never retried blindly. */
export class IntegrationUncertainError extends Error {}

export function toConfig(i: Integration): IntegrationConfig {
  return {
    name: i.name,
    kind: i.kind,
    baseUrl: i.baseUrl,
    allowedPaths: (i.allowedPaths as string[]) ?? [],
    allowedTools: (i.allowedTools as string[]) ?? [],
    authHeader: i.authHeader,
    authScheme: i.authScheme,
    secretRef: i.secretRef,
  };
}

/**
 * Runs integration steps (FR-17). The policy engine has already checked that the
 * integration is registered and enabled and that the path/tool is allowed; the AI service,
 * which holds the credentials, checks again and performs the call.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClientService,
  ) {}

  async summaries(): Promise<IntegrationSummary[]> {
    const rows = await this.prisma.integration.findMany({ where: { enabled: true }, orderBy: { name: 'asc' } });
    return rows.map((i) => ({ name: i.name, kind: i.kind, description: i.description, allowedPaths: (i.allowedPaths as string[]) ?? [], allowedTools: (i.allowedTools as string[]) ?? [] }));
  }

  async execute(operation: string, params: Record<string, unknown>): Promise<OperationResult> {
    const row = await this.prisma.integration.findUnique({ where: { name: String(params.integration) } });
    if (!row || !row.enabled) return { ok: false, code: 'POLICY_DENIED', error: `Integration "${String(params.integration)}" is not registered or is disabled` };
    const integration = toConfig(row);
    try {
      let output: Record<string, unknown>;
      if (operation === 'integration.mcp_tool') {
        output = await this.ai.integrationMcpCall({ integration, tool: String(params.tool), arguments: (params.arguments as Record<string, unknown>) ?? {} });
        if (output.isError === true) return { ok: false, code: 'REMOTE_ERROR', error: `The tool reported an error: ${String(output.text ?? '').slice(0, 500)}`, output };
      } else {
        const method = operation === 'integration.rest_post' ? 'POST' : 'GET';
        output = await this.ai.integrationRest({ integration, method, path: String(params.path), query: params.query as Record<string, unknown> | undefined, body: params.body });
        if (output.ok !== true) return { ok: false, code: 'REMOTE_ERROR', error: `The service answered HTTP ${String(output.status)}`, output };
      }
      return { ok: true, output: { integration: integration.name, ...output } };
    } catch (err) {
      if (!(err instanceof AiServiceError)) throw err;
      if (err.timedOut) throw new IntegrationUncertainError(err.message);
      const code = err.code ?? (err.status === undefined ? 'UNAVAILABLE' : 'ERROR');
      return { ok: false, code, error: err.message };
    }
  }
}
