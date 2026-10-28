import { z } from 'zod';

/**
 * Whitelist of operations the local agent may perform. Plans (including model output)
 * are rejected unless every step names an operation listed here with valid parameters.
 * There is deliberately no shell / arbitrary-command operation.
 */

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A path relative to a named agent root. Absolute paths, traversal, ADS and device names are rejected. */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 260) return false;
  // Control characters are exactly what is being rejected; ':' covers drive letters and alternate data streams.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f<>:"|?*]/.test(p)) return false;
  if (/^[\\/]/.test(p)) return false;
  const segments = p.split(/[\\/]/);
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..' && !RESERVED_NAMES.test(s) && !/[. ]$/.test(s));
}

export const RootName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Root must be a configured agent root name');
export const RelPath = z.string().refine(isSafeRelativePath, 'Path must be a safe path relative to an approved root');
const OptionalRelPath = z.union([z.literal(''), RelPath]).default('');

const BLOCKED_URL_HOSTS = /^(metadata\.google\.internal|169\.254\.169\.254)$/i;

export function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null; // credentials never travel in URLs
    if (BLOCKED_URL_HOSTS.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h === '::1' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^f[cd][0-9a-f]{2}:/.test(h) ||
    /^fe80:/.test(h)
  );
}

const HttpUrl = z.string().max(2000).refine((u) => parseHttpUrl(u) !== null, 'Only http(s) URLs without embedded credentials are allowed');
const Selector = z.string().min(1).max(500);
export const IntegrationName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Invalid integration name');
const ApiPath = z.string().min(1).max(1000).regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/, 'Path must start with / and contain only URL path characters').refine((p) => !p.includes('//') && !`${p}/`.includes('/../') && !`${p}/`.includes('/./'), 'Path must not contain "//", "." or ".." segments');
const ApiQuery = z.record(z.string().max(100), z.union([z.string().max(1000), z.number(), z.boolean()]));
const ApiBody = z.unknown().refine((b) => b === undefined || JSON.stringify(b).length <= 100_000, 'Body is too large');
const MAX_CONTENT = 1024 * 1024;

/** File types that are never downloaded or written by the agent. */
export const EXECUTABLE_EXTENSIONS = /\.(exe|msi|msix|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|dll|sys|reg|jar|appx|cpl)$/i;

export interface OperationDef {
  name: string;
  description: string;
  params: z.ZodTypeAny;
  baseRisk: Risk;
  /** Re-running with the same parameters gives the same end state. */
  idempotent: boolean;
  /** Has effects outside the local machine (form submissions, external clicks). Never blindly retried. */
  external: boolean;
  timeoutMs: number;
  target: (p: Record<string, unknown>) => string;
  consequences: (p: Record<string, unknown>) => string;
  /** Who performs it: the local agent (default) or the server, for external integrations. */
  executor?: 'agent' | 'server';
}

type TypedDef<S extends z.ZodTypeAny> = Omit<OperationDef, 'params' | 'target' | 'consequences'> & {
  params: S;
  target: (p: z.infer<S>) => string;
  consequences: (p: z.infer<S>) => string;
};

/** Lets each definition use typed parameters while the registry stays uniform. */
function op<S extends z.ZodTypeAny>(def: TypedDef<S>): OperationDef {
  return {
    ...def,
    target: (p) => def.target(p as z.infer<S>),
    consequences: (p) => def.consequences(p as z.infer<S>),
  };
}

