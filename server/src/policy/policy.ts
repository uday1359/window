import { getOperation, isPrivateHost, parseHttpUrl, Risk } from '../operations/operations';

export type PolicyKind = 'FOLDER' | 'WEBSITE' | 'APPLICATION' | 'ACTION';
export type PolicyEffect = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface PolicyRule {
  kind: PolicyKind;
  value: string;
  effect: PolicyEffect;
}

export interface PolicyContext {
  rules: PolicyRule[];
  /** Root names configured locally on the agent; the server can never widen them. */
  deviceRoots: string[] | null;
  /** Applications allow-listed in the agent's local configuration. */
  deviceApps: string[] | null;
  approveMediumRisk: boolean;
  /** Administrator-approved integrations (FR-17); absent means none are registered. */
  integrations?: Array<{ name: string; kind: 'REST' | 'MCP'; enabled: boolean; allowedPaths: string[]; allowedTools: string[] }>;
}

export interface StepDecision {
  risk: Risk;
  requiresApproval: boolean;
  denied: string | null;
  reasons: string[];
}

const RISK_ORDER: Risk[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const maxRisk = (a: Risk, b: Risk): Risk => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b);

export const SEARCH_HOST = 'duckduckgo.com';

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().replace(/^\*\./, '');
  return h === p || h.endsWith(`.${p}`);
}

function folderMatches(root: string, path: string, value: string): boolean {
  const [ruleRoot, rulePrefix] = value.split(':', 2);
  if (ruleRoot !== root) return false;
  if (!rulePrefix) return true;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const p = norm(path);
  const prefix = norm(rulePrefix);
  return p === prefix || p.startsWith(`${prefix}/`);
}

/** DENY beats REQUIRE_APPROVAL beats ALLOW. */
function strongest(effects: PolicyEffect[]): PolicyEffect | null {
  if (effects.includes('DENY')) return 'DENY';
  if (effects.includes('REQUIRE_APPROVAL')) return 'REQUIRE_APPROVAL';
  if (effects.includes('ALLOW')) return 'ALLOW';
  return null;
}

/**
 * Pure policy decision for one step. Evaluated at planning time and again immediately
 * before dispatch, so revoked permissions take effect for queued and running tasks.
 */
