import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type ErrorRequestHandler } from "express";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod/v4";
import { loadConfig } from "./config.js";
import { uploadBytes } from "./uploads.js";
import { serializedUpdate } from "./updates.js";
import { strictInput, patchInput, dateTimeInput, utcDateTime, reminderInput, taskReminders, repeatInput, taskRepeat } from "./tool-inputs.js";
import { paginationFromHeaders } from "./pagination.js";
import { createAtomicFieldUpdates } from "./atomic-updates.js";

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

class VikunjaHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${message} (${status})`);
    this.name = "VikunjaHttpError";
  }
}

const config = loadConfig();
const serverVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const atomicFieldUpdates = createAtomicFieldUpdates(vikunjaFetch, config.requireAtomicUpdates);

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
const taskExpandSchema = z.array(z.enum([
  "subtasks", "buckets", "reactions", "comments", "comment_count", "time_entries_count", "is_unread",
])).max(7);

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
    "hex_color",
    "parent_project_id",
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
      "comment_count",
      "time_entries_count",
      "is_unread",
      "reactions",
      "buckets",
    ]),
    project: Object.keys(project).length === 0 ? undefined : pickFields(project, ["id", "title", "identifier"]),
    assignees: Array.isArray(item.assignees) ? item.assignees.map(summarizeAssignee) : undefined,
    reminders: Array.isArray(item.reminders) ? item.reminders.map(summarizeReminder) : undefined,
    labels: Array.isArray(item.labels) ? item.labels.map(summarizeLabel) : undefined,
    attachments: Array.isArray(item.attachments) ? item.attachments.map(summarizeAttachment) : undefined,
    comments: Array.isArray(item.comments) ? item.comments.map(summarizeComment) : undefined,
    subtasks: Array.isArray(item.subtasks) ? item.subtasks.map(summarizeTask)
      : Array.isArray(asJsonRecord(item.related_tasks).subtask)
        ? (asJsonRecord(item.related_tasks).subtask as unknown[]).map(summarizeTask) : undefined,
    related_tasks: item.related_tasks && typeof item.related_tasks === "object"
      ? Object.fromEntries(Object.entries(asJsonRecord(item.related_tasks)).map(([kind, tasks]) => [kind, Array.isArray(tasks) ? tasks.map(summarizeTask) : []]))
      : undefined,
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

function summarizeConfiguredUser(): JsonRecord | undefined {
  const identityValue = (value?: string) => {
    const trimmed = value?.trim();
    return trimmed && !["undefined", "null"].includes(trimmed) ? trimmed : undefined;
  };
  const userId = Number(process.env.VIKUNJA_USER_ID ?? "");
  const username = identityValue(process.env.VIKUNJA_USERNAME);
  const name = identityValue(process.env.VIKUNJA_USER_NAME);
  const email = identityValue(process.env.VIKUNJA_USER_EMAIL);
  const user: JsonRecord = {};

  if (Number.isInteger(userId) && userId > 0) {
    user.id = userId;
  }

  if (username) {
    user.username = username;
  }

  if (name) {
    user.name = name;
  }

  if (email) {
    user.email = email;
  }

  return Object.keys(user).length > 0 ? user : undefined;
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

function isVikunjaStatus(error: unknown, statuses: number[]): error is VikunjaHttpError {
  return error instanceof VikunjaHttpError && statuses.includes(error.status);
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
  apiVersion: 1 | 2 = 1,
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
    const baseApiUrl = apiVersion === 2 ? config.baseApiUrl.replace(/\/v1$/, "/v2") : config.baseApiUrl;
    const response = await fetch(`${baseApiUrl}${path}`, {
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
          : typeof errorBody.detail === "string"
            ? errorBody.detail
          : typeof body === "string" && body.length > 0
            ? body
            : `Vikunja request failed with status ${response.status}`;

      throw new VikunjaHttpError(message, response.status, body);
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

async function updateTaskObject(taskId: number, mutate: (existing: JsonRecord) => JsonRecord, requestedFields: string[]) {
  return serializedUpdate(`task:${taskId}`, async () => {
    const existing = await getTask(taskId);
    const updatedTask = mutate(existing);
    const useAtomic = await atomicFieldUpdates.available();
    const fields = useAtomic ? requestedFields : Object.keys(updatedTask).filter(key => JSON.stringify(existing[key]) !== JSON.stringify(updatedTask[key]));
    if (fields.length === 0) return summarizeTask(existing);
    if (useAtomic) {
      return summarizeTask(await atomicFieldUpdates.write("tasks", taskId, updatedTask, fields));
    }
    // The v1 bulk API applies only named scalar columns. Its domain updater also
    // processes assignees, reminders and favorites, so retain those read values.
    // Reminder replacement has no field-scoped v1 endpoint and uses the same lock.
    if (!fields.includes("reminders")) {
      const response = await vikunjaFetch<JsonRecord>("/tasks/bulk", {
        method: "POST",
        body: JSON.stringify({ task_ids: [taskId], fields, values: updatedTask }),
      });
      const tasks = asJsonRecord(response.data).tasks;
      if (!Array.isArray(tasks) || tasks.length !== 1 || asJsonRecord(tasks[0]).id !== taskId) {
        throw new Error("Unexpected Vikunja bulk task update response; requires the Vikunja 2.7 v1 API");
      }
      return summarizeTask(tasks[0]);
    }
    const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}`, {
      method: "POST",
      body: JSON.stringify(updatedTask),
    });
    return summarizeTask(response.data);
  });
}

