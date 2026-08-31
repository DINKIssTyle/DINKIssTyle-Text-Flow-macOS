//go:build darwin

package platform

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit -framework QuartzCore
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

typedef struct PinShotSelectionData {
	int x;
	int y;
	int width;
	int height;
	int pixelX;
	int pixelY;
	int pixelWidth;
	int pixelHeight;
	bool valid;
} PinShotSelectionData;

static NSView* pinShotFindWebView(NSView* rootView) {
	if (rootView == nil) {
		return nil;
	}
	Class webViewClass = NSClassFromString(@"WKWebView");
	if (webViewClass != nil && [rootView isKindOfClass:webViewClass]) {
		return rootView;
	}
	for (NSView* subview in rootView.subviews) {
		NSView* match = pinShotFindWebView(subview);
		if (match != nil) {
			return match;
		}
	}
	return nil;
}

static CGFloat pinShotPrimaryScreenHeight(void) {
	NSScreen* primaryScreen = [[NSScreen screens] firstObject];
	if (primaryScreen == nil) {
		primaryScreen = [NSScreen mainScreen];
	}
	return primaryScreen != nil ? primaryScreen.frame.size.height : 0.0;
}

static NSScreen* pinShotScreenForDisplayID(uint32_t displayID) {
	for (NSScreen* screen in [NSScreen screens]) {
		NSNumber* screenNumber = [screen.deviceDescription objectForKey:@"NSScreenNumber"];
		if (screenNumber != nil && screenNumber.unsignedIntValue == displayID) {
			return screen;
		}
	}
	return nil;
}

// Wails creates the native content view one point smaller than the requested
// window while creating its WKWebView at the requested size. Once the window
// is resized to the exact display frame, autoresizing otherwise leaves the
// web view one point larger than the window. Keep the actual CSS viewport and
// the native content rectangle identical.
static NSView* pinShotLayoutWebView(NSWindow* window) {
	NSView* contentView = window.contentView;
	NSView* webView = pinShotFindWebView(contentView);
	if (webView != nil) {
		webView.frame = contentView.bounds;
		webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
	}
	return webView != nil ? webView : contentView;
}

static void configurePinShotWindow(void* nativeWindow) {
	if (nativeWindow == NULL) {
		return;
	}
	if (![NSThread isMainThread]) {
		dispatch_sync(dispatch_get_main_queue(), ^{
			configurePinShotWindow(nativeWindow);
		});
		return;
	}
	NSWindow* window = (NSWindow*)nativeWindow;
	NSView* contentView = window.contentView;
	contentView.wantsLayer = YES;
	contentView.layer.cornerRadius = 0.0;
	contentView.layer.masksToBounds = NO;
	pinShotLayoutWebView(window);
}

// Keep the pixels that were present before Text Flow became active behind the
// transparent WKWebView. CALayer retains the decoded CGImage after this call,
// so the Go byte buffer only needs to remain valid while NSData is created.
static bool setPinShotWindowSnapshot(
	void* nativeWindow,
	const unsigned char* bytes,
	size_t length
) {
	if (nativeWindow == NULL || bytes == NULL || length == 0) {
		return false;
	}
	if (![NSThread isMainThread]) {
		__block bool applied = false;
		dispatch_sync(dispatch_get_main_queue(), ^{
			applied = setPinShotWindowSnapshot(nativeWindow, bytes, length);
		});
		return applied;
	}

	NSWindow* window = (NSWindow*)nativeWindow;
	NSView* contentView = window.contentView;
	if (contentView == nil) {
		return false;
	}
	NSData* data = [NSData dataWithBytes:bytes length:length];
	NSImage* image = [[NSImage alloc] initWithData:data];
	if (image == nil) {
		return false;
	}
	CGImageRef cgImage = [image CGImageForProposedRect:NULL context:nil hints:nil];
	if (cgImage == NULL) {
		[image release];
		return false;
	}
	contentView.wantsLayer = YES;
	contentView.layer.contents = (id)cgImage;
	contentView.layer.contentsGravity = kCAGravityResize;
	contentView.layer.contentsScale = window.screen != nil
		? window.screen.backingScaleFactor
		: NSScreen.mainScreen.backingScaleFactor;
	[image release];
	return true;
}

