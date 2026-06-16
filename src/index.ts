import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { readFile } from "node:fs/promises";
import { z } from "zod/v4";

type JsonRecord = Record<string, unknown>;
type RelationKind =
  | "subtask"
  | "parenttask"
  | "related"
  | "duplicateof"
  | "duplicates"
  | "blocking"
  | "blocked"
  | "precedes"
  | "follows"
  | "copiedfrom"
  | "copiedto";
type ReminderRelation = "due_date" | "start_date" | "end_date";

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

const relationKindSchema = z.enum([
  "subtask",
  "parenttask",
  "related",
  "duplicateof",
  "duplicates",
  "blocking",
  "blocked",
  "precedes",
  "follows",
  "copiedfrom",
  "copiedto",
]);
const reminderRelationSchema = z.enum(["due_date", "start_date", "end_date"]);
const repeatModeSchema = z.number().int().min(0).max(2);

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
      "identifier",
      "description",
      "done",
      "due_date",
      "start_date",
      "end_date",
      "priority",
      "percent_done",
      "project_id",
      "index",
      "position",
      "repeat_after",
      "repeat_mode",
      "created",
      "updated",
      "done_at",
    ]),
    project: Object.keys(project).length === 0 ? undefined : pickFields(project, ["id", "title", "identifier"]),
    assignees: Array.isArray(item.assignees) ? item.assignees.map(summarizeAssignee) : undefined,
    reminders: Array.isArray(item.reminders) ? item.reminders.map(summarizeReminder) : undefined,
  };
}

function summarizeComment(comment: unknown): JsonRecord {
  const item = asJsonRecord(comment);

  return {
    ...pickFields(item, ["id", "comment", "created", "updated"]),
    author: pickFields(asJsonRecord(item.author), ["id", "username", "name"]),
  };
}

function summarizeUser(user: unknown): JsonRecord {
  const item = asJsonRecord(user);

  return pickFields(item, [
    "id",
    "username",
    "name",
    "email",
    "created",
    "updated",
    "is_admin",
    "status",
  ]);
}

function summarizeLabel(label: unknown): JsonRecord {
  const item = asJsonRecord(label);

  return pickFields(item, [
    "id",
    "title",
    "description",
    "hex_color",
    "created",
    "updated",
  ]);
}

function summarizeTaskLabelLink(link: unknown): JsonRecord {
  const item = asJsonRecord(link);

  return pickFields(item, ["label_id", "created"]);
}

function summarizeTaskRelation(relation: unknown): JsonRecord {
  const item = asJsonRecord(relation);

  return {
    ...pickFields(item, ["task_id", "other_task_id", "relation_kind", "created"]),
    created_by: pickFields(asJsonRecord(item.created_by), ["id", "username", "name"]),
  };
}

function summarizeAttachment(attachment: unknown): JsonRecord {
  const item = asJsonRecord(attachment);

  return {
    ...pickFields(item, [
      "id",
      "file",
      "file_name",
      "mime",
      "size",
      "created",
      "task_id",
    ]),
    created_by: summarizeUser(item.created_by),
  };
}

function summarizeReminder(reminder: unknown): JsonRecord {
  const item = asJsonRecord(reminder);

  return pickFields(item, ["reminder", "relative_to", "relative_period"]);
}

function summarizeAssignee(assignee: unknown): JsonRecord {
  return summarizeUser(assignee);
}

