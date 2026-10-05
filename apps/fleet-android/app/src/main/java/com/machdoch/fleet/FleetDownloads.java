package com.machdoch.fleet;

import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

final class FleetDownloads {
    private static final long MAXIMUM_BYTES = 512L * 1024 * 1024;
    private final ComponentActivity activity;
    private final ActivityResultLauncher<Intent> picker;
    private String transferId;
    private JavaScriptReplyProxy reply;
    private OutputStream output;
    private long received;

    FleetDownloads(ComponentActivity activity) {
        this.activity = activity;
        picker = activity.registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (transferId == null) return;
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { fail(); return; }
            if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
                cancel();
                return;
            }
            try {
                output = activity.getContentResolver().openOutputStream(result.getData().getData());
                if (output == null) throw new IOException("The selected file could not be opened.");
                sendReply(reply, "ready");
            } catch (IOException | SecurityException error) { fail(); }
        });
    }

    void attach(WebView view, FleetOrigin origin) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
          WebViewCompat.addWebMessageListener(view, "machdochDownload", Set.of(origin.url()), (source, message, sourceOrigin, isMainFrame, proxy) -> {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { fail(); return; }
            String data = message.getData();
            if (!origin.allows(sourceOrigin.toString()) || data == null || data.length() > 100_000) return;
            try {
                JSONObject request = new JSONObject(data);
                String id = request.getString("id");
                String operation = request.getString("operation");
                if (operation.equals("busy")) {
                    Toast.makeText(activity, "Finish the current download first.", Toast.LENGTH_SHORT).show();
                } else if (operation.equals("begin")) {
                    if (transferId != null || id.length() > 64 || !origin.allowsDownload(request.getString("url"))) { sendReply(proxy, "cancel"); return; }
                    transferId = id;
                    reply = proxy;
                    received = 0;
                    String name = request.optString("name", "download").replaceAll("[\\\\/\\p{Cntrl}]", "_");
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream");
                    intent.putExtra(Intent.EXTRA_TITLE, name.substring(0, Math.min(name.length(), 180)));
                    picker.launch(intent);
                } else if (operation.equals("error") && (transferId == null || id.equals(transferId))) {
                    boolean incomplete = output != null;
                    cancel();
                    String error = request.optString("reason").equals("size")
                        ? "Save a file smaller than 512 MB."
                        : incomplete ? "Download failed. Delete the incomplete file and try again." : "The download could not be opened. Retry to download it.";
                    Toast.makeText(activity, error, Toast.LENGTH_LONG).show();
                } else if (id.equals(transferId) && output != null) {
                    if (operation.equals("chunk")) {
                        byte[] bytes = android.util.Base64.decode(request.getString("data"), android.util.Base64.NO_WRAP);
                        received += bytes.length;
                        if (received > MAXIMUM_BYTES) throw new IOException("The download exceeds the size limit.");
                        output.write(bytes);
                        sendReply(reply, "continue");
                    } else if (operation.equals("complete")) {
                        output.close();
                        output = null;
                        transferId = null;
                        reply = null;
                        Toast.makeText(activity, "File saved", Toast.LENGTH_SHORT).show();
                    }
                }
            } catch (JSONException | IOException | IllegalArgumentException | SecurityException | ActivityNotFoundException error) { fail(); }
          });
        try {
            String script;
            try (java.io.InputStream input = activity.getAssets().open("downloads.js")) {
                script = new String(input.readAllBytes(), StandardCharsets.UTF_8);
            }
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(view, script, Set.of(origin.url()));
            } else {
                view.setDownloadListener((url, agent, disposition, type, size) -> Toast.makeText(activity, "Update Android System WebView to download files.", Toast.LENGTH_LONG).show());
            }
        } catch (IOException error) { throw new IllegalStateException("Download script is missing.", error); }
        } else {
            view.setDownloadListener((url, agent, disposition, type, size) -> Toast.makeText(activity, "Update Android System WebView to download files.", Toast.LENGTH_LONG).show());
        }
    }

    void cancel() {
        if (reply != null) sendReply(reply, "cancel");
        if (output != null) {
            try { output.close(); }
            catch (IOException error) { Toast.makeText(activity, "The incomplete file could not be closed. Delete it and retry.", Toast.LENGTH_LONG).show(); }
        }
        output = null;
        transferId = null;
        reply = null;
    }

    private void fail() {
        cancel();
        Toast.makeText(activity, "Download failed. Delete the incomplete file and try again.", Toast.LENGTH_LONG).show();
    }

    private void sendReply(JavaScriptReplyProxy proxy, String message) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            proxy.postMessage(message);
        }
    }
}
