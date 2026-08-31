import { basename } from "node:path";
import {
  getAvatarDataUrlCacheUsage,
  readAvatarBytesWithinDir as readAvatarBytes,
  readAvatarMetadataWithinDir as readAvatarMetadata,
  readAvatarWithinDir as readAvatar,
  resolveDerivedAvatarFilename,
} from "../../agents/agent-avatar.js";
import { getSandProfilePath, readLegacyProfileAvatarField, readSandProfileFile, type SandAgentProfile } from "../../agents/agent-profile.js";
import { buildSummary, loadAgentDbExtras, type DbExtras } from "./session-summaries.js";
const safeReadAvatar=(dir:string,path:string|null)=>path==null?Promise.resolve(null):readAvatar(dir,path);
const safeReadAvatarBytes=(dir:string,path:string|null)=>path==null?Promise.resolve(null):readAvatarBytes(dir,path);
const safeReadAvatarMetadata=(dir:string,path:string|null)=>path==null?Promise.resolve(null):readAvatarMetadata(dir,path);
export { getAvatarDataUrlCacheUsage };
export async function updateAgentProfile(host:{memory:{agentHasContent(dir:string):boolean};withAgentDb<T>(id:string,fn:(db:UpdateProfileDb,path:string)=>Promise<T>):Promise<T>;statOpenDb(args:{dbPath:string;agentId:string}):Promise<{size:number;mtimeMs:number}|undefined>;writeAgentProfileFile(id:string,profile:Partial<SandAgentProfile> & {name:string;description:string}):void},agentId:string,profile:Partial<SandAgentProfile> & {name:string;description:string}){return host.withAgentDb(agentId,async(db,dbPath)=>{host.writeAgentProfileFile(agentId,profile);const dbStats=await host.statOpenDb({dbPath,agentId});return await buildSummary({extras:loadAgentDbExtras(db,dbPath,agentId,dbStats),dbPath,dirName:agentId,...(dbStats==null?{}:{dbStats}),includeBlank:true,agentHasMemory:(dir)=>host.memory.agentHasContent(dir)})})}
interface UpdateProfileDb { get(key:string):unknown; getTranscriptEntries():Record<string,unknown>[]; getUnreadState():DbExtras["unreadState"]; getAwaitingUserResponse?():unknown; getAgentOrigin?():unknown; getAgentPurpose?():unknown; getConversationPartnerIds?():string[]; getSandProfile?():{description:string;avatarPath:string|null} }
export function getAgentProfileText(host:{getAgentDir(id:string):string},agentId:string){const profile=readSandProfileFile(getSandProfilePath(host.getAgentDir(agentId)));return profile==null?null:{name:profile.name,description:profile.description,title:profile.title,avatarShape:profile.avatarShape,avatarColor:profile.avatarColor}}
export async function readLegacyStoredAvatar<T>(host:{agentExists(id:string):boolean;getAgentDir(id:string):string;withAgentDb<R>(id:string,fn:(db:{getSandProfile():{avatarPath:string|null}})=>Promise<R>):Promise<R>},agentId:string,read:(dir:string,path:string|null)=>Promise<T|null>):Promise<T|null>{if(!host.agentExists(agentId))return null;return host.withAgentDb(agentId,async(db)=>read(host.getAgentDir(agentId),db.getSandProfile().avatarPath))}
export async function getAgentAvatar(host:{agentExists(id:string):boolean;getAgentDir(id:string):string;withAgentDb<R>(id:string,fn:(db:{getSandProfile():{avatarPath:string|null}})=>Promise<R>):Promise<R>},agentId:string){const dir=host.getAgentDir(agentId),derived=resolveDerivedAvatarFilename(dir,readLegacyProfileAvatarField(getSandProfilePath(dir))),avatar=await safeReadAvatar(dir,derived)??await readLegacyStoredAvatar(host,agentId,safeReadAvatar);return{version:avatar?.version??null,dataUrl:avatar?.dataUrl??null}}
export async function getAgentAvatarPng(host:{agentExists(id:string):boolean;getAgentDir(id:string):string;withAgentDb<R>(id:string,fn:(db:{getSandProfile():{avatarPath:string|null}})=>Promise<R>):Promise<R>},agentId:string):Promise<Uint8Array|null>{const dir=host.getAgentDir(agentId),derived=resolveDerivedAvatarFilename(dir,readLegacyProfileAvatarField(getSandProfilePath(dir)));return await safeReadAvatarBytes(dir,derived)??await readLegacyStoredAvatar(host,agentId,safeReadAvatarBytes)}

