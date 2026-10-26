# fail2ban: bans SSH brute force (KW_F2B_SSH_MAXRETRY failures), web scanners and repeated
# failed logins on your sites - before Docker sees the packet.
need fail2ban python3-systemd nftables

JD=/etc/fail2ban/jail.d
# This server's own public addresses: it must never ban itself (its own
# checks go through its public domains). Detected, not hard-coded - a new
# server has other addresses. Plus KW_TRUSTED_IPS.
OWN=$(ip -o addr show scope global | awk '$2 !~ /^(docker|br-|veth|tailscale)/ {split($4, a, "/"); print a[1]}' | sort -u | tr '\n' ' ')
# The address this deploy comes from is never banned either: a typo in
# your own ssh command must not lock you out of the server you just set up.
# Only the latest one (rewritten on every deploy); tailnet addresses are
# handled by the tailscale jail anyway.
DEPLOY_IP=$(deploy_client_ip)
case $DEPLOY_IP in 100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|fd7a:115c:a1e0:*) DEPLOY_IP="" ;; esac
# shellcheck disable=SC2086,SC2116 # joins the words
IGNORE=$(echo $OWN $KW_TRUSTED_IPS)
write "$JD/00-keepwatch-ips.local" <<CONF
# Written by Keepwatch on every deploy - do not edit (set KW_TRUSTED_IPS instead).
# keepwatch_ignore: this server's own addresses and KW_TRUSTED_IPS.
# deploy_ip: the address of the most recent ./keepwatch deploy.
# Every jail ignores both, recidive (a year on all ports) included.
[DEFAULT]
deploy_ip = $DEPLOY_IP
keepwatch_ignore = $IGNORE %(deploy_ip)s
CONF

# The port(s) sshd really listens on - a custom port must be what gets banned.
install -d -m 755 /run/sshd
SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' | sort -un | paste -sd, -)
SSH_PORT=${SSH_PORT:-22}
TAILNET=""
enabled tailscale && TAILNET="100.64.0.0/10 fd7a:115c:a1e0::/48"
jail() {  # jail <file in files/> <target>: fill in the placeholders
  sed -e "s|@SSH_BANTIME@|$KW_F2B_SSH_BANTIME|g" -e "s|@SSH_MAXRETRY@|$KW_F2B_SSH_MAXRETRY|g" -e "s|@SSH_PORT@|$SSH_PORT|g" \
      -e "s|@TAILNET@|$TAILNET|g" -e "s|@LOGS@|$PROXY_LOGS|g" "$F/$1" | write "$JD/$2"
}
drop() {  # drop <target>: remove a jail file whose module is off
  if [[ -f $JD/$1 ]]; then rm -f "$JD/$1"; CHANGED+=("$JD/$1"); echo "  removed: $JD/$1"; fi
}
PROXY_LOGS=$KW_SRV/proxy/data/logs

jail jail-base.local keepwatch.local
if enabled tailscale; then
  put "$F/f2b-not-tailscale" /usr/local/sbin/keepwatch-f2b-not-tailscale 755
  jail jail-sshd-tailscale.local keepwatch-tailscale.local
else
  drop keepwatch-tailscale.local
fi

# ssh-closed reads what keepwatch-firewall logs to kern.log (via rsyslog).
if enabled firewall && { [[ -f /var/log/kern.log ]] || systemctl is-active -q rsyslog; }; then
  [[ -f /var/log/kern.log ]] || install -m 640 -o syslog -g adm /dev/null /var/log/kern.log 2>/dev/null || touch /var/log/kern.log
  jail jail-ssh-closed.local keepwatch-ssh-closed.local
else
  enabled firewall && warn "fail2ban: no rsyslog/kern.log - the ssh-closed jail is off"
  drop keepwatch-ssh-closed.local
fi

# The web jails read the proxy's access logs. The proxy module runs after
# this one, so on the first deploy its log directory does not exist yet - and
# fail2ban refuses to start at all when a jail has no file to watch. Create
# the directory and the two logs every proxy has, the proxy writes into them.
if enabled proxy && [[ $KW_F2B_WEB_SCANNER == yes || $KW_F2B_APP_LOGIN == yes ]]; then
  install -d -m 755 "$KW_SRV/proxy" "$KW_SRV/proxy/data" "$PROXY_LOGS"
  for f in fallback_http_access.log default-host_access.log; do
    [[ -e $PROXY_LOGS/$f ]] || touch "$PROXY_LOGS/$f"
  done
fi
if enabled proxy && [[ $KW_F2B_WEB_SCANNER == yes ]]; then jail jail-web-scanner.local keepwatch-web-scanner.local; else drop keepwatch-web-scanner.local; fi
if enabled proxy && [[ $KW_F2B_APP_LOGIN == yes ]]; then jail jail-app-login.local keepwatch-app-login.local; else drop keepwatch-app-login.local; fi

put "$F/fail2ban-keepwatch.local" /etc/fail2ban/fail2ban.d/keepwatch.local
put "$F/filter-ssh-closed.conf" /etc/fail2ban/filter.d/keepwatch-ssh-closed.conf
put "$F/filter-web-scanner.conf" /etc/fail2ban/filter.d/keepwatch-web-scanner.conf
put "$F/filter-app-login.conf" /etc/fail2ban/filter.d/keepwatch-app-login.conf
# recidive watches fail2ban's own log; it must exist before the first start.
[[ -e /var/log/fail2ban.log ]] || install -m 640 /dev/null /var/log/fail2ban.log

systemctl enable -q fail2ban
if changed /etc/fail2ban/ || ! systemctl is-active -q fail2ban; then
  # Test first: a broken configuration must not take the running fail2ban down.
  if fail2ban-client -t >/dev/null 2>&1; then
    systemctl restart fail2ban
  else
    warn "fail2ban configuration test failed - not restarted: $(fail2ban-client -t 2>&1 | grep -iE 'error|fail' | head -2 | tr '\n' ' ')"
  fi
fi
unset -f jail drop
echo "  ok"
