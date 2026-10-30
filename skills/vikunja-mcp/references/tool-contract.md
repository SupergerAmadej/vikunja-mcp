# Tool contract and limits

Reviewed against this server snapshot; the connected host may expose a different
version. Use its advertised schemas, and request a connection refresh or explain
the limitation if a required field or tool is absent.

```json
{
  "mcpVersion": "0.2.1",
  "toolCount": 42,
  "schemaSha256": "29e3884bb212eae8979e81047bb741ff0f484f0e353820421c51fe63c32d2f97"
}
```

## Choose an operation

| Intent | Logical tools / boundary |
| --- | --- |
| Find a project or task | `list_projects`, `get_project`, `list_tasks`, `get_task`, `get_task_by_identifier` |
| Create or edit a task | `create_task`, `update_task`; unknown keys and an edit with no supported field are rejected |
| Finish or move a task | `complete_task`, `move_task_to_project`; a project move is not a board-bucket move |
| Add/remove a label | `list_labels`, `add_task_label`, `remove_task_label`; use `create_label` only when creation fits the request |
| Replace labels or assignees | `replace_task_labels`, `set_task_assignees`; first obtain a complete set if preserving members |
| Link tasks | Generic relation tools or the explicit parent/child subtask helpers; relation creation does not create either task |
| Comments | `list_task_comments`, `add_task_comment`, `update_task_comment`, `delete_task_comment` |
| Files | `list_task_attachments`, `upload_task_attachment`, `delete_task_attachment`; listing metadata does not retrieve content |
| Project or label changes | Their create/update/delete tools; there is no general sharing, membership or account administration interface |

All input objects are strict. `create_task` accepts project, title, description,
due date and priority; it does not accept assignees, labels, start/end dates or
arbitrary backend fields. Perform supported follow-up steps when requested.
`update_task` supports title, description, done, dueDate, priority and percentDone.
`dueDate: null` clears the date. A supplied, unchanged value is a valid edit.
`priority` is an integer from 0 to 5; `percentDone` is an integer from 0 to 100.

`get_task` expansions are `subtasks`, `buckets`, `reactions`, `comments`,
`comment_count`, `time_entries_count`, and `is_unread`. Expansions do not add
mutation capabilities or establish complete global search coverage.

Request only the expansions needed for the task. Scoped tokens need
`reactions.read_all` for `reactions`, `time_entries.read_all` for
`time_entries_count`, and `tasks_comments.read_all` for `comments` or
`comment_count`, in addition to permission for the task read. These are backend
token scopes, not extra tool arguments. A 401/403 on an expansion can therefore
occur while a basic task read still works; it does not establish token expiry.
Retry the same read without optional expansions to establish basic access, then
isolate required expansions if necessary. Report unavailable data when it affects
the answer and identify the relevant read scope; do not change token permissions
as part of ordinary task work. A successful read may omit expansion fields, so
absence alone does not establish an empty collection or a zero count.

## Dates, reminders and repetition

Use an explicit timezone/offset when turning calendar language into a timestamp.
The server normalizes RFC3339 offsets to UTC; date-only strings and local times
without an offset are rejected. Clearing a date may return an unset backend
timestamp instead of JSON null; do not present year 0001 as a real deadline.

Each reminder is exactly one of:

- Absolute: `{"reminder":"2027-01-11T08:45:00+01:00"}`.
- Relative: `{"relativeTo":"due_date","relativePeriodSeconds":-900}`.

Relative bases are `due_date`, `start_date` or `end_date`; the base must already
be set. These tools cannot set start/end dates. A negative offset means before,
zero means at the base. At most 100 reminders are accepted; an offset's maximum
magnitude is 315360000 seconds. Do not send an absolute timestamp and a relative
form in the same item. When preserving backend reminders, map `relative_to` and
`relative_period` into the input's camelCase keys and omit read-only fields.
Prefer the relative form when a stored reminder already has a valid relative
base; otherwise retain its actual absolute `reminder` timestamp.

