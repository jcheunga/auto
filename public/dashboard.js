const refreshBtn = document.getElementById("refresh-btn");
const cleanupBtn = document.getElementById("cleanup-btn");
const lastRefreshEl = document.getElementById("last-refresh");

const summaryCards = document.getElementById("summary-cards");
const queueTable = document.getElementById("queue-table");
const itemsTable = document.getElementById("items-table");
const webhooksTable = document.getElementById("webhooks-table");
const duplicatesTable = document.getElementById("duplicates-table");
const actionsTable = document.getElementById("actions-table");

const REFRESH_INTERVAL_MS = 6000;

async function loadDashboard() {
  try {
    const [summaryResp, itemsResp, queueResp, webhooksResp, duplicatesResp, actionsResp] = await Promise.all([
      fetchJson("/api/dashboard/summary"),
      fetchJson("/api/dashboard/work-items?limit=120"),
      fetchJson("/api/dashboard/queue?limit=120"),
      fetchJson("/api/dashboard/webhooks?limit=120"),
      fetchJson("/api/dashboard/webhooks/duplicates?limit=80"),
      fetchJson("/api/dashboard/actions?limit=180")
    ]);

    renderSummary(summaryResp.summary, summaryResp.runtime);
    renderQueue(queueResp.jobs || []);
    renderWorkItems(itemsResp.items || []);
    renderWebhooks(webhooksResp.events || []);
    renderDuplicateWebhooks(duplicatesResp.events || []);
    renderActions(actionsResp.actions || []);
    lastRefreshEl.textContent = `Updated ${new Date().toLocaleString()}`;
  } catch (error) {
    lastRefreshEl.textContent = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function renderSummary(summary, runtime) {
  const status = summary?.workItems?.byStatus || {};
  const cards = [
    { label: "Work Items", value: summary?.workItems?.total ?? 0 },
    { label: "Queue Pending", value: summary?.queue?.pending ?? 0 },
    { label: "Queue Processing", value: summary?.queue?.processing ?? 0 },
    { label: "Queue Failed", value: summary?.queue?.failed ?? 0 },
    { label: "Webhooks (24h)", value: summary?.webhooksLast24h ?? 0 },
    { label: "Actions (24h)", value: summary?.actionsLast24h ?? 0 },
    { label: "Workers Active", value: runtime?.activeWorkers ?? 0 },
    { label: "Worker Running", value: runtime?.running ? "yes" : "no" }
  ];

  for (const [statusName, count] of Object.entries(status)) {
    cards.push({ label: `Status: ${statusName}`, value: count });
  }

  summaryCards.innerHTML = cards
    .map(
      (card) => `
      <article class="card">
        <div class="card-label">${escapeHtml(String(card.label))}</div>
        <div class="card-value">${escapeHtml(String(card.value))}</div>
      </article>
    `
    )
    .join("");
}

function renderQueue(jobs) {
  if (jobs.length === 0) {
    queueTable.innerHTML = `<tr><td colspan="6" class="muted">No queued jobs.</td></tr>`;
    return;
  }

  queueTable.innerHTML = jobs
    .map(
      (job) => `
      <tr>
        <td><code>${job.id}</code></td>
        <td><code>${escapeHtml(job.itemId)}</code></td>
        <td>${statusBadge(job.status)}</td>
        <td>${job.attempts}</td>
        <td>${formatDate(job.availableAt)}</td>
        <td class="payload">${escapeHtml(job.lastError || "")}</td>
      </tr>
    `
    )
    .join("");
}

function renderWorkItems(items) {
  if (items.length === 0) {
    itemsTable.innerHTML = `<tr><td colspan="7" class="muted">No work items yet.</td></tr>`;
    return;
  }

  itemsTable.innerHTML = items
    .map((item) => {
      const repo = item.githubOwner && item.githubRepo ? `${item.githubOwner}/${item.githubRepo}` : "-";
      const pr = item.githubPrUrl
        ? `<a href="${escapeHtml(item.githubPrUrl)}" target="_blank" rel="noreferrer">${item.githubPrNumber}</a>`
        : item.githubPrNumber
          ? `#${escapeHtml(item.githubPrNumber)}`
          : "-";

      return `
      <tr>
        <td><code>${escapeHtml(item.mondayItemId)}</code><br/>${escapeHtml(item.title)}</td>
        <td>${statusBadge(item.status)}</td>
        <td><code>${escapeHtml(repo)}</code></td>
        <td><code>${escapeHtml(item.workBranch || "-")}</code></td>
        <td>${pr}</td>
        <td>${formatDate(item.updatedAt)}</td>
        <td>
          <div class="work-item-controls" data-item-id="${escapeHtml(item.mondayItemId)}">
            <select data-field="status" class="control-input">${statusOptions(item.status)}</select>
            <div class="control-grid">
              <input data-field="workBranch" class="control-input" placeholder="branch" value="${escapeHtml(item.workBranch || "")}" />
              <input data-field="githubPrNumber" class="control-input" placeholder="PR #" inputmode="numeric" value="${escapeHtml(item.githubPrNumber || "")}" />
              <input data-field="githubPrUrl" class="control-input" placeholder="PR URL" value="${escapeHtml(item.githubPrUrl || "")}" />
            </div>
            <div class="control-actions">
              <button type="button" class="inline-btn" data-save-item="${escapeHtml(item.mondayItemId)}">Save</button>
            </div>
          </div>
        </td>
      </tr>
      `;
    })
    .join("");
}

function renderWebhooks(events) {
  if (events.length === 0) {
    webhooksTable.innerHTML = `<tr><td colspan="7" class="muted">No webhook events captured yet.</td></tr>`;
    return;
  }

  webhooksTable.innerHTML = events
    .map(
      (event) => `
      <tr>
        <td>${formatDate(event.createdAt)}</td>
        <td><code>${escapeHtml(event.eventType || "challenge/unknown")}</code></td>
        <td><code>${escapeHtml(event.itemId || "-")}</code></td>
        <td>${statusBadge(event.queueStatus)}</td>
        <td>${event.httpStatus}</td>
        <td>
          <details>
            <summary>view</summary>
            <pre class="payload">${escapeHtml(prettyJson(event.payloadJson))}</pre>
          </details>
        </td>
        <td>${replayButton(event.id)}</td>
      </tr>
    `
    )
    .join("");
}

function renderDuplicateWebhooks(events) {
  if (events.length === 0) {
    duplicatesTable.innerHTML = `<tr><td colspan="5" class="muted">No duplicate webhook events.</td></tr>`;
    return;
  }

  duplicatesTable.innerHTML = events
    .map(
      (event) => `
      <tr>
        <td>${formatDate(event.createdAt)}</td>
        <td><code>${escapeHtml(event.eventType || "unknown")}</code></td>
        <td><code>${escapeHtml(event.itemId || "-")}</code></td>
        <td>${statusBadge(event.queueStatus)}</td>
        <td>${replayButton(event.id)}</td>
      </tr>
    `
    )
    .join("");
}

function renderActions(actions) {
  if (actions.length === 0) {
    actionsTable.innerHTML = `<tr><td colspan="5" class="muted">No worker actions yet.</td></tr>`;
    return;
  }

  actionsTable.innerHTML = actions
    .map(
      (action) => `
      <tr>
        <td>${formatDate(action.createdAt)}</td>
        <td>${statusBadge(action.level)}</td>
        <td><code>${escapeHtml(action.actionType)}</code></td>
        <td><code>${escapeHtml(action.itemId || "-")}</code></td>
        <td>
          ${escapeHtml(action.message)}
          ${action.metadataJson ? `<details><summary>meta</summary><pre class="payload">${escapeHtml(prettyJson(action.metadataJson))}</pre></details>` : ""}
        </td>
      </tr>
    `
    )
    .join("");
}

function replayButton(id) {
  return `<button class="inline-btn" data-replay-id="${id}">Replay</button>`;
}

function statusOptions(current) {
  const statuses = ["new", "processing", "pr_open", "ready_to_merge", "awaiting_changes", "error"];
  const normalized = String(current || "");
  return statuses
    .map((status) => `<option value="${status}"${status === normalized ? " selected" : ""}>${status}</option>`)
    .join("");
}

function statusBadge(value) {
  const text = String(value || "-");
  const normalized = text.toLowerCase();

  let className = "info";
  if (["pr_open", "ready_to_merge", "accepted", "info", "ok"].includes(normalized)) {
    className = "ok";
  } else if (["pending", "processing", "warn", "retry", "duplicate"].includes(normalized)) {
    className = "warn";
  } else if (["error", "failed", "invalid_signature"].includes(normalized)) {
    className = "error";
  }

  return `<span class="badge ${className}">${escapeHtml(text)}</span>`;
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return escapeHtml(String(value));
  }
  return date.toLocaleString();
}

function prettyJson(raw) {
  try {
    return JSON.stringify(typeof raw === "string" ? JSON.parse(raw) : raw, null, 2);
  } catch {
    return String(raw);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function fetchJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...options,
    headers
  });
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}`);
  }
  return response.json();
}

async function replayWebhook(eventId) {
  await fetchJson(`/api/dashboard/webhooks/${eventId}/replay`, { method: "POST" });
  await loadDashboard();
}

async function saveWorkItem(itemId, payload) {
  await fetchJson(`/api/dashboard/work-items/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  await loadDashboard();
}

