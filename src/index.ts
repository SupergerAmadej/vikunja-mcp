import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod/v4";

type JsonRecord = Record<string, unknown>;

const DEFAULT_BASE_URL = "http://vikunja:3456";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PORT = 9090;
const DEFAULT_BIND_HOST = "0.0.0.0";

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function requireEnv(name: string): string {
  return getRequiredEnv(name);
}

function getBaseApiUrl(): string {
  const baseUrl =
    process.env.VIKUNJA_BASE_URL?.trim() ||
    process.env.VIKUNJA_API_URL?.trim() ||
    DEFAULT_BASE_URL;
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  if (normalizedBaseUrl.endsWith("/api/v1")) {
    return normalizedBaseUrl;
  }

  return `${normalizedBaseUrl}/api/v1`;
}

function getTimeoutMs(): number {
  const parsed = Number(process.env.VIKUNJA_TIMEOUT_MS ?? "");

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return DEFAULT_TIMEOUT_MS;
}

function getPort(): number {
  const parsed = Number(process.env.PORT ?? "");

  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }

  return DEFAULT_PORT;
}

const config = {
  baseApiUrl: getBaseApiUrl(),
  token: requireEnv("VIKUNJA_TOKEN"),
  apiKey: getRequiredEnv("VIKUNJA_MCP_API_KEY"),
  timeoutMs: getTimeoutMs(),
  port: getPort(),
  host: process.env.HOST?.trim() || DEFAULT_BIND_HOST,
};

function asJsonRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as JsonRecord;
}

function pickFields<T extends JsonRecord>(value: T, keys: string[]): JsonRecord {
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined && value[key] !== null)
      .map((key) => [key, value[key]]),
  );
}

function summarizeProject(project: unknown): JsonRecord {
  const item = asJsonRecord(project);

  return pickFields(item, [
    "id",
    "title",
    "identifier",
    "description",
    "is_archived",
    "is_favorite",
    "created",
    "updated",
  ]);
}

function summarizeTask(task: unknown): JsonRecord {
  const item = asJsonRecord(task);
  const project = asJsonRecord(item.project);

  return {
    ...pickFields(item, [
      "id",
      "title",
      "description",
      "done",
      "due_date",
      "priority",
      "percent_done",
      "project_id",
      "index",
      "created",
      "updated",
      "done_at",
    ]),
    project: Object.keys(project).length === 0 ? undefined : pickFields(project, ["id", "title", "identifier"]),
  };
}

function summarizeComment(comment: unknown): JsonRecord {
  const item = asJsonRecord(comment);

  return {
    ...pickFields(item, ["id", "comment", "created", "updated"]),
    author: pickFields(asJsonRecord(item.author), ["id", "username", "name"]),
  };
}

function toolText(title: string, payload: JsonRecord): string {
  return `${title}\n${JSON.stringify(payload, null, 2)}`;
}

function toolResult(title: string, payload: JsonRecord) {
  return {
    content: [
      {
        type: "text" as const,
        text: toolText(title, payload),
      },
    ],
    structuredContent: payload,
  };
}

