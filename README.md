# vikunja-mcp

HTTP MCP server for Vikunja task management. It exposes Vikunja projects, tasks,
labels, comments, relations, reminders, assignees, and attachments to MCP
clients through a Streamable HTTP endpoint.

42 Tools - Streamable HTTP - Docker ready

## Tools

Tools are grouped by the Vikunja objects they operate on. Read tools return
compact, normalized JSON so agents do not need to reason over the full Vikunja
API response shape. Mutating tools call the Vikunja API with the configured
token and return the updated or affected object whenever Vikunja provides one.

### Connection

| Tool | Description |
| --- | --- |
| `vikunja_health` | Verifies that the configured Vikunja API token and base URL work. |
| `get_current_user` | Fetches the Vikunja user associated with the configured API token, with configured/token-owner fallbacks when `/user` is not in scope. |

### Projects

| Tool | Description |
| --- | --- |
| `list_projects` | Lists projects available to the current token, with optional search and pagination. |
| `get_project` | Fetches one project by numeric id. |
| `create_project` | Creates a new project. |
| `update_project` | Updates selected project fields. |
| `delete_project` | Deletes a project. |

### Tasks

| Tool | Description |
| --- | --- |
| `list_tasks` | Lists tasks, with optional search, pagination, project filtering, and done-task inclusion. |
| `get_task` | Fetches one task by numeric id, with optional Vikunja `expand` values. |
| `get_task_by_identifier` | Fetches one task by human-facing identifier such as `PROJ-123`. |
| `create_task` | Creates a task in a project. |
| `update_task` | Applies selected task fields through the atomic field-update API; `percentDone` uses 0 to 100. |
| `delete_task` | Deletes a task. |
| `complete_task` | Marks a task as done. |
| `move_task_to_project` | Moves a task by updating its `project_id`. |
| `set_task_due_date` | Sets or clears a task due date. |
| `set_task_repeat` | Sets task repeat settings. |
| `set_task_position` | Sets manual ordering in a required `projectViewId` and returns the persisted position. |
| `set_task_reminders` | Replaces the reminders on a task. |

### Labels

| Tool | Description |
| --- | --- |
| `list_labels` | Lists labels available to the current token, with optional search and pagination. |
| `create_label` | Creates a new label. |
| `update_label` | Updates an existing label. |
| `delete_label` | Deletes a label. |
| `list_task_labels` | Lists labels associated with a task. |
| `add_task_label` | Associates an existing label with a task. |
| `remove_task_label` | Removes a label from a task. |
| `replace_task_labels` | Replaces the effective label set on a task using Vikunja's bulk update endpoint. |

### Relations and subtasks

| Tool | Description |
| --- | --- |
| `list_task_relations` | Inspects related tasks grouped by relation kind. |
| `create_task_relation` | Creates a relation between two tasks. |
| `remove_task_relation` | Removes a relation between two tasks. |
| `create_subtask_relation` | Marks one task as a subtask of another. |
| `remove_subtask_relation` | Removes the subtask relation between a parent task and subtask. |
| `list_subtasks` | Lists subtasks using Vikunja task expansion, falling back to related tasks when needed. |

Relation kinds accepted by the generic relation tools:

`subtask`, `parenttask`, `related`, `duplicateof`, `duplicates`, `blocking`,
`blocked`, `precedes`, `follows`, `copiedfrom`, `copiedto`

### Comments

| Tool | Description |
| --- | --- |
| `list_task_comments` | Lists comments on a task. |
| `add_task_comment` | Adds a comment to a task. |
| `update_task_comment` | Updates an existing task comment. |
| `delete_task_comment` | Deletes a task comment. |

### Assignees

| Tool | Description |
| --- | --- |
| `list_task_assignees` | Lists assignees on a task. |
| `set_task_assignees` | Replaces the assignee set on a task. |

### Attachments

| Tool | Description |
| --- | --- |
| `list_task_attachments` | Lists attachments on a task. |
| `upload_task_attachment` | Uploads base64 content or a file from an explicitly configured import directory; returns successes and failures. |
| `delete_task_attachment` | Deletes a task attachment. |

