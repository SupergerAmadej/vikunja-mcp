import { z } from "zod/v4";

export function strictInput<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject(shape);
}

export function patchInput<Shape extends z.ZodRawShape>(shape: Shape, idField: keyof Shape) {
  return strictInput(shape).refine(
    value => Object.entries(value).some(([key, entry]) => key !== idField && entry !== undefined),
    { message: "Provide at least one supported field to update" },
  );
}

export const dateTimeInput = z.string().datetime({ offset: true })
  .refine(value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999;
  }, "Timestamp must normalize to a UTC year from 0001 to 9999")
  .describe("RFC3339 timestamp with Z or an explicit UTC offset; normalized to UTC. Date-only values are not accepted.");

export function utcDateTime(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString().replace(".000Z", "Z");
}

const reminderRelation = z.enum(["due_date", "start_date", "end_date"])
  .describe("Existing task date used as the reminder base.");

export const reminderInput = z.union([
  strictInput({ reminder: dateTimeInput.refine(value => new Date(value).getTime() !== Date.parse("0001-01-01T00:00:00Z"), "An absolute reminder cannot use the unset timestamp") }),
  strictInput({
    relativeTo: reminderRelation,
    relativePeriodSeconds: z.number().int().min(-315_360_000).max(315_360_000)
      .describe("Signed seconds from the base date; negative is before it, zero is at it. Maximum magnitude: ten years."),
  }),
]);

export function taskReminders(reminders: z.infer<typeof reminderInput>[], task: Record<string, unknown>) {
  return reminders.map(reminder => {
    if ("reminder" in reminder) return { reminder: utcDateTime(reminder.reminder) };
    const base = task[reminder.relativeTo];
    const date = typeof base === "string" ? new Date(base) : undefined;
    if (!date || !Number.isFinite(date.getTime()) || date.getUTCFullYear() <= 1) {
      throw new Error(`Cannot set relative reminder: task ${reminder.relativeTo} is not set. No changes were written.`);
    }
    const target = new Date(date.getTime() + reminder.relativePeriodSeconds * 1000);
    if (!Number.isFinite(target.getTime()) || target.getUTCFullYear() <= 1 || target.getUTCFullYear() > 9999) {
      throw new Error("Relative reminder falls outside the supported timestamp range. No changes were written.");
    }
    return { relative_to: reminder.relativeTo, relative_period: reminder.relativePeriodSeconds };
  });
}

export const repeatInput = strictInput({
  taskId: z.number().int().positive(),
  mode: z.enum(["none", "interval", "monthly", "fromCompletion"]).optional()
    .describe("Semantic repeat mode. none clears repetition; monthly ignores the interval; interval/fromCompletion require a positive interval."),
  repeatAfterSeconds: z.number().int().min(0).max(315_360_000).optional()
    .describe("Repeat interval in seconds, at most ten years. Without mode, zero disables repetition unless repeatMode is explicitly monthly (1)."),
  repeatMode: z.number().int().min(0).max(2).optional()
    .describe("Legacy numeric mode: 0 interval, 1 monthly, 2 from current date. Do not combine with mode."),
}).superRefine((value, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });
  if (value.mode !== undefined) {
    if (value.repeatMode !== undefined) reject("Use mode or repeatMode, not both");
    if (["interval", "fromCompletion"].includes(value.mode)) {
      if (!value.repeatAfterSeconds) reject("This repeat mode requires a positive repeatAfterSeconds");
    } else if (value.repeatAfterSeconds !== undefined && value.repeatAfterSeconds !== 0) {
      reject("none and monthly do not accept a nonzero repeatAfterSeconds");
    }
  } else {
    if (value.repeatAfterSeconds === undefined) reject("Provide mode or repeatAfterSeconds");
    if (value.repeatMode === 2 && value.repeatAfterSeconds === 0) reject("Mode 2 requires a positive repeatAfterSeconds");
  }
});

export function taskRepeat(input: z.infer<typeof repeatInput>, task: Record<string, unknown>) {
  if (input.mode !== undefined) {
    const repeat_mode = { none: 0, interval: 0, monthly: 1, fromCompletion: 2 }[input.mode];
    return { repeat_mode, repeat_after: input.repeatAfterSeconds ?? 0 };
  }
  return {
    repeat_after: input.repeatAfterSeconds!,
    repeat_mode: input.repeatMode ?? (input.repeatAfterSeconds === 0 ? 0 : task.repeat_mode ?? 0),
  };
}
