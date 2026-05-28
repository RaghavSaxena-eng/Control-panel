import { useState, useEffect, useRef } from "react";
import "./App.css";

const STATUS_COLORS = {
  pending:    { bg: "#FFF8E1", text: "#B45309", dot: "#F59E0B" },
  running:    { bg: "#EFF6FF", text: "#1D4ED8", dot: "#3B82F6" },
  completed:  { bg: "#F0FDF4", text: "#166534", dot: "#22C55E" },
  failed:     { bg: "#FFF1F2", text: "#9F1239", dot: "#F43F5E" },
};

const STATUS_LABELS = {
  pending: "Queued",
  running: "Deploying",
  completed: "Live",
  failed: "Failed",
};

function StatusBadge({ status }) {
  const s = STATUS_COLORS[status] || STATUS_COLORS.pending;
  return (
    <span className="status-badge" style={{ background: s.bg, color: s.text }}>
      <span className="status-dot" style={{ background: s.dot, boxShadow: status === "running" ? `0 0 0 3px ${s.dot}33` : "none" }} />
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function LogLine({ line, index }) {
  const isError = line.toLowerCase().includes("error") || line.toLowerCase().includes("failed");
  const isSuccess = line.toLowerCase().includes("success") || line.toLowerCase().includes("completed") || line.toLowerCase().includes("✓");
  return (
    <div
      className="log-line"
      style={{
        color: isError ? "#F87171" : isSuccess ? "#4ADE80" : "#94A3B8",
        animationDelay: `${index * 30}ms`,
      }}
    >
      <span className="log-prefix">›</span>
      {line}
    </div>
  );
}

function DeploymentCard({ deployment, onSelect, selected }) {
  return (
    <div
      className={`deployment-card ${selected ? "selected" : ""}`}
      onClick={() => onSelect(deployment._id)}
    >
      <div className="card-header">
        <div>
          <p className="card-client">{deployment.clientName}</p>
          <p className="card-domain">{deployment.domain}</p>
        </div>
        <StatusBadge status={deployment.status} />
      </div>
      <div className="card-footer">
        <span className="card-image">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
          </svg>
          {deployment.image}
        </span>
        <span className="card-time">{new Date(deployment.createdAt).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

export default function App() {
  const [deployments, setDeployments] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState({ clientName: "", domain: "", image: "nginx:latest" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("deploy");
  const pollingRef = useRef({});
  const logsEndRef = useRef(null);

  const selectedDeploy = deployments.find(d => d._id === selectedId);

  useEffect(() => {
    fetchAllDeployments();
  }, []);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [selectedDeploy?.logs]);

  async function fetchAllDeployments() {
    try {
      const res = await fetch("/api/deployments");
      if (res.ok) {
        const data = await res.json();
        setDeployments(data);
        data.forEach(d => {
          if (d.status === "pending" || d.status === "running") {
            startPolling(d._id);
          }
        });
      }
    } catch (_) {}
  }

  function startPolling(id) {
    if (pollingRef.current[id]) return;
    pollingRef.current[id] = setInterval(async () => {
      try {
        const res = await fetch(`/api/status/${id}`);
        if (!res.ok) return;
        const data = await res.json();
        setDeployments(prev =>
          prev.map(d => (d._id === id ? { ...d, ...data } : d))
        );
        if (data.status === "completed" || data.status === "failed") {
          clearInterval(pollingRef.current[id]);
          delete pollingRef.current[id];
        }
      } catch (_) {}
    }, 2000);
  }

  async function handleDeploy(e) {
    e.preventDefault();
    setError("");
    if (!form.clientName || !form.domain || !form.image) {
      setError("All fields are required.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Deploy failed");

      const newDeploy = {
        _id: data.deploymentId,
        ...form,
        status: "pending",
        logs: [],
        createdAt: new Date().toISOString(),
      };
      setDeployments(prev => [newDeploy, ...prev]);
      setSelectedId(data.deploymentId);
      setActiveTab("status");
      setForm({ clientName: "", domain: "", image: "nginx:latest" });
      startPolling(data.deploymentId);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const stats = {
    total: deployments.length,
    live: deployments.filter(d => d.status === "completed").length,
    deploying: deployments.filter(d => d.status === "running" || d.status === "pending").length,
    failed: deployments.filter(d => d.status === "failed").length,
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-mark">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
            </svg>
          </div>
          <span>ControlPlane</span>
        </div>

        <nav className="sidebar-nav">
          <button className={`nav-item ${activeTab === "deploy" ? "active" : ""}`} onClick={() => setActiveTab("deploy")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12l7-7 7 7"/>
            </svg>
            New Deployment
          </button>
          <button className={`nav-item ${activeTab === "status" ? "active" : ""}`} onClick={() => setActiveTab("status")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
            </svg>
            Live Status
            {stats.deploying > 0 && <span className="nav-badge">{stats.deploying}</span>}
          </button>
        </nav>

        <div className="sidebar-stats">
          <div className="stat-row">
            <span className="stat-label">Live</span>
            <span className="stat-val green">{stats.live}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Deploying</span>
            <span className="stat-val blue">{stats.deploying}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Failed</span>
            <span className="stat-val red">{stats.failed}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Total</span>
            <span className="stat-val">{stats.total}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        {activeTab === "deploy" && (
          <div className="panel">
            <div className="panel-header">
              <h1>Deploy a Client</h1>
              <p>Pull a Docker image and map it to a domain on your EC2 instance.</p>
            </div>

            <form className="deploy-form" onSubmit={handleDeploy}>
              <div className="field">
                <label>Client Name</label>
                <input
                  type="text"
                  placeholder="e.g. Acme Corp"
                  value={form.clientName}
                  onChange={e => setForm(p => ({ ...p, clientName: e.target.value }))}
                  disabled={submitting}
                />
              </div>
              <div className="field">
                <label>Domain</label>
                <input
                  type="text"
                  placeholder="e.g. acme.ourplatform.com"
                  value={form.domain}
                  onChange={e => setForm(p => ({ ...p, domain: e.target.value }))}
                  disabled={submitting}
                />
              </div>
              <div className="field">
                <label>Docker Image</label>
                <input
                  type="text"
                  placeholder="e.g. nginx:latest"
                  value={form.image}
                  onChange={e => setForm(p => ({ ...p, image: e.target.value }))}
                  disabled={submitting}
                />
                <span className="field-hint">Image must be available on Docker Hub or your private registry.</span>
              </div>

              {error && <div className="form-error">{error}</div>}

              <button type="submit" className="deploy-btn" disabled={submitting}>
                {submitting ? (
                  <>
                    <span className="spinner" />
                    Queuing deployment...
                  </>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M5 12h14M12 5l7 7-7 7"/>
                    </svg>
                    Deploy
                  </>
                )}
              </button>
            </form>
          </div>
        )}

        {activeTab === "status" && (
          <div className="status-panel">
            <div className="deployments-list">
              <div className="list-header">
                <h2>Deployments</h2>
                <button className="refresh-btn" onClick={fetchAllDeployments}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 4v6h-6M1 20v-6h6"/>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                  </svg>
                </button>
              </div>
              {deployments.length === 0 ? (
                <div className="empty-state">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                  </svg>
                  <p>No deployments yet</p>
                </div>
              ) : (
                deployments.map(d => (
                  <DeploymentCard
                    key={d._id}
                    deployment={d}
                    selected={selectedId === d._id}
                    onSelect={setSelectedId}
                  />
                ))
              )}
            </div>

            <div className="detail-pane">
              {!selectedDeploy ? (
                <div className="detail-empty">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                    <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>
                  </svg>
                  <p>Select a deployment to view logs</p>
                </div>
              ) : (
                <>
                  <div className="detail-header">
                    <div>
                      <h2>{selectedDeploy.clientName}</h2>
                      <a href={`https://${selectedDeploy.domain}`} target="_blank" rel="noreferrer" className="detail-domain">
                        {selectedDeploy.domain}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>
                        </svg>
                      </a>
                    </div>
                    <StatusBadge status={selectedDeploy.status} />
                  </div>

                  <div className="detail-meta">
                    <div className="meta-item">
                      <span className="meta-key">Image</span>
                      <span className="meta-val">{selectedDeploy.image}</span>
                    </div>
                    <div className="meta-item">
                      <span className="meta-key">Deployed at</span>
                      <span className="meta-val">{new Date(selectedDeploy.createdAt).toLocaleString()}</span>
                    </div>
                    {selectedDeploy.jobId && (
                      <div className="meta-item">
                        <span className="meta-key">Job ID</span>
                        <span className="meta-val mono">{selectedDeploy.jobId}</span>
                      </div>
                    )}
                  </div>

                  <div className="log-panel">
                    <div className="log-header">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M4 17l6-6-6-6M12 19h8"/>
                      </svg>
                      Deployment Log
                      {(selectedDeploy.status === "pending" || selectedDeploy.status === "running") && (
                        <span className="log-live-dot" />
                      )}
                    </div>
                    <div className="log-body">
                      {(!selectedDeploy.logs || selectedDeploy.logs.length === 0) ? (
                        <div className="log-line" style={{ color: "#475569" }}>Waiting for worker to pick up job...</div>
                      ) : (
                        selectedDeploy.logs.map((line, i) => (
                          <LogLine key={i} line={line} index={i} />
                        ))
                      )}
                      <div ref={logsEndRef} />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
