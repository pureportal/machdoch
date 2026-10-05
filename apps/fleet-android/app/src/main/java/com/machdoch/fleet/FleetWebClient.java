package com.machdoch.fleet;

import android.net.Uri;
import android.net.http.SslError;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.util.Map;
import java.util.function.Consumer;

final class FleetWebClient extends WebViewClient {
    private final FleetOrigin origin;
    private final Consumer<Uri> openExternal;
    private final Consumer<String> showError;

    FleetWebClient(FleetOrigin origin, Consumer<Uri> openExternal, Consumer<String> showError) {
        this.origin = origin;
        this.openExternal = openExternal;
        this.showError = showError;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        String url = request.getUrl().toString();
        if (origin.allows(url)) return false;
        try {
            if (request.isForMainFrame() && request.hasGesture() && FleetOrigin.isHttps(URI.create(url))) openExternal.accept(request.getUrl());
        } catch (IllegalArgumentException error) { showError.accept("This link is invalid."); }
        return true;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        String url = request.getUrl().toString();
        if (origin.allows(url) || (!request.isForMainFrame() && (origin.allowsDownload(url) || url.startsWith("data:")))) return null;
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Map.of(), new ByteArrayInputStream(new byte[0]));
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.cancel();
        showError.accept("The connection is not secure. Fix the Fleet Manager HTTPS certificate and try again.");
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) showError.accept("Fleet Manager could not be reached. Check the URL and connection, then retry.");
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        showError.accept("The device view closed unexpectedly. Retry to reconnect.");
        return true;
    }
}
