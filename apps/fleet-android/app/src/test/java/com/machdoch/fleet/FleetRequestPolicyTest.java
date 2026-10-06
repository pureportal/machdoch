package com.machdoch.fleet;

import java.util.ArrayList;
import java.util.Collection;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import static org.junit.Assert.assertEquals;

@RunWith(Parameterized.class)
public class FleetRequestPolicyTest {
    @Parameterized.Parameters(name = "{index}: origin={0}, url={1}, mainFrame={2}, gesture={3}")
    public static Collection<Object[]> requests() {
        Object[][] cases = {
            { "https://fleet.example", "https://fleet.example/instances", "ALLOW_IN_WEBVIEW", true, true },
            { "https://fleet.example", "HTTPS://FLEET.EXAMPLE/instances", "ALLOW_IN_WEBVIEW", true, true },
            { "https://fleet.example", "https://fleet.example:443/path?query=value#fragment", "ALLOW_IN_WEBVIEW", true, true },
            { "https://fleet.example:443", "https://fleet.example/path", "ALLOW_IN_WEBVIEW", true, true },
            { "https://fleet.example:8443", "https://FLEET.EXAMPLE:8443/path", "ALLOW_IN_WEBVIEW", true, true },
            { "https://fleet.example:8443", "https://fleet.example/path", "OPEN_EXTERNAL", false, false },
            { "https://fleet.example", "https://fleet.example:8443/path", "OPEN_EXTERNAL", false, false },
            { "https://fleet.example", "https://external.example/path", "OPEN_EXTERNAL", false, false },
            { "https://fleet.example", "https://fleet.example.evil.example/path", "OPEN_EXTERNAL", false, false },
            { "https://fleet.example", "https://owner:password@fleet.example/path", "BLOCK", false, false },
            { "https://fleet.example", "https://fleet.example@evil.example/path", "BLOCK", false, false },
            { "https://fleet.example", "https://fleet.example:0/path", "BLOCK", false, false },
            { "https://fleet.example", "https://fleet.example:65536/path", "BLOCK", false, false },
            { "https://fleet.example", "https://fleet.example:invalid/path", "BLOCK", false, false },
            { "https://fleet.example", "https://fleet.example:-1/path", "BLOCK", false, false },
            { "https://fleet.example", "https://fleet.example:65535/path", "OPEN_EXTERNAL", false, false },
            { "https://fleet.example", "http://fleet.example/path", "BLOCK", false, false },
            { "https://fleet.example", "file:///etc/passwd", "BLOCK", false, false },
            { "https://fleet.example", "content://fleet.example/path", "BLOCK", false, false },
            { "https://fleet.example", "javascript:alert(1)", "BLOCK", false, false },
            { "https://fleet.example", "/relative/path", "BLOCK", false, false },
            { "https://fleet.example", "", "BLOCK", false, false },
            { "https://fleet.example", "https://", "INVALID_LINK", false, false },
            { "https://fleet.example", "https://fleet.example/%zz", "INVALID_LINK", false, false },
            { "https://fleet.example", "https://fleet.example/path with spaces", "INVALID_LINK", false, false },
            { "https://fleet.example", "https://fleet.example\\@evil.example", "INVALID_LINK", false, false },
            { "https://fleet.example", "blob:https://fleet.example/file", "BLOCK", true, false },
            { "https://fleet.example", "blob:HTTPS://FLEET.EXAMPLE:443/file", "BLOCK", true, false },
            { "https://fleet.example:8443", "blob:https://fleet.example:8443/file", "BLOCK", true, false },
            { "https://fleet.example:8443", "blob:https://fleet.example/file", "BLOCK", false, false },
            { "https://fleet.example", "blob:https://external.example/file", "BLOCK", false, false },
            { "https://fleet.example", "BLOB:https://fleet.example/file", "BLOCK", false, false },
            { "https://fleet.example", "blob:https://owner:password@fleet.example/file", "BLOCK", false, false },
            { "https://fleet.example", "blob:https://fleet.example/%zz", "INVALID_LINK", false, false },
            { "https://fleet.example", "data:text/plain,hello", "BLOCK", true, false },
            { "https://fleet.example", "data:text/plain,hello world", "INVALID_LINK", true, false },
            { "https://fleet.example", "DATA:text/plain,hello", "BLOCK", false, false }
        };
        Collection<Object[]> requests = new ArrayList<>();
        for (Object[] entry : cases) {
            for (boolean mainFrame : new boolean[] { false, true }) {
                for (boolean gesture : new boolean[] { false, true }) {
                    String navigation = (String) entry[2];
                    if (!navigation.equals("ALLOW_IN_WEBVIEW") && !(mainFrame && gesture)) navigation = "BLOCK";
                    requests.add(new Object[] {
                        entry[0], entry[1], mainFrame, gesture, navigation, mainFrame ? entry[4] : entry[3]
                    });
                }
            }
        }
        return requests;
    }

    private final FleetRequestPolicy requestPolicy;
    private final String url;
    private final boolean mainFrame;
    private final boolean gesture;
    private final String expectedNavigation;
    private final boolean expectedResourceAllowed;

    public FleetRequestPolicyTest(String originUrl, String url, boolean mainFrame, boolean gesture,
                                 String expectedNavigation, boolean expectedResourceAllowed) {
        this.requestPolicy = new FleetRequestPolicy(FleetOrigin.parse(originUrl));
        this.url = url;
        this.mainFrame = mainFrame;
        this.gesture = gesture;
        this.expectedNavigation = expectedNavigation;
        this.expectedResourceAllowed = expectedResourceAllowed;
    }

    @Test
    public void decidesNavigationForTheOriginFrameAndGesture() {
        assertEquals(expectedNavigation, requestPolicy.decideNavigation(url, mainFrame, gesture).name());
    }

    @Test
    public void decidesResourceInterceptionIndependentlyOfNavigation() {
        assertEquals(expectedResourceAllowed, requestPolicy.allowsResource(url, mainFrame));
    }
}
