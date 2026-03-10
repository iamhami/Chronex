import type {
  AuditEntry,
  AuthorizationContext,
  AuthorizationDecision,
  AuthorizationRequest,
  Permission,
  ProtectedRoute,
  Role
} from "./types.ts";

export class ForbiddenError extends Error {
  readonly status = 403;
  readonly decision: AuthorizationDecision;
  readonly auditEntry: AuditEntry;

  constructor(decision: AuthorizationDecision, auditEntry: AuditEntry) {
    super("FORBIDDEN");
    this.name = "ForbiddenError";
    this.decision = decision;
    this.auditEntry = auditEntry;
  }
}

export const rolePermissions: Record<Role, Permission[]> = {
  Member: ["profile:read:self", "profile:write:self"],
  Creator: [
    "profile:read:self",
    "profile:write:self",
    "creator:stack:publish"
  ],
  Moderator: ["profile:read:any"],
  Admin: ["profile:read:any", "admin:roles:write"]
};

export const protectedRoutes: ProtectedRoute[] = [
  {
    method: "GET",
    route: "/api/v1/profile/me",
    resource: "profile:self",
    action: "read",
    permission: "profile:read:self"
  },
  {
    method: "PATCH",
    route: "/api/v1/profile/me",
    resource: "profile:self",
    action: "write",
    permission: "profile:write:self"
  },
  {
    method: "POST",
    route: "/api/v1/creator/stacks/publish",
    resource: "creator-stack",
    action: "publish",
    permission: "creator:stack:publish"
  },
  {
    method: "GET",
    route: "/api/v1/moderation/profiles/:userId",
    resource: "profile:any",
    action: "read",
    permission: "profile:read:any"
  },
  {
    method: "POST",
    route: "/api/v1/admin/users/:userId/roles",
    resource: "user-role",
    action: "assign",
    permission: "admin:roles:write"
  }
];

export function resolvePermissions(role: Role): Permission[] {
  return [...rolePermissions[role]];
}

export function authorize(permission: Permission) {
  return function enforce(request: AuthorizationRequest): AuthorizationContext {
    const decision = evaluateDecision(permission, request);
    const auditEntry = createAuditEntry(permission, request, decision);
    request.auditLogger?.record(auditEntry);

    if (!decision.allowed) {
      throw new ForbiddenError(decision, auditEntry);
    }

    const identity = request.lookupIdentity(request.token!.userId)!;
    const role = identity.role as Role;
    const permissions = identity.permissions ?? resolvePermissions(role);

    return {
      auth: {
        userId: identity.userId,
        role,
        sessionId: request.token!.sessionId,
        permissions
      },
      permission,
      requestId: request.requestId,
      route: request.route,
      action: request.action,
      resource: request.resource
    };
  };
}

function evaluateDecision(
  permission: Permission,
  request: AuthorizationRequest
): AuthorizationDecision {
  if (!request.token) {
    return { allowed: false, reason: "missing_token" };
  }

  const identity = request.lookupIdentity(request.token.userId);
  if (!identity) {
    return { allowed: false, reason: "missing_identity" };
  }

  if (!identity.role) {
    return { allowed: false, reason: "missing_role" };
  }

  const permissions = identity.permissions ?? resolvePermissions(identity.role);
  if (!permissions.includes(permission)) {
    return { allowed: false, reason: "missing_permission" };
  }

  return { allowed: true, reason: "allowed" };
}

function createAuditEntry(
  permission: Permission,
  request: AuthorizationRequest,
  decision: AuthorizationDecision
): AuditEntry {
  const identity = request.token
    ? request.lookupIdentity(request.token.userId)
    : null;

  return {
    actor: request.token?.userId ?? "anonymous",
    action: request.action,
    resource: request.resource,
    requestId: request.requestId,
    permission,
    outcome: decision.allowed ? "allowed" : "denied",
    timestamp: new Date().toISOString(),
    role: identity?.role
  };
}
