import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appLogger } from "../lib/appLogger";
import { serializeError } from "../lib/logger";
import { runCommand } from "../lib/shell";
import { WorkflowAgentContext } from "../types";

interface GitWorkspaceManagerConfig {
  rootDir: string;
  githubToken: string;
}

export interface PreparedGitWorkspace {
  worktreeDir: string;
  gitAskPassPath: string;
  repository: {
    owner: string;
    repo: string;
    baseBranch: string;
    branch: string | null;
  };
  cleanup(): Promise<void>;
}

export class GitWorkspaceManager {
  private readonly rootDir: string;
  private readonly logger = appLogger.child({ component: "git-workspace" });
  private readonly repoLocks = new Map<string, Promise<void>>();
  private readonly branchLocks = new Map<string, Promise<void>>();
  private readonly lastSweepAtByRepo = new Map<string, number>();
  private askPassPathPromise: Promise<string> | null = null;

  constructor(private readonly cfg: GitWorkspaceManagerConfig) {
    this.rootDir = path.resolve(cfg.rootDir);
  }

  async prepareWorkflowWorkspace(context: WorkflowAgentContext): Promise<PreparedGitWorkspace> {
    const repository = resolveRepositoryTarget(context);
    const repoKey = toPathSegment(`${repository.owner}__${repository.repo}`);
    const cacheDir = path.join(this.rootDir, "repos", repoKey);
    const worktreesDir = path.join(this.rootDir, "worktrees", repoKey);
    const worktreeDir = path.join(
      worktreesDir,
      `${Date.now()}-${toPathSegment(context.item.mondayItemId)}-${crypto.randomUUID().slice(0, 8)}`
    );

    await fs.mkdir(worktreesDir, { recursive: true });

    this.logger.info("Preparing isolated git worktree", {
      itemId: context.item.mondayItemId,
      owner: repository.owner,
      repo: repository.repo,
      baseBranch: repository.baseBranch,
      existingBranch: repository.branch,
      worktreeDir
    });

    let worktreeCreated = false;
    const branchLockKey = (repository.branch ?? context.suggestedBranch)
      ? `${repoKey}:${toPathSegment(repository.branch ?? context.suggestedBranch)}`
      : null;
    const releaseBranchLock = branchLockKey
      ? await this.acquireLock(this.branchLocks, branchLockKey)
      : null;

    try {
      await this.withRepoLock(repoKey, async () => {
        const gitEnv = await this.buildGitEnv();
        await this.ensureRepoCache(cacheDir, repository, gitEnv);
        await this.sweepStaleWorktrees(worktreesDir, cacheDir, gitEnv, repoKey);
        await runCommand(`git --git-dir=${shellEscape(cacheDir)} worktree prune`, { env: gitEnv });

        const startRef = await this.resolveStartRef(cacheDir, repository, gitEnv);
        await runCommand(
          `git --git-dir=${shellEscape(cacheDir)} worktree add --detach ${shellEscape(worktreeDir)} ${shellEscape(startRef)}`,
          { env: gitEnv }
        );
        worktreeCreated = true;

        if (repository.branch) {
          await runCommand(
            `git -C ${shellEscape(worktreeDir)} checkout -B ${shellEscape(repository.branch)} ${shellEscape(startRef)}`,
            { env: gitEnv }
          );
        }
      });

      return {
        worktreeDir,
        gitAskPassPath: await this.ensureAskPassScript(),
        repository,
        cleanup: async () => {
          try {
            await this.cleanupWorktree(repoKey, cacheDir, worktreeDir);
          } finally {
            releaseBranchLock?.();
          }
        }
      };
    } catch (error) {
      this.logger.error("Failed to prepare isolated git worktree", {
        itemId: context.item.mondayItemId,
        owner: repository.owner,
        repo: repository.repo,
        worktreeDir,
        ...serializeError(error)
      });

      if (worktreeCreated) {
        await this.cleanupWorktree(repoKey, cacheDir, worktreeDir);
      } else {
        await fs.rm(worktreeDir, { recursive: true, force: true });
      }

      releaseBranchLock?.();

      throw error;
    }
  }

