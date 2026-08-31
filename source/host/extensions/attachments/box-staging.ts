import { basename, posix } from "node:path";
import { videoMimeFromPath } from "../../../shared/media/image-mime.js";
import type { TransferBox } from "../../box/box-transfer.js";

export const SAND_BOX_STAGE_MAX_BYTES = 50 * 1024 * 1024;
export const SAND_BOX_UPLOADS_DIR = "/workspace/uploads";
export interface BoxStagingDependencies<Context> {
  readonly ctx: Context;
  readonly box: TransferBox & { runState(ctx: Context, agentId: string): Promise<string> };
  readonly resolveOwnerDir: (path: string) => string | null;
  readonly readOwnedFile: (path: string, maximumBytes: number) => Promise<Uint8Array | null>;
  readonly upload: (ctx: Context, box: BoxStagingDependencies<Context>["box"], agentId: string, files: readonly { boxPath: string; data: Uint8Array }[]) => Promise<void>;
}
export async function stageAttachmentsIntoBox<Context>(deps: BoxStagingDependencies<Context>, agentId: string, hostPaths: readonly string[]): Promise<Map<string, string>> {
  const staged = new Map<string, string>();
  if (hostPaths.length === 0) return staged;
  try { if (await deps.box.runState(deps.ctx, agentId) !== "running") return staged; } catch { return staged; }
  const uploads: { boxPath: string; data: Uint8Array }[] = [];
  let stagedBytes = 0;
  for (const hostPath of hostPaths) {
    if (videoMimeFromPath(hostPath) !== undefined || deps.resolveOwnerDir(hostPath) == null) continue;
    try {
      const remainingBytes = SAND_BOX_STAGE_MAX_BYTES - stagedBytes;
      if (remainingBytes <= 0) break;
      const data = await deps.readOwnedFile(hostPath, remainingBytes);
      if (data == null) continue;
      const boxPath = posix.join(SAND_BOX_UPLOADS_DIR, basename(hostPath));
      uploads.push({ boxPath, data });
      stagedBytes += data.byteLength;
      staged.set(hostPath, boxPath);
    } catch {}
  }
  if (uploads.length === 0) return staged;
  try { await deps.upload(deps.ctx, deps.box, agentId, uploads); } catch { return new Map(); }
  return staged;
}