async function updateTaskFields(taskId: number, changes: JsonRecord) {
  return updateTaskObject(taskId, existing => ({ ...existing, ...changes }), Object.keys(changes));
}

async function getProjects(params?: { page?: number; perPage?: number; search?: string; includeArchived?: boolean }) {
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

  if (params?.includeArchived) query.set("is_archived", "true");

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await vikunjaFetch<unknown[]>(`/projects${suffix}`);
  return {
    projects: Array.isArray(response.data) ? response.data.map(summarizeProject) : [],
    pagination: paginationFromHeaders(response.headers, Array.isArray(response.data) ? response.data.length : 0, params ?? {}),
  };
}

async function getProject(projectId: number): Promise<JsonRecord> {
  const response = await vikunjaFetch<JsonRecord>(`/projects/${projectId}`);
  return asJsonRecord(response.data);
}

async function updateProjectObject(projectId: number, changes: JsonRecord) {
  return serializedUpdate(`project:${projectId}`, async () => {
    const existing = await getProject(projectId);
    const updatedProject = { ...existing, ...changes };
    const useAtomic = await atomicFieldUpdates.available();
    const fields = useAtomic ? Object.keys(changes) : Object.keys(updatedProject).filter(key => JSON.stringify(existing[key]) !== JSON.stringify(updatedProject[key]));
    if (fields.length === 0) return summarizeProject(existing);
    if (useAtomic) {
      return summarizeProject(await atomicFieldUpdates.write("projects", projectId, updatedProject, fields));
    }
    if (updatedProject.description === "" && existing.description) {
      throw new Error("Vikunja 2.7.0 does not support clearing a non-empty project description. No changes were written.");
    }
    const response = await vikunjaFetch<JsonRecord>(`/projects/${projectId}`, {
      method: "POST",
      body: JSON.stringify(updatedProject),
    });
    return summarizeProject(response.data);
  });
}

