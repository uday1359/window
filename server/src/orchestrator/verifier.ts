import { sha256 } from '../common/crypto';
import type { SuccessCriterion } from '../operations/operations';
import type { OperationResult } from '../realtime/agent-hub.service';

/** Runs a read-only operation on the agent and returns its result (throws if unreachable). */
export type Probe = (operation: string, params: Record<string, unknown>) => Promise<OperationResult>;

export interface StepSnapshot {
  index: number;
  operation: string;
  status: string;
  result: unknown;
}

export interface EvidenceRecord {
  criterion: string;
  kind: SuccessCriterion['kind'];
  outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  expected: string | null;
  actual: string | null;
  sha256: string | null;
  source: 'agent' | 'server';
  isSimulated: boolean;
}

const EXCERPT = 2000;
const excerpt = (s: unknown): string | null => (typeof s === 'string' ? (s.length > EXCERPT ? `${s.slice(0, EXCERPT)}…` : s) : null);

export function describeCriterion(c: SuccessCriterion): string {
  switch (c.kind) {
    case 'file_exists':
      return `File ${c.root}:${c.path} exists`;
    case 'file_content_equals':
      return `File ${c.root}:${c.path} contains exactly the expected text`;
    case 'file_contains':
      return `File ${c.root}:${c.path} contains "${c.text.slice(0, 80)}"`;
    case 'step_succeeded':
      return `Step ${c.stepIndex + 1} succeeded`;
    case 'page_contains_text':
      return `Extracted page text contains "${c.text.slice(0, 80)}"`;
    case 'window_exists':
      return `A window titled "*${c.titleContains}*" exists`;
    case 'screen_contains_text':
      return `${c.titleContains ? `Window "*${c.titleContains}*"` : 'The screen'} shows "${c.text.slice(0, 80)}" (OCR)`;
  }
}

/** OCR output varies in spacing and case, so text is compared in a normalised form. */
const normalise = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

async function probeSafe(probe: Probe, operation: string, params: Record<string, unknown>): Promise<OperationResult | null> {
  try {
    return await probe(operation, params);
  } catch {
    return null;
  }
}

/**
 * Independently re-checks every success criterion against real evidence. Step outputs
 * are never trusted alone for file criteria: the file is read again from the agent.
 */
