//go:build darwin

package platform

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit -framework CoreGraphics -framework CoreFoundation -framework Foundation -framework ImageIO -framework ScreenCaptureKit
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

typedef struct PinShotCaptureData {
	unsigned char* bytes;
	size_t length;
	char* error;
} PinShotCaptureData;

static char* pinShotCopyError(NSError* error, const char* fallback) {
	if (error != nil && error.localizedDescription != nil) {
		return strdup(error.localizedDescription.UTF8String);
	}
	return strdup(fallback);
}

static CGImageRef pinShotCaptureDisplayRegion(
	CGDirectDisplayID displayID,
	CGRect sourceRect,
	size_t pixelWidth,
	size_t pixelHeight,
	char** errorMessage
) {
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
	if (@available(macOS 26.0, *)) {
		dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
		__block CGImageRef capturedImage = NULL;
		__block char* asynchronousError = NULL;
		__block SCContentFilter* filter = nil;
		__block SCScreenshotConfiguration* configuration = nil;

		[SCShareableContent
			getShareableContentExcludingDesktopWindows:NO
			onScreenWindowsOnly:YES
			completionHandler:^(SCShareableContent* content, NSError* error) {
				@autoreleasepool {
					if (error != nil || content == nil) {
						asynchronousError = pinShotCopyError(error, "unable to enumerate displays");
						dispatch_semaphore_signal(semaphore);
						return;
					}
					SCDisplay* targetDisplay = nil;
					for (SCDisplay* display in content.displays) {
						if (display.displayID == displayID) {
							targetDisplay = display;
							break;
						}
					}
					if (targetDisplay == nil) {
						asynchronousError = strdup("selected display is unavailable");
						dispatch_semaphore_signal(semaphore);
						return;
					}

					filter = [[SCContentFilter alloc] initWithDisplay:targetDisplay excludingWindows:@[]];
					configuration = [[SCScreenshotConfiguration alloc] init];
					configuration.width = pixelWidth;
					configuration.height = pixelHeight;
					configuration.showsCursor = NO;
					configuration.ignoreShadows = NO;
					configuration.ignoreClipping = NO;
					configuration.includeChildWindows = YES;
					configuration.displayIntent = SCScreenshotDisplayIntentLocal;
					configuration.dynamicRange = SCScreenshotDynamicRangeSDR;

					CGRect localSourceRect = sourceRect;
					if (fabs(sourceRect.size.width - targetDisplay.width) < 1.0 &&
						fabs(sourceRect.size.height - targetDisplay.height) < 1.0) {
						localSourceRect = CGRectMake(0, 0, targetDisplay.width, targetDisplay.height);
					} else {
						localSourceRect.origin.x -= targetDisplay.frame.origin.x;
						localSourceRect.origin.y -= targetDisplay.frame.origin.y;
					}
					configuration.sourceRect = localSourceRect;

					[SCScreenshotManager
						captureScreenshotWithFilter:filter
						configuration:configuration
						completionHandler:^(SCScreenshotOutput* output, NSError* captureError) {
							@autoreleasepool {
								if (output.sdrImage != NULL) {
									capturedImage = CGImageRetain(output.sdrImage);
								} else {
									asynchronousError = pinShotCopyError(
										captureError,
										"screen capture returned no image"
									);
								}
								dispatch_semaphore_signal(semaphore);
							}
						}
					];
				}
			}
		];

		dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
		[configuration release];
		[filter release];
		dispatch_release(semaphore);
		if (capturedImage == NULL) {
			*errorMessage = asynchronousError != NULL
				? asynchronousError
				: strdup("screen capture failed");
		} else if (asynchronousError != NULL) {
			free(asynchronousError);
		}
		return capturedImage;
	}
#endif

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 150200
	if (@available(macOS 15.2, *)) {
		dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
		__block CGImageRef capturedImage = NULL;
		__block char* asynchronousError = NULL;

		[SCScreenshotManager
			captureImageInRect:sourceRect
			completionHandler:^(CGImageRef image, NSError* captureError) {
				@autoreleasepool {
					if (image != NULL) {
						capturedImage = CGImageRetain(image);
					} else {
						asynchronousError = pinShotCopyError(
							captureError,
							"screen capture returned no image"
						);
					}
					dispatch_semaphore_signal(semaphore);
				}
			}
		];

		dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
		dispatch_release(semaphore);
		if (capturedImage == NULL) {
			*errorMessage = asynchronousError != NULL
				? asynchronousError
				: strdup("screen capture failed");
		} else if (asynchronousError != NULL) {
			free(asynchronousError);
		}
		return capturedImage;
	}
#endif

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 140000
	if (@available(macOS 14.0, *)) {
		dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
		__block CGImageRef capturedImage = NULL;
		__block char* asynchronousError = NULL;
		__block SCContentFilter* filter = nil;
		__block SCStreamConfiguration* configuration = nil;

		[SCShareableContent
			getShareableContentExcludingDesktopWindows:NO
			onScreenWindowsOnly:NO
			completionHandler:^(SCShareableContent* content, NSError* error) {
				@autoreleasepool {
					if (error != nil || content == nil) {
						asynchronousError = pinShotCopyError(error, "unable to enumerate displays");
						dispatch_semaphore_signal(semaphore);
						return;
					}

					SCDisplay* targetDisplay = nil;
					for (SCDisplay* display in content.displays) {
						if (display.displayID == displayID) {
							targetDisplay = display;
							break;
						}
					}
					if (targetDisplay == nil) {
						asynchronousError = strdup("selected display is unavailable");
						dispatch_semaphore_signal(semaphore);
						return;
					}

					filter = [[SCContentFilter alloc] initWithDisplay:targetDisplay excludingWindows:@[]];
					configuration = [[SCStreamConfiguration alloc] init];
					CGRect localSourceRect = sourceRect;
					localSourceRect.origin.x -= targetDisplay.frame.origin.x;
					localSourceRect.origin.y -= targetDisplay.frame.origin.y;
					configuration.sourceRect = localSourceRect;
					configuration.width = pixelWidth;
					configuration.height = pixelHeight;
					configuration.scalesToFit = YES;
					configuration.showsCursor = NO;

					[SCScreenshotManager
						captureImageWithFilter:filter
						configuration:configuration
						completionHandler:^(CGImageRef image, NSError* captureError) {
							@autoreleasepool {
								if (image != NULL) {
									capturedImage = CGImageRetain(image);
								} else {
									asynchronousError = pinShotCopyError(
										captureError,
										"screen capture returned no image"
									);
								}
								dispatch_semaphore_signal(semaphore);
							}
						}
					];
				}
			}
		];

		dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
		[configuration release];
		[filter release];
		dispatch_release(semaphore);
		if (capturedImage == NULL) {
			*errorMessage = asynchronousError != NULL
				? asynchronousError
				: strdup("screen capture failed");
		} else if (asynchronousError != NULL) {
			free(asynchronousError);
		}
		return capturedImage;
	}
#endif

	CGRect displayBounds = CGDisplayBounds(displayID);
	CGRect localSourceRect = sourceRect;
	localSourceRect.origin.x -= displayBounds.origin.x;
	localSourceRect.origin.y -= displayBounds.origin.y;
	CGImageRef image = CGDisplayCreateImageForRect(displayID, localSourceRect);
	if (image == NULL) {
		*errorMessage = strdup("screen capture returned no image");
	}
	return image;
}

