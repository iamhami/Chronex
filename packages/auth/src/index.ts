export { AuthError } from "./errors.ts";
export { hashPassword, verifyPassword } from "./password.ts";
export { AuthService, resolvePermissions, rolePermissions } from "./service.ts";
export { InMemoryAuthStore } from "./store.ts";
export {
  createOpaqueId,
  hashToken,
  signToken,
  verifyAccessToken,
  verifyRefreshToken
} from "./tokens.ts";
export type {
  AuthAuditEvent,
  AuthContext,
  AuthResponse,
  LoginRequest,
  LogoutRequest,
  Permission,
  RefreshRequest,
  RegisterRequest,
  RegisterableRole,
  RequestMeta,
  Role
} from "./types.ts";