  private async ensureRepoCache(
    cacheDir: string,
    repository: PreparedGitWorkspace["repository"],
    gitEnv: NodeJS.ProcessEnv
  ): Promise<void> {
    const repoUrl = repositoryHttpsUrl(repository.owner, repository.repo);
    const bareHead = path.join(cacheDir, "HEAD");

    if (!(await pathExists(bareHead))) {
      await fs.rm(cacheDir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(cacheDir), { recursive: true });
      this.logger.info("Cloning repository cache", {
        owner: repository.owner,
        repo: repository.repo,
        cacheDir
      });
      await runCommand(`git clone --bare ${shellEscape(repoUrl)} ${shellEscape(cacheDir)}`, {
        env: gitEnv
      });
      return;
    }

    await runCommand(
      `git --git-dir=${shellEscape(cacheDir)} remote set-url origin ${shellEscape(repoUrl)} && git --git-dir=${shellEscape(cacheDir)} fetch origin --prune`,
      { env: gitEnv }
    );
  }

  private async resolveStartRef(
    cacheDir: string,
    repository: PreparedGitWorkspace["repository"],
    gitEnv: NodeJS.ProcessEnv
  ): Promise<string> {
    if (repository.branch) {
      const remoteBranchRef = `refs/remotes/origin/${repository.branch}`;
      if (await this.hasRef(cacheDir, remoteBranchRef, gitEnv)) {
        return remoteBranchRef;
      }

      this.logger.warn("Tracked branch not found on origin; falling back to base branch", {
        owner: repository.owner,
        repo: repository.repo,
        branch: repository.branch,
        baseBranch: repository.baseBranch
      });
    }

    const baseRef = `refs/remotes/origin/${repository.baseBranch}`;
    if (await this.hasRef(cacheDir, baseRef, gitEnv)) {
      return baseRef;
    }

    throw new Error(
      `Unable to resolve base branch ${repository.baseBranch} for ${repository.owner}/${repository.repo}`
    );
  }

  private async hasRef(
    cacheDir: string,
    ref: string,
    gitEnv: NodeJS.ProcessEnv
  ): Promise<boolean> {
    try {
      await runCommand(
        `git --git-dir=${shellEscape(cacheDir)} rev-parse --verify ${shellEscape(ref)}`,
        { env: gitEnv }
      );
      return true;
    } catch {
      return false;
    }
  }

  private async cleanupWorktree(
    repoKey: string,
    cacheDir: string,
    worktreeDir: string
  ): Promise<void> {
    await this.withRepoLock(repoKey, async () => {
      const gitEnv = await this.buildGitEnv();
      try {
        await runCommand(
          `git --git-dir=${shellEscape(cacheDir)} worktree remove --force ${shellEscape(worktreeDir)}`,
          { env: gitEnv }
        );
      } catch (error) {
        this.logger.warn("git worktree remove failed; removing directory directly", {
          worktreeDir,
          ...serializeError(error)
        });
      }

      await fs.rm(worktreeDir, { recursive: true, force: true });

      try {
        await runCommand(`git --git-dir=${shellEscape(cacheDir)} worktree prune`, { env: gitEnv });
      } catch (error) {
        this.logger.warn("git worktree prune failed", {
          cacheDir,
          ...serializeError(error)
        });
      }
    });
  }

  private async sweepStaleWorktrees(
    worktreesDir: string,
    cacheDir: string,
    gitEnv: NodeJS.ProcessEnv,
    repoKey: string
  ): Promise<void> {
    const now = Date.now();
    const lastSweep = this.lastSweepAtByRepo.get(repoKey) ?? 0;
    const sweepIntervalMs = 30 * 60 * 1000;
    const staleAfterMs = 7 * 24 * 60 * 60 * 1000;

    if (now - lastSweep < sweepIntervalMs) {
      return;
    }

    this.lastSweepAtByRepo.set(repoKey, now);

    let entries: Array<{ path: string }> = [];
    try {
      const dirents = await fs.readdir(worktreesDir, { withFileTypes: true });
      entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => ({
        path: path.join(worktreesDir, entry.name)
      }));
    } catch {
      return;
    }