export const OPERATIONS = {
  'file.write': op({
    name: 'file.write',
    description: 'Create (or, if overwrite=true, replace) a UTF-8 text file. The original is backed up before replacement.',
    params: z.object({ root: RootName, path: RelPath, content: z.string().max(MAX_CONTENT), overwrite: z.boolean().default(false) }).strict()
      .refine((p) => !EXECUTABLE_EXTENSIONS.test(p.path), 'Executable or script file types cannot be written'),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 15_000,
    target: (p) => `${p.root}:${p.path}`,
    consequences: (p) => (p.overwrite ? 'Replaces the file if it exists (original is backed up first).' : 'Creates a new file. Fails if the file already exists.'),
  }),
  'file.read': op({
    name: 'file.read',
    description: 'Read a text file and return its content and SHA-256.',
    params: z.object({ root: RootName, path: RelPath, maxBytes: z.number().int().positive().max(MAX_CONTENT).default(MAX_CONTENT) }).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 15_000,
    target: (p) => `${p.root}:${p.path}`,
    consequences: () => 'Reads the file. No changes are made.',
  }),
  'file.stat': op({
    name: 'file.stat',
    description: 'Report whether a file exists, its size and SHA-256 (used for verification and resume inspection).',
    params: z.object({ root: RootName, path: RelPath }).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 15_000,
    target: (p) => `${p.root}:${p.path}`,
    consequences: () => 'Reads file metadata. No changes are made.',
  }),
  'file.list': op({
    name: 'file.list',
    description: 'List the entries of a folder.',
    params: z.object({ root: RootName, path: OptionalRelPath }).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 15_000,
    target: (p) => `${p.root}:${p.path || '.'}`,
    consequences: () => 'Lists folder contents. No changes are made.',
  }),
  'file.mkdir': op({
    name: 'file.mkdir',
    description: 'Create a folder (and parents).',
    params: z.object({ root: RootName, path: RelPath }).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 15_000,
    target: (p) => `${p.root}:${p.path}`,
    consequences: () => 'Creates a folder if it does not exist.',
  }),
  'file.copy': op({
    name: 'file.copy',
    description: 'Copy a file to a new location.',
    params: z.object({ root: RootName, path: RelPath, destRoot: RootName, destPath: RelPath, overwrite: z.boolean().default(false) }).strict()
      .refine((p) => !EXECUTABLE_EXTENSIONS.test(p.destPath), 'Executable or script file types cannot be written'),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 30_000,
    target: (p) => `${p.root}:${p.path} -> ${p.destRoot}:${p.destPath}`,
    consequences: (p) => (p.overwrite ? 'Copies the file, replacing the destination (backed up first).' : 'Copies the file to a new destination.'),
  }),
  'file.move': op({
    name: 'file.move',
    description: 'Move or rename a file. A backup copy of the original is kept.',
    params: z.object({ root: RootName, path: RelPath, destRoot: RootName, destPath: RelPath }).strict()
      .refine((p) => !EXECUTABLE_EXTENSIONS.test(p.destPath), 'Executable or script file types cannot be written'),
    baseRisk: 'MEDIUM',
    idempotent: false,
    external: false,
    timeoutMs: 30_000,
    target: (p) => `${p.root}:${p.path} -> ${p.destRoot}:${p.destPath}`,
    consequences: () => 'Moves the file. The original location will no longer contain it (a backup copy is kept).',
  }),
  'file.delete': op({
    name: 'file.delete',
    description: 'Delete a file. The agent moves it to its quarantine folder rather than destroying it.',
    params: z.object({ root: RootName, path: RelPath }).strict(),
    baseRisk: 'HIGH',
    idempotent: false,
    external: false,
    timeoutMs: 15_000,
    target: (p) => `${p.root}:${p.path}`,
    consequences: () => 'Removes the file from its folder. It is kept in the agent quarantine folder for recovery.',
  }),
  'browser.open': op({
    name: 'browser.open',
    description: 'Open a web page in the automated browser.',
    params: z.object({ url: HttpUrl }).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 45_000,
    target: (p) => p.url,
    consequences: () => 'Navigates the automated browser to the page. No data is submitted.',
  }),
  'browser.search': op({
    name: 'browser.search',
    description: 'Search the web (DuckDuckGo) and return result titles and links.',
    params: z.object({ query: z.string().min(1).max(300) }).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 45_000,
    target: (p) => `search: ${p.query}`,
    consequences: () => 'Sends the query to the search engine.',
  }),
  'browser.extract_text': op({
    name: 'browser.extract_text',
    description: 'Extract visible text from the current page (optionally from one element).',
    params: z.object({ selector: Selector.optional(), maxChars: z.number().int().positive().max(100_000).default(20_000) }).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 30_000,
    target: (p) => p.selector ?? 'page',
    consequences: () => 'Reads page text. Page content is treated as untrusted data.',
  }),
  'browser.screenshot': op({
    name: 'browser.screenshot',
    description: 'Capture a screenshot of the current page as evidence.',
    params: z.object({}).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 30_000,
    target: () => 'current page',
    consequences: () => 'Saves a screenshot to protected local storage.',
  }),
  'browser.fill': op({
    name: 'browser.fill',
    description: 'Type a value into a form field (password fields are refused).',
    params: z.object({ selector: Selector, value: z.string().max(5000) }).strict(),
    baseRisk: 'MEDIUM',
    idempotent: true,
    external: false,
    timeoutMs: 30_000,
    target: (p) => p.selector,
    consequences: () => 'Fills a form field. Nothing is submitted.',
  }),
  'browser.click': op({
    name: 'browser.click',
    description: 'Click an element on the current page.',
    params: z.object({ selector: Selector }).strict(),
    baseRisk: 'MEDIUM',
    idempotent: false,
    external: true,
    timeoutMs: 30_000,
    target: (p) => p.selector,
    consequences: () => 'Clicks the element; this may trigger actions on the website.',
  }),
  'browser.submit': op({
    name: 'browser.submit',
    description: 'Submit a form. Always requires explicit approval.',
    params: z.object({ selector: Selector }).strict(),
    baseRisk: 'HIGH',
    idempotent: false,
    external: true,
    timeoutMs: 45_000,
    target: (p) => p.selector,
    consequences: () => 'Submits data to the website. This may be irreversible.',
  }),
  'browser.download': op({
    name: 'browser.download',
    description: 'Download a file into an approved folder. Executables are refused.',
    params: z.object({ url: HttpUrl, root: RootName, path: RelPath }).strict()
      .refine((p) => !EXECUTABLE_EXTENSIONS.test(p.path) && !EXECUTABLE_EXTENSIONS.test(new URL(p.url).pathname), 'Executable or script downloads are not allowed'),
    baseRisk: 'MEDIUM',
    idempotent: true,
    external: false,
    timeoutMs: 120_000,
    target: (p) => `${p.url} -> ${p.root}:${p.path}`,
    consequences: () => 'Downloads an untrusted file to disk. It is not opened or executed.',
  }),
  'desktop.list_windows': op({
    name: 'desktop.list_windows',
    description: 'List visible top-level windows (via Windows UI Automation).',
    params: z.object({}).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 15_000,
    target: () => 'desktop',
    consequences: () => 'Reads window titles. No changes are made.',
  }),
  'desktop.launch_app': op({
    name: 'desktop.launch_app',
    description: 'Launch an application from the agent’s local allowlist (e.g. notepad, calculator).',
    params: z.object({ app: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/) }).strict(),
    baseRisk: 'LOW',
    idempotent: false,
    external: false,
    timeoutMs: 20_000,
    target: (p) => p.app,
    consequences: () => 'Starts the application with normal user privileges.',
  }),
  'desktop.read_window_text': op({
    name: 'desktop.read_window_text',
    description: 'Read text from a window using UI Automation.',
    params: z.object({ titleContains: z.string().min(1).max(200), maxChars: z.number().int().positive().max(100_000).default(20_000) }).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 20_000,
    target: (p) => `window: ${p.titleContains}`,
    consequences: () => 'Reads window text. No changes are made.',
  }),
  'desktop.type_text': op({
    name: 'desktop.type_text',
    description: 'Type text into a window. Always requires approval.',
    params: z.object({ titleContains: z.string().min(1).max(200), text: z.string().max(5000) }).strict(),
    baseRisk: 'HIGH',
    idempotent: false,
    external: false,
    timeoutMs: 30_000,
    target: (p) => `window: ${p.titleContains}`,
    consequences: () => 'Sends keystrokes to the window. The effect depends on the application.',
  }),
  'desktop.screenshot': op({
    name: 'desktop.screenshot',
    description: 'Capture a screenshot of the primary screen as evidence.',
    params: z.object({}).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 20_000,
    target: () => 'screen',
    consequences: () => 'Saves a screenshot to protected local storage. It may contain private information.',
  }),
  'browser.research': op({
    name: 'browser.research',
    description:
      'Research a question on the web: search, open the most trustworthy distinct sources (official > reference > general) and return their text with citations. A model then lists claims, each marked verified (2+ independent sources or an official one) or single-source.',
    params: z
      .object({
        query: z.string().trim().min(2).max(300),
        maxSources: z.number().int().min(1).max(5).default(3),
        // Set by the orchestrator from WEBSITE DENY rules; a plan may only narrow it further.
        blockedDomains: z.array(z.string().min(1).max(253)).max(500).optional(),
      })
      .strict(),
    baseRisk: 'MEDIUM',
    idempotent: true,
    external: false,
    timeoutMs: 180_000,
    target: (p) => `web research "${p.query}"`,
    consequences: (p) => `Searches the web and opens up to ${p.maxSources} public pages (read-only: nothing is submitted or downloaded). Page content is untrusted.`,
  }),
  'desktop.ocr': op({
    name: 'desktop.ocr',
    description: 'Read visible text from the screen, or from one window, with the Windows OCR engine (fallback when UI Automation cannot read it).',
    params: z.object({ titleContains: z.string().min(1).max(200).optional() }).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 90_000,
    target: (p) => (p.titleContains ? `window "*${p.titleContains}*"` : 'screen'),
    consequences: () => 'Captures a screenshot as evidence and reads its text on this computer. It may contain private information.',
  }),
  'integration.rest_get': op({
    name: 'integration.rest_get',
    description: 'Read data from an administrator-approved REST integration (GET). Only registered integrations and their allowed paths can be used.',
    params: z.object({ integration: IntegrationName, path: ApiPath, query: ApiQuery.optional() }).strict(),
    baseRisk: 'MEDIUM',
    idempotent: true,
    external: false,
    timeoutMs: 45_000,
    target: (p) => `integration ${p.integration} GET ${p.path}`,
    consequences: (p) => `Sends a read request to the "${p.integration}" service. The request parameters leave this computer; nothing is changed there.`,
    executor: 'server',
  }),
  'integration.rest_post': op({
    name: 'integration.rest_post',
    description: 'Send data to an administrator-approved REST integration (POST). Always requires approval.',
    params: z.object({ integration: IntegrationName, path: ApiPath, query: ApiQuery.optional(), body: ApiBody }).strict(),
    baseRisk: 'HIGH',
    idempotent: false,
    external: true,
    timeoutMs: 45_000,
    target: (p) => `integration ${p.integration} POST ${p.path}`,
    consequences: (p) => `Sends data to the "${p.integration}" service, which may create or change something there. It may not be reversible.`,
    executor: 'server',
  }),
  'integration.mcp_tool': op({
    name: 'integration.mcp_tool',
    description: 'Call one allowed tool on an administrator-approved MCP server (HTTP). Always requires approval.',
    params: z.object({ integration: IntegrationName, tool: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()).default({}).refine((a) => JSON.stringify(a).length <= 100_000, 'Arguments are too large') }).strict(),
    baseRisk: 'HIGH',
    idempotent: false,
    external: true,
    timeoutMs: 45_000,
    target: (p) => `integration ${p.integration} tool ${p.tool}`,
    consequences: (p) => `Runs the "${p.tool}" tool on the "${p.integration}" MCP server, which may change data there. It may not be reversible.`,
    executor: 'server',
  }),
  'system.resources': op({
    name: 'system.resources',
    description: 'Report CPU, memory, battery and GPU usage.',
    params: z.object({}).strict(),
    baseRisk: 'LOW',
    idempotent: true,
    external: false,
    timeoutMs: 10_000,
    target: () => 'system',
    consequences: () => 'Reads resource usage. No changes are made.',
  }),
} satisfies Record<string, OperationDef>;

