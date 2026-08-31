//go:build darwin

package windowing

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework WebKit

#import <WebKit/WebKit.h>
#import <dispatch/dispatch.h>
#import <objc/message.h>
#import <objc/runtime.h>

// Wails does not currently expose WKWebViewConfiguration.writingToolsBehavior.
// Intercept WKWebView creation so the public setting is applied to the supplied
// configuration before WebKit copies it.
static IMP originalWKWebViewInit = NULL;

static void disableWritingToolsForConfiguration(WKWebViewConfiguration *configuration) {
	SEL setter = sel_registerName("setWritingToolsBehavior:");

	if (configuration != nil && [configuration respondsToSelector:setter]) {
		// NSWritingToolsBehaviorNone. Use the integer value dynamically because
		// the app still supports macOS versions earlier than macOS 15.
		((void (*)(id, SEL, NSInteger))objc_msgSend)(configuration, setter, (NSInteger)-1);
	}
}

static id dkstWKWebViewInit(
	id instance,
	SEL selector,
	NSRect frame,
	WKWebViewConfiguration *configuration
) {
	disableWritingToolsForConfiguration(configuration);
	return ((id (*)(id, SEL, NSRect, WKWebViewConfiguration *))originalWKWebViewInit)(
		instance,
		selector,
		frame,
		configuration
	);
}

static void disableWritingToolsForWailsWebViews(void) {
	static dispatch_once_t onceToken;
	dispatch_once(&onceToken, ^{
		Class webViewClass = [WKWebView class];
		SEL initializerSelector = @selector(initWithFrame:configuration:);
		Method initializer = class_getInstanceMethod(webViewClass, initializerSelector);
		if (initializer == NULL) {
			return;
		}

		originalWKWebViewInit = method_getImplementation(initializer);
		if (!class_addMethod(
			webViewClass,
			initializerSelector,
			(IMP)dkstWKWebViewInit,
			method_getTypeEncoding(initializer)
		)) {
			method_setImplementation(initializer, (IMP)dkstWKWebViewInit);
		}
	});
}

static bool writingToolsWebViewHookIsInstalled(void) {
	Method initializer = class_getInstanceMethod(
		[WKWebView class],
		@selector(initWithFrame:configuration:)
	);
	return initializer != NULL
		&& method_getImplementation(initializer) == (IMP)dkstWKWebViewInit;
}
*/
import "C"

// DisableWritingTools installs the WKWebView configuration hook before Wails
// creates any windows. On macOS 15 and later every subsequently created Wails
// webview opts out of Writing Tools; earlier releases remain unaffected.
func DisableWritingTools() {
	C.disableWritingToolsForWailsWebViews()
}

func writingToolsWebViewHookIsInstalled() bool {
	return bool(C.writingToolsWebViewHookIsInstalled())
}