## Transport and endpoints

The server runs Streamable HTTP MCP over Express.

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | Handles MCP JSON-RPC requests. |
| `GET /healthz` | Returns a simple HTTP health payload. |
| `GET /readyz` | Authenticated upstream connectivity check; returns 503 if Vikunja is unavailable. |

Every MCP request must include the configured API key:

```http
X-API-Key: your_mcp_api_key
```

Requests without a matching key receive a JSON-RPC unauthorized response.

MCP requests use uncompressed JSON. Compressed request bodies are rejected with
HTTP 415 before decompression; the JSON body limit remains 1 MB.
`/mcp` only accepts `POST`; other methods return method-not-allowed.
Host headers must match the configured allowlist. If an Origin header is present,
it must match an allowed origin. These checks and authentication run before JSON
parsing. `/healthz` reports process liveness without exposing the upstream URL.

## Environment

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VIKUNJA_TOKEN` | Yes | - | Vikunja API token used as `Authorization: Bearer ...` for upstream requests. |
| `VIKUNJA_MCP_API_KEY` | Yes | - | Shared secret required from MCP clients in the `X-API-Key` header. |
| `VIKUNJA_BASE_URL` | No | `http://vikunja:3456` | Vikunja root URL or full `/api/v1` URL. |
| `VIKUNJA_API_URL` | No | - | Backwards-compatible alternative to `VIKUNJA_BASE_URL`. |
| `VIKUNJA_TIMEOUT_MS` | No | `10000` | Upstream Vikunja request timeout in milliseconds. |
| `VIKUNJA_REQUIRE_ATOMIC_UPDATES` | No | `1` | Require the reviewed backend extension for affected mutations and readiness. Explicit `0` enables stock compatibility with the limits below. |
| `PORT` | No | `9090` | HTTP port for this MCP server. |
| `HOST` | No | `127.0.0.1` | HTTP bind host; the Docker image explicitly uses `0.0.0.0`. |
| `VIKUNJA_MCP_ALLOWED_HOSTS` | No | `localhost:9090,127.0.0.1:9090,[::1]:9090` | Exact allowed Host headers; default ports follow `PORT`. |
| `VIKUNJA_MCP_ALLOWED_ORIGINS` | No | HTTP origins for allowed hosts | Comma-separated exact HTTP(S) origins; no wildcards or URL paths. |
| `VIKUNJA_UPLOAD_DIRECTORY` | No | Disabled | Existing operator-controlled directory for local file imports. |
| `VIKUNJA_MAX_UPLOAD_BYTES` | No | `524288` | Maximum decoded bytes per attachment, including local files. |
| `VIKUNJA_MCP_MAX_CONCURRENT_REQUESTS` | No | `32` | Concurrent MCP request limit; excess requests receive 503 and Retry-After. |
| `VIKUNJA_MCP_VALIDATE_ONLY` | No | - | Set to `1` to validate configuration and exit without starting HTTP. |
| `VIKUNJA_USER_ID` | No | - | Optional current-user fallback when the token can use task endpoints but cannot call `/user`. |
| `VIKUNJA_USERNAME` | No | - | Optional username returned with the fallback current-user identity. |
| `VIKUNJA_USER_NAME` | No | - | Optional display name returned with the fallback current-user identity. |
| `VIKUNJA_USER_EMAIL` | No | - | Optional email returned with the fallback current-user identity. |

`VIKUNJA_BASE_URL` and `VIKUNJA_API_URL` can be either the Vikunja root URL or a
full `/api/v1` URL. The server normalizes root URLs by appending `/api/v1`.
URLs must use HTTP(S) and contain no credentials, query or fragment. Explicitly
invalid port, timeout and byte-limit settings fail startup; omitted settings use
the documented defaults. The timeout range is 1 to 300000 ms and the upload limit
range is 1 to 52428800 bytes. The incoming JSON body limit remains 1 MB, so larger
files need the optional local import mechanism.

