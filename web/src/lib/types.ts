export type TaskStatus =
  | 'PENDING'
  | 'PLANNING'
  | 'NEEDS_CLARIFICATION'
  | 'AWAITING_APPROVAL'
  | 'QUEUED'
  | 'RUNNING'
  | 'PAUSED'
  | 'INTERRUPTED'
  | 'BLOCKED'
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'FAILED'
  | 'CANCELLED'
  | 'REJECTED';

export type PrivacyLevel = 'LOCAL_ONLY' | 'CLOUD_REDACTED' | 'CLOUD_ALLOWED';
export type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Me {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
}

export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  statusReason: string | null;
  progress: number;
  riskLevel: Risk | null;
  privacyLevel: PrivacyLevel;
  queuePosition: number;
  createdAt: string;
  finishedAt: string | null;
  planSource: string | null;
}

export interface Step {
  id: string;
  index: number;
  operation: string;
  description: string;
  params: Record<string, unknown>;
  riskLevel: Risk;
  requiresApproval: boolean;
  status: string;
  attempts: number;
  result: { ok?: boolean; output?: Record<string, unknown> } | null;
  error: string | null;
}

export interface Evidence {
  id: string;
  criterion: string;
  kind: string;
  outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  expected: string | null;
  actual: string | null;
  sha256: string | null;
  source: string;
  isSimulated: boolean;
  createdAt: string;
}

export interface Approval {
  id: string;
  taskId: string;
  stepId: string;
  actionHash: string;
  operation: string;
  target: string;
  summary: string;
  consequences: string;
  riskLevel: Risk;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED';
  expiresAt: string;
  createdAt: string;
  task?: { id: string; title: string; status: TaskStatus };
  step?: { index: number; params: Record<string, unknown> };
  decision?: { decision: string; comment: string | null; createdAt: string } | null;
}

export interface TaskDetail extends TaskSummary {
  instruction: string;
  plan: { title: string } | null;
  successCriteria: unknown[] | null;
  steps: Step[];
  evidence: Evidence[];
  approvals: Approval[];
  checkpoints: Array<{ id: string; stepIndex: number; state: Record<string, unknown>; createdAt: string }>;
  executions: Array<{ id: string; operationId: string; attempt: number; status: string; error: string | null; dispatchedAt: string; finishedAt: string | null }>;
  agentDevice: { id: string; name: string; status: string } | null;
  attachments?: Array<{ id: string; mediaType: string; sizeBytes: number; sha256: string; createdAt: string }>;
  startedAt: string | null;
}

export interface Device {
  id: string;
  name: string;
  hostname: string;
  osVersion: string | null;
  agentVersion: string | null;
  status: 'ACTIVE' | 'REVOKED';
  connected: boolean;
  capabilities: Record<string, unknown> | null;
  allowedRoots: string[] | null;
  lastResources: Resources | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface Resources {
  cpuPercent?: number;
  memoryAvailableMb?: number;
  memoryTotalMb?: number;
  memoryPercent?: number;
  battery?: { percent: number; plugged: boolean } | null;
  gpu?: Array<{ name: string; utilPercent: number; temperatureC: number }> | null;
  temperature?: number | null;
}

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export const TERMINAL: TaskStatus[] = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'REJECTED'];
export const RESUMABLE: TaskStatus[] = ['PAUSED', 'INTERRUPTED', 'BLOCKED', 'FAILED', 'AWAITING_APPROVAL'];
export const PAUSABLE: TaskStatus[] = ['PLANNING', 'QUEUED', 'RUNNING', 'AWAITING_APPROVAL'];
