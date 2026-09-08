import localforage from "localforage";

import { isShortDramaIntegration } from "@/lib/short-drama-auth";
import { collectImageStorageKeys } from "@/services/image-storage";
import { collectMediaStorageKeys } from "@/services/file-storage";
import { uploadCanvasMedia, batchCreateRemoteCanvasAssets, type CanvasMediaKind, type RemoteCanvasAssetInput } from "@/services/short-drama-media";
import { toRemoteCanvasAssetInput, type Asset } from "@/stores/use-asset-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

/**
 * 一次性本地媒体迁移（集成模式）：
 * 把浏览器 IndexedDB 中的资产媒体与画布项目引用的本地 storageKey 上传到云端，
 * 并把资产记录入库、项目 content 里的引用替换为云端 storageKey / 持久 URL。
 * 全程幂等、可中断恢复（进度持久化在 localforage），本地 Blob 保守保留。
 */

const MIGRATION_FLAG_KEY = "infinite-canvas:media_cloud_migrated";
const MIGRATION_PROGRESS_KEY = "infinite-canvas:cloud_migration";
const UPLOAD_CONCURRENCY = 3;
const BATCH_SIZE = 200;

export type CloudMigrationMapping = { storageKey: string; url: string };

export type CloudMigrationStatus = {
    state: "idle" | "running" | "done" | "failed";
    total: number;
    uploaded: number;
    error?: string;
};

type MigrationProgress = {
    version: 1;
    mapping: Record<string, CloudMigrationMapping>;
    assetIds: string[];
};

const imageStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const mediaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const assetStateStore = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });

let running = false;
const listeners = new Set<(status: CloudMigrationStatus) => void>();
let lastStatus: CloudMigrationStatus = { state: "idle", total: 0, uploaded: 0 };

export function subscribeCloudMigration(listener: (status: CloudMigrationStatus) => void): () => void {
    listeners.add(listener);
    listener(lastStatus);
    return () => {
        listeners.delete(listener);
    };
}

function updateStatus(patch: Partial<CloudMigrationStatus>) {
    lastStatus = { ...lastStatus, ...patch };
    listeners.forEach((listener) => listener(lastStatus));
}

export function isCloudMigrationDone() {
    return window.localStorage.getItem(MIGRATION_FLAG_KEY) === "1";
}

export async function runCloudMediaMigration(): Promise<void> {
    if (!isShortDramaIntegration || running || isCloudMigrationDone()) return;
    running = true;
    try {
        await migrate();
        window.localStorage.setItem(MIGRATION_FLAG_KEY, "1");
        updateStatus({ state: "done" });
    } catch (error) {
        updateStatus({ state: "failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
    } finally {
        running = false;
    }
}

async function migrate() {
    const progress = await loadProgress();
    const [localAssets, referencedKeys] = await collectLocalReferences();
    // 只上传被资产或画布项目引用的本地媒体；生成日志引用的媒体不迁移（与跨设备现状一致）。
    const pendingKeys = Array.from(referencedKeys).filter((key) => !progress.mapping[key]);

    updateStatus({ state: "running", total: pendingKeys.length, uploaded: 0 });

    // 1. 上传本地 Blob（并发池），进度持久化支持中断恢复。
    let uploaded = 0;
    const queue = [...pendingKeys];
    const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length || 1) }, async () => {
        while (queue.length > 0) {
            const key = queue.shift();
            if (!key) return;
            const blob = await readLocalBlob(key);
            if (!blob) {
                // Blob 缺失（该浏览器从未有过或已清理）：记录占位映射，避免反复重试。
                progress.mapping[key] = { storageKey: "", url: "" };
                await saveProgress(progress);
                continue;
            }
            const result = await uploadCanvasMedia(blob, mediaKindForKey(key));
            progress.mapping[key] = { storageKey: result.storage_key, url: result.url };
            await saveProgress(progress);
            uploaded += 1;
            updateStatus({ uploaded });
        }
    });
    await Promise.all(workers);

    const mapping = progress.mapping;

    // 2. 旧资产入库云端（data 内联 dataUrl 一并转 Blob 上传），仅迁移云端不存在的。
    await migrateLocalAssets(localAssets, mapping, progress);

    // 3. 画布项目 content 引用替换（storageKey -> cloud key；blob:/data: URL -> 云 URL）。
    await rewriteCanvasProjects(mapping);

    await assetStateStore.removeItem(MIGRATION_PROGRESS_KEY);
}

/** 从本地 persist 原始 JSON 快照资产列表（不经过 store，避免被云端 replace 覆盖）。 */
async function snapshotLocalAssets(): Promise<Asset[]> {
    const raw = await assetStateStore.getItem<string>("infinite-canvas:asset_store");
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as { state?: { assets?: Asset[] } };
        return Array.isArray(parsed.state?.assets) ? parsed.state.assets : [];
    } catch {
        return [];
    }
}

async function collectLocalReferences(): Promise<[Asset[], Set<string>]> {
    const localAssets = await snapshotLocalAssets();
    const projects = useCanvasStore.getState().projects;
    const keys = new Set<string>();
    localAssets.forEach((asset) => {
        const data = asset.data as { storageKey?: string } | undefined;
        if (data?.storageKey && !data.storageKey.startsWith("cloud:")) keys.add(data.storageKey);
    });
    projects.forEach((project) => {
        collectImageStorageKeys(project, keys);
        collectMediaStorageKeys(project, keys);
    });
    return [localAssets, keys];
}

async function readLocalBlob(key: string) {
    const blob = key.startsWith("image:") ? await imageStore.getItem<Blob>(key) : await mediaStore.getItem<Blob>(key);
    return blob ?? null;
}