function paginationFromHeaders(headers: Headers): JsonRecord {
  const totalPages = Number(headers.get("x-pagination-total-pages") ?? "");
  const resultCount = Number(headers.get("x-pagination-result-count") ?? "");

  return {
    totalPages: Number.isFinite(totalPages) ? totalPages : undefined,
    resultCount: Number.isFinite(resultCount) ? resultCount : undefined,
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
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const mergedHeaders = new Headers(init?.headers ?? {});

  if (!isFormData && !mergedHeaders.has("Content-Type")) {
    mergedHeaders.set("Content-Type", "application/json");
  }

  if (!mergedHeaders.has("Authorization")) {
    mergedHeaders.set("Authorization", `Bearer ${config.token}`);
  }

  try {
    const response = await fetch(`${config.baseApiUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: mergedHeaders,
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

async function getExpandedTask(taskId: number, expand?: string[]): Promise<JsonRecord> {
  const query = new URLSearchParams();

  for (const value of expand ?? []) {
    query.append("expand", value);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}${suffix}`);
  return asJsonRecord(response.data);
}

async function updateTaskObject(taskId: number, mutate: (existing: JsonRecord) => JsonRecord) {
  const existing = await getTask(taskId);
  const updatedTask = mutate(existing);
  const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}`, {
    method: "POST",
    body: JSON.stringify(updatedTask),
  });

  return summarizeTask(response.data);
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
  return {
    projects: Array.isArray(response.data) ? response.data.map(summarizeProject) : [],
    pagination: paginationFromHeaders(response.headers),
  };
}

async function getProject(projectId: number): Promise<JsonRecord> {
  const response = await vikunjaFetch<JsonRecord>(`/projects/${projectId}`);
  return asJsonRecord(response.data);
}

async function updateProjectObject(projectId: number, mutate: (existing: JsonRecord) => JsonRecord) {
  const existing = await getProject(projectId);
  const updatedProject = mutate(existing);
  const response = await vikunjaFetch<JsonRecord>(`/projects/${projectId}`, {
    method: "POST",
    body: JSON.stringify(updatedProject),
  });

  return summarizeProject(response.data);
}

async function getTaskLabels(taskId: number, params?: { page?: number; perPage?: number }) {
  const query = new URLSearchParams();

  if (params?.page) {
    query.set("page", String(params.page));
  }

  if (params?.perPage) {
    query.set("per_page", String(params.perPage));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await vikunjaFetch<unknown[]>(`/tasks/${taskId}/labels${suffix}`);
  return {
    labels: Array.isArray(response.data) ? response.data.map(summarizeLabel) : [],
    pagination: paginationFromHeaders(response.headers),
  };
}

async function getLabels(params?: { page?: number; perPage?: number; search?: string }) {
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
  const response = await vikunjaFetch<unknown[]>(`/labels${suffix}`);
  return {
    labels: Array.isArray(response.data) ? response.data.map(summarizeLabel) : [],
    pagination: paginationFromHeaders(response.headers),
  };
}

async function getTaskComments(taskId: number, orderBy?: "asc" | "desc") {
  const query = new URLSearchParams();

  if (orderBy) {
    query.set("order_by", orderBy);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await vikunjaFetch<unknown[]>(`/tasks/${taskId}/comments${suffix}`);
  return {
    comments: Array.isArray(response.data) ? response.data.map(summarizeComment) : [],
    pagination: paginationFromHeaders(response.headers),
  };
}

async function getTaskAssignees(taskId: number, params?: { page?: number; perPage?: number }) {
  const query = new URLSearchParams();

  if (params?.page) {
    query.set("page", String(params.page));
  }

  if (params?.perPage) {
    query.set("per_page", String(params.perPage));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await vikunjaFetch<unknown[]>(`/tasks/${taskId}/assignees${suffix}`);
  return {
    assignees: Array.isArray(response.data) ? response.data.map(summarizeAssignee) : [],
    pagination: paginationFromHeaders(response.headers),
  };
}

async function getTaskAttachments(taskId: number, params?: { page?: number; perPage?: number }) {
  const query = new URLSearchParams();

  if (params?.page) {
    query.set("page", String(params.page));
  }

  if (params?.perPage) {
    query.set("per_page", String(params.perPage));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await vikunjaFetch<unknown[]>(`/tasks/${taskId}/attachments${suffix}`);
  return {
    attachments: Array.isArray(response.data) ? response.data.map(summarizeAttachment) : [],
    pagination: paginationFromHeaders(response.headers),
  };
}

async function createTaskRelation(taskId: number, otherTaskId: number, relationKind: RelationKind) {
  const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/relations`, {
    method: "PUT",
    body: JSON.stringify({
      task_id: taskId,
      other_task_id: otherTaskId,
      relation_kind: relationKind,
    }),
  });

  return summarizeTaskRelation(response.data);
}

