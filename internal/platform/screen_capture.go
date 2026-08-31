package platform

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
)

const (
	maxScreenCaptureBytes         = 20 * 1024 * 1024
	maxScreenCaptureSnapshotBytes = 128 * 1024 * 1024
)

type ScreenCaptureRect struct {
	DisplayID   string `json:"displayId,omitempty"`
	X           int    `json:"x"`
	Y           int    `json:"y"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	PixelWidth  int    `json:"pixelWidth,omitempty"`
	PixelHeight int    `json:"pixelHeight,omitempty"`
}

type ScreenCaptureResult struct {
	DataURL  string `json:"dataUrl"`
	MimeType string `json:"mimeType"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Canceled bool   `json:"canceled"`
	PNGData  []byte `json:"-"`
}

func validateScreenCaptureRect(rect ScreenCaptureRect) error {
	if rect.Width <= 1 || rect.Height <= 1 {
		return errors.New("screen capture region is empty")
	}
	return nil
}

func screenCaptureResultFromPNG(data []byte) (ScreenCaptureResult, error) {
	return screenCaptureResultFromPNGData(data, maxScreenCaptureBytes, true)
}

func screenCaptureSnapshotFromPNG(data []byte) (ScreenCaptureResult, error) {
	return screenCaptureResultFromPNGData(data, maxScreenCaptureSnapshotBytes, false)
}

func screenCaptureResultFromPNGData(
	data []byte,
	maxBytes int,
	includeDataURL bool,
) (ScreenCaptureResult, error) {
	if len(data) == 0 {
		return ScreenCaptureResult{}, errors.New("screen capture returned an empty image")
	}
	if len(data) > maxBytes {
		return ScreenCaptureResult{}, fmt.Errorf(
			"screen capture is too large (%d MB maximum)",
			maxBytes/(1024*1024),
		)
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return ScreenCaptureResult{}, fmt.Errorf("failed to inspect screen capture: %w", err)
	}
	result := ScreenCaptureResult{
		MimeType: "image/png",
		Width:    config.Width,
		Height:   config.Height,
		PNGData:  append([]byte(nil), data...),
	}
	if includeDataURL {
		result.DataURL = "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
	}
	return result, nil
}

func screenCaptureResultFromImage(captured image.Image) (ScreenCaptureResult, error) {
	if captured == nil {
		return ScreenCaptureResult{}, errors.New("screen capture returned no image")
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, captured); err != nil {
		return ScreenCaptureResult{}, fmt.Errorf("failed to encode screen capture: %w", err)
	}
	return screenCaptureResultFromPNG(encoded.Bytes())
}

// CropScreenCapture returns a pixel-exact subsection of an earlier capture.
// Pin Shot uses this to crop the display snapshot taken before its overlay
// activates, so transient menus and inactive-window chrome remain unchanged.
func CropScreenCapture(
	captured ScreenCaptureResult,
	x int,
	y int,
	width int,
	height int,
) (ScreenCaptureResult, error) {
	if len(captured.PNGData) == 0 {
		return ScreenCaptureResult{}, errors.New("screen capture returned an empty image")
	}
	if width <= 1 || height <= 1 {
		return ScreenCaptureResult{}, errors.New("screen capture region is empty")
	}

	decoded, err := png.Decode(bytes.NewReader(captured.PNGData))
	if err != nil {
		return ScreenCaptureResult{}, fmt.Errorf("failed to decode screen capture: %w", err)
	}
	sourceBounds := decoded.Bounds()
	requestedBounds := image.Rect(x, y, x+width, y+height)
	cropBounds := requestedBounds.Intersect(sourceBounds)
	if cropBounds.Dx() <= 1 || cropBounds.Dy() <= 1 {
		return ScreenCaptureResult{}, errors.New("screen capture region is outside the display")
	}
	if !cropBounds.Eq(requestedBounds) {
		return ScreenCaptureResult{}, errors.New("screen capture region extends outside the display")
	}

	cropped := image.NewNRGBA(image.Rect(0, 0, cropBounds.Dx(), cropBounds.Dy()))
	draw.Draw(cropped, cropped.Bounds(), decoded, cropBounds.Min, draw.Src)
	return screenCaptureResultFromImage(cropped)
}
