# Workflow recipes

The examples use illustrative IDs and explicit example dates. Resolve real IDs
on the selected instance and compute the date from the actual request. Logical
tool names omit the host-specific namespace; these are examples, not executable
instructions to create sample tasks in a user's workspace.

## Capture a task or linked subtask

Resolve the project with the supplied ID or a sufficiently complete search. For
an existing parent, resolve its identifier or task ID and project. If the user
wants a new child, create it once, then link its returned ID. In this example,
the parent is 201 in project 101 and creation returned child ID 202:

```json
[
  {"tool":"create_task","arguments":{"projectId":101,"title":"Draft launch notes","dueDate":"2027-01-11T09:00:00+01:00"}},
  {"tool":"create_subtask_relation","arguments":{"parentTaskId":201,"subtaskId":202}}
]
```

If creation succeeds and linking fails, report child 202 and the failed link.
Do not recreate or delete the child automatically. Reconcile a timed-out create
with a scoped search for matching title, project, dates and returned evidence;
duplicates or incomplete coverage leave the outcome uncertain.

## Make a focused edit

Read the task when needed to resolve identity or inspect relevant state. Send
only the requested changes; do not copy the whole read response into an update.
For "50% complete and clear its deadline", use:

```json
{"tool":"update_task","arguments":{"taskId":201,"percentDone":50,"dueDate":null}}
```

The output fraction 0.5 means 50%, not 0.5%. Finishing a task is a completion
operation, rather than an instruction to set its progress percentage. A project
description clear is `update_project` with `description: ""`; if an older server
rejects the clear, report that no unsupported clear was applied.

## Add collection members without removing others

For a label, resolve or appropriately create the label and use `add_task_label`.
For an assignee addition, obtain the complete current assignee list, resolve the
new user to a verified ID and union/deduplicate IDs. Suppose the current set is
7 and 8, and the explicitly identified new user is 42:

```json
[
  {"tool":"list_task_assignees","arguments":{"taskId":201,"page":1,"perPage":100}},
  {"tool":"set_task_assignees","arguments":{"taskId":201,"userIds":[7,8,42]}}
]
```

Follow additional assignee pages before the replacement when necessary. If "Sam"
is ambiguous or no user lookup is available, ask for the user ID while completing
independent read work. Do not replace the current set with an empty or guessed
one. For removals, preserve everyone except the explicitly selected users.

For reminders, read the existing task reminders, retain their meaningful forms
and add the requested item. Suppose it already has one relative reminder before
its set due date and the user adds an absolute reminder:

```json
{"tool":"set_task_reminders","arguments":{"taskId":201,"reminders":[{"relativeTo":"due_date","relativePeriodSeconds":-900},{"reminder":"2027-01-10T18:00:00+01:00"}]}}
```

Do not send a stored `id` or mix stored snake_case response keys with input keys.
If another writer may have changed this same collection, reconcile the latest
state before replacing it and explain any unresolved conflicting intent.

## Schedule and complete recurring work

Resolve "tomorrow" against the user's current calendar date. Apply the offset
appropriate to the target date; do not reuse today's offset across a DST change.
For an unset relative base, set a supported due date first only when the user
has specified it. Otherwise ask for it or explain the unsupported base date.

```json
[
  {"tool":"set_task_due_date","arguments":{"taskId":201,"dueDate":"2027-01-11T09:00:00+01:00"}},
  {"tool":"set_task_reminders","arguments":{"taskId":201,"reminders":[{"relativeTo":"due_date","relativePeriodSeconds":-900}]}},
  {"tool":"set_task_repeat","arguments":{"taskId":201,"mode":"fromCompletion","repeatAfterSeconds":86400}}
]
```

Use `mode: "none"` to stop repetition. If completing a recurring task returns
it reopened with a new deadline, explain that this occurrence was completed and
the next one is active. After a timeout, read its state and any history already available
before another completion; a second call may complete a second occurrence.
Explain when a weekday-only or business-calendar schedule cannot be represented.

## Review and prioritize a project

Resolve project 101 and retrieve the requested status scope. A completed-work
review needs `includeDone: true`; an open-work review does not:

```json
{"tool":"list_tasks","arguments":{"projectId":101,"includeDone":false,"page":1,"perPage":100}}
```

Follow continuation for all required pages. If a later page fails, report the
successful pages and incomplete coverage. Count unique task IDs across retrieved
pages rather than adding legacy headers. Use actual deadline, completion,
priority and relation data for the review. Mark inferred priorities as proposals;
a read-only review does not authorize changing priorities or deadlines.

## Attach a provided file

Use the user-provided file/content as the input. This tiny example is the base64
of "hello", not a file to upload unless the user actually requests it:

```json
{"tool":"upload_task_attachment","arguments":{"taskId":201,"filename":"notes.txt","mimeType":"text/plain","contentBase64":"aGVsbG8="}}
```

Check success and per-file errors. If asked to summarize an existing attachment,
first establish access to its content through a supported, authorized source.
Listing a filename does not mean the brief was read. Report the current download
capability gap instead of inventing a tool or pulling credentials from disk.
