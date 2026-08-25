/**
 * Transport-level safety limits. These are deliberately not configurable:
 * they exist to prevent abuse and resource exhaustion, not to be tuned.
 */

/** Max accepted client request body size (10 MB). */
export const BODY_LIMIT_BYTES = 10_485_760;

/** Max stored/relayed upstream response size (50 MB). */
export const RESPONSE_LIMIT_BYTES = 52_428_800;

/** Fastify-level guard for slow clients sending request bodies (60 s). */
export const FASTIFY_REQUEST_TIMEOUT_MS = 60_000;

/** Masking token for request-log bodies. */
export const LOG_SECRET_MASK = "[MASKED]";