const NOTIFICATION_FALLBACK_SHAPES = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop"] as const;
const NOTIFICATION_SHAPES = new Set(["blob", "pebble", "bean", "egg", "squircle", "tablet", "capsule", "cylinder", "hex", "gem", "crystal", "wedge", "shield", "dome", "arch", "cloud", "teardrop", "leaf"]);
const NOTIFICATION_COLORS = new Set(["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"]);
const NOTIFICATION_FALLBACK_COLORS = ["brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"] as const;
const NOTIFICATION_AVATAR_SEED_VERSION = 1;

function notificationAvatarHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function notificationAvatarShapeHash(value: string): number {
  let hash = notificationAvatarHash(value) | 0;
  hash = Math.imul(hash ^ hash >>> 16, 73244475);
  hash = Math.imul(hash ^ hash >>> 13, 3266489909);
  return (hash ^ hash >>> 16) >>> 0;
}

function notificationAvatarRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = state + 1831565813 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function resolveAgentNotificationAvatarAppearance(args: {
  agentId: string;
  avatarShape?: string;
  avatarColor?: string;
}): { shape: string; color: string } {
  const shape = args.avatarShape != null && NOTIFICATION_SHAPES.has(args.avatarShape)
    ? args.avatarShape
    : NOTIFICATION_FALLBACK_SHAPES[
        notificationAvatarShapeHash(args.agentId) % NOTIFICATION_FALLBACK_SHAPES.length
      ] ?? "blob";
  const colorSeed = (
    notificationAvatarHash(args.agentId) ^
    Math.imul(NOTIFICATION_AVATAR_SEED_VERSION, 2654435769)
  ) >>> 0;
  const random = notificationAvatarRandom(colorSeed);
  const color = args.avatarColor != null && NOTIFICATION_COLORS.has(args.avatarColor)
    ? args.avatarColor
    : NOTIFICATION_FALLBACK_COLORS[
        Math.floor(random() * NOTIFICATION_FALLBACK_COLORS.length)
      ] ?? "black";
  return { shape, color };
}

export interface AgentNotificationAvatar {
  readonly name: string | null;
  readonly shape: string;
  readonly color: string;
  readonly avatarVersion: string | null;
  readonly avatarContentType: string | null;
  readonly avatarByteCount: number | null;
}

/**
 * The public notification-avatar contract is metadata-only. Consumers fetch
 * the versioned avatar through the avatar endpoint when byte metadata is
 * present; this method never copies or resizes the image itself.
 */
export async function getAgentNotificationAvatar(
  host: {
    agentExists(id: string): boolean;
    getAgentDir(id: string): string;
    withAgentDb<R>(id: string, fn: (db: { getSandProfile(): { avatarPath: string | null } }) => Promise<R>): Promise<R>;
  },
  agentId: string,
): Promise<AgentNotificationAvatar> {
  const profile = getAgentProfileText(host, agentId);
  const dir = host.getAgentDir(agentId);
  const derived = resolveDerivedAvatarFilename(
    dir,
    readLegacyProfileAvatarField(getSandProfilePath(dir)),
  );
  const avatar = await safeReadAvatarMetadata(dir, derived)
    ?? await readLegacyStoredAvatar(host, agentId, safeReadAvatarMetadata);
  const appearance = resolveAgentNotificationAvatarAppearance({
    agentId,
    ...(profile == null
      ? {}
      : { avatarShape: profile.avatarShape, avatarColor: profile.avatarColor }),
  });
  return {
    name: profile?.name ?? null,
    shape: appearance.shape,
    color: appearance.color,
    avatarVersion: avatar?.version ?? null,
    avatarContentType: avatar?.contentType ?? null,
    avatarByteCount: avatar?.byteCount ?? null,
  };
}
export const avatarBasename=(path:string):string=>basename(path);
