/** Self-contained HTML page for passkey registration on the admin port. */
export const ADMIN_REGISTRATION_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenGraft — Passkey Setup</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d1117; color: #e6edf3;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh;
  }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 12px;
    padding: 2rem; max-width: 420px; width: 100%; text-align: center;
  }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  .subtitle { color: #8b949e; font-size: 0.9rem; margin-bottom: 1.5rem; }
  .btn {
    display: inline-block; padding: 0.75rem 1.5rem; border-radius: 8px;
    border: none; font-size: 1rem; cursor: pointer; font-weight: 600;
    transition: opacity 0.2s;
  }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: #238636; color: #fff; }
  .btn-danger { background: #da3633; color: #fff; margin-top: 0.5rem; font-size: 0.85rem; padding: 0.5rem 1rem; }
  .status { margin-top: 1rem; font-size: 0.9rem; min-height: 1.5rem; }
  .status.ok { color: #3fb950; }
  .status.err { color: #f85149; }
  .cred-list { margin-top: 1.5rem; text-align: left; }
  .cred-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: 0.5rem 0.75rem; background: #0d1117; border-radius: 6px;
    margin-bottom: 0.5rem; font-size: 0.85rem;
  }
  .cred-id { color: #8b949e; font-family: monospace; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
  .cred-date { color: #8b949e; font-size: 0.8rem; }
</style>
</head>
<body>
<div class="card">
  <h1>🔐 OpenGraft Passkey Setup</h1>
  <p class="subtitle">Register a passkey to authenticate remote access</p>
  <button class="btn btn-primary" id="registerBtn" onclick="doRegister()">
    Register Passkey
  </button>
  <div class="status" id="status"></div>
  <div class="cred-list" id="credList"></div>
</div>
<script type="module">
import { startRegistration } from "https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@13/dist/bundle/index.js";

window.doRegister = async () => {
  const btn = document.getElementById("registerBtn");
  const status = document.getElementById("status");
  btn.disabled = true;
  status.textContent = "Starting registration...";
  status.className = "status";

  try {
    // Get registration options from admin server
    const optRes = await fetch("/auth/register/options", { method: "POST" });
    if (!optRes.ok) throw new Error(await optRes.text());
    const options = await optRes.json();

    // Start WebAuthn registration
    const credential = await startRegistration({ optionsJSON: options });

    // Verify with server
    const verifyRes = await fetch("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credential),
    });
    if (!verifyRes.ok) throw new Error(await verifyRes.text());
    const result = await verifyRes.json();

    if (result.verified) {
      status.textContent = "✓ Passkey registered successfully!";
      status.className = "status ok";
      loadCredentials();
    } else {
      throw new Error("Verification failed");
    }
  } catch (err) {
    status.textContent = "✗ " + (err.message || "Registration failed");
    status.className = "status err";
  } finally {
    btn.disabled = false;
  }
};

async function loadCredentials() {
  try {
    const res = await fetch("/auth/credentials");
    const data = await res.json();
    const list = document.getElementById("credList");
    if (data.count === 0) {
      list.innerHTML = "<p style='color:#8b949e;text-align:center;font-size:0.85rem'>No passkeys registered yet</p>";
      return;
    }
    list.innerHTML = data.credentials.map(c =>
      '<div class="cred-item">' +
        '<div><span class="cred-id">' + c.id.slice(0, 20) + '...</span>' +
        '<div class="cred-date">' + new Date(c.createdAt).toLocaleString() + '</div></div>' +
        '<button class="btn btn-danger" onclick="deleteCred(\\'' + c.id + '\\')">Delete</button>' +
      '</div>'
    ).join("");
  } catch { /* ignore */ }
}

window.deleteCred = async (id) => {
  if (!confirm("Delete this passkey?")) return;
  try {
    await fetch("/auth/credentials/" + encodeURIComponent(id), { method: "DELETE" });
    loadCredentials();
  } catch { /* ignore */ }
};

loadCredentials();
</script>
</body>
</html>`;
