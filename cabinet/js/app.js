"use strict";

const $ = (s) => document.querySelector(s);
const app = $("#app");

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function getOperatorToken() {
  return localStorage.getItem("surfai_operator_token") || "";
}

function setOperatorToken(token) {
  localStorage.setItem("surfai_operator_token", token);
}

function clearOperatorToken() {
  localStorage.removeItem("surfai_operator_token");
}

async function api(path, opts = {}) {
  const token = getOperatorToken();
  const headers = { "Content-Type": "application/json", ...opts.headers };
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(path, {
    headers,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    clearOperatorToken();
    renderLogin("Session expired. Please log in again.");
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Login screen
// ---------------------------------------------------------------------------

function renderLogin(errorMsg) {
  updateNavVisibility(false);
  app.innerHTML = `
    <div class="login-wrapper">
      <div class="login-card">
        <h2 class="login-title">SURFAI</h2>
        <p class="login-subtitle">Operator access</p>
        ${errorMsg ? `<div class="login-error">${esc(errorMsg)}</div>` : ""}
        <form id="login-form">
          <div class="form-group">
            <label>API Token</label>
            <input type="password" name="token" required placeholder="Enter operator token" autofocus>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%">Log in</button>
        </form>
      </div>
    </div>`;

  $("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    const token = new FormData(e.target).get("token").toString().trim();
    if (!token) return;
    setOperatorToken(token);
    try {
      await api("/api/projects");
      render();
    } catch (err) {
      if (err.message === "unauthorized") return; // renderLogin already called
      clearOperatorToken();
      renderLogin("Invalid token");
    }
  };
}

function updateNavVisibility(show) {
  const nav = $("#nav");
  const logoutBtn = $("#logout-btn");
  if (nav) nav.style.display = show ? "" : "none";
  if (logoutBtn) logoutBtn.style.display = show ? "" : "none";
}

window.logout = function () {
  clearOperatorToken();
  window.location.hash = "";
  renderLogin();
};

// ---------------------------------------------------------------------------
// Router (hash-based)
// ---------------------------------------------------------------------------

function navigate(hash) {
  window.location.hash = hash;
}

function getRoute() {
  const hash = window.location.hash.slice(1) || "/";
  const parts = hash.split("/").filter(Boolean);
  return { path: hash, parts };
}

window.addEventListener("hashchange", render);
window.addEventListener("load", render);

async function render() {
  if (!getOperatorToken()) {
    renderLogin();
    return;
  }
  updateNavVisibility(true);

  const { parts } = getRoute();

  try {
    if (parts[0] === "project" && parts[1]) {
      if (parts[2] === "add-site") {
        await renderAddSite(parts[1]);
      } else if (parts[2] === "site" && parts[3]) {
        await renderSiteDetail(parts[1], parts[3]);
      } else {
        await renderProjectDetail(parts[1]);
      }
    } else if (parts[0] === "new-project") {
      renderNewProject();
    } else {
      await renderProjects();
    }
  } catch (err) {
    if (err.message === "unauthorized") return;
    const errCard = document.createElement("div");
    errCard.className = "card";
    const errP = document.createElement("p");
    errP.style.color = "var(--red)";
    errP.textContent = "Error: " + err.message;
    errCard.appendChild(errP);
    app.innerHTML = "";
    app.appendChild(errCard);
  }
}

// ---------------------------------------------------------------------------
// Projects List
// ---------------------------------------------------------------------------

async function renderProjects() {
  const { projects } = await api("/api/projects");

  if (!projects.length) {
    app.innerHTML = `
      <div class="empty">
        <p>No projects yet</p>
        <button class="btn btn-primary" onclick="navigate('#/new-project')">Create first project</button>
      </div>`;
    return;
  }

  app.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Projects</span>
        <button class="btn btn-primary btn-sm" onclick="navigate('#/new-project')">+ New Project</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Vertical</th>
            <th>Sites</th>
            <th>Sessions (24h)</th>
            <th>Conversions (24h)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${projects.map((p) => `
            <tr onclick="navigate('#/project/${p.project_id}')">
              <td><strong>${esc(p.name)}</strong></td>
              <td><span class="vertical-badge">${esc(p.vertical)}</span></td>
              <td>${p.sites_count}</td>
              <td>${p.sessions_24h}</td>
              <td>${p.conversions_24h}</td>
              <td><span class="status status-${p.status}">${p.status}</span></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------------
// New Project Form
// ---------------------------------------------------------------------------

function renderNewProject() {
  app.innerHTML = `
    <a href="#/" class="back-link">&larr; Back to projects</a>
    <div class="card">
      <h2 style="margin-bottom:20px">Create Project</h2>
      <form id="create-project-form">
        <div class="form-group">
          <label>Project Name</label>
          <input type="text" name="name" required placeholder="e.g. MyStore" autofocus>
        </div>
        <div class="form-group">
          <label>Vertical</label>
          <select name="vertical" required>
            <option value="ecommerce">Ecommerce</option>
            <option value="services">Services</option>
            <option value="leadgen">Lead Generation</option>
            <option value="education">Education</option>
            <option value="b2b">B2B</option>
            <option value="other">Other</option>
          </select>
        </div>
        <button type="submit" class="btn btn-primary">Create Project</button>
      </form>
    </div>`;

  $("#create-project-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = { name: fd.get("name"), vertical: fd.get("vertical") };
    const { project } = await api("/api/projects", { method: "POST", body: data });
    navigate(`#/project/${project.project_id}`);
  };
}

// ---------------------------------------------------------------------------
// Project Detail
// ---------------------------------------------------------------------------

async function renderProjectDetail(projectId) {
  const [{ project }, { sites }, { goals }] = await Promise.all([
    api(`/api/projects/${projectId}`),
    api(`/api/projects/${projectId}/sites`),
    api(`/api/goals?project_id=${projectId}`),
  ]);

  const statusOptions = ["setup", "active", "paused", "archived"];

  app.innerHTML = `
    <a href="#/" class="back-link">&larr; Back to projects</a>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
      <div>
        <h2>${esc(project.name)} <span class="vertical-badge">${esc(project.vertical)}</span></h2>
        <span class="status status-${project.status}" style="margin-top:4px">${project.status}</span>
      </div>
      <div style="display:flex;gap:8px">
        <select id="status-select" class="btn btn-secondary btn-sm" style="appearance:auto">
          ${statusOptions.map((s) => `<option value="${s}" ${s === project.status ? "selected" : ""}>${s}</option>`).join("")}
        </select>
        <button class="btn btn-primary btn-sm" onclick="navigate('#/project/${projectId}/add-site')">+ Add Site</button>
      </div>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="sites">Sites (${sites.length})</button>
      <button class="tab" data-tab="goals">Goals (${goals.length})</button>
    </div>

    <div id="tab-sites">
      ${sites.length === 0
        ? `<div class="empty"><p>No sites yet</p><button class="btn btn-primary" onclick="navigate('#/project/${projectId}/add-site')">Add first site</button></div>`
        : `<table>
            <thead><tr><th>Domain</th><th>Site Key</th><th>Method</th><th>Status</th><th>Last Event</th></tr></thead>
            <tbody>
              ${sites.map((s) => `
                <tr onclick="navigate('#/project/${projectId}/site/${s.site_id}')">
                  <td><strong>${esc(s.domain)}</strong></td>
                  <td><code style="font-size:12px;color:var(--text-dim)">${s.site_key.slice(0, 12)}...</code></td>
                  <td>${s.install_method}</td>
                  <td><span class="status status-${s.install_status}">${s.install_status}</span></td>
                  <td>${s.last_event_at ? timeAgo(s.last_event_at) : '<span style="color:var(--text-dim)">never</span>'}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>`
      }
    </div>

    <div id="tab-goals" style="display:none">
      ${goals.length === 0
        ? `<div class="empty"><p>No goals configured</p></div>`
        : `<table>
            <thead><tr><th>Name</th><th>Type</th><th>Primary</th><th>Created</th></tr></thead>
            <tbody>
              ${goals.map((g) => `
                <tr style="cursor:default">
                  <td><strong>${esc(g.name)}</strong></td>
                  <td>${g.type}</td>
                  <td>${g.is_primary ? '<span style="color:var(--green)">Yes</span>' : "No"}</td>
                  <td>${new Date(g.created_at).toLocaleDateString()}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>`
      }
    </div>`;

  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.tab;
      $("#tab-sites").style.display = target === "sites" ? "" : "none";
      $("#tab-goals").style.display = target === "goals" ? "" : "none";
    };
  });

  // Status change
  $("#status-select").onchange = async (e) => {
    await api(`/api/projects/${projectId}`, { method: "PUT", body: { status: e.target.value } });
    render();
  };
}

// ---------------------------------------------------------------------------
// Add Site
// ---------------------------------------------------------------------------

function renderAddSite(projectId) {
  app.innerHTML = `
    <a href="#/project/${projectId}" class="back-link">&larr; Back to project</a>
    <div class="card">
      <h2 style="margin-bottom:20px">Add Site</h2>
      <form id="add-site-form">
        <div class="form-group">
          <label>Domain</label>
          <input type="text" name="domain" required placeholder="e.g. mystore.com" autofocus>
        </div>
        <div class="form-group">
          <label>Allowed Origins (comma-separated, leave empty to skip validation)</label>
          <input type="text" name="origins" placeholder="https://mystore.com, https://www.mystore.com">
        </div>
        <div class="form-group">
          <label>Install Method</label>
          <select name="install_method">
            <option value="gtm">GTM (Google Tag Manager)</option>
            <option value="direct_script">Direct Script</option>
            <option value="server_only">Server Only</option>
          </select>
        </div>
        <button type="submit" class="btn btn-primary">Add Site</button>
      </form>
    </div>`;

  $("#add-site-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const origins = fd.get("origins").toString().split(",").map((s) => s.trim()).filter(Boolean);
    const data = {
      domain: fd.get("domain"),
      allowed_origins: origins,
      install_method: fd.get("install_method"),
    };
    const { site } = await api(`/api/projects/${projectId}/sites`, { method: "POST", body: data });
    navigate(`#/project/${projectId}/site/${site.site_id}`);
  };
}

// ---------------------------------------------------------------------------
// Site Detail — snippet + verification
// ---------------------------------------------------------------------------

async function renderSiteDetail(projectId, siteId) {
  const [verifyRes, snippetRes] = await Promise.all([
    api(`/api/sites/${siteId}/verify`),
    api(`/api/sites/${siteId}/snippet`),
  ]);

  const statusClass = verifyRes.status === "verified" ? "green"
    : verifyRes.status === "stale" ? "yellow" : "text-dim";

  app.innerHTML = `
    <a href="#/project/${projectId}" class="back-link">&larr; Back to project</a>

    <div class="card">
      <div class="card-header">
        <span class="card-title">${esc(snippetRes.domain)}</span>
        <span class="status status-${verifyRes.status}" id="verify-status">${verifyRes.status}</span>
      </div>

      <div class="stats">
        <div class="stat-card">
          <div class="stat-label">Site Key</div>
          <div style="font-family:monospace;font-size:14px;word-break:break-all">${snippetRes.siteKey}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Install Method</div>
          <div class="stat-value" style="font-size:20px">${snippetRes.installMethod}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Last Event</div>
          <div class="stat-value" style="font-size:20px">${verifyRes.lastEventAt ? timeAgo(verifyRes.lastEventAt) : "never"}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Install Snippet</span>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm snippet-tab active" data-type="gtm">GTM</button>
          <button class="btn btn-secondary btn-sm snippet-tab" data-type="direct">Direct</button>
        </div>
      </div>
      <div class="snippet-box" id="snippet-code">${esc(snippetRes.snippets.gtm)}</div>
      <button class="btn btn-primary btn-sm" id="copy-btn" onclick="copySnippet()">Copy to clipboard</button>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Verify Installation</span>
        <button class="btn btn-secondary btn-sm" id="verify-btn" onclick="checkVerify('${siteId}')">Check now</button>
      </div>
      <p style="color:var(--text-dim);font-size:14px">
        After installing the snippet on your site, click "Check now" to verify events are being received.
      </p>
      <div id="verify-result" style="margin-top:12px"></div>
    </div>`;

  // Store snippets for tab switching
  window._snippets = snippetRes.snippets;
  window._activeSnippetType = "gtm";

  document.querySelectorAll(".snippet-tab").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".snippet-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      window._activeSnippetType = btn.dataset.type;
      $("#snippet-code").textContent = window._snippets[btn.dataset.type];
    };
  });
}