`get_current_user` first calls Vikunja's `/user` endpoint. If a scoped API token
can perform task CRUD but does not have access to `/user`, the server falls back
to `VIKUNJA_USER_*` values and then to `/tokens` owner metadata when available.
Unset optional identity fields and literal `undefined`/`null` placeholders are
omitted from the configured fallback. The local Compose override leaves email
unset unless an actual address is provided.

## Running locally

Install dependencies and build the TypeScript source:

```bash
npm ci
npm run build
```

Run the built server:

```bash
VIKUNJA_TOKEN=your_token \
VIKUNJA_MCP_API_KEY=your_mcp_api_key \
npm start
```

On PowerShell:

```powershell
$env:VIKUNJA_TOKEN = "your_token"
$env:VIKUNJA_MCP_API_KEY = "your_mcp_api_key"
npm start
```

Validate configuration without starting the HTTP server:

```bash
VIKUNJA_TOKEN=your_token \
VIKUNJA_MCP_API_KEY=your_mcp_api_key \
npm run validate
```

## Docker

Build the image:

```bash
docker build -t vikunja-mcp .
```

Run it next to a Vikunja container on the same Docker network:

```bash
docker run --rm -p 9090:9090 \
  -e VIKUNJA_TOKEN=your_token \
  -e VIKUNJA_MCP_API_KEY=your_mcp_api_key \
  vikunja-mcp
```

When the container can resolve the Vikunja service as `http://vikunja:3456`,
the default `VIKUNJA_BASE_URL` works. If your Vikunja container has a different
service name or runs outside the Docker network, set `VIKUNJA_BASE_URL`
explicitly.

The repository includes a compose example:

```bash
docker compose -f docker-compose.example.yml up --build
```

## MCP client configuration

Example VS Code MCP configuration:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "vikunja-mcp-key",
      "description": "Vikunja MCP API key",
      "password": true
    }
  ],
  "servers": {
    "vikunja": {
      "type": "http",
      "url": "http://127.0.0.1:9090/mcp",
      "headers": {
        "X-API-Key": "${input:vikunja-mcp-key}"
      }
    }
  }
}
```

For remote use, put this server behind a TLS reverse proxy such as Caddy,
Nginx, or Traefik and configure the client with the HTTPS `/mcp` URL.
Set `VIKUNJA_MCP_ALLOWED_HOSTS=mcp.example.com` for the Host header forwarded by
that proxy, and `VIKUNJA_MCP_ALLOWED_ORIGINS=https://client.example.com` for any
browser clients. Requests from native clients without an Origin remain supported.

## Safety model

- The MCP API key protects the MCP endpoint from unauthenticated clients.
- The Vikunja token controls the actual upstream permissions. Use a token with
  the narrowest permissions that fit your workflow.
- Removal and replacement tools carry destructive annotations. These inform
  clients and do not enforce permission or confirmation by themselves.
- A shared queue serializes task, project and label edits within one server
  process. The default backend applies only explicitly requested fields inside
  its update transaction, preserving unrelated edits from independent writers.
- On stock Vikunja, the v1 updater also handles reminders, assignees and favorites, so those
  values are retained from the current task. Project, label and reminder writes
  still use replacement semantics. Coordinate these writes with other MCP
  processes and the Vikunja UI; the v1 API has no atomic conditional-write
  contract for them. A local queue cannot protect against an external writer.
- Local-file uploads are disabled unless `VIKUNJA_UPLOAD_DIRECTORY` is set.
  Relative paths resolve inside that directory. Traversal, symbolic links,
  hard links, directories and oversized files are rejected. Keep the directory
  writable only by the trusted operator and mount it read-only in containers.
  Base64 input must be valid padded base64; provide exactly one upload source.
- Upload results contain `attachments`, `errors` and `partialSuccess`. A response
  with no successful attachments is a tool error, including HTTP 200 responses
  containing per-file failures. Avoid automatic write retries after timeouts.

## Supported API and migration notes

