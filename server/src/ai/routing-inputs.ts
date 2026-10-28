import type { PrismaService } from '../prisma/prisma.service';
import type { ModelInfo } from './ai-client.service';

export const PREF_COST_LIMIT = 'cloudCostLimitUsd';
export const DEFAULT_COST_LIMIT_USD = 0.05;

/** Enabled models and the user's cloud cost limit: what every model call is routed with. */
export async function loadRoutingInputs(prisma: PrismaService, userId: string): Promise<{ models: ModelInfo[]; costLimitUsd: number }> {
  const [models, costPref] = await Promise.all([
    prisma.modelConfig.findMany({ where: { enabled: true } }),
    prisma.userPreference.findUnique({ where: { userId_key: { userId, key: PREF_COST_LIMIT } } }),
  ]);
  return {
    models: models.map((m): ModelInfo => ({ ...m, costPer1kTokens: Number(m.costPer1kTokens), capabilities: (m.capabilities as string[]) ?? [] })),
    costLimitUsd: typeof costPref?.value === 'number' ? costPref.value : DEFAULT_COST_LIMIT_USD,
  };
}
