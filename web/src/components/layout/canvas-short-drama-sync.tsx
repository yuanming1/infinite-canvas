import { useEffect, type ReactNode } from "react";

import { isShortDramaIntegration } from "@/lib/short-drama-auth";
import {
    createRemoteCanvasProject,
    deleteRemoteCanvasProject,
    fromRemoteCanvasProject,
    getRemoteCanvasSettings,
    listRemoteCanvasProjects,
    updateRemoteCanvasProject,
    updateRemoteCanvasSettings,
} from "@/services/short-drama-canvas";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { ensureShortDramaChannel } from "@/components/layout/canvas-short-drama-models";

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

// useCanvasModelSync 集成模式启动时重置为单一短剧虚拟渠道；模型列表不再启动预拉，
// 改由 ModelPicker 在用户打开对应工作台的模型选择器时按 capability 懒加载（见 canvas-short-drama-models.ts）。
function useCanvasModelSync() {
    useEffect(() => {
        if (!isShortDramaIntegration) return;
        ensureShortDramaChannel();
    }, []);
}
