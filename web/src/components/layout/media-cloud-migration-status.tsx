import { useEffect, useState } from "react";

import { useTranslation } from "react-i18next";

import { isShortDramaIntegration } from "@/lib/short-drama-auth";
import { subscribeCloudMigration, runCloudMediaMigration, type CloudMigrationStatus } from "@/services/canvas-media-migration";

/**
 * 集成模式的存量媒体迁移进度浮层：迁移进行中显示进度，失败时可手动重试。
 */
export function MediaCloudMigrationStatus() {
    const { t } = useTranslation();
    const [status, setStatus] = useState<CloudMigrationStatus | null>(null);

    useEffect(() => {
        if (!isShortDramaIntegration) return;
        return subscribeCloudMigration(setStatus);
    }, []);

    if (!isShortDramaIntegration || !status || (status.state !== "running" && status.state !== "failed")) return null;

    if (status.state === "failed") {
        return (
            <div className="fixed bottom-4 right-4 z-50 max-w-xs rounded-lg border border-red-300 bg-white p-3 text-sm shadow-lg dark:border-red-700 dark:bg-neutral-900">
                <div className="font-medium text-red-600 dark:text-red-400">{t("migration.failed")}</div>
                <div className="mt-1 break-all text-xs text-neutral-500 dark:text-neutral-400">{status.error}</div>
                <button type="button" className="mt-2 rounded border px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => void runCloudMediaMigration()}>
                    {t("migration.retry")}
                </button>
            </div>
        );
    }

    const percent = status.total > 0 ? Math.round((status.uploaded / status.total) * 100) : 100;
    return (
        <div className="fixed bottom-4 right-4 z-50 max-w-xs rounded-lg border border-neutral-200 bg-white p-3 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
            <div className="font-medium">{t("migration.title")}</div>
            <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t("migration.progress", { uploaded: status.uploaded, total: status.total })}</div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-700">
                <div className="h-full bg-blue-500 transition-all" style={{ width: `${percent}%` }} />
            </div>
        </div>
    );
}
