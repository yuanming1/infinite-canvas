import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

type ApiEnvelope<T> = { data: T };

export type RemoteCanvasProject = {
    id: string;
    drama_project_id?: string;
    title: string;
    content: Record<string, unknown>;
    version: number;
    created_at: string;
    updated_at: string;
};

export type CanvasGeneratedImage = { url: string; b64_json?: string; mime_type?: string };
export type CanvasVideoTask = { id: string; status: string; video_url?: string; error?: string };

const apiBaseUrl = (import.meta.env.VITE_SHORT_DRAMA_API_BASE_URL || "/api").replace(/\/+$/, "");

async function request<T>(path: string, init?: RequestInit) {
    const token = window.localStorage.getItem("short_drama_token")?.trim();
    const response = await fetch(`${apiBaseUrl}${path}`, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...init?.headers,
        },
    });
    if (!response.ok) throw new Error(`短剧画布同步失败：${response.status}`);
    return ((await response.json()) as ApiEnvelope<T>).data;
}

export function listRemoteCanvasProjects() {
    return request<RemoteCanvasProject[]>("/canvas/projects");
}

export function createRemoteCanvasProject(project: CanvasProject) {
    return request<RemoteCanvasProject>("/canvas/projects", { method: "POST", body: JSON.stringify(toRemoteCanvasProject(project)) });
}

export function updateRemoteCanvasProject(project: CanvasProject, version: number) {
    return request<RemoteCanvasProject>(`/canvas/projects/${encodeURIComponent(project.id)}`, {
        method: "PUT",
        body: JSON.stringify({ ...toRemoteCanvasProject(project), version }),
    });
}

export function deleteRemoteCanvasProject(id: string) {
    return request<{ deleted: boolean }>(`/canvas/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getRemoteCanvasSettings() {
    return request<{ settings: Record<string, unknown> }>("/canvas/settings");
}

export function updateRemoteCanvasSettings(settings: Record<string, unknown>) {
    return request<{ settings: Record<string, unknown> }>("/canvas/settings", { method: "PUT", body: JSON.stringify({ settings }) });
}

export function generateCanvasImages(input: { prompt: string; model: string; count: number; size: string; quality: string; references?: unknown[] }) {
    return request<CanvasGeneratedImage[]>("/canvas/generations/images", { method: "POST", body: JSON.stringify(input) });
}

export function completeCanvasChat(input: { model: string; messages: Array<{ role: string; content: string }> }) {
    return request<{ content: string }>("/canvas/generations/chat", { method: "POST", body: JSON.stringify(input) });
}

export async function generateCanvasAudio(input: { input: string; model: string; options: { voice: string; response_format: string; speed: number } }) {
    const result = await request<{ data: string; mime_type?: string }>("/canvas/generations/audio", { method: "POST", body: JSON.stringify(input) });
    const bytes = Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: result.mime_type || "audio/mpeg" });
}

export function createCanvasVideoTask(input: { prompt: string; options: Record<string, unknown> }) {
    return request<CanvasVideoTask>("/canvas/generations/videos", { method: "POST", body: JSON.stringify(input) });
}

export function getCanvasVideoTask(taskID: string, model: string) {
    return request<CanvasVideoTask>(`/canvas/generations/videos/${encodeURIComponent(taskID)}?model=${encodeURIComponent(model)}`);
}

export function fromRemoteCanvasProject(project: RemoteCanvasProject): CanvasProject {
    const content = project.content && typeof project.content === "object" ? project.content : {};
    return {
        id: project.id,
        title: project.title,
        createdAt: stringValue(content.createdAt, project.created_at),
        updatedAt: stringValue(content.updatedAt, project.updated_at),
        nodes: arrayValue(content.nodes),
        connections: arrayValue(content.connections),
        chatSessions: arrayValue(content.chatSessions),
        activeChatId: stringValue(content.activeChatId) || null,
        backgroundMode: content.backgroundMode === "dots" || content.backgroundMode === "plain" ? content.backgroundMode : "lines",
        showImageInfo: content.showImageInfo === true,
        viewport: viewportValue(content.viewport),
    } as CanvasProject;
}

function toRemoteCanvasProject(project: CanvasProject) {
    const { id, title, createdAt, updatedAt, ...content } = project;
    return { id, title, content: { ...content, createdAt, updatedAt } };
}

function stringValue(value: unknown, fallback = "") {
    return typeof value === "string" ? value : fallback;
}

function arrayValue(value: unknown) {
    return Array.isArray(value) ? value : [];
}

function viewportValue(value: unknown) {
    if (!value || typeof value !== "object") return { x: 0, y: 0, k: 1 };
    const viewport = value as Record<string, unknown>;
    return {
        x: typeof viewport.x === "number" ? viewport.x : 0,
        y: typeof viewport.y === "number" ? viewport.y : 0,
        k: typeof viewport.k === "number" ? viewport.k : 1,
    };
}
