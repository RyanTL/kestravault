#!/usr/bin/env bash
# Back up the self-hosted stack: a full pg_dump + a tar of the storage files.
#
# Self-hosting means backups are YOUR job — run this from cron, e.g. nightly:
#   0 3 * * *  /path/to/kestravault/selfhost/backup.sh >/dev/null
#
# Restore (into a FRESH stack: ./setup.sh + up -d, before running migrate.sh):
#   docker compose exec -T db psql -U postgres -d postgres < backups/db-<stamp>.sql
#   tar -xzf backups/storage-<stamp>.tar.gz -C volumes
set -euo pipefail
cd "$(dirname "$0")"

stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p backups

echo "Dumping database…"
docker compose exec -T db pg_dump -U postgres -d postgres --clean --if-exists \
  >"backups/db-${stamp}.sql"

if [[ -d volumes/storage ]]; then
  echo "Archiving storage files…"
  tar -czf "backups/storage-${stamp}.tar.gz" -C volumes storage
fi

echo "Backup written:"
ls -lh "backups/db-${stamp}.sql" "backups/storage-${stamp}.tar.gz" 2>/dev/null || true
echo "(Prune old backups yourself, or add e.g. 'find backups -mtime +30 -delete' to your cron.)"
