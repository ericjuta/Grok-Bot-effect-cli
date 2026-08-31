import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function loadModule() {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-attachment-image-module-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/attachments/attachments-service.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external"
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("attachment reads stay inside canonical agent-owned media roots", async t => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-attachment-image-data-"));
  const sandRoot = path.join(temporary, "sand");
  const previousDataRoot = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = sandRoot;

  const agentRoot = path.join(sandRoot, "agents", "agent-safe");
  const attachmentsRoot = path.join(agentRoot, "attachments");
  const assetsRoot = path.join(agentRoot, "assets");
  await Promise.all([
    mkdir(attachmentsRoot, { recursive: true }),
    mkdir(assetsRoot, { recursive: true })
  ]);

  try {
    await t.test("reads legitimate attachment and asset images", async () => {
      const attachment = path.join(attachmentsRoot, "photo.png");
      const asset = path.join(assetsRoot, "generated.png");
      await Promise.all([writeFile(attachment, onePixelPng), writeFile(asset, onePixelPng)]);

      for (const candidate of [attachment, asset]) {
        const result = await loaded.module.readHostAttachmentImage(candidate);
        assert.equal(result?.dataUrl, `data:image/png;base64,${onePixelPng.toString("base64")}`);
        assert.equal(result?.width, 1);
        assert.equal(result?.height, 1);
      }
    });

    await t.test("rejects arbitrary sandbox paths and symlink escapes", async () => {
      const sandboxSecret = path.join(sandRoot, "secret.png");
      const externalSecret = path.join(temporary, "external-secret.png");
      await Promise.all([writeFile(sandboxSecret, onePixelPng), writeFile(externalSecret, onePixelPng)]);

      const fileEscape = path.join(attachmentsRoot, "file-escape.png");
      await symlink(externalSecret, fileEscape);

      const linkedBucketAgent = path.join(sandRoot, "agents", "linked-bucket");
      const externalBucket = path.join(temporary, "external-bucket");
      await Promise.all([mkdir(linkedBucketAgent, { recursive: true }), mkdir(externalBucket)]);
      await writeFile(path.join(externalBucket, "bucket-escape.png"), onePixelPng);
      await symlink(externalBucket, path.join(linkedBucketAgent, "attachments"), "dir");

      const otherAgent = path.join(sandRoot, "agents", "other-agent");
      await mkdir(path.join(otherAgent, "attachments"), { recursive: true });
      await writeFile(path.join(otherAgent, "attachments", "other.png"), onePixelPng);
      const linkedAgent = path.join(sandRoot, "agents", "linked-agent");
      await symlink(otherAgent, linkedAgent, "dir");

      assert.equal(await loaded.module.readHostAttachmentImage(sandboxSecret), null);
      assert.equal(await loaded.module.readHostAttachmentImage(fileEscape), null);
      assert.equal(
        await loaded.module.readHostAttachmentImage(path.join(linkedBucketAgent, "attachments", "bucket-escape.png")),
        null
      );
      assert.equal(
        await loaded.module.readHostAttachmentImage(path.join(linkedAgent, "attachments", "other.png")),
        null
      );
    });

    await t.test("rejects oversized images before reading them", async () => {
      const oversized = path.join(attachmentsRoot, "oversized.png");
      await writeFile(oversized, onePixelPng);
      await truncate(oversized, loaded.module.HOST_ATTACHMENT_IMAGE_BYTE_LIMIT + 1);
      assert.equal(await loaded.module.readHostAttachmentImage(oversized), null);
    });

    await t.test("reads legitimate text previews and bounded chunks", async () => {
      const textPath = path.join(attachmentsRoot, "notes.txt");
      const assetPath = path.join(assetsRoot, "artifact.bin");
      await Promise.all([
        writeFile(textPath, "hello from the owned attachment"),
        writeFile(assetPath, Buffer.from([0, 1, 2, 3, 4, 5]))
      ]);

      assert.deepEqual(await loaded.module.readAttachmentText(agentRoot, textPath), {
        kind: "text",
        text: "hello from the owned attachment",
        truncated: false,
        bytes: 31
      });
      assert.deepEqual(await loaded.module.readHostAttachmentChunk(agentRoot, assetPath, 2, 3), {
        bytesBase64: Buffer.from([2, 3, 4]).toString("base64"),
        totalSize: 6,
        mime: null
      });
    });

    await t.test("text and chunk reads reject outside, symlink, and cross-agent paths", async () => {
      const sandboxText = path.join(sandRoot, "sandbox-secret.txt");
      const externalText = path.join(temporary, "external-secret.txt");
      const externalBytes = path.join(temporary, "external-secret.bin");
      await Promise.all([
        writeFile(sandboxText, "sandbox secret"),
        writeFile(externalText, "external secret"),
        writeFile(externalBytes, Buffer.from([9, 8, 7, 6]))
      ]);

      const textEscape = path.join(attachmentsRoot, "text-escape.txt");
      const chunkEscape = path.join(assetsRoot, "chunk-escape.bin");
      await Promise.all([
        symlink(externalText, textEscape),
        symlink(externalBytes, chunkEscape)
      ]);

      const otherAgent = path.join(sandRoot, "agents", "other-agent");
      const otherAttachments = path.join(otherAgent, "attachments");
      const otherAssets = path.join(otherAgent, "assets");
      await Promise.all([
        mkdir(otherAttachments, { recursive: true }),
        mkdir(otherAssets, { recursive: true })
      ]);
      const otherText = path.join(otherAttachments, "other.txt");
      const otherBytes = path.join(otherAssets, "other.bin");
      await Promise.all([
        writeFile(otherText, "other agent secret"),
        writeFile(otherBytes, Buffer.from([5, 4, 3, 2]))
      ]);
      const crossAgentText = path.join(attachmentsRoot, "cross-agent.txt");
      const crossAgentChunk = path.join(assetsRoot, "cross-agent.bin");
      await Promise.all([
        symlink(otherText, crossAgentText),
        symlink(otherBytes, crossAgentChunk)
      ]);

      assert.equal(await loaded.module.readAttachmentText(agentRoot, sandboxText), null);
      assert.equal(await loaded.module.readAttachmentText(agentRoot, textEscape), null);
      assert.equal(await loaded.module.readAttachmentText(agentRoot, otherText), null);
      assert.equal(await loaded.module.readAttachmentText(agentRoot, crossAgentText), null);
      assert.equal(await loaded.module.readHostAttachmentChunk(agentRoot, externalBytes, 0, 4), null);
      assert.equal(await loaded.module.readHostAttachmentChunk(agentRoot, chunkEscape, 0, 4), null);
      assert.equal(await loaded.module.readHostAttachmentChunk(agentRoot, otherBytes, 0, 4), null);
      assert.equal(await loaded.module.readHostAttachmentChunk(agentRoot, crossAgentChunk, 0, 4), null);

      const service = loaded.module.createAttachmentsService({ auth: {}, ctx: {}, box: {} });
      service.setFallbackAgentId("agent-safe");
      assert.equal(await service.readText({ path: otherText }), null);
      assert.equal(await service.readChunk({ path: otherBytes, offset: 0, length: 4 }), null);
      assert.equal(await service.readText({ path: otherText, agentId: "agent-safe" }), null);
      assert.equal(await service.readChunk({ path: otherBytes, agentId: "agent-safe", offset: 0, length: 4 }), null);
    });

    await t.test("ingest, media helpers, and box staging reject owned-path symlink escapes", async () => {
      const externalImage = path.join(temporary, "dimension-secret.png");
      const externalVideo = path.join(temporary, "video-secret.mp4");
      const externalText = path.join(temporary, "box-secret.txt");
      await Promise.all([
        writeFile(externalImage, onePixelPng),
        writeFile(externalVideo, Buffer.from("outside video bytes")),
        writeFile(externalText, "outside box bytes"),
      ]);
      const imageEscape = path.join(attachmentsRoot, "dimension-escape.png");
      const videoEscape = path.join(attachmentsRoot, "video-escape.mp4");
      const boxEscape = path.join(attachmentsRoot, "box-escape.txt");
      await Promise.all([
        symlink(externalImage, imageEscape),
        symlink(externalVideo, videoEscape),
        symlink(externalText, boxEscape),
      ]);

      await assert.rejects(
        loaded.module.ingestAttachment(agentRoot, boxEscape),
        /owned regular file/,
      );
      assert.equal(await loaded.module.readImageDimensions(imageEscape), null);
      assert.equal(await loaded.module.readMediaDimensions(imageEscape), null);
      assert.equal(await loaded.module.readHostAttachmentVideoBytes(videoEscape), null);
      assert.equal(await loaded.module.readVideoDimensions(videoEscape), null);
      assert.equal(await loaded.module.readMediaDimensions(videoEscape), null);

      const legitimate = path.join(attachmentsRoot, "box-legitimate.txt");
      await writeFile(legitimate, "legitimate box bytes");
      const uploads = [];
      const service = loaded.module.createAttachmentsService({
        auth: {},
        ctx: {},
        box: {
          runState: async () => "running",
          downloadFile: async () => new Uint8Array(),
          uploadFile: async (_ctx, _agentId, boxPath, data) => uploads.push({ boxPath, data: Buffer.from(data) }),
        },
      });
      const staged = await service.stageIntoBox("agent-safe", [boxEscape, legitimate]);
      assert.equal(staged.has(boxEscape), false);
      assert.equal(staged.get(legitimate), "/workspace/uploads/box-legitimate.txt");
      assert.deepEqual(uploads, [{
        boxPath: "/workspace/uploads/box-legitimate.txt",
        data: Buffer.from("legitimate box bytes"),
      }]);
    });
  } finally {
    if (previousDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousDataRoot;
    await Promise.all([
      loaded.dispose(),
      rm(temporary, { recursive: true, force: true })
    ]);
  }
});
