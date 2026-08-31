//go:build darwin

package platform

/*
#cgo CFLAGS: -mmacosx-version-min=12.0 -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

static bool DKSTWriteUTF8TextToClipboard(const unsigned char *bytes, int length) {
	@autoreleasepool {
		if (length < 0) {
			return false;
		}
		NSString *text = [[[NSString alloc]
			initWithBytes:bytes
			length:(NSUInteger)length
			encoding:NSUTF8StringEncoding] autorelease];
		if (text == nil) {
			return false;
		}
		NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
		[pasteboard clearContents];
		return [pasteboard setString:text forType:NSPasteboardTypeString];
	}
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

// WriteClipboardText publishes UTF-8 text directly through NSPasteboard.
// This avoids pbcopy's locale-dependent decoding when launched from a GUI app.
func WriteClipboardText(text string) error {
	data := []byte(text)
	var bytes *C.uchar
	if len(data) > 0 {
		bytes = (*C.uchar)(unsafe.Pointer(&data[0]))
	}
	if !bool(C.DKSTWriteUTF8TextToClipboard(bytes, C.int(len(data)))) {
		return errors.New("macOS pasteboard rejected the UTF-8 text")
	}
	return nil
}
