package com.machdoch.fleet;

import java.net.URI;

final class FleetRequestPolicy {
    enum NavigationDecision {
        ALLOW_IN_WEBVIEW,
        OPEN_EXTERNAL,
        BLOCK,
        INVALID_LINK
    }

    private final FleetOrigin origin;

    FleetRequestPolicy(FleetOrigin origin) {
        this.origin = origin;
    }

    NavigationDecision decideNavigation(String url, boolean mainFrame, boolean gesture) {
        if (origin.allows(url)) return NavigationDecision.ALLOW_IN_WEBVIEW;
        if (!mainFrame || !gesture) return NavigationDecision.BLOCK;
        try {
            return FleetOrigin.isHttps(URI.create(url))
                ? NavigationDecision.OPEN_EXTERNAL : NavigationDecision.BLOCK;
        } catch (IllegalArgumentException error) {
            return NavigationDecision.INVALID_LINK;
        }
    }

    boolean allowsResource(String url, boolean mainFrame) {
        return origin.allows(url)
            || (!mainFrame && (origin.allowsDownload(url) || url.startsWith("data:")));
    }
}
