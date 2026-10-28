/** Single source of truth for roles and permissions; seeded into MySQL at startup. */
export const PERMISSIONS = {
  'task:create': 'Create tasks',
  'task:read': 'Read own tasks',
  'task:read_all': 'Read every user’s tasks',
  'task:control': 'Pause, resume, cancel and reorder own tasks',
  'approval:decide': 'Approve or reject actions on own tasks',
  'agent:manage': 'Pair and revoke agent devices',
  'agent:read': 'View agent devices',
  'settings:manage': 'Manage AI models and secrets',
  'policy:manage': 'Manage own permission policies',
  'memory:manage': 'Manage own memory and skills',
  'audit:read': 'Read own audit events',
  'audit:read_all': 'Read all audit events',
  'system:emergency_stop': 'Trigger emergency stop',
  'system:admin': 'Clear emergency stop, manage users, backups',
} as const;

export type PermissionId = keyof typeof PERMISSIONS;

const OPERATOR: PermissionId[] = [
  'task:create',
  'task:read',
  'task:control',
  'approval:decide',
  'agent:read',
  'policy:manage',
  'memory:manage',
  'audit:read',
  'system:emergency_stop',
];

export const ROLES: Record<string, { description: string; permissions: PermissionId[] }> = {
  ADMIN: { description: 'Full administration', permissions: Object.keys(PERMISSIONS) as PermissionId[] },
  OPERATOR: { description: 'Runs and supervises own tasks', permissions: OPERATOR },
  VIEWER: { description: 'Read-only access to own tasks', permissions: ['task:read', 'agent:read', 'audit:read', 'system:emergency_stop'] },
};