The default deployment targets **Vikunja 2.7.1+atomic-fields.1** and Node.js 24 LTS.
It uses the existing v1 API and dedicated v2 atomic field-update routes. Scoped
API tokens need `projects.fields`, `tasks.fields` and `labels.fields` for the
corresponding edits, plus read and subresource permissions used by their tools.
The separate stock 2.7.1 integration suite verifies explicit compatibility mode
(`VIKUNJA_REQUIRE_ATOMIC_UPDATES=0`). Stock scalar task updates require
`POST /tasks/bulk`; there is no fallback to a full-object scalar task write when
that endpoint is missing. Older releases are not assumed compatible.

`set_task_position` now requires `projectViewId`. `percentDone` accepts 0 to 100
and is converted to the upstream 0 to 1 scale; task responses retain that upstream
`percent_done` fraction. Task filters are applied upstream before pagination.
Missing pagination headers remain unknown rather than being reported as zero.
Supported `expand` values are `subtasks`, `buckets`, `reactions`, `comments`,
`comment_count`, `time_entries_count` and `is_unread`; their data is retained in
task responses. Other names fail validation.
Scoped tokens additionally need `reactions.read_all` for reactions,
`time_entries.read_all` for time-entry counts, and `tasks_comments.read_all` for
comments or comment counts. Missing expansion scopes can return HTTP 401 even
when a basic task read works.

Task-label listing compensates for the upstream v1 handler ignoring `per_page`:
MCP reads native pages without that parameter, then applies the requested page
size and reports stable totals. This scan is bounded to 100 native pages and
rejects repeated IDs or inconsistent pagination rather than claiming a complete
label set. Other list endpoints continue to use upstream pagination.

Version **0.2.0** rejects unknown arguments on every tool. Patch tools require at
least one supported edit; an already-persisted value is still a valid no-op.
Datetime inputs accept RFC3339 UTC offsets and normalize them to UTC. A date-only
or local clock time without an offset is rejected.

`set_task_reminders` accepts at most 100 items. Each item is either
`{ "reminder": "2026-11-01T09:00:00+01:00" }` or
`{ "relativeTo": "due_date", "relativePeriodSeconds": -900 }`.
Relative reminders require the task's base date to be set; negative seconds mean
before the base. The relative offset is bounded to ten years in either direction.
The collection is replaced in full; `[]` clears it.

Prefer the named `set_task_repeat` modes: `none`, `monthly`, `interval` or
`fromCompletion`. The last two require a positive `repeatAfterSeconds`, at most
315360000 (ten years). The first two accept an omitted or zero interval. Legacy
numeric `repeatMode` remains supported and cannot be combined with `mode`.
Setting a zero interval without an explicit monthly mode now disables repetition,
including on an already-monthly task. Completing a repeating task may reschedule
and reopen it; inspect the returned state before reporting completion.

Vikunja 2.7.1 does not persist an empty project description over an existing
non-empty value. Such `update_project` requests now fail before writing any
fields, rather than claiming success. The default backend extension below adds
an explicit field-scoped clear operation.
Task identifier lookup accepts numeric-leading and encoded project prefixes.
Purely numeric or dot project identifiers are resolved through project listing
(including archived projects) to avoid the API confusing an identifier with an ID.
That fallback requires project-list permission and stops after 100 pages; use the
numeric task ID if it cannot resolve the project.

Paginated list results include `pageItemCount`, `page`, optional
`requestedPerPage`, and `completeness` (`complete`, `partial` or `unknown`).
Completeness describes this response's coverage of the matching result set: the
last page of a multi-page set is still only partial coverage. With a consistent
total-page header, `hasMore` and optional `nextPage` identify continuation.
`requestedPerPage` is the requested size, which the backend may cap. Legacy
`resultCount` retains the raw header for compatibility; it is **not** a total
match count. Tools without paging controls do not infer completeness from it.

The reviewed public MCP schemas and their fingerprint are saved in
[`docs/tool-contract.json`](docs/tool-contract.json). `npm test` compares the
runtime catalogue to that snapshot and the server version to package.json.
After intentionally reviewing a schema change, run `npm run tool-contract:update`.
When deploying 0.2.x, refresh/reconnect clients and compare their advertised tools
with this snapshot. A checked-in contract cannot refresh an existing host cache.

