# Local Docker deployment

Use `docker-compose.example.yml` together with `docker-compose.local.yml` for a
local development stack. The override uses a separate Compose project and
loopback URLs. Both services publish ports only on the local machine.

| Item | Example value |
| --- | --- |
| Docker Compose project | `vikunja-local` |
| Vikunja web interface | <http://127.0.0.1:3456/> |
| MCP endpoint | `http://127.0.0.1:9090/mcp` |
| MCP client connection name | `vikunja-local` |
| MCP version | `0.2.1` |
| Backend version | Official unpatched `2.7.1` by default; atomic extension optional |
| Database directory | `data/vikunja/db` |
| Attachment directory | `data/vikunja/files` |
| Service secrets | `.env` (private; ignored by Git) |

These commands manage an already configured local stack. Create `.env` from
`.env.example`, replace every placeholder secret, and provision a Vikunja account
and scoped API token before using MCP. Account credentials and any client-config
backups must stay in private storage outside the source checkout. On Windows,
use a restricted directory under `%LOCALAPPDATA%\vikunja-mcp\private` or your
credential manager. Keep only the ignored runtime `.env`, database and
attachments in the checkout, and restrict their filesystem permissions.
Disable registration after provisioning. Set `VIKUNJA_USER_*` to the account's
identity if the token cannot read `/user`; the override's identity defaults are
examples, not provisioned account credentials.

The services run with non-root users, read-only roots and dropped Linux
capabilities. Containers use `restart: unless-stopped`; Docker must be running.

Run these commands from the repository root. Include both Compose files and the
project name so the commands address the intended local stack.

```powershell
# Start/recover the configured local deployment.
docker compose --project-name vikunja-local --env-file .env -f docker-compose.example.yml -f docker-compose.local.yml up -d

# Inspect services without printing secrets.
docker compose --project-name vikunja-local --env-file .env -f docker-compose.example.yml -f docker-compose.local.yml ps

# Stop services, retaining their database and attachments.
docker compose --project-name vikunja-local --env-file .env -f docker-compose.example.yml -f docker-compose.local.yml stop
```

For an update, take the cold database/files backup described in the
[project README](../README.md#persistent-docker-deployment-and-backups), then use
the same start command with `--build` added. Preserve `.env`, private credentials
and both persistent directories.

The 2.7.1 backend includes upstream security fixes and token-permission/database
migrations from 2.7.0. Take the backup before first starting the new image; an
image rollback alone is not a database rollback. See the
[server upgrade instructions](server-upgrade.md).

Configure your MCP client with the loopback `/mcp` URL and an `X-API-Key` header
matching `VIKUNJA_MCP_API_KEY`. Store the key in the client's protected
configuration. Use a distinct connection name when keeping both local and remote
instances, and reload the intended connection after changing its configuration.

Automated verification checks the 42-tool catalogue, selected task/project/label
writes, description clearing, scoped-token denial, and database/attachment
persistence after container recreation. Regression and native integration suites
also cover authentication, schemas, dates, recurrence, reminders, assignments,
relations and attachments. See [verification evidence](atomic-verification.json).
These checks use disposable instances and do not certify an existing deployment.
Private deployment logs and account details are not included in this repository.