export function evaluateStep(ctx: PolicyContext, operation: string, params: Record<string, unknown>): StepDecision {
  const def = getOperation(operation);
  if (!def) return { risk: 'CRITICAL', requiresApproval: true, denied: `Operation "${operation}" is not supported`, reasons: [] };

  let risk: Risk = def.baseRisk;
  let requiresApproval = false;
  const reasons: string[] = [];
  const deny = (why: string): StepDecision => ({ risk: maxRisk(risk, 'HIGH'), requiresApproval: true, denied: why, reasons });

  const rulesOf = (kind: PolicyKind) => ctx.rules.filter((r) => r.kind === kind);

  // Overwrites are reversible (agent backs up the original) but riskier than creation.
  if ((operation === 'file.write' || operation === 'file.copy') && params.overwrite === true) {
    risk = maxRisk(risk, 'MEDIUM');
    reasons.push('Overwrites an existing file (original is backed up first)');
  }

  // ---- folders
  const folderTargets: Array<[string, string]> = [];
  if (typeof params.root === 'string') folderTargets.push([params.root, String(params.path ?? '')]);
  if (typeof params.destRoot === 'string') folderTargets.push([params.destRoot, String(params.destPath ?? '')]);
  for (const [root, path] of folderTargets) {
    if (!ctx.deviceRoots || !ctx.deviceRoots.includes(root)) return deny(`Folder root "${root}" is not approved on the agent device`);
    const effect = strongest(rulesOf('FOLDER').filter((r) => folderMatches(root, path, r.value)).map((r) => r.effect));
    if (effect === 'DENY') return deny(`Access to ${root}:${path || '.'} is denied by policy`);
    if (effect === 'REQUIRE_APPROVAL') {
      requiresApproval = true;
      reasons.push(`Folder ${root}:${path || '.'} requires approval by policy`);
    }
  }

  // ---- websites
  const urls: string[] = [];
  if (typeof params.url === 'string') urls.push(params.url);
  const searches = operation === 'browser.search' || operation === 'browser.research';
  if (searches) urls.push(`https://${SEARCH_HOST}/`);
  if (operation === 'browser.research') {
    // The pages are chosen from search results at run time; the orchestrator passes the
    // WEBSITE DENY rules to the agent so they still apply to every page it opens.
    reasons.push('Opens public web pages chosen from search results (read-only; denied websites are skipped)');
  }
  for (const raw of urls) {
    const url = parseHttpUrl(raw);
    if (!url) return deny('URL is not an allowed http(s) address');
    const effect = strongest(rulesOf('WEBSITE').filter((r) => hostMatches(url.hostname, r.value)).map((r) => r.effect));
    if (effect === 'DENY') return deny(`Website ${url.hostname} is denied by policy`);
    if (isPrivateHost(url.hostname) && effect !== 'ALLOW') {
      risk = maxRisk(risk, 'HIGH');
      reasons.push(`${url.hostname} is a local/private network address`);
    }
    if (effect === 'REQUIRE_APPROVAL' || (effect === null && !searches)) {
      requiresApproval = true;
      reasons.push(effect === null ? `Website ${url.hostname} is not on the allow list` : `Website ${url.hostname} requires approval by policy`);
    }
  }

  // ---- integrations: only registered, enabled ones, within their allowed paths / tools
  if (operation.startsWith('integration.')) {
    const name = String(params.integration);
    const integration = ctx.integrations?.find((i) => i.name === name);
    if (!integration || !integration.enabled) return deny(`Integration "${name}" is not registered or is disabled`);
    const wantsMcp = operation === 'integration.mcp_tool';
    if ((integration.kind === 'MCP') !== wantsMcp) return deny(`Integration "${name}" is a ${integration.kind} integration`);
    if (wantsMcp) {
      if (!integration.allowedTools.includes(String(params.tool))) return deny(`Tool "${String(params.tool)}" is not allowed for integration "${name}"`);
    } else {
      const path = String(params.path);
      const allowed = integration.allowedPaths.some((p) => path === p || path.startsWith(`${p.replace(/\/+$/, '')}/`));
      if (!allowed) return deny(`Path ${path} is not allowed for integration "${name}"`);
    }
    reasons.push(`Uses the external "${name}" integration`);
  }

  // ---- applications
  if (operation === 'desktop.launch_app') {
    const app = String(params.app);
    if (!ctx.deviceApps || !ctx.deviceApps.includes(app)) return deny(`Application "${app}" is not in the agent's allow list`);
    const effect = strongest(rulesOf('APPLICATION').filter((r) => r.value.toLowerCase() === app).map((r) => r.effect));
    if (effect === 'DENY') return deny(`Application "${app}" is denied by policy`);
    if (effect === 'REQUIRE_APPROVAL') {
      requiresApproval = true;
      reasons.push(`Application "${app}" requires approval by policy`);
    }
  }

  // ---- actions
  const actionEffect = strongest(rulesOf('ACTION').filter((r) => r.value === operation || r.value === '*').map((r) => r.effect));
  if (actionEffect === 'DENY') return deny(`Action ${operation} is denied by policy`);
  if (actionEffect === 'REQUIRE_APPROVAL') {
    requiresApproval = true;
    reasons.push(`Action ${operation} requires approval by policy`);
  }

  // ---- risk-based approval. ALLOW policies can never waive approval for HIGH/CRITICAL or external effects.
  if (risk === 'HIGH' || risk === 'CRITICAL') {
    requiresApproval = true;
    reasons.push(`${risk} risk action`);
  }
  if (def.external) {
    requiresApproval = true;
    reasons.push('Has effects outside this computer');
  }
  if (risk === 'MEDIUM' && ctx.approveMediumRisk && actionEffect !== 'ALLOW') {
    requiresApproval = true;
    reasons.push('Medium-risk actions require approval (user preference)');
  }

  return { risk, requiresApproval, denied: null, reasons };
}

export function overallRisk(decisions: StepDecision[]): Risk {
  return decisions.reduce<Risk>((acc, d) => maxRisk(acc, d.risk), 'LOW');
}
