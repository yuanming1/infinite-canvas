import { isShortDramaIntegration } from "@/lib/short-drama-auth";

type ApiEnvelope<T> = { data: T };

export type CanvasMediaKind = "image" | "video" | "audio";

export type CanvasMediaUploadResult = {
    storage_key: string;
    url: string;
    provider: "imagex" | "minio";
    bytes: number;
    mime_type: string;
    width?: number;
    height?: number;
    duration_ms?: number;
};

export type RemoteCanvasAsset = {
    id: string;
    kind: "text" | "image" | "video";
    title: string;
    cover_url: string;
    tags: string[];
    note: string;
    source: string;
    metadata?: Record<string, unknown> | null;
    data: Record<string, unknown>;
    version: number;
    created_at: string;
    updated_at: string;
};

export type RemoteCanvasAssetInput = {
    id: string;
    kind: "text" | "image" | "video";
    title: string;
    cover_url: string;
    tags: string[];
    note: string;
    source: string;
    metadata?: Record<string, unknown> | null;
    data: Record<string, unknown>;
    version: number;
};

const apiBaseUrl = (import.meta.env.VITE_SHORT_DRAMA_API_BASE_URL || "/api").replace(/\/+$/, "");

function authHeaders(extra?: HeadersInit): HeadersInit {
    const token = window.localStorage.getItem("short_drama_token")?.trim();
    return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

async function request<T>(path: string, init?: RequestInit) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
        ...init,
        headers: authHeaders({ "Content-Type": "application/json", ...init?.headers }),
    });
    if (!response.ok) {
        let message = `${response.status}`;
        try {
            const body = (await response.json()) as { error?: string };
            if (body?.error) message = body.error;
        } catch {
            // keep status text
        }
        throw new Error(message);
    }
    return ((await response.json()) as ApiEnvelope<T>).data;
}

export async function uploadCanvasMedia(blob: Blob, kind: CanvasMediaKind, meta?: { width?: number; height?: number; durationMs?: number }) {
    const form = new FormData();
    form.append("file", blob);
    form.append("kind", kind);
    if (meta?.width !== undefined) form.append("width", String(meta.width));
    if (meta?.height !== undefined) form.append("height", String(meta.height));
    if (meta?.durationMs !== undefined) form.append("durationMs", String(meta.durationMs));
    // multipart 不能手工设 Content-Type，由浏览器带 boundary；authHeaders 不注入 json 头。
    const response = await fetch(`${apiBaseUrl}/canvas/media`, { method: "POST", body: form, headers: authHeaders() });
    if (!response.ok) {
        let message = `${response.status}`;
        try {
            const body = (await response.json()) as { error?: string };
            if (body?.error) message = body.error;
        } catch {
            // keep status text
        }
        throw new Error(message);
    }
    return ((await response.json()) as ApiEnvelope<CanvasMediaUploadResult>).data;
}

export function getCanvasMedia(storageKey: string) {
    assertIntegration();
    return request<CanvasMediaUploadResult>(`/canvas/media/by-key/${encodeURIComponent(storageKey)}`);
}

export function deleteCanvasMedia(storageKey: string) {
    assertIntegration();
    return request<{ deleted: boolean }>(`/canvas/media/by-key/${encodeURIComponent(storageKey)}`, { method: "DELETE" });
}

export function listRemoteCanvasAssets() {
    assertIntegration();
    return request<RemoteCanvasAsset[]>("/canvas/assets");
}

export function createRemoteCanvasAsset(asset: RemoteCanvasAssetInput) {
    assertIntegration();
    return request<RemoteCanvasAsset>("/canvas/assets", { method: "POST", body: JSON.stringify(asset) });
}

export function batchCreateRemoteCanvasAssets(assets: RemoteCanvasAssetInput[]) {
    assertIntegration();
    return request<{ created: number; skipped: number }>("/canvas/assets/batch", { method: "POST", body: JSON.stringify({ assets }) });
}

export function updateRemoteCanvasAsset(asset: RemoteCanvasAssetInput) {
    assertIntegration();
    return request<RemoteCanvasAsset>(`/canvas/assets/${encodeURIComponent(asset.id)}`, { method: "PUT", body: JSON.stringify(asset) });
}

export function deleteRemoteCanvasAsset(id: string) {
    assertIntegration();
    return request<{ deleted: boolean }>(`/canvas/assets/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function isCanvasMediaTooLargeError(error: unknown) {
    return error instanceof Error && error.message.includes("too large");
}

export function isCanvasAssetConflictError(error: unknown) {
    return error instanceof Error && (error.message.includes("409") || error.message.includes("changed or no longer exists"));
}

function assertIntegration() {
    if (!isShortDramaIntegration) throw new Error("short drama integration is disabled");
}
