type ApiFetch = (
  path: string,
  init?: RequestInit,
  version?: 1 | 2,
) => Promise<{ data: unknown; status: number; headers: Headers }>;

type Resource = "tasks" | "projects" | "labels";

export function createAtomicFieldUpdates(fetchApi: ApiFetch, required: boolean) {
  let discovery: Promise<boolean> | undefined;

  async function available() {
    discovery ??= fetchApi("/info").then(({ data }) =>
      typeof data === "object" && data !== null &&
      "atomic_field_updates" in data && data.atomic_field_updates === 1,
    ).catch(error => {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 404) return false;
      discovery = undefined;
      throw error;
    });
    const supported = await discovery;
    if (required && !supported) {
      throw new Error("Atomic field updates are required, but this Vikunja instance does not advertise protocol 1. Install the reviewed upstream patch; no changes were written.");
    }
    return supported;
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

  return { available, write };
}