// Wails normalises mixed-DPI display topology before exposing Screen.Bounds.
// That coordinate space is useful for ordinary windows but can differ from
// NSScreen.frame when displays have different scale factors or vertical
// offsets. A capture overlay must match the physical display frame exactly.
static bool setPinShotWindowDisplayBounds(void* nativeWindow, uint32_t displayID) {
	if (nativeWindow == NULL || displayID == 0) {
		return false;
	}
	if (![NSThread isMainThread]) {
		__block bool applied = false;
		dispatch_sync(dispatch_get_main_queue(), ^{
			applied = setPinShotWindowDisplayBounds(nativeWindow, displayID);
		});
		return applied;
	}
	NSScreen* screen = pinShotScreenForDisplayID(displayID);
	if (screen == nil) {
		return false;
	}
	NSWindow* window = (NSWindow*)nativeWindow;
	[window setFrame:screen.frame display:YES animate:NO];
	pinShotLayoutWebView(window);
	return true;
}

static bool setPinShotWindowBounds(
	void* nativeWindow,
	int x,
	int y,
	int width,
	int height
) {
	if (nativeWindow == NULL || width <= 0 || height <= 0) {
		return false;
	}
	if (![NSThread isMainThread]) {
		__block bool applied = false;
		dispatch_sync(dispatch_get_main_queue(), ^{
			applied = setPinShotWindowBounds(nativeWindow, x, y, width, height);
		});
		return applied;
	}
	CGFloat primaryHeight = pinShotPrimaryScreenHeight();
	if (primaryHeight <= 0.0) {
		return false;
	}
	NSRect frame = NSMakeRect(
		x,
		primaryHeight - y - height,
		width,
		height
	);
	NSWindow* window = (NSWindow*)nativeWindow;
	[window setFrame:frame display:YES animate:NO];
	pinShotLayoutWebView(window);
	return true;
}