export type OperationName = keyof typeof OPERATIONS;

export function getOperation(name: string): OperationDef | undefined {
  return Object.prototype.hasOwnProperty.call(OPERATIONS, name) ? (OPERATIONS as Record<string, OperationDef>)[name] : undefined;
}

// ---------------------------------------------------------------- plans

export const SuccessCriterionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file_exists'), root: RootName, path: RelPath }).strict(),
  z.object({ kind: z.literal('file_content_equals'), root: RootName, path: RelPath, expected: z.string().max(MAX_CONTENT) }).strict(),
  z.object({ kind: z.literal('file_contains'), root: RootName, path: RelPath, text: z.string().min(1).max(10_000) }).strict(),
  z.object({ kind: z.literal('step_succeeded'), stepIndex: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('page_contains_text'), text: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('window_exists'), titleContains: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('screen_contains_text'), text: z.string().min(1).max(1000), titleContains: z.string().min(1).max(200).optional() }).strict(),
]);
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

export const RawPlanSchema = z.object({
  title: z.string().min(1).max(200),
  steps: z.array(z.object({ operation: z.string().max(64), description: z.string().min(1).max(500), params: z.record(z.string(), z.unknown()) }).strict()).max(20),
  successCriteria: z.array(SuccessCriterionSchema).max(20),
  clarification: z.string().max(1000).nullish(),
});

