/**
 * Convert the messaging SDK's inbound attachments/images into the
 * `UploadInput` shape `session/uploads.ts` already validates, routes, and
 * stages — so the messaging adapter (Slack/web chat) reuses exactly the same
 * pipeline the browser's multipart upload path does, rather than a second
 * one.
 *
 * Two SDK fields, two different byte sources:
 *
 *  - `attachments` (non-image files): bytes staged on the agent's shared
 *    files volume, read at `path`. `path` can be absent (older sidecar/proto,
 *    per the SDK's own doc comment) — skipped rather than guessed at. The
 *    SDK's documented fallback is to scan the agent's files dir for
 *    `<key>.blob`; that scan isn't implemented here (undocumented exact
 *    contract, and the common case always has `path`) — a known, logged gap,
 *    not a silent wrong guess.
 *
 *  - `images`: delivered inline, bytes in a `url` data URI
 *    (`data:<mime>;base64,...`) — no disk read needed. The SDK also allows "a
 *    directly fetchable image URL" there; that form is skipped, not fetched —
 *    pulling an arbitrary, message-supplied URL from agent-side code is its
 *    own surface (SSRF, timeouts, trust) and out of scope here.
 *
 * `routeUploads` (session/uploads.ts) decides image-vs-file purely by MIME
 * type, so a decoded `images` entry flows through exactly like an image
 * `attachments` entry would.
 */

import { readFile } from "node:fs/promises";
import type { StreamOptions } from "@astropods/adapter-core";
import type { UploadInput } from "../session/uploads.ts";

// Not re-exported from @astropods/adapter-core's public entry (its `exports`
// map only has "." and "./instrument") — derive off the type that is.
type AttachmentInput = NonNullable<StreamOptions["attachments"]>[number];
type ImageInput = NonNullable<StreamOptions["images"]>[number];

const DATA_URI = /^data:([^;,]*)(;base64)?,/i;

/** Decode a `data:<mime>;base64,...` URI. Null for anything else, including
 *  a bare fetchable URL (see module doc) or a non-base64 data URI. */
function decodeDataUri(url: string): { mimeType?: string; bytes: Uint8Array } | null {
  const m = url.match(DATA_URI);
  if (!m || !m[2]) return null;
  return { mimeType: m[1] || undefined, bytes: Buffer.from(url.slice(m[0].length), "base64") };
}

/**
 * Read this turn's attachments and images into one batch, in the order
 * `checkUploadLimits`/`routeUploads` expect. Partially undeliverable items
 * (a missing path, an image as a bare URL) are skipped and logged — not a
 * whole-turn rejection, since that's a platform/protocol gap, not a policy
 * violation the user caused.
 */
export async function readAttachments(
  attachments: AttachmentInput[] | undefined,
  images: ImageInput[] | undefined,
): Promise<UploadInput[]> {
  const out: UploadInput[] = [];

  for (const a of attachments ?? []) {
    if (!a.path) {
      console.warn(`[messaging] attachment "${a.name}" has no staged path; skipping`);
      continue;
    }
    try {
      out.push({
        filename: a.name,
        mimeType: a.mimeType ?? "application/octet-stream",
        bytes: await readFile(a.path),
      });
    } catch {
      // The platform said bytes were staged; they aren't actually there.
      // Not the user's fault — note it server-side, don't fail the turn.
      console.warn(`[messaging] attachment "${a.name}" could not be read at its staged path`);
    }
  }

  for (const img of images ?? []) {
    const decoded = decodeDataUri(img.url);
    if (!decoded) {
      console.warn(`[messaging] image "${img.name}" is a fetchable URL, not a data URI; skipping`);
      continue;
    }
    out.push({
      filename: img.name,
      mimeType: img.mimeType ?? decoded.mimeType ?? "image/png",
      bytes: decoded.bytes,
    });
  }

  return out;
}