window.copySnippet = async function () {
  const code = window._snippets[window._activeSnippetType];
  try {
    await navigator.clipboard.writeText(code);
    const btn = $("#copy-btn");
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy to clipboard"; }, 2000);
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = code;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
};

window.checkVerify = async function (siteId) {
  const btn = $("#verify-btn");
  btn.textContent = "Checking...";
  btn.disabled = true;

  try {
    const res = await api(`/api/sites/${siteId}/verify`);
    const el = $("#verify-result");
    const statusEl = $("#verify-status");

    el.innerHTML = "";
    const span = document.createElement("span");
    if (res.status === "verified") {
      span.style.color = "var(--green)";
      span.textContent = "Events received! Last event: " + timeAgo(res.lastEventAt);
      statusEl.className = "status status-verified";
      statusEl.textContent = "verified";
    } else if (res.status === "stale") {
      span.style.color = "var(--yellow)";
      span.textContent = "Events were received but last event was " + timeAgo(res.lastEventAt) + ". Check if tracker is still active.";
      statusEl.className = "status status-stale";
      statusEl.textContent = "stale";
    } else {
      span.style.color = "var(--text-dim)";
      span.textContent = "No events received yet. Make sure the snippet is installed and visit the site.";
    }
    el.appendChild(span);
  } catch (err) {
    const errSpan = document.createElement("span");
    errSpan.style.color = "var(--red)";
    errSpan.textContent = "Error: " + err.message;
    const vr = $("#verify-result");
    vr.innerHTML = "";
    vr.appendChild(errSpan);
  }

  btn.textContent = "Check now";
  btn.disabled = false;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