async function cleanupWorktrees() {
  const result = await fetchJson("/api/admin/worktrees/cleanup", {
    method: "POST",
    body: JSON.stringify({})
  });
  lastRefreshEl.textContent = `Cleanup removed ${result.worktreesRemoved || 0} worktrees across ${result.reposScanned || 0} repos.`;
  await loadDashboard();
}

refreshBtn.addEventListener("click", () => {
  void loadDashboard();
});

cleanupBtn?.addEventListener("click", () => {
  cleanupBtn.setAttribute("disabled", "true");
  void cleanupWorktrees().catch((error) => {
    lastRefreshEl.textContent = `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
  }).finally(() => {
    cleanupBtn.removeAttribute("disabled");
  });
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const saveItemId = target.getAttribute("data-save-item");
  if (saveItemId) {
    const controls = target.closest("[data-item-id]");
    if (!(controls instanceof HTMLElement)) {
      return;
    }

    const payload = {
      status: controls.querySelector('[data-field="status"]')?.value || null,
      workBranch: controls.querySelector('[data-field="workBranch"]')?.value || null,
      githubPrNumber: controls.querySelector('[data-field="githubPrNumber"]')?.value || null,
      githubPrUrl: controls.querySelector('[data-field="githubPrUrl"]')?.value || null
    };

    target.setAttribute("disabled", "true");
    void saveWorkItem(saveItemId, payload).catch((error) => {
      lastRefreshEl.textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      target.removeAttribute("disabled");
    });
    return;
  }

  const replayId = target.getAttribute("data-replay-id");
  if (!replayId) {
    return;
  }

  target.setAttribute("disabled", "true");
  void replayWebhook(replayId).catch((error) => {
    lastRefreshEl.textContent = `Replay failed: ${error instanceof Error ? error.message : String(error)}`;
    target.removeAttribute("disabled");
  });
});

void loadDashboard();
setInterval(() => {
  void loadDashboard();
}, REFRESH_INTERVAL_MS);
