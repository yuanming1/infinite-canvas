import { isShortDramaIntegration } from "@/lib/short-drama-auth";
import { listCanvasModels } from "@/services/short-drama-canvas";
import { useConfigStore, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";

// 后端 /llm-configs/{purpose}/models 对 image/video 返回的是同一份完整模型清单（不按 purpose 过滤），
// 因此每个 capability 必须使用独立 channel：既避免按模型名去重时把后加载的 capability 全部跳过，
// 也保证 encodeChannelModel 编码出的 value（{channelId}::{model}）在两个下拉之间不冲突。
const SHORT_DRAMA_IMAGE_CHANNEL_ID = "short-drama-image";
const SHORT_DRAMA_VIDEO_CHANNEL_ID = "short-drama-video";
const SHORT_DRAMA_CHANNEL_IDS = new Set([SHORT_DRAMA_IMAGE_CHANNEL_ID, SHORT_DRAMA_VIDEO_CHANNEL_ID]);

// 集成模式下需要懒加载的 capability；text/audio（对应 chat 模型）暂不加载。
function purposeOf(capability: ModelCapability): "image" | "video" | null {
    if (capability === "image") return "image";
    if (capability === "video") return "video";
    return null;
}

function shortDramaChannelId(capability: ModelCapability): string {
    return capability === "image" ? SHORT_DRAMA_IMAGE_CHANNEL_ID : SHORT_DRAMA_VIDEO_CHANNEL_ID;
}

function shortDramaChannelName(capability: ModelCapability): string {
    return capability === "image" ? "短剧·图像" : "短剧·视频";
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

// ensureShortDramaChannel 在集成模式启动时清掉本地 persist 的非短剧渠道，
// 只保留按 capability 拆分的 short-drama-image / short-drama-video 虚拟渠道；模型列表按需由 ensureShortDramaModels 填充。
export function ensureShortDramaChannel() {
    if (!isShortDramaIntegration) return;
    useConfigStore.setState((state) => {
        const channels = state.config.channels.filter((channel) => SHORT_DRAMA_CHANNEL_IDS.has(channel.id));
        return channels.length === state.config.channels.length ? state : { config: { ...state.config, channels } };
    });
}

// mergeShortDramaModels 用最新拉取的模型列表整体覆盖该 capability 对应的虚拟渠道。
// 同一 capability 再次拉取时直接覆盖，避免之前因按模型名去重导致后加载 capability 永远拿不到模型。
function mergeShortDramaModels(capability: ModelCapability, models: { id: string }[]) {
    useConfigStore.setState((state) => {
        const channelId = shortDramaChannelId(capability);
        const incoming: ChannelModel[] = models.map((model) => ({ name: model.id, capability }));
        if (!incoming.length) return state;
        const others = state.config.channels.filter((channel) => channel.id !== channelId);
        const channel: ModelChannel = {
            id: channelId,
            name: shortDramaChannelName(capability),
            baseUrl: "https://short-drama-proxy",
            apiKey: "integrated",
            apiFormat: "openai",
            models: incoming,
        };
        return { config: { ...state.config, channels: [...others, channel] } };
    });
}
