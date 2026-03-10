import { randomUUID } from "node:crypto";

import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from "express";

import {
  AuthService,
  resolvePermissions,
  type AuthContext,
  type Permission
} from "../../../packages/auth/src/index.ts";
import { rolePermissions } from "../../../packages/auth/src/service.ts";
import { ProfileError, ProfileService } from "../../../packages/profile/src/index.ts";
import {
  SecurityTelemetry,
  SensitiveCryptoError
} from "../../../packages/security/src/index.ts";
import {
  StackDraftService,
  StackError,
  type PricingMetadata,
  type RedactionRuleSet
} from "../../../packages/stacks/src/index.ts";

type CreateApiAppOptions = {
  authService: AuthService;
  profileService: ProfileService;
  securityTelemetry: SecurityTelemetry;
  stackService: StackDraftService;
};

type ApiRequest = Request & {
  authContext?: AuthContext;
  requestId?: string;
};

export function createApiApp(options: CreateApiAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(assignRequestId());
  app.use(authenticateRequest(options));

  app.post(
    "/api/v1/profile/consent",
    authorize("profile:write:self", options),
    (request, response, next) => {
      try {
        const actor = requireAuthContext(request);
        const consent = options.profileService.acceptConsent(
          {
            userId: actor.userId,
            policyVersion: readRequiredString(request.body?.policyVersion)
          },
          buildProfileMeta(request)
        );
        response.status(200).json({ consent });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/v1/profile/metrics",
    authorize("profile:write:self", options),
    (request, response, next) => {
      try {
        const actor = requireAuthContext(request);
        const profile = options.profileService.updateProfile(
          {
            userId: actor.userId,
            conditionPrimary: optionalString(request.body?.conditionPrimary),
            severityBand: request.body?.severityBand,
            symptomTags: request.body?.symptomTags,
            lifestyleTags: request.body?.lifestyleTags
          },
          buildProfileMeta(request)
        );
        response.status(200).json({ profile });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/v1/profile/consent/revoke",
    authorize("profile:write:self", options),
    (request, response, next) => {
      try {
        const actor = requireAuthContext(request);
        const consent = options.profileService.revokeConsent(
          {
            userId: actor.userId
          },
          buildProfileMeta(request)
        );
        response.status(200).json({ consent });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/v1/profile/me",
    authorize("profile:read:self", options),
    (request, response, next) => {
      try {
        const actor = requireAuthContext(request);
        const profile = options.profileService.getProfile(
          {
            userId: actor.userId
          },
          buildProfileMeta(request)
        );
        response.status(200).json({ profile });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/v1/profile/:userId",
    authorize("profile:read:any", options),
    (request, response, next) => {
      try {
        const profile = options.profileService.getProfile(
          {
            userId: request.params.userId ?? ""
          },
          buildProfileMeta(request)
        );
        response.status(200).json({ profile });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/v1/stacks/:id/publish",
    authorize("creator:stack:publish", options),
    (request, response, next) => {
      try {
        const actor = requireAuthContext(request);
        const result = options.stackService.publishDraft(actor, {
          stackId: request.params.id ?? "",
          requestKey:
            request.header("idempotency-key")
            ?? optionalString(request.body?.requestKey)
            ?? requireRequestId(request),
          pricingMetadata: readPricingMetadata(request.body?.pricingMetadata),
          redactionRuleSet: readRedactionRuleSet(request.body?.redactionRuleSet)
        });
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/v1/creator/publish-capability",
    authorize("creator:stack:publish", options),
    (request, response) => {
      const actor = requireAuthContext(request);
      response.status(200).json({
        ok: true,
        actor: {
          userId: actor.userId,
          role: actor.role
        }
      });
    }
  );

  app.get(
    "/api/v1/admin/security/metrics",
    authorize("admin:roles:write", options),
    (_request, response) => {
      response.status(200).json({
        metrics: options.securityTelemetry.getMetrics(),
        auditEvents: options.securityTelemetry.listAuditEvents()
      });
    }
  );

  app.use(notFoundHandler());
  app.use(errorHandler(options));

  return app;
}

function assignRequestId(): RequestHandler {
  return (request, response, next) => {
    const apiRequest = request as ApiRequest;
    apiRequest.requestId = request.header("x-request-id") ?? randomUUID();
    response.setHeader("x-request-id", apiRequest.requestId);
    next();
  };
}

function authenticateRequest(
  options: CreateApiAppOptions
): RequestHandler {
  return (request, response, next) => {
    const token = parseBearerToken(request.header("authorization"));
    if (!token) {
      next();
      return;
    }

    try {
      const tokenContext = options.authService.authenticateAccessToken(token);
      const user = options.authService.store.findUserById(tokenContext.userId);
      if (!user || !(user.role in rolePermissions)) {
        options.securityTelemetry.recordAuthorizationDecision({
          actorUserId: tokenContext.userId,
          action: "authenticate",
          resource: request.path,
          requestId: requireRequestId(request),
          ipAddress: readIpAddress(request),
          outcome: "failure",
          reason: user ? "identity_role_missing" : "identity_not_found"
        });
        response.status(403).json(buildErrorResponse("FORBIDDEN", "Forbidden."));
        return;
      }

      (request as ApiRequest).authContext = {
        userId: user.id,
        role: user.role,
        sessionId: tokenContext.sessionId,
        permissions: resolvePermissions(user.role)
      };
      next();
    } catch {
      options.securityTelemetry.recordAuthorizationDecision({
        action: "authenticate",
        resource: request.path,
        requestId: requireRequestId(request),
        ipAddress: readIpAddress(request),
        outcome: "failure",
        reason: "invalid_token"
      });
      response.status(403).json(buildErrorResponse("FORBIDDEN", "Forbidden."));
    }
  };
}

function authorize(
  permission: Permission,
  options: CreateApiAppOptions
): RequestHandler {
  return (request, response, next) => {
    const actor = (request as ApiRequest).authContext;
    if (!actor) {
      options.securityTelemetry.recordAuthorizationDecision({
        action: permission,
        resource: request.path,
        requestId: requireRequestId(request),
        ipAddress: readIpAddress(request),
        outcome: "failure",
        reason: "auth_required"
      });
      response.status(403).json(buildErrorResponse("FORBIDDEN", "Forbidden."));
      return;
    }

    if (!actor.permissions.includes(permission)) {
      options.securityTelemetry.recordAuthorizationDecision({
        actorUserId: actor.userId,
        role: actor.role,
        action: permission,
        resource: request.path,
        requestId: requireRequestId(request),
        ipAddress: readIpAddress(request),
        outcome: "failure",
        reason: "permission_denied"
      });
      response.status(403).json(buildErrorResponse("FORBIDDEN", "Forbidden."));
      return;
    }

    options.securityTelemetry.recordAuthorizationDecision({
      actorUserId: actor.userId,
      role: actor.role,
      action: permission,
      resource: request.path,
      requestId: requireRequestId(request),
      ipAddress: readIpAddress(request),
      outcome: "success"
    });
    next();
  };
}

function notFoundHandler(): RequestHandler {
  return (_request, response) => {
    response.status(404).json(buildErrorResponse("NOT_FOUND", "Not found."));
  };
}

function errorHandler(options: CreateApiAppOptions): ErrorRequestHandler {
  return (error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    if (
      error instanceof ProfileError
      && (error as Error & { cause?: unknown }).cause instanceof SensitiveCryptoError
    ) {
      const actor = (request as ApiRequest).authContext;
      const cryptoError = (error as Error & { cause?: SensitiveCryptoError }).cause;
      options.securityTelemetry.recordSensitiveDecryptFailure({
        actorUserId: actor?.userId,
        role: actor?.role,
        resource: request.path,
        requestId: requireRequestId(request),
        ipAddress: readIpAddress(request),
        keyId: cryptoError?.keyId,
        reason: cryptoError?.message ?? "sensitive_decrypt_failure"
      });
    }

    if (error instanceof ProfileError) {
      response
        .status(error.status)
        .json(buildErrorResponse(error.code, error.message));
      return;
    }

    if (error instanceof StackError) {
      response
        .status(error.status)
        .json(buildErrorResponse(error.code, error.message));
      return;
    }

    response
      .status(500)
      .json(buildErrorResponse("INTERNAL_SERVER_ERROR", "Internal server error."));
  };
}

function buildProfileMeta(request: Request): { ipAddress: string; fingerprint: string } {
  return {
    ipAddress: readIpAddress(request),
    fingerprint:
      request.header("x-device-fingerprint")
      ?? `request:${requireRequestId(request)}`
  };
}

function requireAuthContext(request: Request): AuthContext {
  const actor = (request as ApiRequest).authContext;
  if (!actor) {
    throw new Error("Auth context is required.");
  }

  return actor;
}

function requireRequestId(request: Request): string {
  const requestId = (request as ApiRequest).requestId;
  if (!requestId) {
    throw new Error("Request ID is required.");
  }

  return requestId;
}

function parseBearerToken(headerValue?: string): string | undefined {
  if (!headerValue) {
    return undefined;
  }

  const [scheme, token] = headerValue.split(" ");
  if (scheme !== "Bearer" || !token) {
    return undefined;
  }

  return token;
}

function readIpAddress(request: Request): string {
  return request.ip || request.socket.remoteAddress || "127.0.0.1";
}

function readRequiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProfileError(
      "PROFILE_VALIDATION_ERROR",
      "A non-empty string value is required.",
      422
    );
  }

  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readPricingMetadata(value: unknown): PricingMetadata {
  if (!value || typeof value !== "object") {
    throw new StackError(
      "PUBLISH_VALIDATION_FAILED",
      "pricingMetadata is required.",
      422
    );
  }

  const candidate = value as Record<string, unknown>;
  return {
    amountCents: Number(candidate.amountCents),
    currency: readStackRequiredString(candidate.currency, "pricingMetadata.currency"),
    internalSku: readStackRequiredString(
      candidate.internalSku,
      "pricingMetadata.internalSku"
    )
  };
}

function readStackRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new StackError(
      "PUBLISH_VALIDATION_FAILED",
      `${field} must be a non-empty string.`,
      422
    );
  }

  return value.trim();
}

function readRedactionRuleSet(value: unknown): RedactionRuleSet | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value !== "object") {
    throw new StackError(
      "PUBLISH_VALIDATION_FAILED",
      "redactionRuleSet must be an object when provided.",
      422
    );
  }

  const candidate = value as Record<string, unknown>;
  return {
    removeFields: readStringArray(
      candidate.removeFields,
      "redactionRuleSet.removeFields"
    ),
    maskPatterns: readStringArray(
      candidate.maskPatterns,
      "redactionRuleSet.maskPatterns"
    ),
    requiredOutputFields: readStringArray(
      candidate.requiredOutputFields,
      "redactionRuleSet.requiredOutputFields"
    )
  };
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new StackError(
      "PUBLISH_VALIDATION_FAILED",
      `${field} must be an array of strings.`,
      422
    );
  }

  return value;
}

function buildErrorResponse(code: string, message: string): {
  error: { code: string; message: string };
} {
  return {
    error: {
      code,
      message
    }
  };
}
