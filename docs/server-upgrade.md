# Upgrade an existing Docker Compose server

Updated 31 October 2026 for MCP **0.2.1**, official stock Vikunja **2.7.0/2.7.1**,
and the optional **2.7.1+atomic-fields.1** backend. Commands below run in Bash on a Linux Docker
server, except the explicitly marked Windows transfer step. Replace example
paths and service names with the ones from your existing deployment.
Run each step only after the preceding commands succeed. Stop on a failed
version check, backup, checksum or configuration validation.

An unpatched backend can be kept: build/recreate MCP and use
`VIKUNJA_REQUIRE_ATOMIC_UPDATES=0`. Backend build, migration and image-replacement
steps apply only if you choose to upgrade or adopt the optional backend patch.

This is an upgrade of your current stack. Keep its Compose project name,
database, attachments, networks, ports, upstream URL, JWT secret and MCP API key.
The existing client connection can then keep its URL and `X-API-Key`.
Do not copy the Windows `.env`, `data/` directory or `docker-compose.local.yml`
to the server, and do not replace the server's Compose file with the local example.

## 1. Identify the existing stack and backend version

Use `docker compose ls` and `docker ps` to identify the current stack. If needed,
read the project name from its existing MCP container:

```bash
docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' EXISTING_MCP_CONTAINER
```

Set these to the actual existing values. Include every original `-f` override
in the `dc` function if your deployment uses more than one Compose file.
If the existing stack has no environment file, omit `--env-file` and the
environment-file backup/restore commands; retain its existing way of supplying secrets.

```bash
PROJECT='your-existing-compose-project'
COMPOSE_FILE='/absolute/path/to/your/compose.yml'
ENV_FILE='/absolute/path/to/your/.env'
MCP_SERVICE='vikunja-mcp'
BACKEND_SERVICE='vikunja'
dc() { docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
dc config --quiet
dc ps
```

Read backend version information through the old MCP container, without showing
its token or dumping its environment:

```bash
dc exec -T "$MCP_SERVICE" node --input-type=module <<'NODE'
const url = new URL(process.env.VIKUNJA_BASE_URL ?? process.env.VIKUNJA_API_URL ?? 'http://vikunja:3456');
const path = url.pathname.replace(/\/+$/, '');
url.pathname = `${path.endsWith('/api/v1') ? path : `${path}/api/v1`}/info`;
const response = await fetch(url, {signal: AbortSignal.timeout(15000)});
if (!response.ok) throw new Error(`Backend info: HTTP ${response.status}`);
const info = await response.json();
console.log(JSON.stringify({version: info.version, atomic_field_updates: info.atomic_field_updates ?? null}));
NODE
```

Choose the matching route:

| Current backend | Upgrade route |
| --- | --- |
| Stock or patched Vikunja 2.7.0 | Upgrade backend and MCP to include the 2.7.1 security fixes. Keep a complete cold backup; upstream database and token-scope migrations run on first startup. |
| Stock Vikunja 2.7.1 | Update MCP only and use automatic stock compatibility. No backend patch is required. |
| The reviewed patched 2.7.1 backend, advertising numeric `atomic_field_updates: 1` | Update MCP only; keep required mode enabled. |
| Stock 2.7.0 or 2.7.1, keeping the backend | Stock compatibility is the default. Change an existing explicit `VIKUNJA_REQUIRE_ATOMIC_UPDATES=1` to `0` and recreate MCP. Independent clients can still overwrite unrelated changes through stock update routes; coordinate writers. |
| Any other Vikunja version | First test the intended backend transition against a restored copy of your data. Do not replace a newer backend with the pinned 2.7.1 build or assume an older database can be upgraded safely without following its migration requirements. |

The companion patch adds no migrations beyond stock 2.7.1. The completed backend
verification covers stock **2.7.0** and **2.7.1**, plus patched **2.7.1**, rather
than every Vikunja release.
The upstream upgrade from 2.7.0 does include migrations. To roll it back, restore
the matching cold database/files backup as well as the old images. Do not use
MCP-only compatibility mode to postpone the 2.7.1 security fixes.