export async function verifyCriteria(criteria: SuccessCriterion[], steps: StepSnapshot[], probe: Probe): Promise<EvidenceRecord[]> {
  const out: EvidenceRecord[] = [];
  for (const c of criteria) {
    const base = { criterion: describeCriterion(c), kind: c.kind, expected: null, actual: null, sha256: null, isSimulated: false } as const;
    switch (c.kind) {
      case 'file_exists': {
        const r = await probeSafe(probe, 'file.stat', { root: c.root, path: c.path });
        if (!r) out.push({ ...base, outcome: 'INCONCLUSIVE', source: 'agent', actual: 'Agent unreachable' });
        else {
          const exists = r.ok && r.output?.exists === true && r.output?.isFile === true;
          out.push({ ...base, outcome: exists ? 'PASS' : 'FAIL', source: 'agent', expected: 'exists', actual: exists ? `exists (${r.output?.size} bytes)` : (r.error ?? 'missing'), sha256: (r.output?.sha256 as string) ?? null, isSimulated: r.output?.simulated === true });
        }
        break;
      }
      case 'file_content_equals':
      case 'file_contains': {
        const r = await probeSafe(probe, 'file.read', { root: c.root, path: c.path });
        const expected = c.kind === 'file_content_equals' ? c.expected : c.text;
        if (!r) {
          out.push({ ...base, outcome: 'INCONCLUSIVE', source: 'agent', expected: excerpt(expected), actual: 'Agent unreachable' });
          break;
        }
        if (!r.ok || typeof r.output?.content !== 'string') {
          out.push({ ...base, outcome: 'FAIL', source: 'agent', expected: excerpt(expected), actual: r.error ?? 'File could not be read', isSimulated: r.output?.simulated === true });
          break;
        }
        const content = r.output.content as string;
        const reportedHash = typeof r.output.sha256 === 'string' ? r.output.sha256 : null;
        // The agent's hash must match the content it returned; a mismatch means the evidence is unreliable.
        const consistent = reportedHash === null || reportedHash === sha256(Buffer.from(content, 'utf8'));
        const pass = consistent && (c.kind === 'file_content_equals' ? content === c.expected && (reportedHash === null || reportedHash === sha256(Buffer.from(c.expected, 'utf8'))) : content.includes(c.text));
        out.push({
          ...base,
          outcome: pass ? 'PASS' : 'FAIL',
          source: 'agent',
          expected: excerpt(expected),
          actual: consistent ? excerpt(content) : 'Agent-reported hash does not match returned content',
          sha256: reportedHash,
          isSimulated: r.output.simulated === true,
        });
        break;
      }
      case 'step_succeeded': {
        const step = steps.find((s) => s.index === c.stepIndex);
        out.push({ ...base, outcome: step?.status === 'SUCCEEDED' ? 'PASS' : 'FAIL', source: 'server', expected: 'SUCCEEDED', actual: step?.status ?? 'missing' });
        break;
      }
      case 'page_contains_text': {
        const texts = steps
          .filter((s) => s.operation === 'browser.extract_text' && s.status === 'SUCCEEDED')
          .map((s) => (s.result as { output?: { text?: unknown } } | null)?.output?.text)
          .filter((t): t is string => typeof t === 'string');
        if (texts.length === 0) out.push({ ...base, outcome: 'FAIL', source: 'server', expected: c.text, actual: 'No extracted page text available' });
        else {
          const hit = texts.find((t) => t.toLowerCase().includes(c.text.toLowerCase()));
          out.push({ ...base, outcome: hit ? 'PASS' : 'FAIL', source: 'server', expected: c.text, actual: excerpt(hit ?? texts[texts.length - 1]) });
        }
        break;
      }
      case 'window_exists': {
        const r = await probeSafe(probe, 'desktop.list_windows', {});
        if (!r) out.push({ ...base, outcome: 'INCONCLUSIVE', source: 'agent', expected: c.titleContains, actual: 'Agent unreachable' });
        else {
          const titles = Array.isArray(r.output?.windows) ? (r.output!.windows as Array<{ title?: string }>).map((w) => w.title ?? '') : [];
          const hit = titles.find((t) => t.toLowerCase().includes(c.titleContains.toLowerCase()));
          out.push({ ...base, outcome: r.ok && hit ? 'PASS' : 'FAIL', source: 'agent', expected: c.titleContains, actual: hit ?? (r.error ?? `${titles.length} windows, none matched`), isSimulated: r.output?.simulated === true });
        }
        break;
      }
      case 'screen_contains_text': {
        const r = await probeSafe(probe, 'desktop.ocr', c.titleContains ? { titleContains: c.titleContains } : {});
        if (!r) out.push({ ...base, outcome: 'INCONCLUSIVE', source: 'agent', expected: c.text, actual: 'Agent unreachable' });
        else if (!r.ok) {
          // OCR unavailable is not evidence that the text is absent.
          const unavailable = r.code === 'UNSUPPORTED';
          out.push({ ...base, outcome: unavailable ? 'INCONCLUSIVE' : 'FAIL', source: 'agent', expected: c.text, actual: r.error ?? r.code ?? 'OCR failed' });
        } else {
          const text = typeof r.output?.text === 'string' ? r.output.text : '';
          const pass = normalise(text).includes(normalise(c.text));
          out.push({ ...base, outcome: pass ? 'PASS' : 'FAIL', source: 'agent', expected: c.text, actual: excerpt(text) || '(no text recognised)', sha256: typeof r.output?.sha256 === 'string' ? r.output.sha256 : null, isSimulated: r.output?.simulated === true });
        }
        break;
      }
    }
  }
  return out;
}

export type VerificationOutcome = 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'BLOCKED';

/** Success requires every criterion to pass with real evidence. */
export function overallOutcome(evidence: EvidenceRecord[]): VerificationOutcome {
  if (evidence.length === 0) return 'FAILED';
  const pass = evidence.filter((e) => e.outcome === 'PASS').length;
  const fail = evidence.filter((e) => e.outcome === 'FAIL').length;
  const inconclusive = evidence.length - pass - fail;
  if (pass === evidence.length) return 'SUCCEEDED';
  if (inconclusive > 0 && fail === 0) return 'BLOCKED';
  if (pass > 0) return 'PARTIAL';
  return 'FAILED';
}
