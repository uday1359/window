import { generalizeTaskFolder, isSafeRelativePath, operationCatalog, parseHttpUrl, PlanValidationError, substituteTaskFolder, validatePlan } from './operations';

const hello = {
  title: 'Create hello.txt',
  steps: [
    { operation: 'file.write', description: 'write', params: { root: 'test', path: 'hello.txt', content: 'Hello from my AI agent.' } },
    { operation: 'file.read', description: 'read', params: { root: 'test', path: 'hello.txt' } },
  ],
  successCriteria: [{ kind: 'file_content_equals', root: 'test', path: 'hello.txt', expected: 'Hello from my AI agent.' }],
};

describe('validatePlan (model output is untrusted)', () => {
  it('accepts the acceptance-test plan and applies defaults', () => {
    const plan = validatePlan(hello);
    expect(plan.steps[0].params).toEqual({ root: 'test', path: 'hello.txt', content: 'Hello from my AI agent.', overwrite: false });
  });

  it.each([
    ['unknown/shell operation', { ...hello, steps: [{ operation: 'shell.exec', description: 'x', params: { cmd: 'del /s C:\\' } }] }],
    ['path traversal', { ...hello, steps: [{ operation: 'file.read', description: 'x', params: { root: 'test', path: '..\\..\\Windows\\win.ini' } }] }],
    ['absolute path', { ...hello, steps: [{ operation: 'file.read', description: 'x', params: { root: 'test', path: 'C:\\Windows\\win.ini' } }] }],
    ['unexpected param', { ...hello, steps: [{ operation: 'file.read', description: 'x', params: { root: 'test', path: 'a.txt', elevate: true } }] }],
    ['executable write', { ...hello, steps: [{ operation: 'file.write', description: 'x', params: { root: 'test', path: 'run.ps1', content: 'x' } }] }],
    ['javascript url', { ...hello, steps: [{ operation: 'browser.open', description: 'x', params: { url: 'javascript:alert(1)' } }] }],
    ['no success criteria', { ...hello, successCriteria: [] }],
    ['out of range criterion', { ...hello, successCriteria: [{ kind: 'step_succeeded', stepIndex: 5 }] }],
    ['too many steps', { ...hello, steps: Array(21).fill(hello.steps[1]) }],
  ])('rejects %s', (_name, plan) => {
    expect(() => validatePlan(plan)).toThrow(PlanValidationError);
  });

  it('accepts a clarification-only plan', () => {
    expect(validatePlan({ title: 'q', steps: [], successCriteria: [], clarification: 'Which folder?' }).clarification).toBe('Which folder?');
  });

  it('rejects non-objects', () => {
    expect(() => validatePlan('rm -rf /')).toThrow(PlanValidationError);
  });
});

describe('path and URL safety', () => {
  it.each(['a.txt', 'sub/dir/a.txt', 'task-1234/out.md'])('allows %s', (p) => expect(isSafeRelativePath(p)).toBe(true));
  it.each(['', '../a', 'a/../b', '/a', '\\a', 'C:a', 'a:stream', 'CON', 'aux.txt', 'a./b', 'a\u0000b', 'x'.repeat(300)])('rejects %j', (p) => expect(isSafeRelativePath(p)).toBe(false));
  it('only allows credential-free http(s) URLs', () => {
    expect(parseHttpUrl('https://example.com/a')).not.toBeNull();
    expect(parseHttpUrl('file:///C:/Windows')).toBeNull();
    expect(parseHttpUrl('https://user:pw@example.com')).toBeNull();
    expect(parseHttpUrl('http://169.254.169.254/latest')).toBeNull();
  });
});

describe('task folders', () => {
  it('substitutes and generalises the {task} placeholder', () => {
    const id = '12345678-aaaa-bbbb-cccc-000000000000';
    const sub = substituteTaskFolder({ path: '{task}/a.txt', list: ['{task}'] }, id);
    expect(sub).toEqual({ path: 'task-12345678/a.txt', list: ['task-12345678'] });
    expect(generalizeTaskFolder(sub, id)).toEqual({ path: '{task}/a.txt', list: ['{task}'] });
  });
});

describe('operationCatalog', () => {
  it('offers integration operations only when matching integrations exist, and names what is allowed', () => {
    expect(operationCatalog().some((o) => o.name.startsWith('integration.'))).toBe(false);
    const ops = operationCatalog([{ name: 'weather', kind: 'REST', description: 'Forecasts', allowedPaths: ['/v1/forecast'], allowedTools: [] }]);
    expect(ops.map((o) => o.name).filter((n) => n.startsWith('integration.'))).toEqual(['integration.rest_get', 'integration.rest_post']);
    expect(ops.find((o) => o.name === 'integration.rest_get')!.description).toContain('weather (paths: /v1/forecast) - Forecasts');
  });

  it('rejects integration paths that try to escape their prefix', () => {
    for (const path of ['/v1/../admin', '//evil.example/x', 'v1/forecast']) {
      expect(() => validatePlan({ title: 't', steps: [{ operation: 'integration.rest_get', description: 'd', params: { integration: 'weather', path } }], successCriteria: [{ kind: 'step_succeeded', stepIndex: 0 }] })).toThrow(PlanValidationError);
    }
  });
});
