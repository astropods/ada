import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttachments } from "../agent/messaging/attachments.ts";
import { AdaMessagingAdapter } from "../agent/messaging/adapter.ts";
import { InMemoryStore } from "../agent/store/store.ts";
import { MAX_UPLOAD_FILES } from "../agent/session/uploads.ts";
import type { SessionRunner } from "../agent/session/runner.ts";
import type { StreamHooks, StreamOptions } from "@astropods/adapter-core";

/**
 * Wiring the messaging adapter (Slack/web chat) to the upload pipeline
 * `agent/session/uploads.ts` already validates, routes, and stages for the
 * browser's multipart path.
 *
 * `checkUploadLimits`/`routeUploads`/`describeUploads`/`writeUploads*` are
 * already thoroughly covered by test/file-upload.spec.ts — these tests only
 * cover the new glue: converting the SDK's `attachments`/`images` into the
 * `UploadInput` shape that pipeline expects, and `stream()`'s rejection path.
 */

type AttachmentInput = NonNullable<StreamOptions["attachments"]>[number];
type ImageInput = NonNullable<StreamOptions["images"]>[number];

function tempFile(name: string, content: string | Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "ada-attachments-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test("reads a staged attachment's bytes from its path", async () => {
  const path = tempFile("notes.txt", "hello from disk");
  const attachments: AttachmentInput[] = [{ key: "k1", name: "notes.txt", path, mimeType: "text/plain" }];

  const uploads = await readAttachments(attachments, undefined);

  expect(uploads).toHaveLength(1);
  expect(uploads[0].filename).toBe("notes.txt");
  expect(uploads[0].mimeType).toBe("text/plain");
  expect(Buffer.from(uploads[0].bytes).toString()).toBe("hello from disk");
});

test("an attachment with no path is skipped, not guessed at", async () => {
  const attachments: AttachmentInput[] = [{ key: "k1", name: "mystery.bin" }];
  const uploads = await readAttachments(attachments, undefined);
  expect(uploads).toHaveLength(0);
});

test("an attachment whose staged path does not actually exist is skipped, not thrown", async () => {
  const attachments: AttachmentInput[] = [
    { key: "k1", name: "ghost.bin", path: "/nonexistent/path/does-not-exist.bin" },
  ];
  await expect(readAttachments(attachments, undefined)).resolves.toHaveLength(0);
});

test("a data-URI image is decoded without touching disk", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const images: ImageInput[] = [
    { name: "shot.png", url: `data:image/png;base64,${png.toString("base64")}`, mimeType: "image/png" },
  ];

  const uploads = await readAttachments(undefined, images);

  expect(uploads).toHaveLength(1);
  expect(uploads[0].filename).toBe("shot.png");
  expect(uploads[0].mimeType).toBe("image/png");
  expect(Buffer.from(uploads[0].bytes)).toEqual(png);
});

test("an image delivered as a bare fetchable URL is skipped, not fetched", async () => {
  const images: ImageInput[] = [{ name: "shot.png", url: "https://example.com/shot.png", mimeType: "image/png" }];
  const uploads = await readAttachments(undefined, images);
  expect(uploads).toHaveLength(0);
});

test("attachments and images are merged into one batch", async () => {
  const path = tempFile("trace.log", "boom");
  const attachments: AttachmentInput[] = [{ key: "k1", name: "trace.log", path, mimeType: "text/plain" }];
  const images: ImageInput[] = [
    { name: "shot.png", url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}` },
  ];

  const uploads = await readAttachments(attachments, images);

  expect(uploads.map((u) => u.filename).sort()).toEqual(["shot.png", "trace.log"]);
});

// --- stream() wiring ---------------------------------------------------

function stubRunner(): { runner: SessionRunner; calls: Array<{ prompt: string; uploads?: unknown[] }> } {
  const calls: Array<{ prompt: string; uploads?: unknown[] }> = [];
  const runner = {
    async continueSession(_id: string, opts: { prompt: string; uploads?: unknown[] }) {
      calls.push({ prompt: opts.prompt, uploads: opts.uploads });
    },
  } as unknown as SessionRunner;
  return { runner, calls };
}

function recordingHooks(): { hooks: StreamHooks; chunks: string[]; state: { finished: boolean } } {
  const chunks: string[] = [];
  const state = { finished: false };
  const hooks = {
    onChunk(text: string) {
      chunks.push(text);
    },
    onStatusUpdate() {},
    onError() {},
    onFinish() {
      state.finished = true;
    },
    onTranscript() {},
    onAudioChunk() {},
    onAudioEnd() {},
    onFile() {},
  } as unknown as StreamHooks;
  return { hooks, chunks, state };
}

function opts(over: Partial<StreamOptions> = {}): StreamOptions {
  return {
    conversationId: "thread-1",
    userId: "U-human",
    ...over,
  } as unknown as StreamOptions;
}

test("a message with an attachment within limits reaches continueSession with uploads populated", async () => {
  const path = tempFile("trace.log", "boom");
  const { runner, calls } = stubRunner();
  const adapter = new AdaMessagingAdapter(new InMemoryStore(), runner);
  const { hooks } = recordingHooks();

  await adapter.stream(
    "what happened here?",
    hooks,
    opts({ attachments: [{ key: "k1", name: "trace.log", path, mimeType: "text/plain" }] as AttachmentInput[] }),
  );

  expect(calls).toHaveLength(1);
  expect(calls[0].uploads).toHaveLength(1);
  expect((calls[0].uploads?.[0] as { filename: string }).filename).toBe("trace.log");
});

test("too many attachments reject the whole turn before continueSession is called", async () => {
  const { runner, calls } = stubRunner();
  const adapter = new AdaMessagingAdapter(new InMemoryStore(), runner);
  const { hooks, chunks, state } = recordingHooks();

  const path = tempFile("f.txt", "x");
  const attachments: AttachmentInput[] = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => ({
    key: `k${i}`,
    name: `f${i}.txt`,
    path,
    mimeType: "text/plain",
  }));

  await adapter.stream("here are some files", hooks, opts({ attachments }));

  expect(calls, "continueSession must not run").toHaveLength(0);
  expect(chunks.join(""), "the user gets an actionable message").toContain("too many files");
  expect(state.finished).toBe(true);
});

test("a turn with no attachments is unaffected — uploads is empty, prompt unchanged", async () => {
  const { runner, calls } = stubRunner();
  const adapter = new AdaMessagingAdapter(new InMemoryStore(), runner);
  const { hooks } = recordingHooks();

  await adapter.stream("just a plain message", hooks, opts());

  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).toBe("just a plain message");
  expect(calls[0].uploads).toEqual([]);
});

test("a directive validates attachments but never threads them through (directives short-circuit)", async () => {
  const { runner, calls } = stubRunner();
  const adapter = new AdaMessagingAdapter(new InMemoryStore(), runner);
  const { hooks, chunks } = recordingHooks();

  const path = tempFile("f.txt", "x");
  const attachments: AttachmentInput[] = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => ({
    key: `k${i}`,
    name: `f${i}.txt`,
    path,
    mimeType: "text/plain",
  }));

  await adapter.stream("whoami", hooks, opts({ attachments }));

  // Over-limit attachments on a directive-shaped message still refuse the
  // turn — validated before parseDirective, same as any other message.
  expect(calls).toHaveLength(0);
  expect(chunks.join("")).toContain("too many files");
});
