import path from "node:path";
import { config } from "./config";
import { AppDb } from "./db";
import { createApp } from "./app";
import { HerokuClient } from "./integrations/heroku";
import { MondayClient } from "./integrations/monday";
import { ClaudeWorkflowAgent } from "./integrations/workflowAgent";
import { appLogger } from "./lib/appLogger";
import { AutomationOrchestrator } from "./orchestrator";

const logger = appLogger.child({ component: "server" });

const db = new AppDb(config.databasePath);

const monday = new MondayClient(config.monday.apiToken, config.monday.apiUrl);

const workflowAgent = new ClaudeWorkflowAgent({
  githubToken: config.github.token,
  command: config.codeAgent.command,
  gitWorkspaceRoot: config.github.workspaceRoot
});

const heroku = new HerokuClient(config.heroku.apiToken, config.heroku.pipelineId, config.heroku.teamId);

const orchestrator = new AutomationOrchestrator(db, config, monday, workflowAgent, heroku);
orchestrator.start();

const app = createApp({
  db,
  orchestrator,
  workflowAgent,
  config,
  publicDir: path.resolve(process.cwd(), "public")
});

const server = app.listen(config.port, () => {
  logger.info("Automation server started", {
    port: config.port,
    databasePath: config.databasePath,
    logLevel: config.logLevel,
    workerConcurrency: config.worker.concurrency,
    workflowAgentCommand: config.codeAgent.command ? "configured" : "missing"
  });
});

function shutdown(): void {
  logger.info("Shutting down automation server");
  server.close(() => {
    orchestrator.stop();
    db.close();
    logger.info("Automation server shutdown complete");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