## 2. Save configuration and rollback images

Keep backups outside the source/build directory. These files contain secrets;
keep them private. Copy any additional Compose overrides or mounted configuration
files too. Keep this Bash session open so its variables remain available.

```bash
umask 077
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="$HOME/vikunja-upgrade-backups/$STAMP"
mkdir -p "$BACKUP_DIR"
cp -- "$COMPOSE_FILE" "$BACKUP_DIR/compose.before.yml"
cp -- "$ENV_FILE" "$BACKUP_DIR/env.before"

OLD_MCP_IMAGE=$(docker inspect --format '{{.Image}}' "$(dc ps -q "$MCP_SERVICE")")
docker image tag "$OLD_MCP_IMAGE" "vikunja-mcp:rollback-$STAMP"
printf '%s\n' "$OLD_MCP_IMAGE" > "$BACKUP_DIR/mcp-image-id.txt"
```

If also changing the backend:

```bash
OLD_BACKEND_IMAGE=$(docker inspect --format '{{.Image}}' "$(dc ps -q "$BACKEND_SERVICE")")
docker image tag "$OLD_BACKEND_IMAGE" "vikunja-mcp-backend:rollback-$STAMP"
printf '%s\n' "$OLD_BACKEND_IMAGE" > "$BACKUP_DIR/backend-image-id.txt"
docker inspect --format '{{json .Mounts}}' "$(dc ps -q "$BACKEND_SERVICE")"
```

Record which mounts contain the actual database and attachments. Preserve the
old image tags until the upgrade has been accepted; do not prune them.

## 3. Transfer the updated source and build images

Build from a reviewed release commit. Generated archives under `output/` are
ignored by Git and are not included in a clone. From a clean checkout of the
intended release commit, create a source snapshot and checksum:

- `output/releases/vikunja-mcp-0.2.1-source.tar.gz`
- `output/releases/vikunja-mcp-0.2.1-source.tar.gz.sha256`

The commands below archive only committed files. Review and commit the intended
release changes first; uncommitted fixes will not be included. The archive carries
the tracked source, lockfile, licenses, Dockerfiles, backend patch, tests,
documentation and portable AI skill. Ignored credentials, local data and generated
artifacts are excluded.

For example, create and transfer the archive from PowerShell, replacing the clone
path and SSH destination with your own values:

```powershell
Set-Location C:\path\to\vikunja-mcp
New-Item -ItemType Directory -Force .\output\releases | Out-Null
git archive --format=tar.gz --prefix=vikunja-mcp-0.2.1/ --output=output/releases/vikunja-mcp-0.2.1-source.tar.gz HEAD
if ($LASTEXITCODE -ne 0) { throw 'Source archive creation failed' }
$releaseHash = (Get-FileHash .\output\releases\vikunja-mcp-0.2.1-source.tar.gz -Algorithm SHA256).Hash.ToLowerInvariant()
"$releaseHash  vikunja-mcp-0.2.1-source.tar.gz" | Set-Content -Encoding ascii .\output\releases\vikunja-mcp-0.2.1-source.tar.gz.sha256
scp .\output\releases\vikunja-mcp-0.2.1-source.tar.gz .\output\releases\vikunja-mcp-0.2.1-source.tar.gz.sha256 user@server:~/
```

Back on the server, extract to a new directory, separate from the existing stack:

```bash
cd "$HOME"
sha256sum -c vikunja-mcp-0.2.1-source.tar.gz.sha256
# Choose a fresh directory; do not extract over an existing installation.
test ! -e vikunja-mcp-0.2.1 && tar -xzf vikunja-mcp-0.2.1-source.tar.gz
SOURCE_DIR="$HOME/vikunja-mcp-0.2.1"
docker build -t vikunja-mcp:0.2.1 "$SOURCE_DIR"
```

If adopting the backend extension, also build its production image:

