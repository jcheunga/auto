import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  PORT: z.coerce.number().default(1337),
  DATABASE_PATH: z.string().default("./data/automation.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  MONDAY_API_TOKEN: z.string().min(1),
  MONDAY_API_URL: z.string().url().default("https://api.monday.com/v2"),
  MONDAY_SIGNING_SECRET: z.string().optional(),
  MONDAY_STATUS_APPROVED_LABEL: z.string().default("Approved"),

  GITHUB_TOKEN: z.string().min(1).optional(),
  GH_TOKEN: z.string().min(1).optional(),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),
  GITHUB_BASE_BRANCH: z.string().default("main"),
  GIT_WORKSPACE_ROOT: z.string().default("./data/git-workspaces"),

  CODE_AGENT_COMMAND: z.string().optional(),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(3),
  WORKER_MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(4),
  WORKER_RETRY_DELAY_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),

  HEROKU_API_TOKEN: z.string().optional(),
  HEROKU_PIPELINE_ID: z.string().optional(),
  HEROKU_TEAM_ID: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const formatted = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${formatted}`);
}

const githubToken = parsed.data.GITHUB_TOKEN ?? parsed.data.GH_TOKEN;
if (!githubToken) {
  throw new Error("Invalid environment configuration:\nGITHUB_TOKEN: Required");
}

export const config = {
  port: parsed.data.PORT,
  databasePath: parsed.data.DATABASE_PATH,
  logLevel: parsed.data.LOG_LEVEL,

  monday: {
    apiToken: parsed.data.MONDAY_API_TOKEN,
    apiUrl: parsed.data.MONDAY_API_URL,
    signingSecret: parsed.data.MONDAY_SIGNING_SECRET,
    statusApprovedLabel: parsed.data.MONDAY_STATUS_APPROVED_LABEL
  },

  github: {
    token: githubToken,
    owner: parsed.data.GITHUB_OWNER,
    repo: parsed.data.GITHUB_REPO,
    baseBranch: parsed.data.GITHUB_BASE_BRANCH,
    workspaceRoot: parsed.data.GIT_WORKSPACE_ROOT
  },

  codeAgent: {
    command: parsed.data.CODE_AGENT_COMMAND
  },

  worker: {
    concurrency: parsed.data.WORKER_CONCURRENCY,
    maxRetries: parsed.data.WORKER_MAX_RETRIES,
    retryDelaySeconds: parsed.data.WORKER_RETRY_DELAY_SECONDS
  },

  heroku: {
    apiToken: parsed.data.HEROKU_API_TOKEN,
    pipelineId: parsed.data.HEROKU_PIPELINE_ID,
    teamId: parsed.data.HEROKU_TEAM_ID
  }
} as const;

export type AppConfig = typeof config;
