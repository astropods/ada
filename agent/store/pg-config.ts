/**
 * Postgres connection configuration — one reading of the environment.
 *
 * Two independent consumers connect to the same platform-managed database:
 * Ada's own `Store` (GitHub tokens, App credentials, repo bindings, the HMAC
 * secret) and Flue's persistence adapter (conversation streams, submissions,
 * attachments). They share this module so a deployment cannot end up with one
 * of them connected and the other silently falling back.
 *
 * Table namespaces do not collide: Flue prefixes everything `flue_`, Ada owns
 * `github_tokens` and `kv`.
 *
 * `KNOWLEDGE_DB_*` is accepted alongside `POSTGRES_*` because the platform has
 * injected both spellings depending on how the knowledge store is declared.
 */

export interface PgConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
}

/** Whether the platform injected a Postgres. */
export function postgresConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.POSTGRES_HOST ?? env.KNOWLEDGE_DB_HOST);
}

export function pgConfig(env: NodeJS.ProcessEnv = process.env): PgConfig {
  return {
    host: (env.POSTGRES_HOST ?? env.KNOWLEDGE_DB_HOST)!,
    port: Number(env.POSTGRES_PORT ?? env.KNOWLEDGE_DB_PORT ?? 5432),
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    // Falling back to the user name matches Postgres's own default-database
    // convention, and is what this deployment has always done.
    database: env.POSTGRES_DB ?? env.POSTGRES_USER,
  };
}

/** Redacted summary for startup logs. Never includes the password. */
export function describePg(env: NodeJS.ProcessEnv = process.env): string {
  if (!postgresConfigured(env)) return "not configured";
  const c = pgConfig(env);
  return `${c.user ?? "?"}@${c.host}:${c.port}/${c.database ?? "?"}`;
}
