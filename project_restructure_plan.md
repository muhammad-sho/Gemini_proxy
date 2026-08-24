  # Greenfield Modularization and Production Hardening Plan

  ## Summary

  Rebuild the app as a modular TypeScript/Node service with a small React/Vite dashboard, while keeping the self-hosted single-node experience simple.

  Retain:

  - Client API authentication
  - Provider-key pools and least-used routing
  - Retry, cooldown, quota, and failure handling
  - Gemini and OpenAI-compatible provider adapters
  - Model discovery and caching
  - Admin dashboard and client-key management
  - Usage metrics and operational request logs
  - SQLite persistence and Docker deployment

  Defer aliases, model groups, detailed payload inspection, streaming, and advanced tenancy until the core architecture is stable.

  Existing database/API compatibility is not required because the app has no real users yet.

  ## Architecture Changes

  ### Backend

  Replace server.js with a layered structure:

  src/
    main.ts
    config/
      env.ts
    http/
      server.ts
      errors.ts
      middleware/
      routes/
        health.routes.ts
        gateway.routes.ts
        auth.routes.ts
        admin.routes.ts
    domain/
      auth/
      clients/
      providers/
      routing/
      models/
      usage/
    application/
      gateway/
      admin/
      authentication/
    infrastructure/
      db/
        connection.ts
        migrations/
        repositories/
      providers/
        gemini.adapter.ts
        openai-compatible.adapter.ts
      logging/
    shared/
      crypto.ts
      validation.ts
      time.ts
      types.ts

  Use:

  - Strict TypeScript
  - Fastify for routing, lifecycle, validation, and centralized errors
  - Zod for environment and request validation
  - Pino for structured logs
  - Explicit SQLite migrations
  - Repository interfaces between business logic and SQLite
  - Dependency injection through application composition rather than globals

  The request path should become:

  HTTP route
    → authentication
    → request validation
    → application use case
    → provider/router service
    → repository and provider ports
    → response mapper

  No route should directly contain SQL, provider HTTP calls, cooldown policy, or business rules.

  ### Domain boundaries

  Create explicit services for:

  - Client-key authentication
  - Admin sessions and CSRF
  - Provider credential management
  - Model availability
  - Key selection and retry policy
  - Cooldown classification
  - Model-cache refresh
  - Usage recording
  - Operational request logging

  The routing service should receive provider candidates through an interface and return a normalized result. Provider-specific URL construction, authentication headers, error formats, and model discovery remain inside adapters.

  Routing must support:

  - Global request deadline
  - Maximum attempts
  - Abort propagation when the client disconnects
  - Concurrent or deadline-aware fallback behavior
  - Deterministic key ordering
  - Cooldown-aware selection
  - Safe handling of invalid credentials and quota exhaustion

  ### Persistence

  Replace startup SQL creation and inline ALTER TABLE calls with numbered migration files.

  The initial schema should use clear names and constraints for:

  - admin_users
  - admin_sessions or an external session abstraction
  - client_keys
  - provider_credentials
  - credential_models
  - client_key_models
  - models
  - model_cache
  - model_credential_state
  - usage_events
  - request_logs
  - audit_logs
  - app_metadata

  Add appropriate indexes for:

  - Client-key hash lookup
  - Model/credential routing
  - Usage by model and day
  - Cooldown expiry
  - Request-log filtering and pagination
  - Audit-log time ordering

  Secrets must never be returned from repositories or API responses unless explicitly needed during one-time creation. Store provider keys encrypted by default when an encryption key is configured, and fail readiness in production mode if encryption is unavailable.

  ### API contracts

  Define versioned contracts in TypeScript/Zod.

  Gateway endpoints:

  GET  /health/live
  GET  /health/ready

  GET  /v1beta/models
  POST /v1beta/models/:model:generateContent

  Admin endpoints should use a versioned namespace:

  POST /api/admin/v1/login
  POST /api/admin/v1/logout
  GET  /api/admin/v1/state
  POST /api/admin/v1/client-keys
  DELETE /api/admin/v1/client-keys/:id
  POST /api/admin/v1/provider-credentials
  DELETE /api/admin/v1/provider-credentials/:id
  GET  /api/admin/v1/logs
  GET  /api/admin/v1/logs/:id
  POST /api/admin/v1/models/refresh
  POST /api/admin/v1/cooldowns/clear

  Standardize error responses:

  {
    error: {
      code: string;
      message: string;
      requestId: string;
      details?: unknown;
    }
  }

  The gateway should preserve upstream status and body semantics where appropriate, while internally logging a normalized classification.

  ### Frontend

  Split the dashboard into a real frontend:

  web/
    index.html
    src/
      main.tsx
      app/
      api/
      auth/
      components/
      features/
        overview/
        client-keys/
        provider-credentials/
        models/
        logs/
      styles/
    vite.config.ts

  Use React with Vite and TypeScript.

  Remove:

  - Inline JavaScript
  - Inline event handlers
  - Duplicated functions
  - Global mutable browser state
  - HTML string construction for complex views
  - Dashboard logic embedded in the backend

  Use typed API clients, feature-local state, reusable table/modal/form components, centralized authentication-expiry handling, and a single error/toast mechanism.

  The first frontend migration should preserve the existing visual language and workflows while simplifying the implementation.

  ### Operations and security

  Add:

  - Graceful shutdown for HTTP server, database, timers, and in-flight work
  - Separate liveness and readiness checks
  - Structured JSON logs with request IDs
  - Configurable log levels
  - Secure cookie configuration
  - Strict proxy-header handling
  - Central request-body and response-size limits
  - Rate limits scoped by address and credential
  - CSP without unsafe-inline
  - Explicit upstream-header allowlist
  - Backup and restore documentation
  - SQLite integrity and migration checks
  - Docker image running as non-root
  - Container healthcheck
  - Reproducible dependency lockfile
  - CI checks for type errors, lint, tests, frontend build, Docker build, and migration startup

  Update documentation to match the real feature set and remove references to unfinished model groups or aliases.

  ## Implementation Sequence

  1. Create the TypeScript package structure, dependency manifest, compiler configuration, linting, formatting, and test setup.
  2. Add configuration validation and application bootstrap.
  3. Implement SQLite connection, migrations, repositories, and seed/setup behavior.
  4. Extract authentication and admin-session services.
  5. Implement provider adapter interfaces and Gemini/OpenAI-compatible adapters.
  6. Implement routing, retries, cooldowns, deadlines, abort handling, and model caching.
  7. Implement gateway and admin HTTP routes against typed contracts.
  8. Build the dashboard feature-by-feature with typed API calls.
  9. Add Docker, environment examples, backup guidance, and CI enforcement.
  10. Remove the monolithic files and all ad-hoc patch scripts after behavior is covered by tests.

  ## Test Plan

  ### Unit tests

  - Environment validation
  - Password hashing and constant-time comparisons
  - Client-key hashing and lookup
  - CSRF/session expiry
  - Model and credential allowlists
  - Key ordering and least-used selection
  - Cooldown classification
  - Daily quota reset calculations
  - Retry limits and global deadlines
  - Model-cache freshness and fallback behavior
  - Provider request/response translation

  ### Integration tests

  - Fresh database migration
  - Restart against an existing migrated database
  - Setup and login flow
  - Client-key creation and deletion
  - Provider credential management
  - Model refresh and cache fallback
  - Usage aggregation and cleanup
  - Audit-log creation
  - Admin authorization and CSRF rejection

  ### HTTP/provider tests

  Use a local mock upstream to verify:

  - Successful generation
  - Invalid provider key fallback
  - Rate-limit fallback
  - Daily-quota cooldown
  - Provider timeout behavior
  - Client disconnect abort
  - Maximum request/response size handling
  - No credential leakage in logs or responses
  - Model discovery across pagination

  ### Frontend tests

  - Login and session-expiry recovery
  - Loading/error/empty states
  - Client-key creation
  - Provider-key management
  - Usage rendering
  - Log filtering and pagination
  - Destructive-action confirmation
  - Accessible keyboard and modal behavior

  ### Acceptance criteria

  - No business logic remains in route handlers or UI templates.
  - npm run check performs type checking, linting, tests, and frontend build successfully.
  - A fresh Docker deployment starts with one documented command.
  - A database migration failure prevents readiness.
  - Provider failures cannot hang a request beyond the configured deadline.
  - Client disconnects cancel upstream work.
  - Secrets are absent from API responses and structured logs.
  - Adding a new provider requires implementing an adapter and tests, without modifying routing logic.
  - Adding a dashboard feature requires changing one feature module rather than a single global HTML file.

  ## Assumptions

  - SQLite remains the default persistence layer for self-hosted deployments.
  - The codebase may reset or replace the current test database; no legacy schema compatibility is required.
  - The initial redesign targets one process and one node, but repositories, sessions, caches, and provider ports must be replaceable later.
  - The current unfinished Model Groups dashboard changes should be removed or reintroduced later through a complete domain/API design.
  - Streaming, countTokens, advanced quotas, tenancy, distributed sessions, Redis, and PostgreSQL are follow-up milestones after the modular v1 is stable.
