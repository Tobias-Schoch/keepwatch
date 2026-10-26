# Stop fail2ban and remove Keepwatch's jails, filters and settings.
# Kept: the ban database (/var/lib/fail2ban) and the dashboard's own
# settings file (jail.d/zz-keepwatch-dashboard.local), in case you come back.
systemctl disable -q --now fail2ban 2>/dev/null || true
rm -f /etc/fail2ban/jail.d/00-keepwatch-ips.local /etc/fail2ban/jail.d/keepwatch.local \
  /etc/fail2ban/jail.d/keepwatch-tailscale.local /etc/fail2ban/jail.d/keepwatch-ssh-closed.local \
  /etc/fail2ban/jail.d/keepwatch-web-scanner.local /etc/fail2ban/jail.d/keepwatch-app-login.local \
  /etc/fail2ban/fail2ban.d/keepwatch.local /etc/fail2ban/filter.d/keepwatch-ssh-closed.conf \
  /etc/fail2ban/filter.d/keepwatch-web-scanner.conf /etc/fail2ban/filter.d/keepwatch-app-login.conf \
  /usr/local/sbin/keepwatch-f2b-not-tailscale
echo "  fail2ban stopped and disabled, all bans lifted (package and ban database kept)"
