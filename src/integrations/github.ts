import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appLogger } from "../lib/appLogger";
import { serializeError } from "../lib/logger";
import { runCommand } from "../lib/shell";

export interface GitHubRepositoryTarget {
  owner: string;
  repo: string;
}

interface GitHubPullRequestResponse {
  number: number;
  html_url: string;
  head: {
    sha: string;
  };
}

export class GitHubClient {
  private readonly logger = appLogger.child({ component: "github" });

  constructor(private readonly token: string) {}

  async createPullRequest(input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<{ number: number; url: string; headSha: string }> {
    const startedAt = Date.now();
    this.logger.info("Creating GitHub pull request", {
      owner: input.owner,
      repo: input.repo,
      head: input.head,
      base: input.base,
      draft: input.draft ?? false
    });

    try {
      const result = await this.withJsonInputFile(
        {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: input.draft ?? false
        },
        async (filePath) => {
          const response = await this.runGhCommand(
            `api --method POST repos/${shellEscapePathSegment(input.owner)}/${shellEscapePathSegment(
              input.repo
            )}/pulls --input ${shellEscape(filePath)}`
          );
          return JSON.parse(response.stdout) as GitHubPullRequestResponse;
        }
      );

      this.logger.info("Created GitHub pull request", {
        owner: input.owner,
        repo: input.repo,
        prNumber: result.number,
        url: result.html_url,
        durationMs: Date.now() - startedAt
      });

      return {
        number: result.number,
        url: result.html_url,
        headSha: result.head.sha
      };
    } catch (error) {
      this.logger.error("GitHub pull request creation failed", {
        owner: input.owner,
        repo: input.repo,
        head: input.head,
        base: input.base,
        durationMs: Date.now() - startedAt,
        ...serializeError(error)
      });
      throw error;
    }
  }

  async commentOnPullRequest(input: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<void> {
    const startedAt = Date.now();
    this.logger.info("Posting GitHub pull request comment", {
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber
    });

    try {
      await this.withJsonInputFile(
        {
          body: input.body
        },
        async (filePath) => {
          await this.runGhCommand(
            `api --method POST repos/${shellEscapePathSegment(input.owner)}/${shellEscapePathSegment(
              input.repo
            )}/issues/${input.prNumber}/comments --input ${shellEscape(filePath)}`
          );
        }
      );

      this.logger.info("Posted GitHub pull request comment", {
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      this.logger.error("GitHub pull request comment failed", {
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        durationMs: Date.now() - startedAt,
        ...serializeError(error)
      });
      throw error;
    }
  }

  repositoryHtmlUrl(target: GitHubRepositoryTarget): string {
    return `https://github.com/${target.owner}/${target.repo}`;
  }

  private async runGhCommand(command: string): Promise<{ stdout: string; stderr: string }> {
    return runCommand(`gh ${command}`, {
      env: {
        ...process.env,
        GITHUB_TOKEN: this.token,
        GH_TOKEN: this.token,
        GIT_TERMINAL_PROMPT: "0"
      }
    });
  }

  private async withJsonInputFile<T>(
    payload: Record<string, unknown>,
    runner: (filePath: string) => Promise<T>
  ): Promise<T> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-input-"));
    const filePath = path.join(tempDir, "payload.json");

    try {
      await fs.writeFile(filePath, JSON.stringify(payload), "utf8");
      return await runner(filePath);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellEscapePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "");
}