Prefer named repeat modes:

| `mode` | `repeatAfterSeconds` |
| --- | --- |
| `none` | Omit or use 0; explicitly disables repetition |
| `monthly` | Omit or use 0; calendar monthly repetition |
| `interval` | Positive integer, maximum 315360000 |
| `fromCompletion` | Positive integer, maximum 315360000 |

Do not combine `mode` with legacy `repeatMode`. In legacy calls, numeric modes
0/1/2 mean interval/monthly/from-current-date; prefer names to avoid ambiguity.
A zero interval without explicit monthly mode disables repetition, including an
existing monthly task. Completing a recurring task can return `done: false` with
its next dates. Report that state; do not complete it again to force `done: true`.
Weekday calendars, cron schedules and arbitrary recurrence rules are unsupported.

## Pagination and discovery gaps

`list_projects`, `list_tasks` and `list_labels` expose `page`, `perPage` and
`search`; task listing also exposes `projectId` and `includeDone`. Some task
subresource lists expose paging, but comments and subtask listing do not. Inspect
the actual schema rather than passing paging keys everywhere. The backend may
cap the requested page size. `completeness` describes one response; combining
every page from the first through the last can establish full requested coverage.

`list_task_labels` collects native backend pages before applying the requested
MCP page size. This compensates for the v1 handler ignoring `per_page` and keeps
`totalPages` stable even for a requested page beyond the end. The scan is bounded
to 100 native pages; invalid or repeated IDs, inconsistent totals, an early empty
page, or exceeding that bound cause a tool error rather than a claim of full
coverage. Do not replace a collection while claiming to preserve unseen members
when listing failed. On older deployed builds or other endpoints, still check
that item counts and continuation metadata agree and report uncertain coverage
when they conflict.

There are no tool arguments for arbitrary due-date/label/assignee filters, no
user search or project-member directory, no dedicated project-view/bucket listing,
and no bucket-move tool. `get_current_user` can resolve "me"; it cannot resolve a
colleague by name. Its `source` and `note` distinguish an API user response from
configured or token-owner fallback metadata. The MCP fallback omits unset or
placeholder optional fields. Do not describe configured fields as API-verified
or invent an email address when it is absent.
Obtain a verified user ID from the user or another already authorized source.
Do not guess it or discover it by reading credentials.

`set_task_position` requires `taskId`, `projectViewId` and a numeric position.
`get_task` with `expand: ["buckets"]` may expose `project_view_id` in bucket
metadata. Reuse that verified ID only when it
identifies the intended view; this does not enumerate all views or their names.
Do not infer the view from a project ID or promise a named board move. An
identifier such as `OPS-17` is not necessarily numeric task ID 17.

## Attachments and concurrent changes

Uploads need `taskId`, `filename` and exactly one of `contentBase64` or
`serverFilePath`. The usual maximum decoded size is 524288 bytes; operators can
configure another bound. Local server-file imports are disabled by default and,
when enabled, are confined to an operator-controlled import directory. A local
client file path is not automatically a path inside the MCP container. Use
base64 from an explicitly authorized input file instead of guessing server paths.

Inspect `attachments`, `errors`, `partialSuccess` and tool `isError`. A partial
upload is not full success. Do not re-upload successful files when reconciling
failures. Attachment metadata alone cannot support a summary of file contents;
the current tool set has no attachment-download tool.

The supported deployment uses backend atomic field updates, required by default.
A missing/denied field route fails instead of falling back to a replacement.
Stock compatibility has cross-client limits and is an operator choice, not a
skill workaround. Atomic field masks preserve unrelated fields; they do not
merge conflicting replacements of the same collection or add revision-based
compare-and-swap. A read/merge/write of assignees or reminders can still conflict
with another writer replacing that collection. Reconcile a detected conflict;
never promise that skill instructions make the merge transactionally safe.
