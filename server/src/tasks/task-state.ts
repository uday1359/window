import type { TaskStatus } from '../generated/prisma/client';

/** Allowed task status transitions. Anything not listed is rejected. */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['PLANNING', 'CANCELLED'],
  PLANNING: ['NEEDS_CLARIFICATION', 'QUEUED', 'BLOCKED', 'FAILED', 'REJECTED', 'CANCELLED', 'INTERRUPTED', 'PAUSED'],
  NEEDS_CLARIFICATION: ['PLANNING', 'CANCELLED'],
  QUEUED: ['RUNNING', 'PAUSED', 'CANCELLED', 'INTERRUPTED', 'BLOCKED'],
  RUNNING: ['AWAITING_APPROVAL', 'PAUSED', 'BLOCKED', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  AWAITING_APPROVAL: ['QUEUED', 'REJECTED', 'CANCELLED', 'PAUSED'],
  PAUSED: ['QUEUED', 'PLANNING', 'CANCELLED', 'REJECTED'],
  INTERRUPTED: ['QUEUED', 'PLANNING', 'CANCELLED', 'BLOCKED'],
  BLOCKED: ['QUEUED', 'PLANNING', 'CANCELLED'],
  FAILED: ['QUEUED', 'PLANNING', 'CANCELLED'],
  SUCCEEDED: [],
  PARTIAL: [],
  CANCELLED: [],
  REJECTED: [],
};

export const TERMINAL: TaskStatus[] = ['SUCCEEDED', 'PARTIAL', 'CANCELLED', 'REJECTED'];
export const ACTIVE: TaskStatus[] = ['PENDING', 'PLANNING', 'QUEUED', 'RUNNING', 'AWAITING_APPROVAL'];
export const RESUMABLE: TaskStatus[] = ['PAUSED', 'INTERRUPTED', 'BLOCKED', 'FAILED', 'AWAITING_APPROVAL'];
export const PAUSABLE: TaskStatus[] = ['PLANNING', 'QUEUED', 'RUNNING', 'AWAITING_APPROVAL'];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** All statuses from which `to` is reachable; used for atomic conditional updates. */
export function sourcesFor(to: TaskStatus, among?: TaskStatus[]): TaskStatus[] {
  return (Object.keys(TRANSITIONS) as TaskStatus[]).filter((s) => TRANSITIONS[s].includes(to) && (!among || among.includes(s)));
}
