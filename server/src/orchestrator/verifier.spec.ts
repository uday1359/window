import { sha256 } from '../common/crypto';
import { overallOutcome, Probe, verifyCriteria } from './verifier';

const EXPECTED = 'Hello from my AI agent.';
const criterion = { kind: 'file_content_equals' as const, root: 'test', path: 'hello.txt', expected: EXPECTED };
const readProbe = (content: string, hash = sha256(Buffer.from(content, 'utf8'))): Probe => async () => ({ ok: true, output: { content, sha256: hash } });

describe('verifyCriteria', () => {
  it('passes only on exact content with a consistent hash', async () => {
    const [e] = await verifyCriteria([criterion], [], readProbe(EXPECTED));
    expect(e.outcome).toBe('PASS');
    expect(e.sha256).toBe(sha256(EXPECTED));
  });

  it.each([
    ['trailing newline', `${EXPECTED}\n`],
    ['missing period', 'Hello from my AI agent'],
    ['different case', 'hello from my ai agent.'],
    ['BOM prefix', String.fromCharCode(0xfeff) + EXPECTED],
    ['empty', ''],
  ])('fails for %s', async (_n, content) => {
    const [e] = await verifyCriteria([criterion], [], readProbe(content));
    expect(e.outcome).toBe('FAIL');
  });

  it('fails when the file is missing', async () => {
    const [e] = await verifyCriteria([criterion], [], async () => ({ ok: false, code: 'NOT_FOUND', error: 'hello.txt does not exist' }));
    expect(e.outcome).toBe('FAIL');
    expect(e.actual).toMatch(/does not exist/);
  });

  it('fails when the agent hash does not match the returned content', async () => {
    const [e] = await verifyCriteria([criterion], [], readProbe(EXPECTED, 'f'.repeat(64)));
    expect(e.outcome).toBe('FAIL');
  });

  it('is inconclusive when the agent is unreachable', async () => {
    const [e] = await verifyCriteria([criterion], [], async () => {
      throw new Error('offline');
    });
    expect(e.outcome).toBe('INCONCLUSIVE');
  });

  it('marks simulated evidence', async () => {
    const [e] = await verifyCriteria([criterion], [], async () => ({ ok: true, output: { content: EXPECTED, sha256: sha256(EXPECTED), simulated: true } }));
    expect(e.isSimulated).toBe(true);
  });

  it('checks step status and page text', async () => {
    const steps = [{ index: 0, operation: 'browser.extract_text', status: 'SUCCEEDED', result: { output: { text: 'Opening Hours 9-5' } } }];
    const ev = await verifyCriteria([{ kind: 'step_succeeded', stepIndex: 0 }, { kind: 'page_contains_text', text: 'opening hours' }, { kind: 'step_succeeded', stepIndex: 3 }], steps, readProbe(''));
    expect(ev.map((e) => e.outcome)).toEqual(['PASS', 'PASS', 'FAIL']);
  });

  it('matches OCR text ignoring case and spacing, and asks OCR for the right window', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const probe: Probe = async (operation, params) => {
      calls.push([operation, params]);
      return { ok: true, output: { text: 'Order   CONFIRMED\nThank you', sha256: 'a'.repeat(64) } };
    };
    const ev = await verifyCriteria([{ kind: 'screen_contains_text', text: 'order confirmed', titleContains: 'Shop' }, { kind: 'screen_contains_text', text: 'payment failed' }], [], probe);
    expect(ev.map((e) => e.outcome)).toEqual(['PASS', 'FAIL']);
    expect(ev[0].sha256).toBe('a'.repeat(64));
    expect(calls).toEqual([['desktop.ocr', { titleContains: 'Shop' }], ['desktop.ocr', {}]]);
  });

  it('treats missing OCR support as inconclusive, not as absent text', async () => {
    const [e] = await verifyCriteria([{ kind: 'screen_contains_text', text: 'x' }], [], async () => ({ ok: false, code: 'UNSUPPORTED', error: 'no Windows OCR language is installed' }));
    expect(e.outcome).toBe('INCONCLUSIVE');
  });
});

describe('overallOutcome', () => {
  const e = (outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE') => ({ outcome }) as never;
  it('never reports success without full evidence', () => {
    expect(overallOutcome([])).toBe('FAILED');
    expect(overallOutcome([e('PASS'), e('PASS')])).toBe('SUCCEEDED');
    expect(overallOutcome([e('PASS'), e('FAIL')])).toBe('PARTIAL');
    expect(overallOutcome([e('FAIL')])).toBe('FAILED');
    expect(overallOutcome([e('PASS'), e('INCONCLUSIVE')])).toBe('BLOCKED');
  });
});