function mediaKindForKey(key: string): CanvasMediaKind {
    if (key.startsWith("image:")) return "image";
    if (key.startsWith("audio:")) return "audio";
    return "video";
}

async function migrateLocalAssets(localAssets: Asset[], mapping: Record<string, CloudMigrationMapping>, progress: MigrationProgress) {
    const migratedIDs = new Set(progress.assetIds);
    const inputs: RemoteCanvasAssetInput[] = [];

    for (const asset of localAssets) {
        if (migratedIDs.has(asset.id)) continue;
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(asset.id);
        if (isUUID) continue; // 之前由云端创建/迁移过的资产，云端已存在
        // 内联 dataUrl 图片资产（无本地 storageKey）：先上传换取云 URL，避免大段 base64 入库。
        if (asset.kind === "image" && !asset.data.storageKey && asset.data.dataUrl.startsWith("data:image/")) {
            try {
                const blob = await (await fetch(asset.data.dataUrl)).blob();
                const uploaded = await uploadCanvasMedia(blob, "image");
                mapping[`inline:${asset.id}`] = { storageKey: uploaded.storage_key, url: uploaded.url };
                await saveProgress(progress);
            } catch (error) {
                console.error("canvas migration: inline asset upload failed", error);
            }
        }
        const converted = convertAssetToCloud(asset, mapping);
        if (!converted) continue;
        inputs.push(converted);
        migratedIDs.add(asset.id);
        if (inputs.length >= BATCH_SIZE) break;
    }

    if (inputs.length > 0) {
        await batchCreateRemoteCanvasAssets(inputs);
        progress.assetIds = Array.from(migratedIDs);
        await saveProgress(progress);
    }
}

/** 把本地资产转换为云端输入：引用的旧 storageKey / blob: / data: 内联替换为云 URL；nanoid 换成 UUID。 */
function convertAssetToCloud(asset: Asset, mapping: Record<string, CloudMigrationMapping>): RemoteCanvasAssetInput | null {
    const cloned = JSON.parse(JSON.stringify(asset)) as Asset;
    if (cloned.kind === "text") return toRemoteCanvasAssetInput({ ...cloned, id: crypto.randomUUID() });

    const data = cloned.data as { dataUrl?: string; url?: string; storageKey?: string };
    const oldKey = data.storageKey;
    const entry = oldKey ? mapping[oldKey] : mapping[`inline:${cloned.id}`];
    if (entry?.url) {
        data.storageKey = entry.storageKey;
        if (cloned.kind === "video") data.url = entry.url;
        else data.dataUrl = entry.url;
    } else if (cloned.kind === "video" && data.url?.startsWith("blob:")) {
        return null; // Blob URL 无法恢复且本地 Blob 缺失，跳过该资产
    }
    if (cloned.coverUrl.startsWith("blob:") || cloned.coverUrl.startsWith("data:")) {
        cloned.coverUrl = entry?.url || (cloned.kind === "video" ? data.url || "" : data.dataUrl || "");
    }
    return toRemoteCanvasAssetInput({ ...cloned, id: crypto.randomUUID() });
}

/** 替换画布项目（nodes/connections 等全量结构）中的本地引用并写回 store（项目同步组件会自动推送远端）。 */
async function rewriteCanvasProjects(mapping: Record<string, CloudMigrationMapping>) {
    const entries = Object.entries(mapping).filter(([, value]) => value.storageKey);
    if (entries.length === 0) return;
    const store = useCanvasStore.getState();
    const projects = store.projects;
    let changed = false;
    const nextProjects = projects.map((project) => {
        const nextProject = rewriteValue(project, new Map(entries)) as CanvasProject;
        if (nextProject === project) return project;
        changed = true;
        return nextProject;
    });
    if (changed) store.replaceProjects(nextProjects);
}

/** 递归替换：值等于旧 storageKey -> cloud key；对象含已映射 storageKey 时其 blob:/data: URL 字段 -> 云 URL。 */
function rewriteValue(value: unknown, mapping: Map<string, CloudMigrationMapping>): unknown {
    if (Array.isArray(value)) {
        let mutated = false;
        const next = value.map((item) => {
            const rewritten = rewriteValue(item, mapping);
            if (rewritten !== item) mutated = true;
            return rewritten;
        });
        return mutated ? next : value;
    }
    if (!value || typeof value !== "object") {
        if (typeof value === "string") {
            const entry = mapping.get(value);
            return entry ? entry.storageKey : value;
        }
        return value;
    }
    const record = value as Record<string, unknown>;
    const storageKey = typeof record.storageKey === "string" ? record.storageKey : "";
    const entry = storageKey ? mapping.get(storageKey) : undefined;

    let mutated = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
        let rewritten: unknown;
        if (entry && typeof item === "string" && (item.startsWith("blob:") || item.startsWith("data:"))) {
            rewritten = entry.url;
        } else {
            rewritten = rewriteValue(item, mapping);
        }
        if (rewritten !== item) mutated = true;
        next[key] = rewritten;
    }
    if (!mutated) return value;
    return next;
}

async function loadProgress(): Promise<MigrationProgress> {
    const raw = await assetStateStore.getItem<string>(MIGRATION_PROGRESS_KEY);
    if (!raw) return { version: 1, mapping: {}, assetIds: [] };
    try {
        const parsed = JSON.parse(raw) as MigrationProgress;
        if (parsed?.version === 1) return { version: 1, mapping: parsed.mapping || {}, assetIds: parsed.assetIds || [] };
    } catch {
        // fall through
    }
    return { version: 1, mapping: {}, assetIds: [] };
}

async function saveProgress(progress: MigrationProgress) {
    await assetStateStore.setItem(MIGRATION_PROGRESS_KEY, JSON.stringify(progress));
}