export interface ValidatedStep {
  operation: OperationName;
  description: string;
  params: Record<string, unknown>;
}

export interface ValidatedPlan {
  title: string;
  steps: ValidatedStep[];
  successCriteria: SuccessCriterion[];
  clarification: string | null;
}

export class PlanValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Plan rejected: ${issues.join('; ')}`);
  }
}

/** Validates untrusted plan JSON (e.g. model output) against the whitelist. */
export function validatePlan(input: unknown): ValidatedPlan {
  const raw = RawPlanSchema.safeParse(input);
  if (!raw.success) throw new PlanValidationError(raw.error.issues.map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`));
  const issues: string[] = [];
  const steps: ValidatedStep[] = raw.data.steps.map((s, i) => {
    const def = getOperation(s.operation);
    if (!def) {
      issues.push(`steps.${i}: operation "${s.operation}" is not supported`);
      return { operation: s.operation as OperationName, description: s.description, params: s.params };
    }
    const params = def.params.safeParse(s.params);
    if (!params.success) {
      issues.push(...params.error.issues.map((e) => `steps.${i}.params.${e.path.join('.')}: ${e.message}`));
      return { operation: def.name as OperationName, description: s.description, params: s.params };
    }
    // Every operation's params schema is a z.object, so the parsed value is a plain record.
    return { operation: def.name as OperationName, description: s.description, params: params.data as Record<string, unknown> };
  });
  const clarification = raw.data.clarification?.trim() || null;
  if (!clarification) {
    if (steps.length === 0) issues.push('steps: a plan needs at least one step');
    if (raw.data.successCriteria.length === 0) issues.push('successCriteria: at least one measurable success criterion is required');
  }
  raw.data.successCriteria.forEach((c, i) => {
    if (c.kind === 'step_succeeded' && c.stepIndex >= steps.length) issues.push(`successCriteria.${i}: stepIndex out of range`);
  });
  if (issues.length) throw new PlanValidationError(issues);
  return { title: raw.data.title, steps, successCriteria: raw.data.successCriteria, clarification };
}

