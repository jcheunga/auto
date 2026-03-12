# Monday -> GitHub PR -> Heroku Review App Automation

This service automates a Monday workflow:

1. A new Monday item is created with a task description.
2. The service gathers the full Monday thread context and existing item state.
3. It hands that context to a workflow agent command (Claude Code or another CLI).
4. Claude decides whether to create a branch/PR, revise an existing branch, reply on Monday, or no-op.
5. Claude uses `gh` for GitHub work and Monday MCP for Monday follow-up updates.
6. When the Monday status is set to `Approved`, it marks the item ready and asks for manual merge.

## Architecture

- `POST /webhooks/monday`: receives Monday webhook events.
- `src/orchestrator.ts`: workflow state machine + worker scheduler.
- `src/integrations/monday.ts`: Monday GraphQL client.
- `src/integrations/github.ts`: GitHub CLI-backed client via `gh`.
- `src/integrations/workflowAgent.ts`: Claude-driven orchestration runner.
- `src/db.ts`: SQLite persistence for item/PR mapping and durable event queue.

## Prerequisites

- Node.js 20+
- Git CLI on PATH
- Monday API token + webhook subscription
- GitHub CLI (`gh`) on PATH
- GitHub token with repo permissions
- (Optional) Heroku API token + pipeline configured for review apps
- (Optional) Claude Code CLI or another codegen CLI command

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

Required env vars:

- `MONDAY_API_TOKEN`
- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`

Optional but recommended:

- `LOG_LEVEL`
- `MONDAY_SIGNING_SECRET`
- `CODE_AGENT_COMMAND`
- `WORKER_CONCURRENCY`
- `WORKER_MAX_RETRIES` and `WORKER_RETRY_DELAY_SECONDS`
- `HEROKU_API_TOKEN` + `HEROKU_PIPELINE_ID`

### `CODE_AGENT_COMMAND`

The service delegates workflow decisions to this command. It sets these env vars before running it:

- `WORK_PROMPT`: full orchestration prompt
- `WORK_CONTEXT_FILE`: JSON file with the Monday item, full thread, current DB state, and defaults
- `WORK_RESULT_FILE`: path where the agent must write a JSON result
- `AUTOMATION_MODE`: always `orchestrate`
- `GITHUB_TOKEN`: passed through for `gh` CLI access

Example:

```bash
CODE_AGENT_COMMAND='claude-code --print "$WORK_PROMPT"'
```

The intended Claude behavior is:

- read `WORK_CONTEXT_FILE`
- decide `create_pr`, `revise_pr`, `reply_only`, or `noop`
- use `gh` for GitHub operations
- use Monday MCP for Monday follow-up updates
- write a JSON result to `WORK_RESULT_FILE`

## Multi-repo routing

- By default, tasks run in `GITHUB_OWNER/GITHUB_REPO` against `GITHUB_BASE_BRANCH`.
- In the first task update body, you can optionally set:
  - `@repo owner/repo` or `repo: owner/repo`
  - `@base branch-name` or `base: branch-name`
- These directive lines are stripped from the prompt before code generation.
- Repo/base routing is persisted per item in SQLite so follow-up comment revisions stay on the same target.

## Queue and concurrency

- Webhooks are written to a durable SQLite queue table before processing.
- Worker concurrency is controlled with `WORKER_CONCURRENCY`.
- The worker enforces per-item locking, so updates for one Monday item stay ordered while different items run in parallel.
- Failed jobs are retried using `WORKER_MAX_RETRIES` and `WORKER_RETRY_DELAY_SECONDS`.

## Running

```bash
npm run dev
```

The app expects `gh` to be installed and uses `GITHUB_TOKEN` for both:
- `gh api` calls for PR creation/comments
- git HTTPS auth via `gh auth git-credential`
- The Claude environment should also have Monday MCP configured if you want the agent to post updates directly back to Monday.

Health check:

```bash
curl http://localhost:1337/health
```

Dashboard:

```bash
open http://localhost:1337/dashboard
```

API endpoints used by the dashboard:

- `GET /api/dashboard/summary`
- `GET /api/dashboard/work-items`
- `GET /api/dashboard/queue`
- `GET /api/dashboard/webhooks`
- `GET /api/dashboard/actions`

Stored history tables:

- `webhook_events`: each incoming webhook payload with queue/HTTP outcome
- `action_logs`: worker actions and failures with metadata

## Logging

- Runtime logs are emitted as JSON lines to stdout/stderr.
- Set `LOG_LEVEL=debug` when you want lower-level details such as worker pump activity, Monday API calls, git workspace setup, review-app polling, and code-agent execution boundaries.
- The dashboard history remains in SQLite:
  - `webhook_events` for inbound payloads
  - `action_logs` for workflow milestones and failures

Example:

```bash
LOG_LEVEL=debug npm run dev
```

## Docker

Build:

```bash
docker build -t monday-automation .
```

Run:

```bash
docker run --rm \
  --name monday-automation \
  --env-file .env \
  -p 1337:1337 \
  -v "$(pwd)/data:/app/data" \
  monday-automation
```

Open dashboard:

```bash
open http://localhost:1337/dashboard
```

## Monday webhook notes

- Point Monday webhook URL to `https://<your-host>/webhooks/monday`.
- Monday challenge validation is handled automatically.
- Signature validation is enforced only if `MONDAY_SIGNING_SECRET` is set.

## Event behavior

- `create_item` / `create_pulse`: creates a local work-item record and waits for prompt updates.
- `create_update` / `new_update`:
  - If no PR exists yet: treats update body as the task prompt, creates branch + PR + optional review app.
  - If PR already exists: treats update body as feedback, runs revision cycle, pushes commit.
- `change_column_value`: if webhook status label equals `MONDAY_STATUS_APPROVED_LABEL`, posts a manual-merge reminder.