## Atomic field-update extension (0.2.1)

The reviewed companion [Vikunja patch](upstream/vikunja-2.7.1-atomic-fields.patch)
addresses F03 across independent MCP clients and edits committed by other clients
between the MCP read and write. Its [source manifest](upstream/vikunja-2.7.1-atomic-fields.json)
pins upstream commit `5619c4a9f66ddfc13f7bbba24ada07c3e82ae7a0`, the source archive
digest, the patch digest and each changed file. The patch preserves upstream's
AGPL license notices. The extension is adopted by the project's default Compose
deployment; no existing user deployment has been changed or upstream submission
made. The production [build instructions](upstream/README.md) describe the full
frontend/API image and its corresponding-source download.

A patched backend advertises `atomic_field_updates: 1` from `/api/v1/info`.
The MCP server discovers that once per process and uses the dedicated v2
`POST /tasks/{id}/fields`, `/projects/{id}/fields` and `/labels/{id}/fields` routes.
Each write names only its explicitly requested fields, including values which
matched the initial read, and the backend ignores stale values
for all other columns and collections. Normal permissions and domain side effects
(such as recurring completion and relative reminders) remain in the backend.
A missing, denied or failed field-update route is an error; it is never retried
as an unsafe replacement. Scoped tokens need the corresponding `fields` POST
permissions in addition to their existing read permissions.

`VIKUNJA_REQUIRE_ATOMIC_UPDATES` defaults to **1**, including in Compose. Affected
mutations and authenticated readiness fail when protocol 1 is absent. Explicit
`0` opts into stock 2.7.1 compatibility and its documented F03 limits; those
limits are not fixed on an unpatched backend. This default changes the behavior
of existing installations that omit the variable: upgrade the backend first,
grant the token the `fields` permissions, then restart the MCP process so
discovery runs again. Check authenticated `/readyz` before opening access.

Run `npm run test:atomic` with Docker available to reproduce the complete proof.
It verifies the source and patch digests, builds unpatched and patched backends,
runs upstream model/HTTP regressions, and runs the same external-write assertions
through MCP against each. Stock 2.7.1 already fixes the scalar task collection
overwrite from 2.7.0; the unpatched control must still exhibit the three reminder,
project and label replacement failures. The patched suite must pass in required-atomic mode. Test
artifacts and logs are left under `.tmp/atomic-proof`. The exported backends use
a placeholder frontend and are test binaries, not deployment images.
`npm run test:stack` separately builds the production frontend/API and MCP images
and verifies the actual Compose services with a new database, fake credentials,
random loopback ports and an isolated project name. It checks the source
download, scoped-token field writes and denial, unrelated-field preservation,
and persistence after container recreation. It never reads `.env` or starts the
default Compose project. Logs and fresh test data remain in `.tmp/stack-proof`.

The field mask preserves unrelated fields. Two callers intentionally replacing
the same collection still express conflicting writes; this protocol is not a
revision-based compare-and-swap API. A legacy client that later submits its own
stale full replacement can still overwrite newer values; it must also use scoped
updates or coordinate its writes. SQLite still requires write transactions to
be serialized. The two-process regression uses stale snapshots followed by
ordered commits to isolate lost updates from unsupported overlapping SQLite
transactions. Timed-out writes are never automatically retried.

## Persistent Docker deployment and backups

For an existing server, follow the [Docker Compose upgrade guide](docs/server-upgrade.md).
It covers preserving the current connection and data, adopting the backend
extension, verifying the result and rolling back.

