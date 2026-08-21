import localforage from "localforage";
import { nanoid } from "nanoid";

import { isShortDramaIntegration } from "@/lib/short-drama-auth";
import { uploadCanvasMedia, type CanvasMediaKind } from "@/services/short-drama-media";
import { isCloudStorageKey } from "@/services/image-storage";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();
const remoteUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const meta: { width?: number; height?: number; durationMs?: number } = blob.type.startsWith("video/")
        ? await readVideoMeta(blob)
        : blob.type.startsWith("audio/")
          ? await readAudioMeta(blob)
          : {};
    if (isShortDramaIntegration) {
        const kind: CanvasMediaKind = prefix === "audio" || blob.type.startsWith("audio/") ? "audio" : "video";
        const uploaded = await uploadCanvasMedia(blob, kind, { width: meta.width, height: meta.height, durationMs: meta.durationMs });
        remoteUrls.set(uploaded.storage_key, uploaded.url);
        return {
            url: uploaded.url,
            storageKey: uploaded.storage_key,
            bytes: uploaded.bytes,
            mimeType: uploaded.mime_type || blob.type || "application/octet-stream",
            width: uploaded.width ?? meta.width,
            height: uploaded.height ?? meta.height,
            durationMs: uploaded.duration_ms ?? meta.durationMs,
        };
    }
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
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

export function rememberCloudMediaUrl(storageKey: string, url: string) {
    if (isCloudStorageKey(storageKey) && url && !url.startsWith("blob:")) remoteUrls.set(storageKey, url);
}

export async function getMediaBlob(storageKey: string) {
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

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
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

export async function cleanupUnusedMedia(usedData: unknown) {
    // 集成模式云端媒体由服务端引用判定与 GC 管理，本地不做清理。
    if (isShortDramaIntegration) return;
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(source: Blob) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const objectUrl = URL.createObjectURL(source);
        const video = document.createElement("video");
        const done = () => {
            resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
            URL.revokeObjectURL(objectUrl);
        };
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = objectUrl;
    });
}

function readAudioMeta(source: Blob) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const objectUrl = URL.createObjectURL(source);
        const audio = document.createElement("audio");
        const done = () => {
            resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
            URL.revokeObjectURL(objectUrl);
        };
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = objectUrl;
    });
}
