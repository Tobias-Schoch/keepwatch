# Remove Keepwatch's rules and stop auditd. The audit log (/var/log/audit) is kept.
rm -f /etc/audit/rules.d/keepwatch.rules
if command -v augenrules >/dev/null; then augenrules --load >/dev/null 2>&1 || true; fi
systemctl disable -q --now auditd 2>/dev/null || true
echo "  auditd stopped and disabled (package and /var/log/audit kept)"