static PinShotCaptureData pinShotCapturePNG(
	uint32_t displayID,
	double x,
	double y,
	double width,
	double height,
	size_t pixelWidth,
	size_t pixelHeight
) {
	PinShotCaptureData result = {0};
	@autoreleasepool {
		char* captureError = NULL;
		CGImageRef image = pinShotCaptureDisplayRegion(
			(CGDirectDisplayID)displayID,
			CGRectMake(x, y, width, height),
			pixelWidth,
			pixelHeight,
			&captureError
		);
		if (image == NULL) {
			result.error = captureError != NULL ? captureError : strdup("screen capture failed");
			return result;
		}

		CFMutableDataRef data = CFDataCreateMutable(kCFAllocatorDefault, 0);
		CGImageDestinationRef destination = CGImageDestinationCreateWithData(
			data,
			CFSTR("public.png"),
			1,
			NULL
		);
		if (destination == NULL) {
			CGImageRelease(image);
			CFRelease(data);
			result.error = strdup("failed to prepare PNG encoder");
			return result;
		}

		CGImageDestinationAddImage(destination, image, NULL);
		Boolean encoded = CGImageDestinationFinalize(destination);
		CGImageRelease(image);
		CFRelease(destination);
		if (!encoded) {
			CFRelease(data);
			result.error = strdup("failed to encode screen capture");
			return result;
		}

		CFIndex length = CFDataGetLength(data);
		if (length <= 0) {
			CFRelease(data);
			result.error = strdup("screen capture returned an empty image");
			return result;
		}
		result.bytes = malloc((size_t)length);
		if (result.bytes == NULL) {
			CFRelease(data);
			result.error = strdup("failed to allocate screen capture buffer");
			return result;
		}
		memcpy(result.bytes, CFDataGetBytePtr(data), (size_t)length);
		result.length = (size_t)length;
		CFRelease(data);
	}
	return result;
}
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"unsafe"
)