    for (const entry of entries) {
      try {
        const stat = await fs.stat(entry.path);
        if (now - stat.mtimeMs < staleAfterMs) {
          continue;
        }

        this.logger.info("Removing stale worktree directory", {
          repoKey,
          worktreeDir: entry.path,
          ageHours: Math.round((now - stat.mtimeMs) / (60 * 60 * 1000))
        });
        await fs.rm(entry.path, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn("Failed to inspect or remove stale worktree", {
          repoKey,
          worktreeDir: entry.path,
          ...serializeError(error)
        });
      }
    }

    try {
      await runCommand(`git --git-dir=${shellEscape(cacheDir)} worktree prune`, { env: gitEnv });
    } catch (error) {
      this.logger.warn("git worktree prune failed during sweep", {
        cacheDir,
        ...serializeError(error)
      });
    }
  }

  private async buildGitEnv(): Promise<NodeJS.ProcessEnv> {
    const askPassPath = await this.ensureAskPassScript();

    return {
      ...process.env,
      GITHUB_TOKEN: this.cfg.githubToken,
      GH_TOKEN: this.cfg.githubToken,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askPassPath
    };
  }

  private async ensureAskPassScript(): Promise<string> {
    if (!this.askPassPathPromise) {
      this.askPassPathPromise = (async () => {
        const binDir = path.join(this.rootDir, "bin");
        const scriptPath = path.join(binDir, "git-askpass.sh");
        await fs.mkdir(binDir, { recursive: true });
        await fs.writeFile(
          scriptPath,
          [
            "#!/bin/sh",
            'case "$1" in',
            '  *Username*) printf "%s\\n" "x-access-token" ;;',
            '  *Password*) printf "%s\\n" "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ;;',
            '  *) printf "\\n" ;;',
            "esac",
            ""
          ].join("\n"),
          { encoding: "utf8", mode: 0o755 }
        );
        return scriptPath;
      })();
    }

    return this.askPassPathPromise;
  }

  private async withRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock(this.repoLocks, repoKey);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async acquireLock(
    store: Map<string, Promise<void>>,
    key: string
  ): Promise<() => void> {
    const previous = store.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    store.set(
      key,
      previous.catch(() => undefined).then(() => next)
    );

    await previous.catch(() => undefined);

    return () => {
      release();
      if (store.get(key) === next) {
        store.delete(key);
      }
    };
  }
}

function resolveRepositoryTarget(context: WorkflowAgentContext): PreparedGitWorkspace["repository"] {
  const fromWorkItem = {
    owner: context.existingWorkItem?.githubOwner ?? null,
    repo: context.existingWorkItem?.githubRepo ?? null,
    baseBranch: context.existingWorkItem?.githubBaseBranch ?? null,
    branch: context.existingWorkItem?.workBranch ?? null
  };

  const hintedRepo = parseRepoHint(context.routing.repoHint ?? context.hints.repoHint);

  return {
    owner: fromWorkItem.owner ?? hintedRepo?.owner ?? context.defaults.githubOwner,
    repo: fromWorkItem.repo ?? hintedRepo?.repo ?? context.defaults.githubRepo,
    baseBranch:
      fromWorkItem.baseBranch ??
      context.routing.baseBranchHint ??
      context.hints.baseBranchHint ??
      context.defaults.githubBaseBranch,
    branch: fromWorkItem.branch ?? context.routing.branchHint ?? context.suggestedBranch
  };
}

function parseRepoHint(
  repoHint: string | undefined
): { owner: string; repo: string } | null {
  if (!repoHint) {
    return null;
  }

  const match = repoHint.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2]
  };
}

function repositoryHttpsUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

function toPathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "value";
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
