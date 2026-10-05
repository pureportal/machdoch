package com.machdoch.fleet;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

public final class FleetOrigin {
    private final URI origin;

    private FleetOrigin(URI origin) {
        this.origin = origin;
    }

    public static FleetOrigin parse(String value) {
        try {
            URI uri = new URI(value.trim());
            if (!isHttps(uri) || uri.getRawQuery() != null || uri.getRawFragment() != null
                || (uri.getRawPath() != null && !uri.getRawPath().isEmpty() && !uri.getRawPath().equals("/"))) {
                throw new IllegalArgumentException("Enter an HTTPS URL without a path, query, or fragment.");
            }
            int port = effectivePort(uri);
            URI normalized = new URI("https", null, uri.getHost().toLowerCase(Locale.ROOT), port == 443 ? -1 : port, null, null, null);
            return new FleetOrigin(normalized);
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Enter a valid HTTPS URL.", error);
        }
    }

    public boolean allows(String value) {
        try {
            URI uri = new URI(value);
            return isHttps(uri) && origin.getHost().equalsIgnoreCase(uri.getHost()) && effectivePort(origin) == effectivePort(uri);
        } catch (URISyntaxException | IllegalArgumentException error) {
            return false;
        }
    }

    public boolean allowsDownload(String value) {
        return allows(value.startsWith("blob:") ? value.substring(5) : value);
    }

    public static boolean isHttps(URI uri) {
        return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
            && uri.getRawUserInfo() == null && uri.getPort() != 0 && uri.getPort() <= 65535;
    }

    private static int effectivePort(URI uri) {
        return uri.getPort() == -1 ? 443 : uri.getPort();
    }

    public String url() {
        return origin.toString();
    }
}