func CaptureScreenRegion(ctx context.Context, rect ScreenCaptureRect) (ScreenCaptureResult, error) {
	return captureScreenRegion(ctx, rect, false)
}

// CaptureScreenSnapshot captures a temporary full-display image without the
// base64 copy and final-attachment size limit used by CaptureScreenRegion.
func CaptureScreenSnapshot(ctx context.Context, rect ScreenCaptureRect) (ScreenCaptureResult, error) {
	return captureScreenRegion(ctx, rect, true)
}

func captureScreenRegion(
	ctx context.Context,
	rect ScreenCaptureRect,
	temporarySnapshot bool,
) (ScreenCaptureResult, error) {
	if rect.DisplayID != "" && rect.Width > 1 && rect.Height > 1 {
		if err := ctx.Err(); err != nil {
			return ScreenCaptureResult{Canceled: true}, nil
		}
		displayID, err := strconv.ParseUint(rect.DisplayID, 10, 32)
		if err != nil {
			return ScreenCaptureResult{}, fmt.Errorf("invalid display ID: %w", err)
		}
		if rect.PixelWidth <= 1 || rect.PixelHeight <= 1 {
			return ScreenCaptureResult{}, errors.New("screen capture pixel size is empty")
		}
		captured := C.pinShotCapturePNG(
			C.uint32_t(displayID),
			C.double(rect.X),
			C.double(rect.Y),
			C.double(rect.Width),
			C.double(rect.Height),
			C.size_t(rect.PixelWidth),
			C.size_t(rect.PixelHeight),
		)
		if captured.error != nil {
			defer C.free(unsafe.Pointer(captured.error))
			return ScreenCaptureResult{}, fmt.Errorf(
				"screen capture failed: %s",
				C.GoString(captured.error),
			)
		}
		if captured.bytes == nil || captured.length == 0 {
			return ScreenCaptureResult{}, errors.New("screen capture returned an empty image")
		}
		defer C.free(unsafe.Pointer(captured.bytes))
		data := C.GoBytes(unsafe.Pointer(captured.bytes), C.int(captured.length))
		var result ScreenCaptureResult
		if temporarySnapshot {
			result, err = screenCaptureSnapshotFromPNG(data)
		} else {
			result, err = screenCaptureResultFromPNG(data)
		}
		if err != nil {
			return ScreenCaptureResult{}, err
		}
		if result.Width != rect.PixelWidth || result.Height != rect.PixelHeight {
			return ScreenCaptureResult{}, fmt.Errorf(
				"screen capture resolution mismatch: expected %dx%d, got %dx%d",
				rect.PixelWidth,
				rect.PixelHeight,
				result.Width,
				result.Height,
			)
		}
		return result, nil
	}

	tempDir, err := os.MkdirTemp("", "dkst-text-flow-screen-capture-")
	if err != nil {
		return ScreenCaptureResult{}, fmt.Errorf("failed to prepare screen capture: %w", err)
	}
	defer os.RemoveAll(tempDir)

	outputPath := filepath.Join(tempDir, "capture.png")
	arguments := []string{"-x", "-t", "png", "-i"}
	arguments = append(arguments, outputPath)
	command := exec.CommandContext(ctx, "/usr/sbin/screencapture", arguments...)
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return ScreenCaptureResult{Canceled: true}, nil
		}
		if _, statErr := os.Stat(outputPath); errors.Is(statErr, os.ErrNotExist) {
			return ScreenCaptureResult{Canceled: true}, nil
		}
		return ScreenCaptureResult{}, fmt.Errorf("screen capture failed: %w", err)
	}

	data, err := os.ReadFile(outputPath)
	if errors.Is(err, os.ErrNotExist) || len(data) == 0 {
		return ScreenCaptureResult{Canceled: true}, nil
	}
	if err != nil {
		return ScreenCaptureResult{}, fmt.Errorf("failed to read screen capture: %w", err)
	}
	return screenCaptureResultFromPNG(data)
}