// Resolve the browser's local, top-left selection against the actual native
// overlay window. This mirrors Fuwari's proven conversion path: local window
// coordinates -> AppKit global coordinates -> primary-screen top-left
// coordinates. It deliberately avoids reconstructing the origin from Wails'
// independently scaled display topology.
static PinShotSelectionData resolvePinShotSelection(
	void* nativeWindow,
	double x,
	double y,
	double width,
	double height,
	double viewportWidth,
	double viewportHeight
) {
	PinShotSelectionData result = {0};
	if (nativeWindow == NULL || width <= 1.0 || height <= 1.0 ||
		viewportWidth <= 0.0 || viewportHeight <= 0.0) {
		return result;
	}
	if (![NSThread isMainThread]) {
		__block PinShotSelectionData resolved = {0};
		dispatch_sync(dispatch_get_main_queue(), ^{
			resolved = resolvePinShotSelection(
				nativeWindow,
				x,
				y,
				width,
				height,
				viewportWidth,
				viewportHeight
			);
		});
		return resolved;
	}

	NSWindow* window = (NSWindow*)nativeWindow;
	NSView* coordinateView = pinShotLayoutWebView(window);
	if (coordinateView == nil || window.screen == nil) {
		return result;
	}
	NSRect viewBounds = coordinateView.bounds;
	if (viewBounds.size.width <= 0.0 || viewBounds.size.height <= 0.0) {
		return result;
	}

	CGFloat scaleX = viewBounds.size.width / viewportWidth;
	CGFloat scaleY = viewBounds.size.height / viewportHeight;
	CGFloat localLeft = x * scaleX;
	CGFloat localTop = y * scaleY;
	CGFloat localRight = (x + width) * scaleX;
	CGFloat localBottom = (y + height) * scaleY;

	NSRect viewWindowRect = [coordinateView convertRect:viewBounds toView:nil];
	NSRect viewScreenRect = [window convertRectToScreen:viewWindowRect];
	// Browser pointer coordinates are top-down regardless of whether the
	// underlying AppKit view reports a flipped coordinate system.
	CGFloat minX = NSMinX(viewScreenRect) + localLeft;
	CGFloat maxX = NSMinX(viewScreenRect) + localRight;
	CGFloat maxY = NSMaxY(viewScreenRect) - localTop;
	CGFloat minY = NSMaxY(viewScreenRect) - localBottom;
	CGFloat primaryHeight = pinShotPrimaryScreenHeight();
	if (primaryHeight <= 0.0) {
		return result;
	}

	// Fuwari rounds the selected origin and size to the nearest logical point.
	// This avoids the one-point expansion caused by independently flooring the
	// first edge and ceiling the opposite edge.
	result.x = (int)llround(minX);
	result.y = (int)llround(primaryHeight - maxY);
	result.width = (int)llround(maxX - minX);
	result.height = (int)llround(maxY - minY);

	CGFloat backingScale = window.screen.backingScaleFactor;
	result.pixelX = (int)llround(localLeft * backingScale);
	result.pixelY = (int)llround(localTop * backingScale);
	result.pixelWidth = (int)llround(result.width * backingScale);
	result.pixelHeight = (int)llround(result.height * backingScale);
	result.valid = result.width > 1 && result.height > 1 &&
		result.pixelWidth > 1 && result.pixelHeight > 1;
	return result;
}
*/
import "C"

import (
	"strconv"
	"unsafe"
)

func ConfigurePinShotWindow(nativeWindow unsafe.Pointer) {
	C.configurePinShotWindow(nativeWindow)
}

func SetPinShotWindowSnapshot(nativeWindow unsafe.Pointer, pngData []byte) bool {
	if nativeWindow == nil || len(pngData) == 0 {
		return false
	}
	return bool(C.setPinShotWindowSnapshot(
		nativeWindow,
		(*C.uchar)(unsafe.Pointer(&pngData[0])),
		C.size_t(len(pngData)),
	))
}

func SetPinShotWindowDisplayBounds(nativeWindow unsafe.Pointer, screenID string) bool {
	displayID, err := strconv.ParseUint(screenID, 10, 32)
	if err != nil || displayID == 0 {
		return false
	}
	return bool(C.setPinShotWindowDisplayBounds(nativeWindow, C.uint32_t(displayID)))
}

func SetPinShotWindowBounds(
	nativeWindow unsafe.Pointer,
	x int,
	y int,
	width int,
	height int,
) bool {
	return bool(C.setPinShotWindowBounds(
		nativeWindow,
		C.int(x),
		C.int(y),
		C.int(width),
		C.int(height),
	))
}

func ResolvePinShotSelection(
	nativeWindow unsafe.Pointer,
	x float64,
	y float64,
	width float64,
	height float64,
	viewportWidth float64,
	viewportHeight float64,
) (PinShotSelectionRect, bool) {
	resolved := C.resolvePinShotSelection(
		nativeWindow,
		C.double(x),
		C.double(y),
		C.double(width),
		C.double(height),
		C.double(viewportWidth),
		C.double(viewportHeight),
	)
	if !bool(resolved.valid) {
		return PinShotSelectionRect{}, false
	}
	return PinShotSelectionRect{
		X:           int(resolved.x),
		Y:           int(resolved.y),
		Width:       int(resolved.width),
		Height:      int(resolved.height),
		PixelX:      int(resolved.pixelX),
		PixelY:      int(resolved.pixelY),
		PixelWidth:  int(resolved.pixelWidth),
		PixelHeight: int(resolved.pixelHeight),
	}, true
}