async function getTaskLabels(taskId: number, params?: { page?: number; perPage?: number }) {
  // The v1 task-label handler ignores per_page for its SQL limit but uses it
  // for pagination headers. Read native pages without that parameter, then
  // apply the MCP page size to the complete collection.
  const labels: JsonRecord[] = [];
  const seen = new Set<unknown>();
  let nativePageSize = 50;
  let nativeTotalPages: number | undefined;
  for (let nativePage = 1; nativePage <= 100; nativePage++) {
    const response = await vikunjaFetch<unknown[]>(`/tasks/${taskId}/labels?page=${nativePage}`);
    if (!Array.isArray(response.data)) throw new Error("Vikunja returned an invalid task-label list.");
    if (nativePage === 1 && response.data.length > 0) nativePageSize = response.data.length;
    for (const value of response.data) {
      const label = summarizeLabel(value);
      if (!Number.isSafeInteger(label.id) || Number(label.id) <= 0 || seen.has(label.id)) {
        throw new Error("Task-label pagination returned invalid or repeated IDs; the complete label set could not be verified.");
      }
      seen.add(label.id);
      labels.push(label);
    }
    const nativePagination = paginationFromHeaders(response.headers, response.data.length, { page: nativePage });
    const reportedPages = nativePagination.totalPages;
    if (typeof reportedPages === "number") {
      if ((nativeTotalPages !== undefined && nativeTotalPages !== reportedPages)
        || (response.data.length > 0 && (reportedPages === 0 || nativePage > reportedPages))) {
        throw new Error("Task-label pagination changed or returned inconsistent totals; the complete label set could not be verified.");
      }
      nativeTotalPages = reportedPages;
    }
    if (response.data.length === 0 && nativeTotalPages !== undefined && nativePage <= nativeTotalPages
      && !(nativePage === 1 && nativeTotalPages === 1)) {
      throw new Error("Task-label pagination returned an empty page before its reported end; the complete label set could not be verified.");
    }
    if (response.data.length === 0 || nativePagination.hasMore === false) {
      const page = params?.page ?? 1;
      const perPage = params?.perPage ?? nativePageSize;
      const selected = labels.slice((page - 1) * perPage, page * perPage);
      const headers = new Headers({
        "X-Pagination-Total-Pages": String(Math.ceil(labels.length / perPage)),
        "X-Pagination-Result-Count": String(selected.length),
      });
      return { labels: selected, pagination: paginationFromHeaders(headers, selected.length, params ?? {}) };
    }
  }
  throw new Error("Task-label pagination exceeded 100 backend pages; the complete label set could not be verified.");
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
    pagination: paginationFromHeaders(response.headers, Array.isArray(response.data) ? response.data.length : 0, params ?? {}),
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
    pagination: paginationFromHeaders(response.headers, Array.isArray(response.data) ? response.data.length : 0),
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
    pagination: paginationFromHeaders(response.headers, Array.isArray(response.data) ? response.data.length : 0, params ?? {}),
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
    pagination: paginationFromHeaders(response.headers, Array.isArray(response.data) ? response.data.length : 0, params ?? {}),
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
  const match = /^(.+)-([1-9]\d*)$/u.exec(identifier.trim());

  if (!match || [...match[1]].length > 10 || /[\u0000-\u001f\u007f]/u.test(match[1]) || !Number.isSafeInteger(Number(match[2]))) {
    throw new Error(`Invalid task identifier: ${identifier}`);
  }

  return {
    project: match[1],
    index: Number(match[2]),
  };
}

