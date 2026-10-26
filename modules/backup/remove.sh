# Stop the backups. Kept: the repository (/var/backups/keepwatch/restic),
# the off-site repository, and the password and credentials in
# /etc/keepwatch/backup - without restic.pass no backup can ever be read.
unit_off keepwatch-backup.timer keepwatch-backup-verify.timer keepwatch-backup.service keepwatch-backup-verify.service
rm -f /usr/local/sbin/keepwatch-backup /usr/local/sbin/keepwatch-backup-verify
rm -rf /var/backups/keepwatch/stage
echo "  backups stopped; kept /var/backups/keepwatch/restic and $KW_ETC/backup (password!)"
