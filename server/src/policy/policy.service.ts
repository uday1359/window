import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { evaluateStep, PolicyContext, StepDecision } from './policy';

export const PREF_APPROVE_MEDIUM = 'approveMediumRisk';

interface DeviceInfo {
  allowedRoots: unknown;
  capabilities: unknown;
}

@Injectable()
export class PolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async context(userId: string, device: DeviceInfo | null): Promise<PolicyContext> {
    const [rules, pref, integrations] = await Promise.all([
      this.prisma.permissionPolicy.findMany({ where: { userId, revokedAt: null }, select: { kind: true, value: true, effect: true } }),
      this.prisma.userPreference.findUnique({ where: { userId_key: { userId, key: PREF_APPROVE_MEDIUM } } }),
      this.prisma.integration.findMany({ select: { name: true, kind: true, enabled: true, allowedPaths: true, allowedTools: true } }),
    ]);
    const caps = (device?.capabilities ?? {}) as { apps?: unknown };
    return {
      rules,
      deviceRoots: Array.isArray(device?.allowedRoots) ? (device!.allowedRoots as string[]) : null,
      deviceApps: Array.isArray(caps.apps) ? (caps.apps as string[]) : null,
      approveMediumRisk: pref?.value === true,
      integrations: integrations.map((i) => ({ ...i, allowedPaths: (i.allowedPaths as string[]) ?? [], allowedTools: (i.allowedTools as string[]) ?? [] })),
    };
  }

  evaluate(ctx: PolicyContext, operation: string, params: Record<string, unknown>): StepDecision {
    return evaluateStep(ctx, operation, params);
  }
}
