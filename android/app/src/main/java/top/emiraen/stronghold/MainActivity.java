package top.emiraen.stronghold;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import org.mozilla.geckoview.*;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static GeckoRuntime runtime;
    private AssetServer server;
    private WebView web;
    private GeckoSession session;
    private GeckoView gecko;
    private boolean canGoBack;
    private boolean pageReady;
    private boolean switched;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private ValueCallback<Uri[]> pendingFiles;
    private GeckoSession.PromptDelegate.FilePrompt geckoFile;
    private GeckoResult<GeckoSession.PromptDelegate.PromptResponse> geckoFileResult;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.rgb(12, 15, 14));
        getWindow().setNavigationBarColor(Color.rgb(12, 15, 14));
        immersive();
        root = new FrameLayout(this); root.setBackgroundColor(Color.rgb(12, 15, 14)); setContentView(root);
        try {
            server = AssetServer.ensure(this);
            if (getPreferences(MODE_PRIVATE).getBoolean("embeddedEngine", false)) showGecko(); else showWebView();
        } catch (Throwable error) { showError("客户端初始化失败", error); }
    }
    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }
    @Override public void onWindowFocusChanged(boolean focus) { super.onWindowFocusChanged(focus); if (focus) immersive(); }
    private void showWebView() {
        try {
            web = new WebView(this);
            WebSettings settings = web.getSettings();
            settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); settings.setDatabaseEnabled(true);
            settings.setAllowFileAccess(false); settings.setAllowContentAccess(true);
            settings.setMediaPlaybackRequiresUserGesture(false); settings.setUseWideViewPort(true); settings.setLoadWithOverviewMode(true);
            settings.setSupportZoom(true); settings.setBuiltInZoomControls(true); settings.setDisplayZoomControls(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
            CookieManager.getInstance().setAcceptCookie(true);
            web.setBackgroundColor(Color.rgb(12, 15, 14));
            web.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView view, String url) {
                    if (!url.startsWith(AssetServer.ORIGIN + "/")) return;
                    String script = "(function(){try{return !!(window.WebAssembly&&window.WebGLRenderingContext&&window.indexedDB&&window.crypto&&crypto.subtle&&window.HTMLScriptElement&&HTMLScriptElement.supports&&HTMLScriptElement.supports('importmap'));}catch(e){return false;}})()";
                    view.evaluateJavascript(script, supported -> { if (!"true".equals(supported)) fallback(); else pageReady = true; });
                }
                @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return navigate(url); }
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return request.isForMainFrame() && navigate(request.getUrl().toString()); }
                @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) { fallback(); return true; }
            });
            web.setWebChromeClient(new WebChromeClient() {
                @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                    if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                    pendingFiles = callback;
                    Intent intent = params.createIntent(); intent.addCategory(Intent.CATEGORY_OPENABLE);
                    try { startActivityForResult(intent, 41); return true; } catch (Exception e) { pendingFiles = null; return false; }
                }
                @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            });
            root.addView(web, new FrameLayout.LayoutParams(-1, -1));
            web.loadUrl(server.entryUrl());
            handler.postDelayed(() -> { if (!pageReady && session == null) fallback(); }, 20000);
        } catch (Throwable error) { fallback(); }
    }
    private void fallback() {
        if (switched || session != null || isFinishing()) return;
        switched = true;
        getPreferences(MODE_PRIVATE).edit().putBoolean("embeddedEngine", true).apply();
        if (web != null) { root.removeView(web); web.stopLoading(); web.destroy(); web = null; }
        try { showGecko(); } catch (Throwable error) { showError("兼容内核启动失败", error); }
    }
    private void showGecko() {
        GeckoRuntimeSettings settings = new GeckoRuntimeSettings.Builder()
            .javaScriptEnabled(true).remoteDebuggingEnabled(false).consoleOutput(false)
            .automaticFontSizeAdjustment(false).fontInflation(false).allowInsecureConnections(GeckoRuntimeSettings.ALLOW_ALL).build();
        if (runtime == null) runtime = GeckoRuntime.create(getApplicationContext(), settings);
        gecko = new GeckoView(this); gecko.setBackgroundColor(Color.rgb(12, 15, 14));
        session = new GeckoSession(new GeckoSessionSettings.Builder()
            .usePrivateMode(false).useTrackingProtection(false).userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_MOBILE)
            .displayMode(GeckoSessionSettings.DISPLAY_MODE_STANDALONE).build());
        session.setNavigationDelegate(new GeckoSession.NavigationDelegate() {
            @Override public void onCanGoBack(GeckoSession s, boolean value) { canGoBack = value; }
            @Override public GeckoResult<AllowOrDeny> onLoadRequest(GeckoSession s, LoadRequest request) {
                return GeckoResult.fromValue(navigate(request.uri) ? AllowOrDeny.DENY : AllowOrDeny.ALLOW);
            }
        });
        session.setContentDelegate(new GeckoSession.ContentDelegate() {
            @Override public void onFullScreen(GeckoSession s, boolean fullscreen) { immersive(); }
            @Override public void onCrash(GeckoSession s) { showError("渲染进程已停止", null); }
        });
        session.setPermissionDelegate(new GeckoSession.PermissionDelegate() {
            @Override public GeckoResult<Integer> onContentPermissionRequest(GeckoSession s, ContentPermission permission) {
                boolean local = permission.uri != null && permission.uri.startsWith(AssetServer.ORIGIN);
                boolean allowed = local && (permission.permission == PERMISSION_PERSISTENT_STORAGE || permission.permission == PERMISSION_AUTOPLAY_AUDIBLE || permission.permission == PERMISSION_AUTOPLAY_INAUDIBLE || permission.permission == PERMISSION_LOCAL_NETWORK_ACCESS);
                return GeckoResult.fromValue(allowed ? ContentPermission.VALUE_ALLOW : ContentPermission.VALUE_DENY);
            }
        });
        session.setPromptDelegate(new GeckoSession.PromptDelegate() {
            @Override public GeckoResult<PromptResponse> onFilePrompt(GeckoSession s, FilePrompt prompt) {
                if (geckoFileResult != null) geckoFileResult.complete(geckoFile.dismiss());
                geckoFile = prompt; geckoFileResult = new GeckoResult<>();
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("*/*"); intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try { startActivityForResult(intent, 42); } catch (Exception e) { geckoFileResult.complete(prompt.dismiss()); }
                return geckoFileResult;
            }
        });
        session.open(runtime); gecko.setSession(session); root.addView(gecko, new FrameLayout.LayoutParams(-1, -1));
        session.loadUri(server.entryUrl());
    }
    private boolean navigate(String url) {
        Uri uri;
        try { uri = Uri.parse(url); } catch (Exception e) { return true; }
        if (url.startsWith(AssetServer.ORIGIN + "/") || "about".equals(uri.getScheme()) || "blob".equals(uri.getScheme())) return false;
        if ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
        }
        return true;
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 41 && pendingFiles != null) { pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data)); pendingFiles = null; }
        if (request == 42 && geckoFileResult != null) {
            if (result == RESULT_OK && data != null && data.getClipData() != null) {
                ClipData clip = data.getClipData(); Uri[] items = new Uri[clip.getItemCount()];
                for (int i = 0; i < items.length; i++) items[i] = clip.getItemAt(i).getUri();
                geckoFileResult.complete(geckoFile.confirm(this, items));
            } else if (result == RESULT_OK && data != null && data.getData() != null) geckoFileResult.complete(geckoFile.confirm(this, data.getData()));
            else geckoFileResult.complete(geckoFile.dismiss());
            geckoFileResult = null; geckoFile = null;
        }
    }
    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) { web.goBack(); return; }
        if (session != null && canGoBack) { session.goBack(); return; }
        new AlertDialog.Builder(this).setMessage("退出客户端？").setPositiveButton("退出", (dialog, which) -> finish()).setNegativeButton("取消", null).show();
    }
    private void showError(String text, Throwable error) {
        root.removeAllViews(); TextView message = new TextView(this); message.setTextColor(Color.WHITE); message.setGravity(Gravity.CENTER); message.setText(text + "\n点击重试");
        message.setOnClickListener(view -> recreate()); root.addView(message, new FrameLayout.LayoutParams(-1, -1));
    }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); if (session != null) session.setActive(true); }
    @Override protected void onPause() { if (web != null) web.onPause(); if (session != null) session.setActive(false); super.onPause(); }
    @Override protected void onDestroy() { handler.removeCallbacksAndMessages(null); if (web != null) { web.destroy(); web = null; } if (session != null) { session.close(); session = null; } super.onDestroy(); }
}