```bash
docker build -f "$SOURCE_DIR/upstream/vikunja.Dockerfile" \
  -t vikunja-mcp-backend:2.7.1-atomic-fields.1 "$SOURCE_DIR"
```

Builds need internet access; the backend frontend/Go compilation also needs
sufficient memory and can take several minutes. Existing services can continue
running during builds. Use `upstream/vikunja.Dockerfile` for production;
`upstream/atomic-fields.Dockerfile` produces test binaries with an empty frontend.

## 4. Take a consistent data backup before a backend change

For an MCP-only update, the MCP has no database of its own; retain your normal
Vikunja backups. Before changing the backend, pause other writers and stop both
services. This begins the maintenance window:

```bash
dc stop "$MCP_SERVICE" "$BACKEND_SERVICE"
```

For **SQLite on bind mounts**, set the following paths from the mount inventory
in step 2. Back up the entire database directory, including any WAL files, and
the matching attachment directory:

```bash
DB_DIR='/actual/host/path/containing/vikunja.db'
FILES_DIR='/actual/host/path/containing/attachments'
test -d "$DB_DIR" && test -d "$FILES_DIR"
sudo tar -C "$DB_DIR" -cpf "$BACKUP_DIR/db.tar" .
sudo tar -C "$FILES_DIR" -cpf "$BACKUP_DIR/files.tar" .
sudo tar -tf "$BACKUP_DIR/db.tar" > /dev/null
sudo tar -tf "$BACKUP_DIR/files.tar" > /dev/null
```

For **named volumes**, use the actual volume names from the inventory. For example,
this backs up one stopped volume; run it once for the database volume and once
for the attachments, with different archive names:

```bash
VOLUME_NAME='actual-database-volume'
ARCHIVE_NAME='db.tar' # Use files.tar when backing up the attachments volume.
docker run --rm --user 0 --entrypoint tar \
  --mount "type=volume,source=$VOLUME_NAME,target=/backup-source,readonly" \
  --mount "type=bind,source=$BACKUP_DIR,target=/backup-output" \
  vikunja-mcp:0.2.1 -C /backup-source -cpf "/backup-output/$ARCHIVE_NAME" .
```

For **PostgreSQL or MySQL**, take a consistent native database backup and the
matching attachments while Vikunja is stopped. Copying an application directory
is not a database backup. Keep ownership/permissions and confirm both backups
are readable before continuing. Do not use `docker compose down -v`.

## 5. Merge the new settings into your existing Compose file

Edit the existing file in place. Preserve its ports, networks, environment,
volumes and reverse proxy settings. These are edits to the existing service,
not a complete replacement service definition:

```yaml
services:
  vikunja-mcp:
    image: vikunja-mcp:0.2.1
    pull_policy: never
    build:
      context: /absolute/path/to/vikunja-mcp-0.2.1
      dockerfile: Dockerfile
    environment:
      # Retain existing VIKUNJA_BASE_URL, VIKUNJA_TOKEN, VIKUNJA_MCP_API_KEY, etc.
      VIKUNJA_REQUIRE_ATOMIC_UPDATES: ${VIKUNJA_REQUIRE_ATOMIC_UPDATES:-0}
      VIKUNJA_MCP_ALLOWED_HOSTS: ${VIKUNJA_MCP_ALLOWED_HOSTS:?Set VIKUNJA_MCP_ALLOWED_HOSTS}
```

Add the values to the **server's existing** environment file. For an example MCP
URL of `http://mcp.example.com:9090/mcp`, its Host must be allowed. Replace this
example hostname with the one used by your clients:

```dotenv
VIKUNJA_REQUIRE_ATOMIC_UPDATES=0
VIKUNJA_MCP_ALLOWED_HOSTS=mcp.example.com:9090,127.0.0.1:9090,localhost:9090
```

If your actual client URL or internal `PORT` differs, adjust these values. Host
entries have no scheme or path and must match the Host received by MCP, including
any non-default port. For a reverse proxy, allow its actual forwarded Host too.
Native clients without an Origin header need no Origin setting. If a browser
client sends one, pass `VIKUNJA_MCP_ALLOWED_ORIGINS` through Compose as well and
set it to the exact HTTP(S) origin, for example `https://tasks.example.com`.
No wildcards or trailing slash. Merely adding a variable to `.env` does not pass
it into a container unless the Compose service references it or uses `env_file`.

