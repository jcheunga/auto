import { appLogger } from "../lib/appLogger";
import { serializeError } from "../lib/logger";

interface ReviewAppCreationResponse {
  id?: string;
  app?: {
    id?: string;
    name?: string;
    web_url?: string;
  };
  status?: string;
}

interface HerokuAppResponse {
  id?: string;
  name?: string;
  web_url?: string;
}

export class HerokuClient {
  private readonly logger = appLogger.child({ component: "heroku" });

  constructor(
    private readonly apiToken: string | undefined,
    private readonly pipelineId: string | undefined,
    private readonly teamId: string | undefined
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiToken && this.pipelineId);
  }

  async createReviewApp(input: {
    branch: string;
    pullRequestNumber: number;
    sourceRepoUrl: string;
  }): Promise<string | null> {
    if (!this.apiToken || !this.pipelineId) {
      this.logger.debug("Skipping review app creation because Heroku is not configured");
      return null;
    }

    const payload: Record<string, unknown> = {
      pipeline: this.pipelineId,
      branch: input.branch,
      source_blob: {
        url: `${input.sourceRepoUrl}/tree/${input.branch}`
      },
      wait_for_ci: true
    };

    if (this.teamId) {
      payload.organization = this.teamId;
    }

    const startedAt = Date.now();
    this.logger.info("Creating Heroku review app", {
      branch: input.branch,
      pullRequestNumber: input.pullRequestNumber,
      pipelineId: this.pipelineId
    });

    try {
      const created = await this.request<ReviewAppCreationResponse>("POST", "/review-apps", payload);
      if (!created.id) {
        const reviewUrl =
          created.app?.web_url ?? (created.app?.name ? toHerokuWebUrl(created.app.name) : null);
        this.logger.info("Created Heroku review app without polling", {
          branch: input.branch,
          pullRequestNumber: input.pullRequestNumber,
          reviewUrl,
          durationMs: Date.now() - startedAt
        });
        return reviewUrl;
      }

      const reviewUrl = await this.waitForReviewApp(created.id);
      this.logger.info("Heroku review app provisioning finished", {
        branch: input.branch,
        pullRequestNumber: input.pullRequestNumber,
        reviewAppId: created.id,
        reviewUrl,
        durationMs: Date.now() - startedAt
      });
      return reviewUrl;
    } catch (error) {
      this.logger.error("Heroku review app creation failed", {
        branch: input.branch,
        pullRequestNumber: input.pullRequestNumber,
        durationMs: Date.now() - startedAt,
        ...serializeError(error)
      });
      throw error;
    }
  }

  private async waitForReviewApp(reviewAppId: string): Promise<string | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      this.logger.debug("Polling Heroku review app", {
        reviewAppId,
        attempt: attempt + 1
      });

      const reviewApp = await this.request<ReviewAppCreationResponse>(
        "GET",
        `/review-apps/${reviewAppId}`
      );

      if (reviewApp.app?.web_url) {
        this.logger.info("Heroku review app URL became available", {
          reviewAppId,
          reviewUrl: reviewApp.app.web_url
        });
        return reviewApp.app.web_url;
      }

      if (reviewApp.app?.id) {
        const app = await this.request<HerokuAppResponse>("GET", `/apps/${reviewApp.app.id}`);
        if (app.web_url) {
          this.logger.info("Resolved Heroku review app URL from app record", {
            reviewAppId,
            appId: reviewApp.app.id,
            reviewUrl: app.web_url
          });
          return app.web_url;
        }
        if (app.name) {
          const reviewUrl = toHerokuWebUrl(app.name);
          this.logger.info("Resolved Heroku review app URL from app name", {
            reviewAppId,
            appId: reviewApp.app.id,
            reviewUrl
          });
          return toHerokuWebUrl(app.name);
        }
      }

      if (reviewApp.app?.name) {
        const reviewUrl = toHerokuWebUrl(reviewApp.app.name);
        this.logger.info("Resolved Heroku review app URL from review app name", {
          reviewAppId,
          reviewUrl
        });
        return toHerokuWebUrl(reviewApp.app.name);
      }

      await sleep(3000);
    }

    this.logger.warn("Timed out waiting for Heroku review app URL", { reviewAppId });
    return null;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    if (!this.apiToken) {
      throw new Error("Heroku API token is not configured");
    }

    this.logger.debug("Calling Heroku API", {
      method,
      path
    });

    const response = await fetch(`https://api.heroku.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/vnd.heroku+json; version=3",
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      const message = await response.text();
      this.logger.error("Heroku API request failed", {
        method,
        path,
        status: response.status,
        responseBody: message
      });
      throw new Error(`Heroku API request failed (${response.status}): ${message}`);
    }

    this.logger.debug("Heroku API request completed", {
      method,
      path,
      status: response.status
    });

    return (await response.json()) as T;
  }
}

function toHerokuWebUrl(appName: string): string {
  return `https://${appName}.herokuapp.com`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
