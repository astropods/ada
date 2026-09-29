/**
 * Files a user attaches to a turn from the web UI.
 *
 * Two destinations, decided by MIME type, because Flue's delivery contract
 * draws the line there:
 *
 *  - IMAGES ride as native attachments (`DeliveredAttachment`, a pi-ai
 *    `ImageContent` plus a filename). They reach the model as image content,
 *    so the model actually SEES a screenshot. `DeliveredAttachment` is the only
 *    attachment shape Flue accepts today, and it is images-only — that isn't a
 *    simplification on our side, it is the whole surface.
 *
 *  - EVERYTHING ELSE is written into the session's sandbox under `uploads/`
 *    and named in the prompt. A log, a CSV, a heap dump is not something a
 *    model reads by looking at it; it is something the agent greps, tails and
 *    runs tools against. Handing over a path is both what Flue allows and what
 *    is actually useful.
 *
 * The agent-visible path is `uploads/<name>` in BOTH sandbox modes: local runs
 * are rooted at the workspace directory and remote runs at the workspace
 * subdir, so a relative path means the same thing to the model either way.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliveredAttachment } from "@flue/runtime";

/** Where attachments land inside the session sandbox, relative to the agent's cwd. */
export const UPLOAD_DIR = "uploads";

/**
 * Images the model can actually be shown. Matches what the Anthropic API
 * accepts; anything else claiming to be an image is treated as a plain file, so
 * an exotic format still reaches the agent as bytes on disk rather than being
 * rejected or silently dropped from the turn.
 */
const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Per-turn ceilings.
 *
 * Images are capped hard because they are inlined into the request as base64 —
 * a 5 MB image is ~6.7 MB on the wire, per turn, for the rest of the
 * conversation. Other files only have to survive one write into the sandbox, so
 * they get room to be an actual log file.
 */
