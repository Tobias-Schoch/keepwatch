# Stop archiving. The archive (/var/log/keepwatch/containers) and its
# settings are kept - delete the directory yourself if you no longer need it.
unit_off keepwatch-log-archive.service
rm -f /usr/local/sbin/keepwatch-log-archive
echo "  stopped; kept /var/log/keepwatch/containers and $KW_ETC/log-archive.conf"
