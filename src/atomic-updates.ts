type ApiFetch = (
  path: string,
  init?: RequestInit,
  version?: 1 | 2,
) => Promise<{ data: unknown; status: number; headers: Headers }>;

type Resource = "tasks" | "projects" | "labels";

const updateTools = [
  "update_task", "complete_task", "move_task_to_project", "set_task_due_date",
  "set_task_reminders", "set_task_repeat", "update_project", "update_label",
] as const;

export function createAtomicFieldUpdates(fetchApi: ApiFetch, required: boolean) {
  let discovery: Promise<{ atomic: boolean; version: string | null }> | undefined;

  async function describe() {
    discovery ??= fetchApi("/info").then(({ data }) => {
      const info = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
      return {
        atomic: info.atomic_field_updates === 1,
        version: typeof info.version === "string" ? info.version : null,
      };
    }).catch(error => {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
        return { atomic: false, version: null };
      }
      discovery = undefined;
      throw error;
    });
    const info = await discovery;
    const stockSupported = /^v?2\.7\.(?:0|1)(?:[+-].*)?$/.test(info.version ?? "");
    const blockedReason = !info.atomic && required
      ? "Atomic field updates are required, but this Vikunja instance does not advertise protocol 1. The operator can use stock compatibility mode with VIKUNJA_REQUIRE_ATOMIC_UPDATES=0. No changes were written."
      : !info.atomic && !stockSupported
        ? `Stock updates are verified only for Vikunja 2.7.0 and 2.7.1; the backend reports ${info.version ?? "an unknown version"}. No changes were written.`
        : null;
    const updateMode = blockedReason ? "blocked" : info.atomic ? "atomic" : "stock";
    return {
      backendVersion: info.version,
      atomicFieldUpdates: info.atomic,
      atomicUpdatesRequired: required,
      updateMode,
      supportedUpdateTools: blockedReason ? [] : [...updateTools],
      unsupportedOperations: info.atomic ? [] : ["clear_nonempty_project_description"],
      blockedReason,
      limitations: updateMode === "stock" ? [
        "Stock updates are serialized within this MCP process only. Reminder, project and label writes can overwrite concurrent edits from other clients.",
        "Stock Vikunja cannot clear a non-empty project description.",
      ] : [],
    };
  }

  async function available() {
    const capabilities = await describe();
    if (capabilities.blockedReason) {
      throw new Error(capabilities.blockedReason);
    }
    return capabilities.atomicFieldUpdates;
  }

  async function write(resource: Resource, id: number, values: Record<string, unknown>, fields: string[]) {
    if (fields.length === 0) throw new Error("An atomic field update requires a non-empty field mask");
    const response = await fetchApi(`/${resource}/${id}/fields?format=html`, {
      method: "POST",
      body: JSON.stringify({ ...values, update_fields: fields }),
    }, 2);
    const data = response.data;
    if (typeof data !== "object" || data === null || !("id" in data) || data.id !== id) {
      throw new Error(`Unexpected atomic ${resource} update response. The write outcome is unknown; read ${resource}/${id} before retrying.`);
    }
    return data as Record<string, unknown>;
  }

  return { available, describe, write };
}
