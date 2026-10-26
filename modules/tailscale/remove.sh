# Remove Tailscale access. First and above all: never lock anyone out. If
# SSH was closed to the internet (Tailscale only), reopen it before anything else.
if grep -q '^SSH_PUBLIC=no' /etc/keepwatch/firewall.env 2>/dev/null; then
  printf 'SSH_PUBLIC=yes\n' > /etc/keepwatch/firewall.env
  systemctl restart keepwatch-firewall 2>/dev/null || true
  echo "  SSH reopened to the internet (it was Tailscale only)"
fi
unit_off keepwatch-ssh-fallback.timer keepwatch-ssh-fallback.service
rm -f /usr/local/sbin/keepwatch-ssh-fallback /run/keepwatch-ssh-fallback.count

# Stopping tailscaled while this deploy runs over Tailscale would cut the
# connection mid-run: then it is only disabled and stops at the next reboot.
if via_tailscale; then
  systemctl disable -q tailscaled 2>/dev/null || true
  warn "tailscale: this deploy runs over Tailscale - tailscaled stays up until the next reboot; point KW_HOST at the public address first"
else
  systemctl disable -q --now tailscaled 2>/dev/null || true
fi
echo "  Tailscale disabled. Kept: the package and the node identity (/var/lib/tailscale)."
echo "  To leave the tailnet for good: tailscale logout && apt purge tailscale"
