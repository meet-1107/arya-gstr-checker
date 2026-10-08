export type Role = "OWNER" | "ADMIN" | "ACCOUNTANT" | "VIEWER";

export type Permission =
  | "billing:manage" | "subscription:manage" | "org:delete" | "team:manage"
  | "clients:write" | "clients:read" | "checks:run" | "reports:generate"
  | "reports:read" | "dashboard:read" | "imports:run" | "auditlog:read";

const VIEW: Permission[] = ["dashboard:read", "clients:read", "reports:read"];
const WORK: Permission[] = [...VIEW, "clients:write", "checks:run", "imports:run", "reports:generate"];
const ADMIN: Permission[] = [...WORK, "team:manage", "auditlog:read"];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEW),
  ACCOUNTANT: new Set(WORK),
  ADMIN: new Set(ADMIN),
  OWNER: new Set<Permission>([...ADMIN, "billing:manage", "subscription:manage", "org:delete"]),
};

export const can = (role: Role | undefined | null, p: Permission): boolean =>
  !!role && MATRIX[role]?.has(p) === true;

export class ForbiddenError extends Error {
  constructor(public permission: Permission) { super(`Missing permission ${permission}`); }
}
export function assertCan(role: Role | undefined | null, p: Permission): void {
  if (!can(role, p)) throw new ForbiddenError(p);
}
