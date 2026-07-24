import { useEffect, type ReactNode } from "react";

import { isShortDramaIntegration } from "@/lib/short-drama-auth";
import {
    createRemoteCanvasProject,
    deleteRemoteCanvasProject,
    fromRemoteCanvasProject,
    getRemoteCanvasSettings,
    listCanvasModels,
    listRemoteCanvasProjects,
    updateRemoteCanvasProject,
    updateRemoteCanvasSettings,
} from "@/services/short-drama-canvas";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { encodeChannelModel, useConfigStore, type AiConfig, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";

const preferenceKeys = ["quality", "size", "background", "count", "canvasImageCount", "videoSeconds", "vquality", "videoGenerateAudio", "videoWatermark", "audioVoice", "audioFormat", "audioSpeed", "audioInstructions"] as const;
type PreferenceKey = (typeof preferenceKeys)[number];

export function CanvasShortDramaSync({ children }: { children: ReactNode }) {
    useCanvasProjectSync();
    useCanvasPreferenceSync();
    useCanvasModelSync();
    return <>{children}</>;
}

function useCanvasProjectSync() {
    useEffect(() => {
        if (!isShortDramaIntegration) return;
        let active = true;
        let ready = false;
        let syncing = false;
        let timer: number | undefined;
        const versions = new Map<string, number>();
		const fingerprints = new Map<string, string>();

        const sync = async () => {
            if (!ready || syncing) return;
            syncing = true;
            try {
                const projects = useCanvasStore.getState().projects;
                const currentIDs = new Set(projects.map((project) => project.id));
                for (const project of projects) {
                    const version = versions.get(project.id);
                    const fingerprint = canvasProjectFingerprint(project);
                    if (version !== undefined && fingerprints.get(project.id) === fingerprint) continue;
                    const remote = version === undefined ? await createRemoteCanvasProject(project) : await updateRemoteCanvasProject(project, version);
                    versions.set(remote.id, remote.version);
                    fingerprints.set(project.id, fingerprint);
                }
                for (const id of Array.from(versions.keys())) {
                    if (currentIDs.has(id)) continue;
                    await deleteRemoteCanvasProject(id);
                    versions.delete(id);
                    fingerprints.delete(id);
                }
            } catch {
                // Keep the local draft. A later edit retries synchronization.
            } finally {
                syncing = false;
            }
        };

        const schedule = () => {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(() => void sync(), 600);
        };

        const unsubscribe = useCanvasStore.subscribe(schedule);
        void listRemoteCanvasProjects()
            .then((remoteProjects) => {
                if (!active) return;
                remoteProjects.forEach((project) => {
                    versions.set(project.id, project.version);
                    fingerprints.set(project.id, canvasProjectFingerprint(fromRemoteCanvasProject(project)));
                });
                const localProjects = useCanvasStore.getState().projects;
                const localIDs = new Set(localProjects.map((project) => project.id));
                const missingRemoteProjects = remoteProjects.filter((project) => !localIDs.has(project.id)).map(fromRemoteCanvasProject);
                useCanvasStore.getState().replaceProjects([...localProjects, ...missingRemoteProjects]);
                ready = true;
                schedule();
            })
            .catch(() => {
                ready = false;
            });

        return () => {
            active = false;
            unsubscribe();
            if (timer) window.clearTimeout(timer);
        };
    }, []);
}

function useCanvasPreferenceSync() {
    useEffect(() => {
        if (!isShortDramaIntegration) return;
        let active = true;
        let ready = false;
        let timer: number | undefined;
        let lastSaved = "";

        const save = () => {
            if (!ready) return;
            const settings = canvasPreferences(useConfigStore.getState().config);
            const encoded = JSON.stringify(settings);
            if (encoded === lastSaved) return;
            lastSaved = encoded;
            void updateRemoteCanvasSettings(settings).catch(() => {
                lastSaved = "";
            });
        };

        const schedule = () => {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(save, 600);
        };

        const unsubscribe = useConfigStore.subscribe(schedule);
        void getRemoteCanvasSettings()
            .then((result) => {
                if (!active) return;
                const updateConfig = useConfigStore.getState().updateConfig;
                for (const key of preferenceKeys) {
                    const value = result.settings?.[key];
                    if (typeof value === "string") updateConfig(key, value);
                }
                lastSaved = JSON.stringify(canvasPreferences(useConfigStore.getState().config));
                ready = true;
            })
            .catch(() => {
                ready = false;
            });

        return () => {
            active = false;
            unsubscribe();
            if (timer) window.clearTimeout(timer);
        };
    }, []);
}

function canvasPreferences(config: AiConfig): Record<PreferenceKey, string> {
    return Object.fromEntries(preferenceKeys.map((key) => [key, config[key]])) as Record<PreferenceKey, string>;
}

function canvasProjectFingerprint(project: CanvasProject) {
    return JSON.stringify(project);
}

const SHORT_DRAMA_CHANNEL_ID = "short-drama";

// useCanvasModelSync 集成模式启动时按用途从短剧后端拉可用模型，构造一个虚拟渠道替换本地 channels，
// 并在用户未选模型时填默认值。画布不存密钥，模型元数据统一由后端 llm_configs 提供。
function useCanvasModelSync() {
    useEffect(() => {
        if (!isShortDramaIntegration) return;
        let active = true;
        void Promise.all([
            listCanvasModels("image").catch(() => []),
            listCanvasModels("video").catch(() => []),
            listCanvasModels("chat").catch(() => []),
        ]).then(([imageModels, videoModels, chatModels]) => {
            if (!active) return;
            applyShortDramaChannels(imageModels, videoModels, chatModels);
        });
        return () => {
            active = false;
        };
    }, []);
}

function applyShortDramaChannels(imageModels: { id: string }[], videoModels: { id: string }[], chatModels: { id: string }[]) {
    const models: ChannelModel[] = [
        ...imageModels.map((model) => ({ name: model.id, capability: "image" as const })),
        ...videoModels.map((model) => ({ name: model.id, capability: "video" as const })),
        ...chatModels.map((model) => ({ name: model.id, capability: "text" as const })),
    ];
    const encode = (model: { id: string } | undefined) => (model ? encodeChannelModel(SHORT_DRAMA_CHANNEL_ID, model.id) : "");
    const channel: ModelChannel = {
        id: SHORT_DRAMA_CHANNEL_ID,
        name: "短剧",
        baseUrl: "https://short-drama-proxy",
        apiKey: "integrated",
        apiFormat: "openai",
        models,
    };
    useConfigStore.setState((state) => {
        const config = state.config;
        const next: AiConfig = { ...config, channels: [channel] };
        if (!config.imageModel?.trim() && imageModels[0]) next.imageModel = encode(imageModels[0]);
        if (!config.videoModel?.trim() && videoModels[0]) next.videoModel = encode(videoModels[0]);
        if (!config.textModel?.trim() && chatModels[0]) next.textModel = encode(chatModels[0]);
        if (!config.model?.trim()) next.model = encode(imageModels[0]) || encode(chatModels[0]);
        return { config: next };
    });
}