For stock compatibility, use **`0`** (the default). Set **`1`** only when requiring
the optional atomic extension.
Use only `0` or `1`. Required mode on an unpatched backend makes readiness fail
and rejects the affected updates.

If changing the backend, merge these two fields into its existing service:

```yaml
services:
  vikunja:
    image: vikunja-mcp-backend:2.7.1-atomic-fields.1
    pull_policy: never
    build:
      context: /absolute/path/to/vikunja-mcp-0.2.1
      dockerfile: upstream/vikunja.Dockerfile
```

These image tags are built locally. `pull_policy: never` replaces any old
always-pull setting so Compose uses the images built in step 3.

The patched image runs as uid/gid **1000:1000**. Keep the current database type,
credentials, JWT secret and public URL. Ensure its configured database and file
paths still point to the existing mounts and are writable by uid 1000. Defaults
are `/db/vikunja.db` and `/app/vikunja/files`; map them deliberately if your old
image used different paths. Preserve mounted configuration and check any custom
`entrypoint`, `command` or healthcheck against the new image, which has no shell.
If the root filesystem is read-only, supply writable temporary storage at `/tmp`
(the example uses `tmpfs: ["/tmp:uid=1000,gid=1000,mode=1777"]`).

## 6. Recreate the services and update backend token permissions

Validate the edited configuration without printing resolved secrets:

```bash
dc config --quiet
```

For a backend upgrade, bring it up first and repeat the version check from
step 1 after starting MCP, or check its public `/api/v1/info` directly. Expect
`2.7.1+atomic-fields.1` and numeric `atomic_field_updates: 1`:

```bash
dc up -d --no-deps --no-build "$BACKEND_SERVICE"
dc logs --tail 50 "$BACKEND_SERVICE"
```

In the existing Vikunja UI, create a replacement API token with the previous
tool permissions **plus** the POST permissions **`tasks.fields`**,
**`projects.fields`** and **`labels.fields`**. Retain project-read permission for
readiness. Save it as `VIKUNJA_TOKEN` in the server environment/configuration and
ensure the Compose service passes that value through. Keep the old token until
verification succeeds. This is the backend token; **keep the MCP shared key
`VIKUNJA_MCP_API_KEY` unchanged** so clients can keep connecting.

For an already-patched backend, only replace its token if the required scopes
are missing. Stock compatibility mode does not have the new fields scopes.
Then recreate MCP:

```bash
dc up -d --no-deps --no-build "$MCP_SERVICE"
dc ps
dc logs --tail 50 "$MCP_SERVICE"
```

