const TOKEN_KEY = "short_drama_token";
const apiBaseUrl = (import.meta.env.VITE_SHORT_DRAMA_API_BASE_URL || "/api").replace(/\/+$/, "");

export const isShortDramaIntegration = import.meta.env.VITE_SHORT_DRAMA_INTEGRATION === "true";

export async function hasShortDramaSession() {
    if (!isShortDramaIntegration) return true;
    const token = window.localStorage.getItem(TOKEN_KEY)?.trim();
    if (!token) return false;

    try {
        const response = await fetch(`${apiBaseUrl}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) return true;
        window.localStorage.removeItem(TOKEN_KEY);
    } catch {
        return false;
    }
    return false;
}

export function redirectToShortDramaLogin() {
    window.location.replace("/");
}