function parseTaskIdentifier(identifier: string): { project: string; index: number } {
  const match = /^([A-Za-z][A-Za-z0-9_-]*)-(\d+)$/.exec(identifier.trim());

  if (!match) {
    throw new Error(`Invalid task identifier: ${identifier}`);
  }

  return {
    project: match[1],
    index: Number(match[2]),
  };
}

async function getTaskByIdentifier(identifier: string, expand?: string[]) {
  const { project, index } = parseTaskIdentifier(identifier);
  const query = new URLSearchParams();

  for (const value of expand ?? []) {
    query.append("expand", value);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await vikunjaFetch<JsonRecord>(`/projects/${project}/tasks/by-index/${index}${suffix}`);
  return summarizeTask(response.data);
}

async function getCurrentUser() {
  const response = await vikunjaFetch<JsonRecord>("/user");
  return summarizeUser(response.data);
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
      const { projects } = await getProjects({ perPage: 1 });

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
      const { projects, pagination } = await getProjects({ search, page, perPage });

      return toolResult("Projects", {
        count: projects.length,
        pagination,
        projects,
      });
    },
  );

  server.registerTool(
    "get_project",
    {
      title: "Get Project",
      description: "Fetch one Vikunja project by id.",
      inputSchema: {
        projectId: z.number().int().positive(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ projectId }) => {
      const project = summarizeProject(await getProject(projectId));

      return toolResult("Project", project);
    },
  );

  server.registerTool(
    "list_task_labels",
    {
      title: "List Task Labels",
      description: "List labels associated with a Vikunja task.",
      inputSchema: {
        taskId: z.number().int().positive(),
        page: z.number().int().positive().optional(),
        perPage: z.number().int().positive().max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ taskId, page, perPage }) => {
      const { labels, pagination } = await getTaskLabels(taskId, { page, perPage });

      return toolResult("Task labels", {
        taskId,
        count: labels.length,
        pagination,
        labels,
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
        pagination: paginationFromHeaders(response.headers),
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
        expand: z.array(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ taskId, expand }) => {
      const task = summarizeTask(await getExpandedTask(taskId, expand));

      return toolResult("Task", task);
    },
  );

  server.registerTool(
    "get_task_by_identifier",
    {
      title: "Get Task By Identifier",
      description: "Fetch one Vikunja task by human-facing identifier like PROJ-123.",
      inputSchema: {
        identifier: z.string().min(3),
        expand: z.array(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ identifier, expand }) => {
      const task = await getTaskByIdentifier(identifier, expand);

      return toolResult("Task", task);
    },
  );

  server.registerTool(
    "get_current_user",
    {
      title: "Get Current User",
      description: "Fetch the Vikunja user associated with the configured API token.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const user = await getCurrentUser();

      return toolResult("Current user", user);
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
    "update_project",
    {
      title: "Update Project",
      description: "Update selected fields on a Vikunja project.",
      inputSchema: {
        projectId: z.number().int().positive(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        identifier: z.string().optional(),
        hexColor: z.string().optional(),
        isFavorite: z.boolean().optional(),
        isArchived: z.boolean().optional(),
        parentProjectId: z.number().int().positive().nullable().optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ projectId, title, description, identifier, hexColor, isFavorite, isArchived, parentProjectId }) => {
      const project = await updateProjectObject(projectId, (existing) => ({
        ...existing,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(identifier !== undefined ? { identifier } : {}),
        ...(hexColor !== undefined ? { hex_color: hexColor } : {}),
        ...(isFavorite !== undefined ? { is_favorite: isFavorite } : {}),
        ...(isArchived !== undefined ? { is_archived: isArchived } : {}),
        ...(parentProjectId !== undefined ? { parent_project_id: parentProjectId } : {}),
      }));

      return toolResult("Updated project", project);
    },
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete Project",
      description: "Delete a Vikunja project.",
      inputSchema: {
        projectId: z.number().int().positive(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ projectId }) => {
      const response = await vikunjaFetch<JsonRecord>(`/projects/${projectId}`, {
        method: "DELETE",
      });

      return toolResult("Deleted project", {
        projectId,
        result: pickFields(asJsonRecord(response.data), ["message"]),
      });
    },
  );

  server.registerTool(
    "list_labels",
    {
      title: "List Labels",
      description: "List labels accessible to the current Vikunja token.",
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
      const { labels, pagination } = await getLabels({ search, page, perPage });

      return toolResult("Labels", {
        count: labels.length,
        pagination,
        labels,
      });
    },
  );

  server.registerTool(
    "create_label",
    {
      title: "Create Label",
      description: "Create a new Vikunja label.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
        hexColor: z.string().optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, description, hexColor }) => {
      const response = await vikunjaFetch<JsonRecord>("/labels", {
        method: "PUT",
        body: JSON.stringify({
          title,
          description,
          hex_color: hexColor,
        }),
      });

      return toolResult("Created label", summarizeLabel(response.data));
    },
  );

  server.registerTool(
    "update_label",
    {
      title: "Update Label",
      description: "Update an existing Vikunja label.",
      inputSchema: {
        labelId: z.number().int().positive(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        hexColor: z.string().optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ labelId, title, description, hexColor }) => {
      const response = await vikunjaFetch<JsonRecord>(`/labels/${labelId}`, {
        method: "PUT",
        body: JSON.stringify({
          id: labelId,
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(hexColor !== undefined ? { hex_color: hexColor } : {}),
        }),
      });

      return toolResult("Updated label", summarizeLabel(response.data));
    },
  );

  server.registerTool(
    "delete_label",
    {
      title: "Delete Label",
      description: "Delete a Vikunja label.",
      inputSchema: {
        labelId: z.number().int().positive(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ labelId }) => {
      const response = await vikunjaFetch<JsonRecord>(`/labels/${labelId}`, {
        method: "DELETE",
      });

      return toolResult("Deleted label", {
        labelId,
        result: pickFields(asJsonRecord(response.data), ["message"]),
      });
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
    "delete_task",
    {
      title: "Delete Task",
      description: "Delete a Vikunja task.",
      inputSchema: {
        taskId: z.number().int().positive(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId }) => {
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}`, {
        method: "DELETE",
      });

      return toolResult("Deleted task", {
        taskId,
        result: pickFields(asJsonRecord(response.data), ["message"]),
      });
    },
  );

  server.registerTool(
    "move_task_to_project",
    {
      title: "Move Task To Project",
      description: "Move a task to another Vikunja project by updating its project_id.",
      inputSchema: {
        taskId: z.number().int().positive(),
        projectId: z.number().int().positive(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, projectId }) => {
      const task = await updateTaskObject(taskId, (existing) => ({
        ...existing,
        project_id: projectId,
      }));

      return toolResult("Moved task", task);
    },
  );

  server.registerTool(
    "add_task_label",
    {
      title: "Add Task Label",
      description: "Associate an existing label with a task.",
      inputSchema: {
        taskId: z.number().int().positive(),
        labelId: z.number().int().positive(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, labelId }) => {
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/labels`, {
        method: "PUT",
        body: JSON.stringify({ label_id: labelId }),
      });

      return toolResult("Added task label", {
        taskId,
        link: summarizeTaskLabelLink(response.data),
      });
    },
  );

  server.registerTool(
    "remove_task_label",
    {
      title: "Remove Task Label",
      description: "Remove a label from a task.",
      inputSchema: {
        taskId: z.number().int().positive(),
        labelId: z.number().int().positive(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, labelId }) => {
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/labels/${labelId}`, {
        method: "DELETE",
      });

      return toolResult("Removed task label", {
        taskId,
        labelId,
        result: pickFields(asJsonRecord(response.data), ["message"]),
      });
    },
  );

  server.registerTool(
    "replace_task_labels",
    {
      title: "Replace Task Labels",
      description: "Replace the effective label set on a task using Vikunja's bulk task-label update endpoint.",
      inputSchema: {
        taskId: z.number().int().positive(),
        labelIds: z.array(z.number().int().positive()),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, labelIds }) => {
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/labels/bulk`, {
        method: "POST",
        body: JSON.stringify({
          labels: labelIds.map((id) => ({ id })),
        }),
      });

      const labels = Array.isArray(asJsonRecord(response.data).labels)
        ? (asJsonRecord(response.data).labels as unknown[]).map(summarizeLabel)
        : labelIds.map((id) => ({ id }));

      return toolResult("Updated task labels", {
        taskId,
        count: labels.length,
        labels,
      });
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
      const task = await updateTaskObject(taskId, (existing) => ({
        ...existing,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(done !== undefined ? { done } : {}),
        ...(dueDate !== undefined ? { due_date: dueDate } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(percentDone !== undefined ? { percent_done: percentDone } : {}),
      }));

      return toolResult("Updated task", task);
    },
  );

  server.registerTool(
    "set_task_due_date",
    {
      title: "Set Task Due Date",
      description: "Set or clear a task due date.",
      inputSchema: {
        taskId: z.number().int().positive(),
        dueDate: z.string().datetime().nullable(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, dueDate }) => {
      const task = await updateTaskObject(taskId, (existing) => ({
        ...existing,
        due_date: dueDate,
      }));

      return toolResult("Updated task due date", task);
    },
  );

  server.registerTool(
    "set_task_repeat",
    {
      title: "Set Task Repeat",
      description: "Set repeat settings on a task.",
      inputSchema: {
        taskId: z.number().int().positive(),
        repeatAfterSeconds: z.number().int().min(0),
        repeatMode: repeatModeSchema.optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, repeatAfterSeconds, repeatMode }) => {
      const task = await updateTaskObject(taskId, (existing) => ({
        ...existing,
        repeat_after: repeatAfterSeconds,
        ...(repeatMode !== undefined ? { repeat_mode: repeatMode } : {}),
      }));

      return toolResult("Updated task repeat", task);
    },
  );

  server.registerTool(
    "set_task_position",
    {
      title: "Set Task Position",
      description: "Set a task position value for manual ordering.",
      inputSchema: {
        taskId: z.number().int().positive(),
        position: z.number(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, position }) => {
      const task = await updateTaskObject(taskId, (existing) => ({
        ...existing,
        position,
      }));

      return toolResult("Updated task position", task);
    },
  );

  server.registerTool(
    "set_task_reminders",
    {
      title: "Set Task Reminders",
      description: "Replace the reminders on a task.",
      inputSchema: {
        taskId: z.number().int().positive(),
        reminders: z.array(
          z.object({
            reminder: z.string().datetime().optional(),
            relativeTo: reminderRelationSchema.optional(),
            relativePeriodSeconds: z.number().int().optional(),
          }),
        ),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, reminders }) => {
      const task = await updateTaskObject(taskId, (existing) => ({
        ...existing,
        reminders: reminders.map((reminder) => ({
          ...(reminder.reminder !== undefined ? { reminder: reminder.reminder } : {}),
          ...(reminder.relativeTo !== undefined ? { relative_to: reminder.relativeTo } : {}),
          ...(reminder.relativePeriodSeconds !== undefined
            ? { relative_period: reminder.relativePeriodSeconds }
            : {}),
        })),
      }));

      return toolResult("Updated task reminders", task);
    },
  );

  server.registerTool(
    "list_task_relations",
    {
      title: "List Task Relations",
      description: "Inspect related tasks grouped by relation kind for a task.",
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
      const task = await getTask(taskId);
      const relatedTasks = asJsonRecord(task.related_tasks);

      return toolResult("Task relations", {
        taskId,
        relations: Object.fromEntries(
          Object.entries(relatedTasks).map(([kind, value]) => [
            kind,
            Array.isArray(value) ? value.map(summarizeTask) : [],
          ]),
        ),
      });
    },
  );

  server.registerTool(
    "create_task_relation",
    {
      title: "Create Task Relation",
      description: "Create a relation between two tasks.",
      inputSchema: {
        taskId: z.number().int().positive(),
        otherTaskId: z.number().int().positive(),
        relationKind: relationKindSchema,
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, otherTaskId, relationKind }) => {
      const relation = await createTaskRelation(taskId, otherTaskId, relationKind);

      return toolResult("Created task relation", relation);
    },
  );

  server.registerTool(
    "remove_task_relation",
    {
      title: "Remove Task Relation",
      description: "Remove a relation between two tasks.",
      inputSchema: {
        taskId: z.number().int().positive(),
        otherTaskId: z.number().int().positive(),
        relationKind: relationKindSchema,
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, otherTaskId, relationKind }) => {
      const response = await vikunjaFetch<JsonRecord>(
        `/tasks/${taskId}/relations/${relationKind}/${otherTaskId}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            task_id: taskId,
            other_task_id: otherTaskId,
            relation_kind: relationKind,
          }),
        },
      );

      return toolResult("Removed task relation", {
        taskId,
        otherTaskId,
        relationKind,
        result: pickFields(asJsonRecord(response.data), ["message"]),
      });
    },
  );

  server.registerTool(
    "create_subtask_relation",
    {
      title: "Create Subtask Relation",
      description: "Mark one task as a subtask of another using Vikunja's documented task relation kind.",
      inputSchema: {
        parentTaskId: z.number().int().positive(),
        subtaskId: z.number().int().positive(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ parentTaskId, subtaskId }) => {
      const relation = await createTaskRelation(parentTaskId, subtaskId, "subtask");

      return toolResult("Created subtask relation", relation);
    },
  );

  server.registerTool(
    "remove_subtask_relation",
    {
      title: "Remove Subtask Relation",
      description: "Remove the subtask relation between a parent task and subtask.",
      inputSchema: {
        parentTaskId: z.number().int().positive(),
        subtaskId: z.number().int().positive(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ parentTaskId, subtaskId }) => {
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${parentTaskId}/relations/subtask/${subtaskId}`, {
        method: "DELETE",
        body: JSON.stringify({
          task_id: parentTaskId,
          other_task_id: subtaskId,
          relation_kind: "subtask",
        }),
      });

      return toolResult("Removed subtask relation", {
        parentTaskId,
        subtaskId,
        result: pickFields(asJsonRecord(response.data), ["message"]),
      });
    },
  );

  server.registerTool(
    "list_subtasks",
    {
      title: "List Subtasks",
      description: "List subtasks of a task using Vikunja's task expansion support.",
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
      const task = await getExpandedTask(taskId, ["subtasks"]);
      const directSubtasks = Array.isArray(task.subtasks) ? task.subtasks.map(summarizeTask) : [];
      const relatedSubtasks = Array.isArray(asJsonRecord(task.related_tasks).subtask)
        ? ((asJsonRecord(task.related_tasks).subtask as unknown[]).map(summarizeTask))
        : [];
      const subtasks = directSubtasks.length > 0 ? directSubtasks : relatedSubtasks;

      return toolResult("Subtasks", {
        taskId,
        count: subtasks.length,
        subtasks,
      });
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
      const task = await updateTaskObject(taskId, (existing) => ({
        ...existing,
        done: true,
      }));

      return toolResult("Completed task", task);
    },
  );

  server.registerTool(
    "list_task_comments",
    {
      title: "List Task Comments",
      description: "List comments on a task.",
      inputSchema: {
        taskId: z.number().int().positive(),
        orderBy: z.enum(["asc", "desc"]).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ taskId, orderBy }) => {
      const { comments, pagination } = await getTaskComments(taskId, orderBy);

      return toolResult("Task comments", {
        taskId,
        count: comments.length,
        pagination,
        comments,
      });
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

  server.registerTool(
    "update_task_comment",
    {
      title: "Update Task Comment",
      description: "Update an existing task comment.",
      inputSchema: {
        taskId: z.number().int().positive(),
        commentId: z.number().int().positive(),
        comment: z.string().min(1),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, commentId, comment }) => {
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/comments/${commentId}`, {
        method: "POST",
        body: JSON.stringify({
          id: commentId,
          comment,
        }),
      });

      return toolResult("Updated comment", summarizeComment(response.data));
    },
  );

  server.registerTool(
    "delete_task_comment",
    {
      title: "Delete Task Comment",
      description: "Delete a task comment.",
      inputSchema: {
        taskId: z.number().int().positive(),
        commentId: z.number().int().positive(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, commentId }) => {
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/comments/${commentId}`, {
        method: "DELETE",
      });

      return toolResult("Deleted comment", {
        taskId,
        commentId,
        result: pickFields(asJsonRecord(response.data), ["message"]),
      });
    },
  );

  server.registerTool(
    "list_task_assignees",
    {
      title: "List Task Assignees",
      description: "List assignees on a task.",
      inputSchema: {
        taskId: z.number().int().positive(),
        page: z.number().int().positive().optional(),
        perPage: z.number().int().positive().max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ taskId, page, perPage }) => {
      const { assignees, pagination } = await getTaskAssignees(taskId, { page, perPage });

      return toolResult("Task assignees", {
        taskId,
        count: assignees.length,
        pagination,
        assignees,
      });
    },
  );

  server.registerTool(
    "set_task_assignees",
    {
      title: "Set Task Assignees",
      description: "Replace the assignee set on a task.",
      inputSchema: {
        taskId: z.number().int().positive(),
        userIds: z.array(z.number().int().positive()),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, userIds }) => {
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/assignees/bulk`, {
        method: "POST",
        body: JSON.stringify({
          assignees: userIds.map((id) => ({ id })),
        }),
      });

      const assignees = Array.isArray(asJsonRecord(response.data).assignees)
        ? (asJsonRecord(response.data).assignees as unknown[]).map(summarizeAssignee)
        : userIds.map((id) => ({ id }));

      return toolResult("Updated task assignees", {
        taskId,
        count: assignees.length,
        assignees,
      });
    },
  );

  server.registerTool(
    "list_task_attachments",
    {
      title: "List Task Attachments",
      description: "List attachments on a task.",
      inputSchema: {
        taskId: z.number().int().positive(),
        page: z.number().int().positive().optional(),
        perPage: z.number().int().positive().max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ taskId, page, perPage }) => {
      const { attachments, pagination } = await getTaskAttachments(taskId, { page, perPage });

      return toolResult("Task attachments", {
        taskId,
        count: attachments.length,
        pagination,
        attachments,
      });
    },
  );

  server.registerTool(
    "upload_task_attachment",
    {
      title: "Upload Task Attachment",
      description: "Upload an attachment to a task from base64 content or a server-local file path.",
      inputSchema: {
        taskId: z.number().int().positive(),
        filename: z.string().min(1),
        mimeType: z.string().optional(),
        contentBase64: z.string().optional(),
        serverFilePath: z.string().optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, filename, mimeType, contentBase64, serverFilePath }) => {
      if (!contentBase64 && !serverFilePath) {
        throw new Error("Provide either contentBase64 or serverFilePath");
      }

      const bytes = serverFilePath ? await readFile(serverFilePath) : Buffer.from(contentBase64!, "base64");
      const form = new FormData();
      form.set("files", new Blob([bytes], { type: mimeType ?? "application/octet-stream" }), filename);

      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/attachments`, {
        method: "PUT",
        body: form,
      });

      return toolResult("Uploaded task attachment", summarizeAttachment(response.data));
    },
  );

  server.registerTool(
    "delete_task_attachment",
    {
      title: "Delete Task Attachment",
      description: "Delete a task attachment.",
      inputSchema: {
        taskId: z.number().int().positive(),
        attachmentId: z.number().int().positive(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, attachmentId }) => {
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/attachments/${attachmentId}`, {
        method: "DELETE",
      });

      return toolResult("Deleted task attachment", {
        taskId,
        attachmentId,
        result: pickFields(asJsonRecord(response.data), ["message"]),
      });
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
