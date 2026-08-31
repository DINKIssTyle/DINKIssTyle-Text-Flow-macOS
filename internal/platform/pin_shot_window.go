package platform

// PinShotSelectionRect describes a selected region in the shared macOS
// screen-space coordinate system: logical points with a top-left origin.
type PinShotSelectionRect struct {
	X           int
	Y           int
	Width       int
	Height      int
	PixelX      int
	PixelY      int
	PixelWidth  int
	PixelHeight int
}
