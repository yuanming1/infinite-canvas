import { useEffect, useState, type ReactNode } from "react";

import { hasShortDramaSession, isShortDramaIntegration, redirectToShortDramaLogin } from "@/lib/short-drama-auth";

export function ShortDramaAuthGate({ children }: { children: ReactNode }) {
    const [authorized, setAuthorized] = useState(!isShortDramaIntegration);

    useEffect(() => {
        if (!isShortDramaIntegration) return;
        let active = true;
        void hasShortDramaSession().then((valid) => {
            if (!active) return;
            if (valid) setAuthorized(true);
            else redirectToShortDramaLogin();
        });
        return () => {
            active = false;
        };
    }, []);

    if (!authorized) return null;
    return <>{children}</>;
}
