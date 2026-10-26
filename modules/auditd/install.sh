# auditd: records changes to SSH keys, sudo, accounts, services, cron,
# fail2ban, Keepwatch's own settings and Docker. The dashboard shows them.
need auditd
put "$F/keepwatch.rules" /etc/audit/rules.d/keepwatch.rules 640
# auditd cannot run everywhere (containers, some VPS kernels without audit):
# then it is a warning, not the end of the deploy.
if systemctl enable -q --now auditd 2>/dev/null && sleep 1 && systemctl is-active -q auditd; then
  if changed /etc/audit/; then augenrules --load >/dev/null || warn "auditd: augenrules --load failed"; fi
else
  warn "auditd does not start on this kernel (container or audit disabled) - no audit log"
fi
echo "  ok"
