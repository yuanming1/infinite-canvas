import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { isShortDramaIntegration } from "@/lib/short-drama-auth";
import { rememberCloudImageUrl } from "@/services/image-storage";
import { rememberCloudMediaUrl } from "@/services/file-storage";
import {
    createRemoteCanvasAsset,
    deleteRemoteCanvasAsset,
    isCanvasAssetConflictError,
    listRemoteCanvasAssets,
    updateRemoteCanvasAsset,
    type RemoteCanvasAsset,
    type RemoteCanvasAssetInput,
} from "@/services/short-drama-media";
import { cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
    /** 集成模式：云端乐观锁版本号（服务端返回，本地编辑时回传）。 */
    version?: number;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    loadCloudAssets: () => Promise<void>;
    cleanupImages: (extra?: unknown) => void;
};

const ASSET_STORE_KEY = "infinite-canvas:asset_store";

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.assets = await Promise.all(
            parsed.state.assets.map(async (asset) => {
                if (asset.kind === "video" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                if (asset.kind !== "image") return asset;
                if (asset.data.storageKey)
                    return {
                        ...asset,
                        coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                        data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
                    };
                if (!isShortDramaIntegration && asset.data.dataUrl.startsWith("data:image/")) {
                    // 独立模式：把遗留内联 dataUrl 迁入本地 IndexedDB。集成模式的存量迁移由云端迁移服务统一处理。
                    const image = await uploadImage(asset.data.dataUrl);
                    return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
                }
                return asset;
            }),
        );
        return parsed;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = isShortDramaIntegration ? crypto.randomUUID() : nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                if (isShortDramaIntegration) {
                    void createRemoteCanvasAsset(toRemoteCanvasAssetInput({ ...asset, id, createdAt: now, updatedAt: now } as Asset))
                        .then((remote) => {
                            syncCloudVersion(remote.id, remote.version);
                        })
                        .catch((error) => {
                            console.error("canvas asset cloud create failed", error);
                        });
                }
                return id;
            },
            updateAsset: (id, patch) =>
                set((state) => ({
                    assets: state.assets.map((asset) => {
                        if (asset.id !== id) return asset;
                        const updated = { ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset;
                        if (isShortDramaIntegration) {
                            void updateRemoteCanvasAsset(toRemoteCanvasAssetInput(updated))
                                .then((remote) => {
                                    syncCloudVersion(remote.id, remote.version);
                                })
                                .catch(async (error) => {
                                    if (isCanvasAssetConflictError(error)) await get().loadCloudAssets();
                                    else console.error("canvas asset cloud update failed", error);
                                });
                        }
                        return updated;
                    }),
                })),
            removeAsset: (id) =>
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    if (isShortDramaIntegration) {
                        void deleteRemoteCanvasAsset(id).catch((error) => {
                            console.error("canvas asset cloud delete failed", error);
                        });
                    } else {
                        get().cleanupImages({ assets });
                    }
                    return { assets };
                }),
            replaceAssets: (assets) => set({ assets }),
            loadCloudAssets: async () => {
                if (!isShortDramaIntegration) return;
                const remote = await listRemoteCanvasAssets();
                const assets = remote.map(fromRemoteCanvasAsset);
                set({ assets });
            },
            cleanupImages: (extra) => {
                if (isShortDramaIntegration) return;
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
                    await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                    await cleanupUnusedMedia({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => () => {
                useAssetStore.setState({ hydrated: true });
            },
        },
    ),
);

function syncCloudVersion(id: string, version: number) {
    if (!Number.isFinite(version) || version <= 0) return;
    useAssetStore.setState((state) => ({
        assets: state.assets.map((asset) => (asset.id === id && (asset.version === undefined || asset.version < version) ? ({ ...asset, version } as Asset) : asset)),
    }));
}

function fromRemoteCanvasAsset(remote: RemoteCanvasAsset): Asset {
    const base = {
        id: remote.id,
        kind: remote.kind,
        title: remote.title,
        coverUrl: remote.cover_url,
        tags: Array.isArray(remote.tags) ? remote.tags : [],
        source: remote.source || undefined,
        note: remote.note || undefined,
        metadata: (remote.metadata as Record<string, unknown> | undefined) ?? undefined,
        createdAt: remote.created_at,
        updatedAt: remote.updated_at,
        version: remote.version,
    };
    const data = (remote.data || {}) as Record<string, unknown>;
    if (remote.kind === "text") {
        return { ...base, data: { content: String(data.content ?? "") } } as Asset;
    }
    if (remote.kind === "video") {
        const url = String(data.url ?? "");
        const storageKey = typeof data.storageKey === "string" ? data.storageKey : undefined;
        if (storageKey && url) rememberCloudMediaUrl(storageKey, url);
        return { ...base, data: { url, storageKey, width: Number(data.width ?? 0), height: Number(data.height ?? 0), bytes: Number(data.bytes ?? 0), mimeType: String(data.mimeType ?? "") } } as Asset;
    }
    const dataUrl = String(data.dataUrl ?? "");
    const storageKey = typeof data.storageKey === "string" ? data.storageKey : undefined;
    if (storageKey && dataUrl) rememberCloudImageUrl(storageKey, dataUrl);
    return { ...base, data: { dataUrl, storageKey, width: Number(data.width ?? 0), height: Number(data.height ?? 0), bytes: Number(data.bytes ?? 0), mimeType: String(data.mimeType ?? "") } } as Asset;
}

export function toRemoteCanvasAssetInput(asset: Asset): RemoteCanvasAssetInput {
    const data: Record<string, unknown> =
        asset.kind === "text"
            ? { content: asset.data.content }
            : asset.kind === "video"
              ? { url: asset.data.url, storageKey: asset.data.storageKey, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType }
              : { dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType };
    return {
        id: asset.id,
        kind: asset.kind,
        title: asset.title,
        cover_url: asset.coverUrl,
        tags: asset.tags,
        note: asset.note ?? "",
        source: asset.source ?? "",
        metadata: asset.metadata ?? null,
        data,
        version: asset.version ?? 1,
    };
}
