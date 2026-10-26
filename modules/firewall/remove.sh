# Remove Keepwatch's firewall rules. Afterwards every port that something
# listens on is reachable again - including ports Docker publishes.
unit_off keepwatch-firewall.service
for T in iptables ip6tables; do
  $T -S INPUT 2>/dev/null | grep -- '--comment keepwatch' | while IFS= read -r rule; do
    # eval: -S prints the LOG prefix in quotes; the spec comes from iptables itself.
    eval "$T -D ${rule#-A }" 2>/dev/null || true
  done || true
  # Back to Docker's default: an empty DOCKER-USER that just returns.
  if $T -S DOCKER-USER >/dev/null 2>&1; then
    printf '*filter\n:DOCKER-USER - [0:0]\n-A DOCKER-USER -j RETURN\nCOMMIT\n' | "$T-restore" --noflush
  fi
done
rm -f /usr/local/sbin/keepwatch-firewall "$KW_ETC/firewall.env"
warn "firewall removed: every listening port is reachable from the internet again (including ports Docker publishes)"
echo "  ok"
