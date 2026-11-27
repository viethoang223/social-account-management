import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** local = FakeConnector; pilot-test = fb-web with audience ONLY_ME; pilot-live = real audience. */
  APP_ENV: z.enum(['local', 'pilot-test', 'pilot-live']).default('local'),
  DATABASE_URL: z.string().url(),
  WORKER_NAME: z.string().default('local-1'),
  TZ_OPERATIONS: z.string().default('Asia/Ho_Chi_Minh'),

  // LLM gateway (only the core server holds the key)
  LLM_MODE: z.enum(['fake', 'claude']).default('fake'),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_EDITOR_MODEL: z.string().default('claude-opus-5-5'),
  LLM_EXCEPTION_MODEL: z.string().default('claude-opus-5-5'),
  LLM_DAILY_BUDGET_USD: z.coerce.number().positive().default(20),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().positive().default(3),
  // Includes adaptive-thinking tokens (thinking is always on for Claude Opus 5.5).
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(16000),
  LLM_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),

  // Object storage
  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('.data/objects'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),

  // Fake platform (local only): shared JSON file so several processes see the same "Facebook"
  FAKE_PLATFORM_FILE: z.string().default('.data/fake-platform.json'),

  // Host limits (spec §16)
  BROWSER_MAX_SESSIONS: z.coerce.number().int().positive().default(4),
  COLLECTOR_CONCURRENCY: z.coerce.number().int().positive().default(2),
  PUBLISHER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  REEL_ALLOW_UNVERIFIED_AUDIENCE: bool.default(false),
  VIDEO_CONCURRENCY: z.coerce.number().int().positive().default(1),

  // API
  API_PORT: z.coerce.number().int().default(3001),
  /** JSON map token → role, e.g. {"dev-admin":"admin"}. Roles: admin | reviewer | operator | viewer */
  API_TOKENS: z.string().default('{}'),

  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  LOG_PRETTY: bool.default(false),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  // LLM_MODE=claude without ANTHROPIC_API_KEY is allowed: the SDK also resolves
  // ANTHROPIC_AUTH_TOKEN / `ant auth login` profiles / workload identity federation.
  if (cfg.STORAGE_DRIVER === 'r2' && !(cfg.R2_ACCOUNT_ID && cfg.R2_ACCESS_KEY_ID && cfg.R2_SECRET_ACCESS_KEY && cfg.R2_BUCKET)) {
    throw new Error('STORAGE_DRIVER=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET');
  }
  return cfg;
}
