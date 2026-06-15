# vikunja-mcp

MCP server for Vikunja packaged to run locally or as a Docker sidecar next to a Vikunja container.

## Environment

- `VIKUNJA_TOKEN` required
- `VIKUNJA_BASE_URL` optional, defaults to `http://vikunja:3456`
- `VIKUNJA_TIMEOUT_MS` optional, defaults to `10000`
- `VIKUNJA_MCP_VALIDATE_ONLY=1` optional, validates config and exits

`VIKUNJA_BASE_URL` may be either the Vikunja root URL or a full `/api/v1` URL.

## Local usage

```bash
npm install
npm run build
node dist/index.js
```

## Local config validation

```bash
npm install
npm run validate
```

## Docker build

```bash
docker build -t vikunja-mcp .
```

## Docker run

When the container runs on the same Docker network as the `vikunja` service, the default base URL works without extra changes.

```bash
docker run --rm -i \
  -e VIKUNJA_TOKEN=your_token \
  --network your_compose_network \
  vikunja-mcp
```

If your Vikunja container uses a different service name, set `VIKUNJA_BASE_URL` explicitly.

## Compose example

See [docker-compose.example.yml](/D:/projs/vikunja-mcp/docker-compose.example.yml).
