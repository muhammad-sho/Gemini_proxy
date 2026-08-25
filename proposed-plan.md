  ## Summary

  Rebuild the app as a modular TypeScript/Node service with a small React/Vite dashboard, while keeping the self-hosted single-node experience simple.

  Retain:

  - Client API authentication
  - Provider-key pools and least-used routing
  - Retry, cooldown, quota, and failure handling
  - Gemini and OpenAI-compatible provider adapters
  - Model discovery and caching
  - Model-group allowlists and expansion
  - Admin dashboard and client-key management
  - Usage metrics and operational request logs
  - SQLite persistence and Docker deployment

  Defer aliases, streaming, and advanced tenancy until the core architecture is stable.

  Existing database/API compatibility is not required because the app has no real users yet.

  ## Architecture Changes

  ### Backend

  server.js has been replaced by a layered TypeScript structure:

  src/
    main.ts
    config/
      env.ts
  http/
    server.ts
    routes/
      health.routes.ts
      gateway.routes.ts
      openai.routes.ts
      clientAccess.ts
      auth.routes.ts
      admin.routes.ts
    domain/
      auth/
      providers/
      routing/
    application/
      gateway/
    infrastructure/
      db/
        connection.ts
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

  In use:

  - Strict TypeScript
  - Fastify for routing, lifecycle, validation, and centralized errors
  - Zod for environment and request validation
  - Pino for structured logs
  - Ordered, idempotent migrations recorded in a schema_version table and applied once at startup
  - Repositories between business logic and SQLite
  - Dependency injection through the composition root in server.ts; repositories currently bind to the global database singleton

  Remaining backend work:

  - Extract a shared errors module and reusable middleware
  - Inject the database handle into repositories instead of the global singleton

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
  - Model-group management and expansion
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
  - Deadline-aware sequential fallback behavior
  - Deterministic key ordering
  - Cooldown-aware selection
  - Safe handling of invalid credentials and quota exhaustion

  ### Persistence

  Schema changes ship as an ordered, idempotent migration list applied at startup and tracked in a schema_version table; ad-hoc ALTER TABLE patching is gone.

  The schema uses clear names and constraints for:

  - admin_users (a single seeded admin account)
  - admin_sessions
  - client_keys
  - provider_credentials
  - model_groups
  - models
  - model_cache
  - model_credential_state
  - usage_events
  - request_logs
  - audit_logs
  - app_metadata (holds the runtime-tunable Settings blob)

  Client-key and provider-credential restrictions are stored as JSON arrays (allowed_models, allowed_groups) on the owning rows rather than in separate mapping tables.

  Add appropriate indexes for:

  - Client-key hash lookup
  - Model/credential routing
  - Usage by model and day
  - Cooldown expiry
  - Request-log filtering and pagination
  - Audit-log time ordering

  On first open of the dashboard (no admin account yet) a one-time setup screen creates the admin password (bcrypt-hashed, min 8 chars); no secrets are configured via environment variables.

  Secrets never come back from repositories except one-time creation responses. Provider keys are AES-256-GCM encrypted; the key is generated automatically inside the data directory on first use, so backing up that directory backs up everything. Readiness fails only if the key cannot be resolved (e.g. disk error).

  ### API contracts

  Define versioned contracts in TypeScript/Zod.

  One process hosts three independent listeners so each surface can be exposed or firewalled separately:

  - Gemini gateway — `GEMINI_PORT` (default 18770), bound to `GATEWAY_HOST`
  - OpenAI gateway — `OPENAI_PORT` (default 18771), bound to `GATEWAY_HOST`
  - Dashboard/admin — `ADMIN_PORT` (default 18765), bound to `ADMIN_HOST` (loopback by default)

  Health endpoints live on the admin surface:

  GET /health/live
  GET /health/ready

  Gemini gateway endpoints:

  GET  /v1beta/models
  POST /v1beta/models/:model:generateContent

  v1 proxies only :generateContent. Other model actions, including streaming variants, stay out of scope until their milestone lands.

  OpenAI gateway endpoints:

  GET  /v1/models
  POST /v1/chat/completions

  The OpenAI surface accepts OpenAI wire format only (Bearer auth), translating chat completions to and from the canonical internal shape; streaming stays out of scope there too.

  Admin endpoints should use a versioned namespace:

  POST /api/admin/v1/login
  POST /api/admin/v1/logout
  GET  /api/admin/v1/setup/status
  POST /api/admin/v1/setup
  GET  /api/admin/v1/state
  POST /api/admin/v1/client-keys
  DELETE /api/admin/v1/client-keys/:id
  POST /api/admin/v1/provider-credentials
  PUT  /api/admin/v1/provider-credentials/:id
  DELETE /api/admin/v1/provider-credentials/:id
  GET  /api/admin/v1/model-groups
  POST /api/admin/v1/model-groups
  PUT  /api/admin/v1/model-groups/:name
  DELETE /api/admin/v1/model-groups/:name
  GET  /api/admin/v1/logs
  GET  /api/admin/v1/logs/:id
  POST /api/admin/v1/models/refresh
  POST /api/admin/v1/cooldowns/clear
  GET  /api/admin/v1/settings
  PUT  /api/admin/v1/settings

  Setup endpoints are public and one-time: `GET /setup/status` tells the dashboard whether first-run provisioning is needed; `POST /setup` creates the admin account (min 8 chars) and refuses with 409 afterwards. Settings changes are audited.

  Login and logout share the versioned namespace with the rest of the admin API, on the dashboard port.

  Standardize error responses:

  {
    error: {
      code: number;
      message: string;
      requestId: string;
      details?: unknown;
    }
  }

  Every emitter — route handlers, services, and the central Fastify error handler — must use this numeric shape.

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
        model-groups/
        models/
        logs/
        settings/
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

  Update documentation to match the real feature set and remove references to unfinished aliases.

  ## Implementation Sequence

  1. Create the TypeScript package structure, dependency manifest, compiler configuration, linting, formatting, and test setup.
  2. Add configuration validation and application bootstrap.
  3. Implement SQLite connection, migrations, repositories, and seed/setup behavior.
  4. Extract authentication and admin-session services.
  5. Implement provider adapter interfaces and Gemini/OpenAI-compatible adapters.
  6. Implement routing, retries, cooldowns, deadlines, abort handling, and model caching.
  7. Implement gateway and admin HTTP routes against typed contracts, including model-group management.
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
  - Model-group CRUD and expansion
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
  - Provider credential management and editing
  - Model-group management
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
  - Streaming, countTokens, advanced quotas, tenancy, distributed sessions, Redis, and PostgreSQL are follow-up milestones after the modular v1 is stable.
