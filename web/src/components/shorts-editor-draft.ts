import type { SubscribeAnimationConfig } from "../types";
import type { ShortsTextOverlay } from "./shorts-editor-toolbox";

export type DraftEditState = {
  start: number;
  end?: number;
  aspect: "9:16" | "16:9" | "1:1" | "4:5";
  subtitles: boolean;
  projectName?: string;
  muted?: boolean;
  volume?: number;
  filterPreset?: "none" | "warm" | "cool" | "black_white" | "tint" | "monochrome";
  filterIntensity?: number;
  tintColor?: string;
  tintOpacity?: number;
  subscribeAnimation?: SubscribeAnimationConfig;
};
export type DraftSnapshot = { edit: DraftEditState; overlays: ShortsTextOverlay[] };
export type DraftSource =
  | { mode: "library"; assetId: string }
  | { mode: "url"; url: string }
  | { mode: "file"; name: string; size: number; lastModified: number; type: string };
export type ShortsEditorDraft = {
  version: 1;
  updatedAt: string;
  source: DraftSource;
  snapshot: DraftSnapshot;
  savedBaseline: DraftSnapshot;
};

const DATABASE = "s6-cut-shorts-editor";
const STORE = "drafts";
const KEY = "current";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("Local draft storage is unavailable.")); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local draft storage."));
  });
}

function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    let result: T | undefined;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error("Local draft storage failed."));
    tx.oncomplete = () => { database.close(); resolve(result as T); };
    tx.onerror = () => { database.close(); reject(tx.error ?? new Error("Local draft storage failed.")); };
    tx.onabort = () => { database.close(); reject(tx.error ?? new Error("Local draft storage was interrupted.")); };
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isShortsEditorDraft(value: unknown): value is ShortsEditorDraft {
  if (!isRecord(value) || value.version !== 1 || typeof value.updatedAt !== "string" || !isRecord(value.source)) return false;
  const source = value.source;
  const validSource = source.mode === "library" ? typeof source.assetId === "string" && Boolean(source.assetId)
    : source.mode === "url" ? typeof source.url === "string" && Boolean(source.url)
      : source.mode === "file" && typeof source.name === "string" && typeof source.size === "number" && typeof source.lastModified === "number" && typeof source.type === "string";
  const validSnapshot = (snapshot: unknown) => isRecord(snapshot) && isRecord(snapshot.edit) && typeof snapshot.edit.start === "number" && typeof snapshot.edit.subtitles === "boolean" && typeof snapshot.edit.aspect === "string" && Array.isArray(snapshot.overlays);
  return validSource && validSnapshot(value.snapshot) && validSnapshot(value.savedBaseline);
}

export async function readShortsEditorDraft(): Promise<ShortsEditorDraft | null> {
  const value: unknown = await transaction("readonly", (store) => store.get(KEY));
  return isShortsEditorDraft(value) ? value : null;
}

export async function writeShortsEditorDraft(draft: ShortsEditorDraft): Promise<void> {
  await transaction("readwrite", (store) => store.put(draft, KEY));
}

export async function clearShortsEditorDraft(): Promise<void> {
  await transaction("readwrite", (store) => store.delete(KEY));
}

export function localFileMatchesDraft(file: File, source: Extract<DraftSource, { mode: "file" }>): boolean {
  return file.name === source.name && file.size === source.size && file.lastModified === source.lastModified && file.type === source.type;
}
