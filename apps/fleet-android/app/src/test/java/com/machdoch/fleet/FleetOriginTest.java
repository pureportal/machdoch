package com.machdoch.fleet;

import org.junit.Test;
import static org.junit.Assert.*;

public class FleetOriginTest {
    @Test
    public void normalizesOnlyHttpsOrigins() {
        assertEquals("https://fleet.example", FleetOrigin.parse(" HTTPS://FLEET.EXAMPLE:443/ ").url());
        assertEquals("https://fleet.example:8443", FleetOrigin.parse("https://fleet.example:8443").url());
    }

    @Test
    public void rejectsCredentialsPathsAndUnencryptedConnections() {
        for (String url : new String[] { "http://fleet.example", "https://owner:password@fleet.example", "https://fleet.example/path", "https://fleet.example?token=secret", "https://fleet.example#token", "https://fleet.example:0", "https://fleet.example:65536", "javascript:alert(1)", "https://fleet.example\\@evil.example" }) {
            assertThrows(url, IllegalArgumentException.class, () -> FleetOrigin.parse(url));
        }
    }

    @Test
    public void locksNavigationToTheExactHostSchemeAndPort() {
        FleetOrigin origin = FleetOrigin.parse("https://fleet.example:8443");
        assertTrue(origin.allows("https://fleet.example:8443/instances"));
        for (String url : new String[] { "https://fleet.example/instances", "http://fleet.example:8443", "https://fleet.example.evil.example:8443", "https://evil.example/fleet.example:8443", "https://fleet.example@evil.example:8443", "file:///etc/passwd", "content://fleet.example", "javascript:alert(1)" }) {
            assertFalse(url, origin.allows(url));
        }
        assertTrue(origin.allowsDownload("blob:https://fleet.example:8443/file"));
        assertFalse(origin.allowsDownload("blob:https://evil.example/file"));
    }
}