async function getTaskByIdentifier(identifier: string, expand?: string[]) {
  let { project, index } = parseTaskIdentifier(identifier);
  // Purely numeric identifiers are interpreted as project IDs by the by-index
  // route. Dot segments are normalized by URL clients. Resolve these to IDs
  // rather than risk fetching a task from a different project.
  if (/^\d+$/.test(project) || project === "." || project === "..") {
    const expected = project.toUpperCase();
    let resolved = false;
    for (let page = 1; page <= 100; page++) {
      const result = await getProjects({ page, perPage: 100, includeArchived: true });
      const found = result.projects.find(item => typeof item.identifier === "string" && item.identifier.toUpperCase() === expected);
      if (found && Number.isSafeInteger(found.id) && Number(found.id) > 0) {
        project = String(found.id);
        resolved = true;
        break;
      }
      if (result.projects.length === 0 || (typeof result.pagination.totalPages === "number" && page >= result.pagination.totalPages)) break;
    }
    if (!resolved) throw new Error("Unable to resolve this project identifier within 100 pages; use the numeric taskId or check project-list permissions.");
  }
  const query = new URLSearchParams();

  for (const value of expand ?? []) {
    query.append("expand", value);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await vikunjaFetch<JsonRecord>(`/projects/${encodeURIComponent(project)}/tasks/by-index/${index}${suffix}`);
  return summarizeTask(response.data);
}

async function getCurrentUserFromTokenOwner(): Promise<JsonRecord | undefined> {
  const response = await vikunjaFetch<unknown[]>("/tokens?per_page=100");
  const tokens = Array.isArray(response.data) ? response.data.map(asJsonRecord) : [];
  const ownerIds = [
    ...new Set(
      tokens
        .map((token) => Number(token.owner_id))
        .filter((ownerId) => Number.isInteger(ownerId) && ownerId > 0),
    ),
  ];

  if (ownerIds.length !== 1) {
    return undefined;
  }

  return {
    id: ownerIds[0],
    source: "tokens.owner_id",
    note: "Resolved from API token ownership because /user was not accessible to this token.",
  };
}

async function getCurrentUser() {
  try {
    const response = await vikunjaFetch<JsonRecord>("/user");
    return {
      ...summarizeUser(response.data),
      source: "user",
    };
  } catch (error) {
    if (!isVikunjaStatus(error, [401, 403])) {
      throw error;
    }

    const configuredUser = summarizeConfiguredUser();

    if (configuredUser) {
      return {
        ...configuredUser,
        source: "environment",
        note: "Resolved from VIKUNJA_USER_* environment variables because /user was not accessible to this token.",
      };
    }

    try {
      const tokenOwner = await getCurrentUserFromTokenOwner();

      if (tokenOwner) {
        return tokenOwner;
      }
    } catch (fallbackError) {
      if (!isVikunjaStatus(fallbackError, [401, 403])) {
        throw fallbackError;
      }
    }

    throw new Error(
      "Unable to resolve current user: /user was denied and no fallback identity is available. " +
        "Grant the token access to GET /user, grant API token read access for /tokens, or set VIKUNJA_USER_ID.",
    );
  }
}

function createServer() {
  const server = new McpServer({
    name: "vikunja-http",
    version: serverVersion,
  });

  server.registerTool(
    "vikunja_health",
    {
      inputSchema: strictInput({}),
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
      inputSchema: strictInput({
        search: z.string().optional(),
        page: z.number().int().positive().optional(),
        perPage: z.number().int().positive().max(100).optional(),
      }),
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
      inputSchema: strictInput({
        projectId: z.number().int().positive(),
      }),
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        page: z.number().int().positive().optional(),
        perPage: z.number().int().positive().max(100).optional(),
      }),
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
      description: "List tasks with project and completion filters applied before pagination. Defaults to open tasks. Results are one page; pagination.pageItemCount counts this page, never all matches. Check completeness/hasMore before claiming a full review.",
      inputSchema: strictInput({
        projectId: z.number().int().positive().optional(),
        search: z.string().optional(),
        page: z.number().int().positive().optional().describe("One-based page number; defaults to 1."),
        perPage: z.number().int().positive().max(100).optional().describe("Requested page size, 1-100. Vikunja may apply a smaller configured maximum."),
        includeDone: z.boolean().optional().describe("false/omitted returns open tasks; true returns both open and completed tasks."),
      }),
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

      const filters: string[] = [];
      if (projectId !== undefined) filters.push(`project_id = ${projectId}`);
      if (includeDone !== true) filters.push("done = false");
      if (filters.length) query.set("filter", filters.join(" && "));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      const response = await vikunjaFetch<unknown[]>(`/tasks${suffix}`);
      const rawTasks = Array.isArray(response.data) ? response.data : [];
      const tasks = rawTasks.map(summarizeTask);

      return toolResult("Tasks", {
        count: tasks.length,
        pagination: paginationFromHeaders(response.headers, tasks.length, { page, perPage }),
        tasks,
      });
    },
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description: "Fetch one Vikunja task by id.",
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        expand: taskExpandSchema.optional(),
      }),
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
      inputSchema: strictInput({
        identifier: z.string().min(3).max(37).describe("Full project-prefix/task-index identifier, such as 9TEAM-12. Numeric-only project prefixes require project-list permission for safe resolution."),
        expand: taskExpandSchema.optional(),
      }),
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
      inputSchema: strictInput({}),
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
      inputSchema: strictInput({
        title: z.string().min(1),
        description: z.string().optional(),
        identifier: z.string().optional(),
        hexColor: z.string().optional(),
        isFavorite: z.boolean().optional(),
      }),
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
      description: "Update selected project fields, preferring advertised atomic field updates. At least one field is required. Stock Vikunja 2.7.0 cannot clear a non-empty description; without the extension that request fails before writing.",
      inputSchema: patchInput({
        projectId: z.number().int().positive(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        identifier: z.string().optional(),
        hexColor: z.string().optional(),
        isFavorite: z.boolean().optional(),
        isArchived: z.boolean().optional(),
        parentProjectId: z.number().int().positive().nullable().optional(),
      }, "projectId"),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ projectId, title, description, identifier, hexColor, isFavorite, isArchived, parentProjectId }) => {
      const project = await updateProjectObject(projectId, {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(identifier !== undefined ? { identifier } : {}),
        ...(hexColor !== undefined ? { hex_color: hexColor } : {}),
        ...(isFavorite !== undefined ? { is_favorite: isFavorite } : {}),
        ...(isArchived !== undefined ? { is_archived: isArchived } : {}),
        ...(parentProjectId !== undefined ? { parent_project_id: parentProjectId ?? 0 } : {}),
      });

      return toolResult("Updated project", project);
    },
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete Project",
      description: "Delete a Vikunja project.",
      inputSchema: strictInput({
        projectId: z.number().int().positive(),
      }),
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
      inputSchema: strictInput({
        search: z.string().optional(),
        page: z.number().int().positive().optional(),
        perPage: z.number().int().positive().max(100).optional(),
      }),
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
      inputSchema: strictInput({
        title: z.string().min(1),
        description: z.string().optional(),
        hexColor: z.string().optional(),
      }),
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
      description: "Update selected label fields, preferring advertised atomic field updates. At least one supported edit is required.",
      inputSchema: patchInput({
        labelId: z.number().int().positive(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        hexColor: z.string().optional(),
      }, "labelId"),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ labelId, title, description, hexColor }) => {
      const response = await serializedUpdate(`label:${labelId}`, async () => {
        const current = await vikunjaFetch<JsonRecord>(`/labels/${labelId}`);
        const changes: JsonRecord = {
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(hexColor !== undefined ? { hex_color: hexColor } : {}),
        };
        const updated = { ...current.data, ...changes };
        const useAtomic = await atomicFieldUpdates.available();
        const fields = useAtomic ? Object.keys(changes) : Object.keys(updated).filter(key => JSON.stringify(current.data[key]) !== JSON.stringify(updated[key]));
        if (fields.length === 0) return current;
        if (useAtomic) {
          return { data: await atomicFieldUpdates.write("labels", labelId, updated, fields) };
        }
        return vikunjaFetch<JsonRecord>(`/labels/${labelId}`, {
          method: "POST",
          body: JSON.stringify(updated),
        });
      });

      return toolResult("Updated label", summarizeLabel(response.data));
    },
  );

  server.registerTool(
    "delete_label",
    {
      title: "Delete Label",
      description: "Delete a Vikunja label.",
      inputSchema: strictInput({
        labelId: z.number().int().positive(),
      }),
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
      inputSchema: strictInput({
        projectId: z.number().int().positive(),
        title: z.string().min(1),
        description: z.string().optional(),
        dueDate: dateTimeInput.optional(),
        priority: z.number().int().min(0).max(5).optional(),
      }),
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
        due_date: dueDate === undefined ? undefined : utcDateTime(dueDate),
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
      }),
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        projectId: z.number().int().positive(),
      }),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, projectId }) => {
      const task = await updateTaskFields(taskId, {
        project_id: projectId,
      });

      return toolResult("Moved task", task);
    },
  );

  server.registerTool(
    "add_task_label",
    {
      title: "Add Task Label",
      description: "Associate an existing label with a task.",
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        labelId: z.number().int().positive(),
      }),
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        labelId: z.number().int().positive(),
      }),
      annotations: {
        destructiveHint: true,
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        labelIds: z.array(z.number().int().positive()),
      }),
      annotations: {
        destructiveHint: true,
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
      description: "Update selected task fields, preferring advertised atomic field updates. Requires at least one supported edit. The stock v1 fallback preserves unrelated scalar columns but has cross-client collection replacement limits.",
      inputSchema: patchInput({
        taskId: z.number().int().positive(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        done: z.boolean().optional(),
        dueDate: dateTimeInput.nullable().optional().describe("Due timestamp with UTC offset, or null to clear it."),
        priority: z.number().int().min(0).max(5).optional(),
        percentDone: z.number().int().min(0).max(100).optional().describe("Completion percentage from 0 to 100. Responses use the API percent_done fraction from 0 to 1."),
      }, "taskId"),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, title, description, done, dueDate, priority, percentDone }) => {
      const task = await updateTaskFields(taskId, {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(done !== undefined ? { done } : {}),
        ...(dueDate !== undefined ? { due_date: utcDateTime(dueDate) } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(percentDone !== undefined ? { percent_done: percentDone / 100 } : {}),
      });

      return toolResult("Updated task", task);
    },
  );

  server.registerTool(
    "set_task_due_date",
    {
      title: "Set Task Due Date",
      description: "Set or clear a task due date.",
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        dueDate: dateTimeInput.nullable().describe("Due timestamp with UTC offset, or null to clear it."),
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, dueDate }) => {
      const task = await updateTaskFields(taskId, {
        due_date: utcDateTime(dueDate),
      });

      return toolResult("Updated task due date", task);
    },
  );

  server.registerTool(
    "set_task_repeat",
    {
      title: "Set Task Repeat",
      description: "Set or disable task repetition. Prefer mode: none, interval, monthly or fromCompletion. Legacy numeric modes remain supported. A zero interval without explicit monthly mode disables repetition. Completing a repeating task may reopen and reschedule it.",
      inputSchema: repeatInput,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const task = await updateTaskObject(input.taskId, (existing) => ({
        ...existing,
        ...taskRepeat(input, existing),
      }), input.mode !== undefined || input.repeatMode !== undefined || input.repeatAfterSeconds === 0
        ? ["repeat_after", "repeat_mode"] : ["repeat_after"]);

      return toolResult("Updated task repeat", task);
    },
  );

  server.registerTool(
    "set_task_position",
    {
      title: "Set Task Position",
      description: "Set a task position for manual ordering within a specific project view.",
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        position: z.number(),
        projectViewId: z.number().int().positive(),
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, projectViewId, position }) => {
      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/position`, {
        method: "POST",
        body: JSON.stringify({ project_view_id: projectViewId, position }),
      });
      return toolResult("Updated task position", response.data);
    },
  );

  server.registerTool(
    "set_task_reminders",
    {
      title: "Set Task Reminders",
      description: "Replace all task reminders; [] clears them. Each item must be either an absolute timestamp or a relative base date plus signed seconds, never both. Relative reminders require that task date to be set. Maximum 100 reminders.",
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        reminders: z.array(reminderInput).max(100).describe("Complete replacement set of absolute or relative reminders; [] clears the collection."),
      }),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, reminders }) => {
      const task = await updateTaskObject(taskId, (existing) => ({
        ...existing,
        reminders: taskReminders(reminders, existing),
      }), ["reminders"]);

      return toolResult("Updated task reminders", task);
    },
  );

  server.registerTool(
    "list_task_relations",
    {
      title: "List Task Relations",
      description: "Inspect related tasks grouped by relation kind for a task.",
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
      }),
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        otherTaskId: z.number().int().positive(),
        relationKind: relationKindSchema,
      }),
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        otherTaskId: z.number().int().positive(),
        relationKind: relationKindSchema,
      }),
      annotations: {
        destructiveHint: true,
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
      inputSchema: strictInput({
        parentTaskId: z.number().int().positive(),
        subtaskId: z.number().int().positive(),
      }),
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
      inputSchema: strictInput({
        parentTaskId: z.number().int().positive(),
        subtaskId: z.number().int().positive(),
      }),
      annotations: {
        destructiveHint: true,
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
      }),
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
      description: "Complete a Vikunja task. A recurring task may immediately reopen with its next dates; the returned state is authoritative. Do not blindly retry after a timeout.",
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId }) => {
      const task = await updateTaskFields(taskId, {
        done: true,
      });

      return toolResult("Completed task", task);
    },
  );

  server.registerTool(
    "list_task_comments",
    {
      title: "List Task Comments",
      description: "List comments on a task.",
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        orderBy: z.enum(["asc", "desc"]).optional(),
      }),
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        comment: z.string().min(1),
      }),
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        commentId: z.number().int().positive(),
        comment: z.string().min(1),
      }),
      annotations: {
        destructiveHint: true,
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        commentId: z.number().int().positive(),
      }),
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        page: z.number().int().positive().optional(),
        perPage: z.number().int().positive().max(100).optional(),
      }),
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        userIds: z.array(z.number().int().positive()),
      }),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, userIds }) => {
      const response = await serializedUpdate(`task:${taskId}`, () =>
        vikunjaFetch<JsonRecord>(`/tasks/${taskId}/assignees/bulk`, {
          method: "POST",
          body: JSON.stringify({ assignees: userIds.map((id) => ({ id })) }),
        }),
      );

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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        page: z.number().int().positive().optional(),
        perPage: z.number().int().positive().max(100).optional(),
      }),
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
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        filename: z.string().min(1).max(255).regex(/^[^\\/\x00]+$/),
        mimeType: z.string().optional(),
        contentBase64: z.string().optional(),
        serverFilePath: z.string().optional(),
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, filename, mimeType, contentBase64, serverFilePath }) => {
      const bytes = await uploadBytes({ contentBase64, serverFilePath }, config);
      const form = new FormData();
      form.set("files", new Blob([new Uint8Array(bytes)], { type: mimeType ?? "application/octet-stream" }), filename);

      const response = await vikunjaFetch<JsonRecord>(`/tasks/${taskId}/attachments`, {
        method: "PUT",
        body: form,
      });

      const result = asJsonRecord(response.data);
      if (!("success" in result) || (result.success !== null && !Array.isArray(result.success)) || (result.errors !== null && result.errors !== undefined && !Array.isArray(result.errors))) {
        throw new Error("Unexpected Vikunja attachment upload response");
      }
      const attachments = Array.isArray(result.success) ? result.success.map(summarizeAttachment) : [];
      const errors = Array.isArray(result.errors) ? result.errors.map(error => pickFields(asJsonRecord(error), ["code", "message"])) : [];
      return {
        ...toolResult(errors.length ? "Attachment upload has failures" : "Uploaded task attachment", {
          taskId, count: attachments.length, attachments, errors, partialSuccess: attachments.length > 0 && errors.length > 0,
        }),
        isError: attachments.length === 0,
      };
    },
  );

  server.registerTool(
    "delete_task_attachment",
    {
      title: "Delete Task Attachment",
      description: "Delete a task attachment.",
      inputSchema: strictInput({
        taskId: z.number().int().positive(),
        attachmentId: z.number().int().positive(),
      }),
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
    const actual = Buffer.from(apiKeyHeader);
    const expected = Buffer.from(config.apiKey);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  return false;
}

async function main() {
  if (process.env.VIKUNJA_MCP_VALIDATE_ONLY === "1") {
    console.error(`vikunja-mcp config ok for ${config.baseApiUrl} on port ${config.port}`);
    return;
  }

  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "vikunja-http",
    });
  });

  let activeRequests = 0;
  app.use(["/mcp", "/readyz"], (req, res, next) => {
    const origin = req.header("origin");
    if (!config.allowedHosts.includes((req.header("host") ?? "").toLowerCase()) ||
      (origin !== undefined && !config.allowedOrigins.includes(origin))) {
      res.status(403).json({ error: "Host or Origin is not allowed" });
      return;
    }
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
    next();
  });

  app.get("/readyz", async (_req, res) => {
    try {
      await getProjects({ perPage: 1 });
      if (config.requireAtomicUpdates) await atomicFieldUpdates.available();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use("/mcp", (req, res, next) => {
    if (activeRequests >= config.maxConcurrentRequests) {
      res.setHeader("Retry-After", "1");
      res.status(503).json({ error: "Server is busy" });
      return;
    }
    activeRequests++;
    const started = performance.now();
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      activeRequests--;
      const method = typeof req.body?.method === "string" ? req.body.method : undefined;
      const tool = method === "tools/call" && typeof req.body?.params?.name === "string" && /^[a-z_]{1,80}$/.test(req.body.params.name)
        ? req.body.params.name : undefined;
      console.error(JSON.stringify({ event: "mcp_request", requestId, method, tool, status: res.statusCode, durationMs: Math.round(performance.now() - started) }));
    };
    res.once("finish", finish);
    res.once("close", finish);
    next();
  });
  app.use("/mcp", express.json({ limit: "1mb", inflate: false }));

  app.all("/mcp", async (req, res) => {

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
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
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      void server.close().catch(() => undefined);
    };
    res.once("close", cleanup);
    res.once("finish", cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      cleanup();
      console.error(JSON.stringify({ event: "mcp_transport_error", name: error instanceof Error ? error.name : "Error" }));

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

  const handleHttpError: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = typeof error?.status === "number" && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (!res.headersSent) res.status(status).json({ error: status === 413 ? "Request body is too large" : status === 415 ? "Unsupported request encoding" : status === 400 ? "Invalid JSON request" : "Internal server error" });
  };
  app.use(handleHttpError);

  const httpServer = app.listen(config.port, config.host, () => {
    console.error(`vikunja-mcp listening on http://${config.host}:${config.port}/mcp`);
  });
  const shutdown = () => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => httpServer.closeAllConnections(), 10_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
