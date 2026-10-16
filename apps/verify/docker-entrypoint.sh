#!/bin/sh
# Container entrypoint for Dockerfile.verify.
#
# Railway (like most hosts) mounts the /data volume owned by root, so the container starts as root only to hand the
# volume to the unprivileged user `fv` (files a previous root-run deployment left behind included). The verifier and
# its Irys sidecar then run as `fv`, never as root. Started as a non-root user already (docker run --user …), it
# simply runs the command.
set -eu

APP_USER=fv
DB_DIR="$(dirname "${FV_DB_PATH:-/data/flaconvault.db}")"
MEDIA_DIR="${FV_MEDIA_DIR:-/data/media}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DB_DIR" "$MEDIA_DIR"
  # only what is not owned by fv yet (cheap on every start, also after the switch from root)
  find "$DB_DIR" "$MEDIA_DIR" ! -user "$APP_USER" -exec chown "$APP_USER:$APP_USER" {} +
  exec /usr/local/bin/python3 -c '
import os, pwd, sys
pw = pwd.getpwnam(sys.argv[1])
os.initgroups(pw.pw_name, pw.pw_gid)
os.setgid(pw.pw_gid)
os.setuid(pw.pw_uid)
if os.getuid() == 0 or os.geteuid() == 0:
    sys.exit("refusing to run as root")
os.environ["HOME"] = pw.pw_dir
os.environ["USER"] = pw.pw_name
os.execvp(sys.argv[2], sys.argv[2:])
' "$APP_USER" "$@"
fi

mkdir -p "$MEDIA_DIR"
exec "$@"