async function vikunjaFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T; headers: Headers; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseApiUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body =
      contentType.includes("application/json")
        ? ((await response.json()) as unknown)
        : ((await response.text()) as unknown);

    if (!response.ok) {
      const errorBody = asJsonRecord(body);
      const message =
        typeof errorBody.message === "string"
          ? errorBody.message
          : typeof body === "string" && body.length > 0
            ? body
            : `Vikunja request failed with status ${response.status}`;

      throw new Error(`${message} (${response.status})`);
    }

    return {
      data: body as T,
      headers: response.headers,
      status: response.status,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Vikunja request timed out after ${config.timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getTask(taskId: number): Promise<JsonRecord> {
  const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}`);
  return asJsonRecord(response.data);
}

async function getProjects(params?: { page?: number; perPage?: number; search?: string }) {
  const query = new URLSearchParams();

  if (params?.page) {
    query.set("page", String(params.page));
  }

  if (params?.perPage) {
    query.set("per_page", String(params.perPage));
  }

  if (params?.search) {
    query.set("s", params.search);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await vikunjaFetch<unknown[]>(`/projects${suffix}`);
  return Array.isArray(response.data) ? response.data.map(summarizeProject) : [];
}

function createServer() {
  const server = new McpServer({
    name: "vikunja-http",
    version: "0.1.0",
  });

  server.registerTool(
    "vikunja_health",
    {
      title: "Vikunja Health",
      description: "Verify that the configured Vikunja API token and base URL work.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const projects = await getProjects({ perPage: 1 });

      return toolResult("Vikunja connection OK", {
        baseApiUrl: config.baseApiUrl,
        timeoutMs: config.timeoutMs,
        sampleProjectCount: projects.length,
      });
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description: "List Vikunja projects available to the current token.",
      inputSchema: {
        search: z.string().optional(),
        page: z.number().int().positive().optional(),
        perPage: z.number().int().positive().max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ search, page, perPage }) => {
      const projects = await getProjects({ search, page, perPage });

      return toolResult("Projects", {
        count: projects.length,
        projects,
      });
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description: "List tasks from Vikunja, with optional client-side filtering by project and completion state.",
      inputSchema: {
        projectId: z.number().int().positive().optional(),
        search: z.string().optional(),
        page: z.number().int().positive().optional(),
        perPage: z.number().int().positive().max(100).optional(),
        includeDone: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ projectId, search, page, perPage, includeDone }) => {
      const query = new URLSearchParams();

      if (search) {
        query.set("s", search);
      }

      if (page) {
        query.set("page", String(page));
      }

      if (perPage) {
        query.set("per_page", String(perPage));
      }

      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      const response = await vikunjaFetch<unknown[]>(`/tasks${suffix}`);
      const rawTasks = Array.isArray(response.data) ? response.data : [];
      let tasks = rawTasks.map(summarizeTask);

      if (projectId !== undefined) {
        tasks = tasks.filter((task) => task.project_id === projectId);
      }

      if (includeDone !== true) {
        tasks = tasks.filter((task) => task.done !== true);
      }

      return toolResult("Tasks", {
        count: tasks.length,
        tasks,
      });
    },
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description: "Fetch one Vikunja task by id.",
      inputSchema: {
        taskId: z.number().int().positive(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ taskId }) => {
      const task = summarizeTask(await getTask(taskId));

      return toolResult("Task", task);
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create Project",
      description: "Create a new Vikunja project.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
        identifier: z.string().optional(),
        hexColor: z.string().optional(),
        isFavorite: z.boolean().optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, description, identifier, hexColor, isFavorite }) => {
      const payload = {
        title,
        description,
        identifier,
        hex_color: hexColor,
        is_favorite: isFavorite,
      };

      const response = await vikunjaFetch<JsonRecord>("/projects", {
        method: "PUT",
        body: JSON.stringify(payload),
      });

      return toolResult("Created project", summarizeProject(response.data));
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description: "Create a new task in a Vikunja project.",
      inputSchema: {
        projectId: z.number().int().positive(),
        title: z.string().min(1),
        description: z.string().optional(),
        dueDate: z.string().datetime().optional(),
        priority: z.number().int().min(0).max(5).optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ projectId, title, description, dueDate, priority }) => {
      const payload = {
        title,
        description,
        due_date: dueDate,
        priority,
      };

      const response = await vikunjaFetch<JsonRecord>(`/projects/${projectId}/tasks`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });

      return toolResult("Created task", summarizeTask(response.data));
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update Task",
      description: "Patch a Vikunja task by reading the current task, merging selected fields, and posting the updated task back.",
      inputSchema: {
        taskId: z.number().int().positive(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        done: z.boolean().optional(),
        dueDate: z.string().datetime().nullable().optional(),
        priority: z.number().int().min(0).max(5).optional(),
        percentDone: z.number().int().min(0).max(100).optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, title, description, done, dueDate, priority, percentDone }) => {
      const existing = await getTask(taskId);
      const updatedTask = {
        ...existing,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(done !== undefined ? { done } : {}),
        ...(dueDate !== undefined ? { due_date: dueDate } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(percentDone !== undefined ? { percent_done: percentDone } : {}),
      };

      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}`, {
        method: "POST",
        body: JSON.stringify(updatedTask),
      });

      return toolResult("Updated task", summarizeTask(response.data));
    },
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete Task",
      description: "Mark a Vikunja task as done.",
      inputSchema: {
        taskId: z.number().int().positive(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId }) => {
      const existing = await getTask(taskId);
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}`, {
        method: "POST",
        body: JSON.stringify({
          ...existing,
          done: true,
        }),
      });

      return toolResult("Completed task", summarizeTask(response.data));
    },
  );

  server.registerTool(
    "add_task_comment",
    {
      title: "Add Task Comment",
      description: "Add a comment to a Vikunja task.",
      inputSchema: {
        taskId: z.number().int().positive(),
        comment: z.string().min(1),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, comment }) => {
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/comments`, {
        method: "PUT",
        body: JSON.stringify({ comment }),
      });

      return toolResult("Created comment", summarizeComment(response.data));
    },
  );

  return server;
}

function isAuthorized(apiKeyHeader: string | string[] | undefined): boolean {
  if (typeof apiKeyHeader === "string") {
    return apiKeyHeader === config.apiKey;
  }

  return false;
}

async function main() {
  if (process.env.VIKUNJA_MCP_VALIDATE_ONLY === "1") {
    console.error(`vikunja-mcp config ok for ${config.baseApiUrl} on port ${config.port}`);
    return;
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "vikunja-http",
      baseApiUrl: config.baseApiUrl,
    });
  });

  app.all("/mcp", async (req, res) => {
    if (!isAuthorized(req.header("x-api-key"))) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized",
        },
        id: null,
      });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      });
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        void server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.listen(config.port, config.host, () => {
    console.error(`vikunja-mcp listening on http://${config.host}:${config.port}/mcp`);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
