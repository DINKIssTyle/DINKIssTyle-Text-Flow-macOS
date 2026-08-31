//go:build darwin

package windowing

import "testing"

func TestDisableWritingToolsInstallsWebViewInitializerHook(t *testing.T) {
	DisableWritingTools()

	if !writingToolsWebViewHookIsInstalled() {
		t.Fatal("WKWebView initializer hook was not installed")
	}
}
