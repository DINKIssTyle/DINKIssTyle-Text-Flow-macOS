//go:build windows

package platform

import "unsafe"

func ConfigurePinShotWindow(unsafe.Pointer) {
}

func SetPinShotWindowSnapshot(unsafe.Pointer, []byte) bool {
	return false
}

func SetPinShotWindowDisplayBounds(unsafe.Pointer, string) bool {
	return false
}

func SetPinShotWindowAboveMenuBar(unsafe.Pointer) bool {
	return false
}

func SetPinShotWindowBounds(unsafe.Pointer, int, int, int, int) bool {
	return false
}

func ResolvePinShotSelection(
	unsafe.Pointer,
	float64,
	float64,
	float64,
	float64,
	float64,
	float64,
) (PinShotSelectionRect, bool) {
	return PinShotSelectionRect{}, false
}
