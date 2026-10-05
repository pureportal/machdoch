package com.machdoch.fleet;

import android.app.AlertDialog;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

public final class FleetActivity extends ComponentActivity {
    private WebView webView;
    private FleetOrigin origin;
    private FleetDownloads downloads;
    private ValueCallback<Uri[]> fileSelection;
    private LinearLayout content;
    private AlertDialog connectionError;
    private final ActivityResultLauncher<Intent> filePicker = registerForActivityResult(
        new ActivityResultContracts.StartActivityForResult(), result -> {
            if (fileSelection == null) return;
            Uri[] files = WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData());
            fileSelection.onReceiveValue(files);
            fileSelection = null;
        });

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        downloads = new FleetDownloads(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets padding = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
            return insets;
        });
        setContentView(content);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) webView.goBack();
                else finish();
            }
        });
        String savedOrigin = getPreferences(MODE_PRIVATE).getString("manager", "");
        if (savedOrigin.isEmpty()) showManagerForm();
        else {
            try { connect(FleetOrigin.parse(savedOrigin)); }
            catch (IllegalArgumentException error) { showManagerForm(); }
        }
    }

    private void showManagerForm() {
        destroyWebView();
        content.removeAllViews();
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setGravity(Gravity.CENTER_VERTICAL);
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        form.setPadding(padding, padding, padding, padding);
        TextView title = new TextView(this);
        title.setText(R.string.manager);
        title.setTextSize(24);
        form.addView(title);
        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setHint(R.string.https_url);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setText(getPreferences(MODE_PRIVATE).getString("manager", ""));
        form.addView(address);
        Button open = new Button(this);
        open.setText(R.string.connect);
        open.setOnClickListener(view -> {
            try {
                FleetOrigin selected = FleetOrigin.parse(address.getText().toString());
                CookieManager.getInstance().removeAllCookies(removed -> {
                    CookieManager.getInstance().flush();
                    WebStorage.getInstance().deleteAllData();
                    getPreferences(MODE_PRIVATE).edit().putString("manager", selected.url()).apply();
                    connect(selected);
                });
            } catch (IllegalArgumentException error) { address.setError(error.getMessage()); }
        });
        form.addView(open);
        content.addView(form, new LinearLayout.LayoutParams(-1, -1));
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void connect(FleetOrigin selected) {
        destroyWebView();
        origin = selected;
        content.removeAllViews();
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        TextView host = new TextView(this);
        host.setText(Uri.parse(origin.url()).getAuthority());
        host.setPadding(16, 0, 16, 0);
        toolbar.addView(host, new LinearLayout.LayoutParams(0, -2, 1));
        Button change = new Button(this);
        change.setText(R.string.change_manager);
        change.setOnClickListener(view -> new AlertDialog.Builder(this)
            .setTitle("Change manager?")
            .setMessage("This closes the device view and signs you out of this app.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Change manager", (dialog, choice) -> CookieManager.getInstance().removeAllCookies(removed -> {
                CookieManager.getInstance().flush();
                WebStorage.getInstance().deleteAllData();
                showManagerForm();
            })).show());
        toolbar.addView(change);
        content.addView(toolbar);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.setWebViewClient(new FleetWebClient(origin, this::openExternal, this::showConnectionError));
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams parameters) {
                if (!origin.allows(view.getUrl())) return false;
                if (fileSelection != null) fileSelection.onReceiveValue(null);
                fileSelection = callback;
                try { filePicker.launch(parameters.createIntent()); }
                catch (ActivityNotFoundException error) {
                    callback.onReceiveValue(null);
                    fileSelection = null;
                    showConnectionError("No file picker is installed. Install one and try again.");
                }
                return true;
            }
        });
        downloads.attach(webView, origin);
        content.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
        webView.loadUrl(origin.url() + "/instances");
    }

    private void openExternal(Uri uri) {
        new AlertDialog.Builder(this).setTitle("Open " + uri.getHost() + "?")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Open browser", (dialog, choice) -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                catch (ActivityNotFoundException error) { showConnectionError("No browser is installed. Install one and try again."); }
            }).show();
    }

    private void showConnectionError(String message) {
        if (isFinishing() || (connectionError != null && connectionError.isShowing())) return;
        destroyWebView();
        connectionError = new AlertDialog.Builder(this).setMessage(message)
            .setNegativeButton("Change manager", (dialog, choice) -> showManagerForm())
            .setPositiveButton("Retry", (dialog, choice) -> connect(origin)).show();
    }

    private void destroyWebView() {
        if (fileSelection != null) { fileSelection.onReceiveValue(null); fileSelection = null; }
        if (downloads != null) downloads.cancel();
        if (webView != null) {
            content.removeView(webView);
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        destroyWebView();
        super.onDestroy();
    }
}