Compose [`up`](https://docs.docker.com/reference/cli/docker/compose/up/) recreates
services when their image or configuration changes. `--no-deps` limits this
operation to the named service and `--no-build` uses the images already built.
`docker compose restart` alone does not apply a new image or environment.

The production backend includes its corresponding source at
`/source/vikunja-2.7.1-atomic-fields.1.tar.gz`; make this link available to users
of the hosted build. See [backend build details](../upstream/README.md).

## 7. Verify before reopening access

Run the supplied read-only check inside the MCP container. It uses the
container's existing credentials without printing them:

```bash
dc exec -T -e VIKUNJA_VERIFY_HOST=mcp.example.com:9090 "$MCP_SERVICE" \
  node --input-type=module < "$SOURCE_DIR/scripts/check-deployment.mjs"
```

Adjust `VIKUNJA_VERIFY_HOST` to match the actual client Host. Expect `ok: true`,
MCP version **0.2.1**, **42** tools, a matching schema fingerprint, authenticated
readiness and a successful upstream read. Required mode also checks atomic
protocol **1**. A compatibility-mode success reports `atomicRequired: false`;
it does not demonstrate the backend concurrency fix. This check performs no writes.
It checks Host acceptance inside the container; it cannot prove the external
firewall, proxy or client network path works.

Reconnect/reload the **existing** MCP entry in Codex or Claude to refresh its
tool schemas, keeping its URL and key. Ask for a project list and read a known
task. In a disposable test project, then verify create/edit/read-back, description
clearing, completion and an attachment upload/download. Confirm a known existing
attachment still downloads, and remove the disposable objects afterward.
Readiness cannot verify every write permission, so complete these write checks
before considering the rollout finished. Do not automatically retry uncertain
write outcomes; read back the object first.

The AI skill lives on the client, separately from Docker. The source bundle
contains `skills/vikunja-mcp/`; see [skill setup](ai-skill.md) if that client also
needs the skill installed or updated.

## 8. Rollback

For an **MCP-only rollback**, stop MCP, restore the original Compose/environment
files to their original paths (and restore any original overrides), then use the
saved image tag. Create a small override in the backup directory:

```bash
dc stop "$MCP_SERVICE"
cp -- "$BACKUP_DIR/compose.before.yml" "$COMPOSE_FILE"
cp -- "$BACKUP_DIR/env.before" "$ENV_FILE"
cat > "$BACKUP_DIR/rollback-mcp.yml" <<EOF
services:
  $MCP_SERVICE:
    image: vikunja-mcp:rollback-$STAMP
    pull_policy: never
EOF
docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" -f "$BACKUP_DIR/rollback-mcp.yml" \
  up -d --no-deps --no-build "$MCP_SERVICE"
```

Include the original override files before `rollback-mcp.yml` if applicable.
MCP rollback does not require restoring the database.

For a **backend rollback**, stop every writer and both services first. Retain
the current database/files before restoring anything. If a database restore is
needed, restore the database and attachments from the same pre-upgrade backup,
with correct ownership, then restore the original configuration and recreate
the backend using `vikunja-mcp-backend:rollback-$STAMP` in an equivalent override.
Do not downgrade a migrated database in place. Restoring the backup discards
changes made after it, so assess those before proceeding. Verify a known task
and attachment before restarting MCP and reopening access.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| HTTP 401 from MCP | Preserve the existing MCP key and client `X-API-Key`; do not substitute the backend token. |
| HTTP 403 from MCP | Match the received Host and, when present, Origin to the exact allowlists. |
| `/healthz` succeeds but `/readyz` fails | Liveness only proves the process runs. Check backend reachability, token project-read scope and required atomic support. |
| Edits return 403 while reads succeed | Grant the relevant `tasks.fields`, `projects.fields` or `labels.fields` POST permission on the backend token. |
| Atomic support appears missing after backend replacement | Confirm `/api/v1/info` advertises numeric `1`, then recreate MCP to clear cached discovery. |
| Backend opens an empty account/task list | Stop and inspect project name, database configuration and mounts; do not create new data over an unintended empty database. |
| Backend reports permission errors | Check uid 1000 access to the actual existing database/files mounts and writable `/tmp`. |
| Existing remote clients cannot connect | Preserve server port bindings, networks and proxy routes. The local example binds to loopback and is not a replacement for your remote deployment. |
| Tools reject old arguments | Refresh client schemas. Inputs are strict; `set_task_position` requires `projectViewId`; dates need explicit offsets; `percentDone` input is 0–100. |
| Local file upload no longer works | Arbitrary server paths are disabled. Configure `VIKUNJA_UPLOAD_DIRECTORY` with a dedicated mounted import directory, or use base64 within the size limit. |

## Evidence and limits

The local deployment was tested through all 42 tools, including task/label/project
lifecycle, field edits, relations, comments, scheduling, assignments, attachments
and persistence after container recreation. The reviewed production backend also
passed permission, stale-snapshot and source/frontend checks. See
[verification evidence](atomic-verification.json) and
[local deployment results](local-deployment.md).
This guide and bundle do not constitute a test of your remote server; no remote
deployment or existing client connection was changed while preparing them.
