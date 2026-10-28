import { evaluateStep, PolicyContext, PolicyRule } from './policy';

const base: PolicyContext = { rules: [], deviceRoots: ['test', 'workspace'], deviceApps: ['notepad'], approveMediumRisk: false };
const ctx = (rules: PolicyRule[] = [], extra: Partial<PolicyContext> = {}): PolicyContext => ({ ...base, rules, ...extra });

describe('evaluateStep', () => {
  it('auto-allows low-risk file creation in an approved root', () => {
    expect(evaluateStep(ctx(), 'file.write', { root: 'test', path: 'a.txt', content: 'x', overwrite: false })).toEqual({ risk: 'LOW', requiresApproval: false, denied: null, reasons: [] });
  });

  it('denies roots the agent did not configure, even if a policy allows them', () => {
    const d = evaluateStep(ctx([{ kind: 'FOLDER', value: 'system', effect: 'ALLOW' }]), 'file.read', { root: 'system', path: 'x' });
    expect(d.denied).toMatch(/not approved on the agent/);
  });

  it('denies when no device is known', () => {
    expect(evaluateStep(ctx([], { deviceRoots: null }), 'file.read', { root: 'test', path: 'x' }).denied).toBeTruthy();
  });

  it('applies folder DENY and sub-path REQUIRE_APPROVAL rules', () => {
    expect(evaluateStep(ctx([{ kind: 'FOLDER', value: 'test', effect: 'DENY' }]), 'file.read', { root: 'test', path: 'a' }).denied).toMatch(/denied by policy/);
    const d = evaluateStep(ctx([{ kind: 'FOLDER', value: 'test:private', effect: 'REQUIRE_APPROVAL' }]), 'file.read', { root: 'test', path: 'private/x.txt' });
    expect(d.requiresApproval).toBe(true);
    expect(evaluateStep(ctx([{ kind: 'FOLDER', value: 'test:private', effect: 'REQUIRE_APPROVAL' }]), 'file.read', { root: 'test', path: 'privateer.txt' }).requiresApproval).toBe(false);
  });

  it('checks destination roots for copy/move', () => {
    expect(evaluateStep(ctx(), 'file.copy', { root: 'test', path: 'a', destRoot: 'other', destPath: 'b' }).denied).toBeTruthy();
  });

  it('raises overwrite to MEDIUM but keeps it automatic by default', () => {
    const d = evaluateStep(ctx(), 'file.write', { root: 'test', path: 'a', content: 'x', overwrite: true });
    expect(d.risk).toBe('MEDIUM');
    expect(d.requiresApproval).toBe(false);
    expect(evaluateStep(ctx([], { approveMediumRisk: true }), 'file.write', { root: 'test', path: 'a', content: 'x', overwrite: true }).requiresApproval).toBe(true);
  });

  it('always requires approval for HIGH risk and external effects, even with ALLOW', () => {
    const allowAll: PolicyRule[] = [{ kind: 'ACTION', value: '*', effect: 'ALLOW' }];
    expect(evaluateStep(ctx(allowAll), 'file.delete', { root: 'test', path: 'a' }).requiresApproval).toBe(true);
    expect(evaluateStep(ctx(allowAll), 'browser.submit', { selector: '#go' }).requiresApproval).toBe(true);
    expect(evaluateStep(ctx(allowAll), 'browser.click', { selector: '#go' }).requiresApproval).toBe(true);
  });

  it('handles websites: deny, allow list, unknown and private hosts', () => {
    expect(evaluateStep(ctx([{ kind: 'WEBSITE', value: 'evil.com', effect: 'DENY' }]), 'browser.open', { url: 'https://www.evil.com/x' }).denied).toMatch(/denied/);
    expect(evaluateStep(ctx([{ kind: 'WEBSITE', value: 'example.com', effect: 'ALLOW' }]), 'browser.open', { url: 'https://docs.example.com' }).requiresApproval).toBe(false);
    expect(evaluateStep(ctx(), 'browser.open', { url: 'https://unknown.org' }).requiresApproval).toBe(true);
    const local = evaluateStep(ctx(), 'browser.open', { url: 'http://192.168.1.1/admin' });
    expect(local.risk).toBe('HIGH');
    expect(local.requiresApproval).toBe(true);
    expect(evaluateStep(ctx(), 'browser.search', { query: 'x' }).requiresApproval).toBe(false);
    expect(evaluateStep(ctx([{ kind: 'WEBSITE', value: 'duckduckgo.com', effect: 'DENY' }]), 'browser.search', { query: 'x' }).denied).toBeTruthy();
  });

  it('treats research as medium-risk read-only browsing behind the search engine policy', () => {
    const d = evaluateStep(ctx(), 'browser.research', { query: 'python release', maxSources: 3 });
    expect(d).toMatchObject({ risk: 'MEDIUM', requiresApproval: false, denied: null });
    expect(d.reasons.join(' ')).toMatch(/denied websites are skipped/);
    expect(evaluateStep(ctx([], { approveMediumRisk: true }), 'browser.research', { query: 'x', maxSources: 3 }).requiresApproval).toBe(true);
    expect(evaluateStep(ctx([{ kind: 'WEBSITE', value: 'duckduckgo.com', effect: 'DENY' }]), 'browser.research', { query: 'x', maxSources: 3 }).denied).toBeTruthy();
  });

  it('allows only registered, enabled integrations within their paths and tools', () => {
    const integrations = [
      { name: 'weather', kind: 'REST' as const, enabled: true, allowedPaths: ['/v1/forecast'], allowedTools: [] },
      { name: 'tickets', kind: 'MCP' as const, enabled: true, allowedTools: ['create_ticket'], allowedPaths: [] },
      { name: 'old', kind: 'REST' as const, enabled: false, allowedPaths: ['/'], allowedTools: [] },
    ];
    const c = ctx([], { integrations });
    const get = evaluateStep(c, 'integration.rest_get', { integration: 'weather', path: '/v1/forecast/today' });
    expect(get).toMatchObject({ risk: 'MEDIUM', requiresApproval: false, denied: null });
    expect(evaluateStep(c, 'integration.rest_get', { integration: 'weather', path: '/v1/admin' }).denied).toMatch(/not allowed/);
    expect(evaluateStep(c, 'integration.rest_get', { integration: 'weather', path: '/v1/forecastX' }).denied).toMatch(/not allowed/);
    expect(evaluateStep(c, 'integration.rest_get', { integration: 'old', path: '/x' }).denied).toMatch(/disabled/);
    expect(evaluateStep(c, 'integration.rest_get', { integration: 'nope', path: '/x' }).denied).toMatch(/not registered/);
    expect(evaluateStep(c, 'integration.rest_get', { integration: 'tickets', path: '/x' }).denied).toMatch(/MCP integration/);
    // Anything that can change data elsewhere always needs approval, even with an ALLOW rule.
    const post = evaluateStep(ctx([{ kind: 'ACTION', value: 'integration.rest_post', effect: 'ALLOW' }], { integrations }), 'integration.rest_post', { integration: 'weather', path: '/v1/forecast', body: {} });
    expect(post).toMatchObject({ risk: 'HIGH', requiresApproval: true, denied: null });
    expect(evaluateStep(c, 'integration.mcp_tool', { integration: 'tickets', tool: 'create_ticket', arguments: {} })).toMatchObject({ requiresApproval: true, denied: null });
    expect(evaluateStep(c, 'integration.mcp_tool', { integration: 'tickets', tool: 'delete_all', arguments: {} }).denied).toMatch(/not allowed/);
    expect(evaluateStep(ctx(), 'integration.rest_get', { integration: 'weather', path: '/v1/forecast' }).denied).toMatch(/not registered/);
  });

  it('handles applications', () => {
    expect(evaluateStep(ctx(), 'desktop.launch_app', { app: 'notepad' }).denied).toBeNull();
    expect(evaluateStep(ctx(), 'desktop.launch_app', { app: 'regedit' }).denied).toMatch(/allow list/);
    expect(evaluateStep(ctx([{ kind: 'APPLICATION', value: 'notepad', effect: 'DENY' }]), 'desktop.launch_app', { app: 'notepad' }).denied).toBeTruthy();
  });

  it('DENY beats ALLOW for actions and unknown operations are denied', () => {
    const rules: PolicyRule[] = [
      { kind: 'ACTION', value: 'file.read', effect: 'ALLOW' },
      { kind: 'ACTION', value: 'file.read', effect: 'DENY' },
    ];
    expect(evaluateStep(ctx(rules), 'file.read', { root: 'test', path: 'a' }).denied).toBeTruthy();
    expect(evaluateStep(ctx(), 'shell.exec', {}).denied).toMatch(/not supported/);
  });
});
