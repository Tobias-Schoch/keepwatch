# Docker runs your applications - switching the module off does not stop or
# uninstall it. Nothing is deleted: containers, images, volumes, networks and
# /etc/docker/daemon.json stay as they are.
echo "  Docker left installed and running with all containers, volumes and networks."
echo "  To remove it yourself: apt purge docker-ce docker-ce-cli containerd.io (this keeps /var/lib/docker;"
echo "  NEVER purge Ubuntu's docker.io package without a backup - its postrm deletes /var/lib/docker)"