The Compose example builds the pinned Vikunja 2.7.1+atomic-fields.1 extension,
including its full frontend, exposes both ports on loopback, and keeps
the SQLite file set in `data/vikunja/db` and attachments in `data/vikunja/files`.
Before first startup on Linux, create these directories and give uid 1000 write
access. Docker Desktop users should also verify that both bind mounts are writable
by the container. Copy `.env.example` to `.env` and replace every placeholder.
Start only Vikunja with `docker compose -f docker-compose.example.yml up -d --build vikunja`,
register the initial user through its local UI, and create the scoped API token.
Replace `VIKUNJA_TOKEN` in `.env`, then start both services. The MCP container runs as the `node` user,
with a read-only filesystem and no Linux capabilities. The backend also runs as
uid 1000 with a read-only root and a temporary `/tmp`; persistent writes use the
database and attachment mounts. For an existing installation, stop writers and
take the cold backup described below before rebuilding and recreating services.
The field extension adds no migrations beyond the pinned 2.7.1 release.
Upgrading from 2.7.0 also applies upstream's 2.7.1 database and token-permission
migrations. Preserve the cold backup for rollback; an old image alone cannot
undo those migrations.

For a cold backup, stop **both** Compose services, copy the complete
`data/vikunja/db` and `data/vikunja/files` directories to a dated backup, then
restart. Copy the entire database directory, including any SQLite WAL files.
To restore, stop both services, retain a copy of the current directories, restore
both directories from the same backup, verify uid 1000 access, and start the
services. Check a known task and download a known attachment before opening
access. Container recreation alone must not remove these host directories;
database and attachment backups must be retained together. The integration suite
exercises a cold restore in a disposable directory.

## AI skill for Codex and Claude Code

The reusable [`vikunja-mcp` skill](skills/vikunja-mcp/SKILL.md) teaches the agent
how to combine the existing tools for task capture, focused edits, project
reviews, scheduling and collection changes. It uses the selected MCP connection
and its live schemas, handles pagination and uncertain writes, and includes no
credentials or connection changes. See the [usage and validation guide](docs/ai-skill.md)
for installation locations and invocation examples for both hosts.

## Development

Project layout:

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Server entry point, config parsing, Vikunja API wrapper, tool registration, and HTTP transport. |
| `src/config.ts` | Validated environment and transport allowlists. |
| `src/uploads.ts` | Bounded attachment decoding and restricted local imports. |
| `src/updates.ts` | Shared per-object update queues. |
| `src/atomic-updates.ts` | Field-update discovery, dedicated route calls and required-support policy. |
| `src/tool-inputs.ts` | Strict input, scheduling and semantic reminder/repeat validation. |
| `src/pagination.ts` | Page counts, continuation and explicit completeness. |
| `docs/tool-contract.json` | Reviewed public tool schemas, release and fingerprint. |
| `upstream/` | Reviewed backend patch, pinned provenance, full production build and isolated proof build. |
| `test/` | Regression tests and disposable real-API integration tests. |
| `Dockerfile` | Multi-stage Node 24 image, installed from the lockfile, running as a non-root user. |
| `docker-compose.example.yml` | Minimal Vikunja plus MCP sidecar example. |
| `package.json` | Scripts, dependencies, and Node engine requirement. |
| `tsconfig.json` | TypeScript compiler configuration. |

Useful commands:

```bash
npm run build
npm test
npm run test:integration
npm run test:container
npm run test:atomic
npm run test:stack
npm audit --audit-level=moderate
npm run validate
npm start
```

`npm test` runs the build and local mock-server regression suite. The integration
command downloads the pinned official Vikunja binary, verifies its SHA256 digest,
and starts it with a fresh temporary database. Windows x64 and Linux x64 are
supported automatically; set `TEST_VIKUNJA_BINARY` to an existing 2.7.1 binary on
other platforms. It never targets your running Vikunja instance. CI runs both
suites on Linux and Windows and builds and smoke-tests the production container.
Request logs include a generated request ID, method, tool name, HTTP status and
duration, without input arguments or credentials. See
[`docs/audit-remediation.md`](docs/audit-remediation.md) for the finding-to-test map.

## License

The MCP server, documentation and AI skill are licensed under the
[MIT License](LICENSE), except for the files in `upstream/`.

The files in `upstream/`, including the Vikunja backend patch and build wrappers,
are licensed under [AGPL-3.0-or-later](upstream/LICENSE). The patched Vikunja
backend retains its upstream copyright and license notices. When distributing
or hosting that backend, provide its corresponding source as described in the
[backend guide](upstream/README.md). Third-party dependencies retain their own
licenses.
