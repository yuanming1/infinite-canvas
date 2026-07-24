import { isShortDramaIntegration } from "@/lib/short-drama-auth";
import { listCanvasModels } from "@/services/short-drama-canvas";
import { useConfigStore, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";

const SHORT_DRAMA_CHANNEL_ID = "short-drama";

// 集成模式下需要懒加载的 capability；text/audio（对应 chat 模型）暂不加载。
function purposeOf(capability: ModelCapability): "image" | "video" | null {
    if (capability === "image") return "image";
    if (capability === "video") return "video";
    return null;
}

const loaded = new Set<ModelCapability>();
const inflight: Partial<Record<ModelCapability, Promise<void>>> = {};

// ensureShortDramaModels 在用户打开对应模型选择器时按 capability 拉取短剧后端可用模型，
// 避免启动时一次性并发拉取 image/video/chat。同一 capability 只拉一次，失败后允许重试。
export function ensureShortDramaModels(capability: ModelCapability): Promise<void> {
    if (!isShortDramaIntegration) return Promise.resolve();
    const purpose = purposeOf(capability);
    if (!purpose) return Promise.resolve();
    if (loaded.has(capability)) return Promise.resolve();
    const existing = inflight[capability];
    if (existing) return existing;
    const task = listCanvasModels(purpose)
        .then((models) => {
            mergeShortDramaModels(capability, models);
            loaded.add(capability);
        })
        .catch(() => {
            // 加载失败静默；用户重新打开选择器会再次触发。
        })
        .finally(() => {
            delete inflight[capability];
        });
    inflight[capability] = task;
    return task;
}

// ensureShortDramaChannel 在集成模式启动时把 channels 重置为单一短剧虚拟渠道，
// 清掉本地 persist 的旧渠道；模型列表按需由 ensureShortDramaModels 填充。
export function ensureShortDramaChannel() {
    if (!isShortDramaIntegration) return;
    useConfigStore.setState((state) => {
        const existingModels = state.config.channels.find((channel) => channel.id === SHORT_DRAMA_CHANNEL_ID)?.models ?? [];
        const channel: ModelChannel = {
            id: SHORT_DRAMA_CHANNEL_ID,
            name: "短剧",
            baseUrl: "https://short-drama-proxy",
            apiKey: "integrated",
            apiFormat: "openai",
            models: existingModels,
        };
        return { config: { ...state.config, channels: [channel] } };
    });
}

function mergeShortDramaModels(capability: ModelCapability, models: { id: string }[]) {
    useConfigStore.setState((state) => {
        const channels = state.config.channels.slice();
        const index = channels.findIndex((channel) => channel.id === SHORT_DRAMA_CHANNEL_ID);
        const existingNames = new Set(index >= 0 ? channels[index].models.map((model) => model.name) : []);
        const incoming: ChannelModel[] = [];
        for (const model of models) {
            if (existingNames.has(model.id)) continue;
            existingNames.add(model.id);
            incoming.push({ name: model.id, capability });
        }
        if (!incoming.length) return state;
        if (index >= 0) {
            channels[index] = { ...channels[index], models: [...channels[index].models, ...incoming] };
        } else {
            channels.push({
                id: SHORT_DRAMA_CHANNEL_ID,
                name: "短剧",
                baseUrl: "https://short-drama-proxy",
                apiKey: "integrated",
                apiFormat: "openai",
                models: incoming,
            });
        }
        return { config: { ...state.config, channels } };
    });
}
