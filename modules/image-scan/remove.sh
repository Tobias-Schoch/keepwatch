# Stop the image scans and remove their results and Trivy's cache volume
# (a vulnerability database, re-downloaded when the module comes back).
unit_off keepwatch-image-scan.timer keepwatch-image-scan.service
rm -f /usr/local/sbin/keepwatch-image-scan "$KW_STATE/image-scan.json" "$KW_STATE/image-scan.progress.json"
if command -v docker >/dev/null; then docker volume rm trivy-cache >/dev/null 2>&1 || true; fi
echo "  removed"
