# vikunja-mcp

HTTP MCP server for Vikunja packaged to run locally or in Docker.

## Environment

- `VIKUNJA_TOKEN` required
- `VIKUNJA_MCP_API_KEY` required for incoming MCP requests
- `VIKUNJA_BASE_URL` optional, defaults to `http://vikunja:3456`
- `PORT` optional, defaults to `9090`
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
docker run --rm -p 9090:9090 \
  -e VIKUNJA_TOKEN=your_token \
  -e VIKUNJA_MCP_API_KEY=your_mcp_api_key \
  vikunja-mcp
```

If your Vikunja container uses a different service name, set `VIKUNJA_BASE_URL` explicitly.

## Endpoints

- `POST /mcp` handles MCP requests
- `GET /healthz` returns a simple health payload

Every MCP request must send:

```http
X-API-Key: your_mcp_api_key
```

## VS Code MCP config

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

For a real HTTPS endpoint, place this container behind a reverse proxy such as Caddy, Nginx, or Traefik and point VS Code at `https://.../mcp`.

## Compose example

See [docker-compose.example.yml](/D:/projs/vikunja-mcp/docker-compose.example.yml).
