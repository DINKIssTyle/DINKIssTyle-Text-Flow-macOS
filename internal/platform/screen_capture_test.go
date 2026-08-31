package platform

import (
	"bytes"
	"image"
	"image/color"
	"testing"
)

func TestCropScreenCaptureUsesFrozenPixels(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 6, 5))
	for y := 0; y < source.Bounds().Dy(); y++ {
		for x := 0; x < source.Bounds().Dx(); x++ {
			source.SetNRGBA(x, y, color.NRGBA{
				R: uint8(10 + x),
				G: uint8(20 + y),
				B: uint8(x + y),
				A: 255,
			})
		}
	}
	captured, err := screenCaptureResultFromImage(source)
	if err != nil {
		t.Fatal(err)
	}

	cropped, err := CropScreenCapture(captured, 2, 1, 3, 3)
	if err != nil {
		t.Fatal(err)
	}
	if cropped.Width != 3 || cropped.Height != 3 {
		t.Fatalf("cropped size = %dx%d, want 3x3", cropped.Width, cropped.Height)
	}
	resultImage, _, err := image.Decode(bytes.NewReader(cropped.PNGData))
	if err != nil {
		t.Fatal(err)
	}
	got := color.NRGBAModel.Convert(resultImage.At(0, 0)).(color.NRGBA)
	want := source.NRGBAAt(2, 1)
	if got != want {
		t.Fatalf("first cropped pixel = %#v, want %#v", got, want)
	}
}

func TestCropScreenCaptureRejectsOutsideRegion(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	captured, err := screenCaptureResultFromImage(source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CropScreenCapture(captured, 10, 10, 3, 3); err == nil {
		t.Fatal("expected an outside-region error")
	}
}

func TestScreenCaptureSnapshotOmitsBase64Copy(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	captured, err := screenCaptureResultFromImage(source)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := screenCaptureSnapshotFromPNG(captured.PNGData)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.DataURL != "" {
		t.Fatal("temporary snapshot unexpectedly contains a base64 data URL")
	}
	if len(snapshot.PNGData) == 0 || snapshot.Width != 4 || snapshot.Height != 4 {
		t.Fatalf("invalid temporary snapshot: %#v", snapshot)
	}
}
