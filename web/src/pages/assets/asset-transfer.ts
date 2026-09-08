import { saveAs } from "file-saver";

import { createZip, readZip } from "@/lib/zip";
import { isShortDramaIntegration } from "@/lib/short-drama-auth";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { uploadCanvasMedia } from "@/services/short-drama-media";
import type { Asset } from "@/stores/use-asset-store";

type AssetExportFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export async function exportAssets(assets: Asset[], filename: string) {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];

    await Promise.all(
        assets.map(async (asset) => {
            if (asset.kind !== "image" && asset.kind !== "video") return;
            const storageKey = asset.data.storageKey;
            if (!storageKey) return;
            let blob = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
            if (!blob) {
                // 云端媒体（跨会话 Map 未命中）或旧数据：从资产记录里的持久 URL 拉取。
                const remoteUrl = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
                if (remoteUrl && !remoteUrl.startsWith("blob:")) {
                    try {
                        blob = await (await fetch(remoteUrl)).blob();
                    } catch {
                        return;
                    }
                }
            }
            if (!blob) return;
            const path = `files/${safeFileName(storageKey)}.${fileExtension(blob.type, asset.kind)}`;
            files.push({ storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
            zipFiles.push({ name: path, data: blob });
        }),
    );

    const data: AssetExportFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets, files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, filename);
}

export async function readAssetPackage(file: File) {
    const zip = await readZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("missing assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    if (isShortDramaIntegration) {
        // 集成模式：解包媒体直接上传云端，资产引用替换为云 storageKey / URL（不写本地 IndexedDB）。
        const mapping = new Map<string, { storageKey: string; url: string }>();
        await Promise.all(
            data.files.map(async (item) => {
                const blob = zip.get(item.path);
                if (!blob) return;
                const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                const kind = item.storageKey.startsWith("image:") ? "image" : item.storageKey.startsWith("audio:") ? "audio" : "video";
                try {
                    const uploaded = await uploadCanvasMedia(typedBlob, kind);
                    mapping.set(item.storageKey, { storageKey: uploaded.storage_key, url: uploaded.url });
                } catch (error) {
                    console.error("canvas asset import upload failed", item.path, error);
                }
            }),
        );
        return data.assets.map((asset) => remapImportedAsset(asset, mapping));
    }
    await Promise.all(
        data.files.map(async (item) => {
            const blob = zip.get(item.path);
            if (!blob) return;
            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
            await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
        }),
    );
    return data.assets;
}

function remapImportedAsset(asset: Asset, mapping: Map<string, { storageKey: string; url: string }>): Asset {
    const cloned = JSON.parse(JSON.stringify(asset)) as Asset;
    if (cloned.kind === "text") return cloned;
    const data = cloned.data as { dataUrl?: string; url?: string; storageKey?: string };
    const entry = data.storageKey ? mapping.get(data.storageKey) : undefined;
    if (!entry) return cloned;
    data.storageKey = entry.storageKey;
    if (cloned.kind === "video") data.url = entry.url;
    else data.dataUrl = entry.url;
    if (cloned.coverUrl.startsWith("blob:") || cloned.coverUrl.startsWith("data:")) cloned.coverUrl = entry.url;
    return cloned;
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    return kind === "image" ? "png" : "bin";
}