export const TASK_FOLDER_TOKEN = '{task}';

export function taskFolderName(taskId: string): string {
  return `task-${taskId.slice(0, 8)}`;
}

/** Replaces the planner's `{task}` placeholder with the task's dedicated output folder name. */
export function substituteTaskFolder<T>(value: T, taskId: string): T {
  if (typeof value === 'string') return value.split(TASK_FOLDER_TOKEN).join(taskFolderName(taskId)) as T;
  if (Array.isArray(value)) return value.map((v) => substituteTaskFolder(v, taskId)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteTaskFolder(v, taskId)])) as T;
  }
  return value;
}

/** Inverse of substituteTaskFolder, so saved skills write into the new task's own folder. */
export function generalizeTaskFolder<T>(value: T, taskId: string): T {
  const name = taskFolderName(taskId);
  if (typeof value === 'string') return value.split(name).join(TASK_FOLDER_TOKEN) as T;
  if (Array.isArray(value)) return value.map((v) => generalizeTaskFolder(v, taskId)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, generalizeTaskFolder(v, taskId)])) as T;
  }
  return value;
}

/** Catalogue sent to the planner so models only propose supported operations. */
export interface IntegrationSummary {
  name: string;
  kind: 'REST' | 'MCP';
  description: string;
  allowedPaths: string[];
  allowedTools: string[];
}

/**
 * What the planner may use. Integration operations are offered only when matching enabled
 * integrations exist, and their descriptions list exactly what is allowed.
 */
export function operationCatalog(integrations: IntegrationSummary[] = []) {
  const rest = integrations.filter((i) => i.kind === 'REST');
  const mcp = integrations.filter((i) => i.kind === 'MCP');
  const restList = rest.map((i) => `${i.name} (paths: ${i.allowedPaths.join(', ')})${i.description ? ` - ${i.description}` : ''}`).join('; ');
  const mcpList = mcp.map((i) => `${i.name} (tools: ${i.allowedTools.join(', ')})${i.description ? ` - ${i.description}` : ''}`).join('; ');
  return Object.values(OPERATIONS as Record<string, OperationDef>)
    .filter((d) => (d.name.startsWith('integration.rest_') ? rest.length > 0 : d.name === 'integration.mcp_tool' ? mcp.length > 0 : true))
    .map((d) => ({
      name: d.name,
      description: d.name.startsWith('integration.rest_') ? `${d.description} Available: ${restList}.` : d.name === 'integration.mcp_tool' ? `${d.description} Available: ${mcpList}.` : d.description,
      risk: d.baseRisk,
    }));
}