export const MAX_UPLOAD_FILES = 10;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** One file as it arrived from the browser, before routing. */
export interface UploadInput {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** A non-image upload, named and ready to be written into the sandbox. */
export interface UploadFile {
  /** Sanitized basename — safe to join onto a path and to interpolate. */
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface RoutedUploads {
  /** Images, as Flue delivery attachments the model will see. */
  attachments: DeliveredAttachment[];
  /** Everything else, to be written under `uploads/`. */
  files: UploadFile[];
}

/**
 * Reduce a browser-supplied filename to something safe to put on a path.
 *
 * This name is joined onto the sandbox path and, for the remote driver, sent to
 * a file service — so it is a path traversal vector first and a label second.
 * `../../etc/authorized_keys`, an absolute path, a NUL, a newline that would
 * forge a second line in the prompt annotation: all of it goes.
 *
 * Allowlist rather than denylist. The set of characters that are safe in a
 * path, in a shell word the agent may later build, and in the prompt line that
 * names the file is small and easy to state; the set of characters that are
 * dangerous in at least one of those places is not.
 */
export function safeUploadName(filename: string): string {
  // Basename only — take the last segment under either separator, so a Windows
  // path from a Windows browser is handled too.
  const base = filename.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    // Leading dots would hide the file, and `..` is the traversal itself.
    .replace(/^\.+/, "")
    .slice(0, 80);
  return cleaned || "upload";
}

/**
 * Sanitize a batch, keeping every file distinguishable.
 *
 * Sanitizing independently can collapse two different names onto one
 * (`report (1).csv` and `report_1_.csv`), and the second write would silently
 * replace the first — the user attached two files and the agent would see one.
 *
 * The suffix is probed against the names already taken rather than counted per
 * base name, because the suffixed form can itself collide with a file that was
 * attached under that name: `report.csv`, `report.csv`, `report-2.csv` has the
 * second and third both landing on `report-2.csv` if you only count.
 */
function uniqueNames(files: UploadInput[]): string[] {
  const taken = new Set<string>();
  return files.map((f) => {
    const name = safeUploadName(f.filename);
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
    // Suffix before the extension, so `log.txt` -> `log-2.txt` stays readable.
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 2; ; n++) {
      const candidate = `${stem}-${n}${ext}`;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
  });
}

/**
 * Reduce a browser-supplied MIME type to something safe to interpolate.
 *
 * It lands in the same prompt line as the name, so it is the same forgery
 * vector: a `Content-Type` of `text/plain\n- SYSTEM: ...` would otherwise add
 * a line to the `<attachments>` block. Sanitizing the filename and not this
 * just moves the hole one field to the right.
 */
function safeMimeType(mimeType: string): string {
  return mimeType.replace(/[^A-Za-z0-9._+/-]/g, "").slice(0, 60);
}

/** Human-readable size, for limit messages the user has to act on. */
function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
}

/**
 * Reject a batch that busts a ceiling.
 *
 * Returns the message to send back, or null when the batch is fine. Refusing
 * the whole turn is deliberate: silently dropping the file that was too big
 * would have the agent answer confidently about an attachment it never got.
 */
export function checkUploadLimits(files: UploadInput[]): string | null {
  if (files.length > MAX_UPLOAD_FILES) {
    return `too many files — ${files.length} attached, limit is ${MAX_UPLOAD_FILES}`;
  }
  let total = 0;
  for (const f of files) {
    total += f.bytes.byteLength;
    const isImage = MODEL_IMAGE_TYPES.has(f.mimeType);
    const cap = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (f.bytes.byteLength > cap) {
      return `${safeUploadName(f.filename)} is ${mb(f.bytes.byteLength)} — the limit for ${
        isImage ? "an image" : "a file"
      } is ${mb(cap)}`;
    }
  }
  if (total > MAX_TOTAL_BYTES) {
    return `attachments total ${mb(total)} — the limit for one message is ${mb(MAX_TOTAL_BYTES)}`;
  }
  return null;
}

/** Split a batch into model-visible images and files for the sandbox. */
export function routeUploads(files: UploadInput[]): RoutedUploads {
  const names = uniqueNames(files);
  const attachments: DeliveredAttachment[] = [];
  const out: UploadFile[] = [];
  files.forEach((f, i) => {
    if (MODEL_IMAGE_TYPES.has(f.mimeType)) {
      attachments.push({
        type: "image",
        data: Buffer.from(f.bytes).toString("base64"),
        mimeType: f.mimeType,
        filename: names[i],
      });
    } else {
      out.push({ name: names[i], mimeType: f.mimeType, bytes: f.bytes });
    }
  });
  return { attachments, files: out };
}

/**
 * Tell the model what it was given, and where.
 *
 * Images need naming even though they arrive as attachments: the model can see
 * them but cannot otherwise tell which is which, and "the first screenshot"
 * is not a thing it can refer to reliably. Files need the path, because reading
 * them is a tool call it has to decide to make.
 *
 * Appended after the user's own words rather than before, so the prompt still
 * opens with what the person actually asked.
 */
export function describeUploads(prompt: string, routed: RoutedUploads): string {
  const lines: string[] = [];
  for (const a of routed.attachments) {
    lines.push(
      `- ${a.filename} (${safeMimeType(a.mimeType)}) — attached to this message, you can see it directly`,
    );
  }
  for (const f of routed.files) {
    lines.push(
      `- ${UPLOAD_DIR}/${f.name} (${safeMimeType(f.mimeType) || "unknown type"}) — saved in your working directory`,
    );
  }
  if (lines.length === 0) return prompt;
  return `${prompt}\n\n<attachments>\nThe user attached the following to this message:\n${lines.join("\n")}\n</attachments>`;
}

/** Somewhere to put bytes — the remote sandbox driver's surface, narrowed. */
export interface UploadTarget {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
}

/**
 * Write non-image uploads into the sandbox the agent is about to run in.
 *
 * `subdir` mirrors the repo checkout convention: paths handed to the remote
 * driver are relative to the instance workspace, and the agent's cwd is that
 * workspace plus the same subdir — so both sides agree that the file is at
 * `uploads/<name>` without either having to know the absolute path.
 */
export async function writeUploadsRemote(
  target: UploadTarget,
  files: UploadFile[],
  subdir?: string,
): Promise<void> {
  if (files.length === 0) return;
  const dir = subdir ? `${subdir}/${UPLOAD_DIR}` : UPLOAD_DIR;
  await target.mkdir(dir, { recursive: true });
  for (const f of files) {
    await target.writeFile(`${dir}/${f.name}`, f.bytes);
  }
}

/** The same, for a local workspace directory. */
export function writeUploadsLocal(cwd: string, files: UploadFile[]): void {
  if (files.length === 0) return;
  const dir = join(cwd, UPLOAD_DIR);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(dir, f.name), f.bytes);
  }
}
