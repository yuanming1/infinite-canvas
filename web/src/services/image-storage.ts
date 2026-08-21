import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { isShortDramaIntegration } from "@/lib/short-drama-auth";
import { readImageMeta } from "@/lib/image-utils";
import { uploadCanvasMedia } from "@/services/short-drama-media";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();
// 集成模式：云端 storageKey(cloud:{uuid}) -> 持久 https URL 的会话内缓存（跨会话由 fallback URL 兜底）。
const remoteUrls = new Map<string, string>();

export function isCloudStorageKey(storageKey?: string) {
    return !!storageKey && storageKey.startsWith("cloud:");
}

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    if (isShortDramaIntegration) {
        // 先用临时 blob URL 读取宽高，再上传到云端（不写本地 IndexedDB）。
        const tempUrl = URL.createObjectURL(blob);
        let meta = { width: 0, height: 0, mimeType: blob.type };
        try {
            meta = await readImageMeta(tempUrl);
        } finally {
            URL.revokeObjectURL(tempUrl);
        }
        const uploaded = await uploadCanvasMedia(blob, "image", { width: meta.width || undefined, height: meta.height || undefined });
        remoteUrls.set(uploaded.storage_key, uploaded.url);
        return { url: uploaded.url, storageKey: uploaded.storage_key, width: uploaded.width ?? meta.width ?? 0, height: uploaded.height ?? meta.height ?? 0, bytes: uploaded.bytes, mimeType: uploaded.mime_type || blob.type || meta.mimeType };
    }
    const storageKey = `image:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = await readImageMeta(url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    if (isCloudStorageKey(storageKey)) return remoteUrls.get(storageKey) ?? fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export function rememberCloudImageUrl(storageKey: string, url: string) {
    if (isCloudStorageKey(storageKey) && url && !url.startsWith("blob:")) remoteUrls.set(storageKey, url);
}

export async function getImageBlob(storageKey: string) {
    if (isCloudStorageKey(storageKey)) {
        const url = remoteUrls.get(storageKey);
        if (!url) return null;
        try {
            return await (await fetch(url)).blob();
        } catch {
            return null;
        }
    }
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    const localKeys = Array.from(new Set(keys)).filter((key) => !isCloudStorageKey(key));
    if (isShortDramaIntegration && localKeys.length === 0) return;
    await Promise.all(
        localKeys.map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    // 集成模式云端媒体由服务端引用判定与 GC 管理，本地不做清理。
    if (isShortDramaIntegration) return;
    const usedKeys = collectImageStorageKeys(usedData);
    await Promise.all([
        imageLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
        videoLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
    ]);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
