import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";
import { z, type ZodIssue } from "zod";

export const beatTargetSchema = z.enum(["page", "popup"]);
export type BeatTarget = z.infer<typeof beatTargetSchema>;

const positiveInteger = z.number().int().positive();
const duration = z.number().int().nonnegative();

const gotoStepSchema = z.object({
  verb: z.literal("goto"),
  url: z.string().url(),
});

const waitStepSchema = z.object({
  verb: z.literal("wait"),
  target: beatTargetSchema.default("page"),
  selector: z.string().optional(),
  ms: duration.optional(),
  expression: z.string().optional(),
  timeoutMs: duration.default(20_000),
});

const clickStepSchema = z.object({
  verb: z.literal("click"),
  target: beatTargetSchema.default("page"),
  selector: z.string(),
});

const typeStepSchema = z.object({
  verb: z.literal("type"),
  target: beatTargetSchema.default("page"),
  selector: z.string(),
  text: z.string(),
  perCharMs: duration.default(40),
});

const scrollStepSchema = z.object({
  verb: z.literal("scroll"),
  target: beatTargetSchema.default("page"),
  deltaY: z.number().int(),
  steps: positiveInteger.default(8),
  stepMs: duration.default(40),
});

const hoverStepSchema = z.object({
  verb: z.literal("hover"),
  target: beatTargetSchema.default("page"),
  selector: z.string(),
});

const openPopupStepSchema = z.object({
  verb: z.literal("openPopup"),
});

const closePopupStepSchema = z.object({
  verb: z.literal("closePopup"),
});

export const cameraFocusSchema = z.enum(["page", "popup", "none"]);
export type CameraFocus = z.infer<typeof cameraFocusSchema>;

const cameraStepSchema = z.object({
  verb: z.literal("camera"),
  zoom: z.number(),
  focus: cameraFocusSchema.default("none"),
  ms: duration.default(600),
});

const holdStepSchema = z.object({
  verb: z.literal("hold"),
  ms: duration,
});

const markStepSchema = z.object({
  verb: z.literal("mark"),
  name: z.string(),
});

export const beatStepSchema = z.discriminatedUnion("verb", [
  gotoStepSchema,
  waitStepSchema,
  clickStepSchema,
  typeStepSchema,
  scrollStepSchema,
  hoverStepSchema,
  openPopupStepSchema,
  closePopupStepSchema,
  cameraStepSchema,
  holdStepSchema,
  markStepSchema,
]).superRefine((step, context) => {
  if (step.verb !== "wait") return;

  const conditionCount = [step.selector, step.ms, step.expression]
    .filter((condition) => condition !== undefined)
    .length;
  if (conditionCount !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "wait requires exactly one of selector, ms, or expression",
    });
  }
});

export const beatSheetSchema = z.object({
  version: z.literal(1),
  title: z.string(),
  viewport: z.object({
    width: positiveInteger,
    height: positiveInteger,
    scale: positiveInteger.default(2),
  }),
  extension: z.object({
    path: z.string(),
    popupPath: z.string().default("popup.html"),
    popup: z.object({
      width: positiveInteger.default(600),
      height: positiveInteger.default(600),
    }).default({}),
  }),
  stageUrlSubstring: z.string().optional(),
  output: z.object({
    fps: positiveInteger.default(30),
    holdTailMs: duration.default(2_000),
  }).default({}),
  steps: z.array(beatStepSchema),
});

export type BeatStep = z.infer<typeof beatStepSchema>;
export type BeatSheet = z.infer<typeof beatSheetSchema>;

function formatIssue(issue: ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "beat sheet";
  return `${path}: ${issue.message}`;
}

export function parseBeatSheet(yamlText: string): BeatSheet {
  let input: unknown;
  try {
    input = parseYaml(yamlText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid beat sheet YAML: ${message}`, { cause: error });
  }

  const result = beatSheetSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid beat sheet:\n${result.error.issues.map(formatIssue).join("\n")}`,
      { cause: result.error },
    );
  }
  return result.data;
}

export function loadBeatSheet(filePath: string): BeatSheet {
  return parseBeatSheet(readFileSync(filePath, "utf8"));
}
