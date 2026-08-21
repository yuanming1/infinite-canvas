import { useEffect } from "react";

import { isShortDramaIntegration, hasShortDramaSession } from "@/lib/short-drama-auth";
import { useAssetStore } from "@/stores/use-asset-store";
import { runCloudMediaMigration } from "@/services/canvas-media-migration";

/**
 * 集成模式下把「我的资产」切换为云端权威：
 * 登录会话确认后先执行一次性本地媒体迁移（迁移内部自行快照本地数据），
 * 迁移结束后拉取全量云端资产覆盖本地缓存。
 */
export function useCanvasAssetCloudSync() {
    useEffect(() => {
        if (!isShortDramaIntegration) return;
        let aborted = false;
        let started = false;

        const load = async () => {
            if (started || !(await hasShortDramaSession())) return;
            started = true;
            try {
                await runCloudMediaMigration();
            } catch (error) {
                console.error("canvas media migration failed", error);
            }
            if (aborted) return;
            try {
                await useAssetStore.getState().loadCloudAssets();
            } catch (error) {
                console.error("canvas asset cloud load failed", error);
            }
        };

        void load();
        return () => {
            aborted = true;
        };
    }, []);
}
