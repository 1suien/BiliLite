package com.readawre.app;

import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * 系统返回键：先用 WebView 的历史（hash 路由天然产生历史记录），
     * 阅读器按返回回到书架；已经在书架（无历史可退）时才真正退出应用。
     */
    @Override
    public void onBackPressed() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }
}
