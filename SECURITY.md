# Security policy

Keepwatch configures firewalls, SSH and a root-level dashboard, so security reports matter a lot.

**Please do not open a public issue for vulnerabilities.** Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability"). You'll get an answer within a few days.

In scope: anything that exposes a port, an admin UI or data that Keepwatch promises to keep private;
privilege escalation through the dashboard; ways to bypass the passkey requirement for dangerous
actions; configurations that lock the owner out of their server.

## Security model in short

- The dashboard runs as root and binds to `127.0.0.1` only; reaching it needs SSH access (and
  Tailscale, if enabled). It has no login of its own: SSH access *is* the authentication. Dangerous
  actions additionally require a passkey (WebAuthn) when `KW_DASHBOARD_PASSKEY="yes"`.
- Admin UIs (proxy, Portainer, your own) are never published, not even in the tailnet.
- Secrets never leave the server except inside the encrypted restic backup.
