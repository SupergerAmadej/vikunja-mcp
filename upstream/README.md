# Patched production backend

The files in this directory, including the backend patch and build wrappers,
are licensed under [AGPL-3.0-or-later](LICENSE). Vikunja retains its upstream
copyright and license notices; the repository's root MIT license does not
replace these terms.

`vikunja.Dockerfile` builds Vikunja **2.7.1+atomic-fields.1** with its complete
frontend and API. The Compose example uses this image by default. The original
archive, patch and changed files are verified against the adjacent manifest
before compilation. Both build images are pinned by digest; frontend and Go
dependencies use the upstream lockfiles. The container runs as uid/gid 1000.

Build from the repository root:

```sh
docker build -f upstream/vikunja.Dockerfile -t vikunja-mcp-backend:2.7.1-atomic-fields.1 .
```

The build needs network access and enough memory for the upstream frontend and
Go compiler. It does not read `.env`, local data or the running deployment.
The image embeds its corresponding patched source, original AGPL license and
build wrapper. The source is available from the running backend at
`/source/vikunja-2.7.1-atomic-fields.1.tar.gz`; make that link available to users
when distributing or hosting this build. The archive contains upstream source,
lockfiles, license notices and this `upstream/` directory; the same command
rebuilds it from the verified original inputs. A custom deployment under a URL
prefix serves this path beneath that prefix.

`atomic-fields.Dockerfile` is a separate **test-only** differential build. Its
empty frontend must never be used for deployment. `npm run test:atomic` compares
unpatched and patched backends, including upstream permission tests. Run
`npm run test:stack` to build the production images and verify a disposable
Compose stack, including frontend assets, the source download, scoped-token
field updates and persistence after container recreation.

For an existing deployment, stop writers and take a cold backup of the complete
database and attachment directories before switching images. This patch adds no
database migrations beyond stock 2.7.1. Rebuild the backend, grant the MCP token
the relevant `fields` POST permissions, and restart the MCP process. Keep
`VIKUNJA_REQUIRE_ATOMIC_UPDATES=1` (the default). Authenticated `/readyz` must
succeed and `/api/v1/info` must advertise `atomic_field_updates: 1` before use.

Upgrading an existing 2.7.0 backend applies upstream's 2.7.1 migrations, including
token-permission changes. Preserve the cold backup and both old images for a
full rollback; do not assume an image-only downgrade can undo a database upgrade.
