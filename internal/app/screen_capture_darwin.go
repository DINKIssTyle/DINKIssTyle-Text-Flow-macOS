//go:build darwin

package app

import (
	"context"
	"errors"
	"math"
	"time"

	"dkst-text-flow/internal/platform"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func (a *App) beginPlatformScreenRegionCapture(
	ctx context.Context,
	purpose screenCapturePurpose,
) error {
	if purpose == screenCapturePurposeFloating {
		if err := a.capturePinShotDisplaySnapshots(ctx); err != nil {
			return err
		}
		return a.beginScreenRegionCaptureOverlay()
	}
	go func() {
		time.Sleep(140 * time.Millisecond)
		result, err := platform.CaptureScreenRegion(ctx, platform.ScreenCaptureRect{})
		a.finishScreenRegionCapture(result, err)
	}()
	return nil
}

func (a *App) completePlatformScreenRegionCapture(selection ScreenRegionSelection) error {
	a.screenCaptureMu.Lock()
	purpose := a.screenCapturePurpose
	a.screenCaptureMu.Unlock()
	if purpose != screenCapturePurposeFloating {
		return errors.New("macOS uses the native screen region selector")
	}

	ctx, placement, err := a.prepareOverlayScreenRegionCapture(selection)
	if err != nil {
		return err
	}
	if placement == nil {
		return nil
	}
	screen := application.Get().Screen.GetByID(placement.ScreenID)
	if screen == nil {
		err := errors.New("the selected display is no longer available")
		a.finishScreenRegionCapture(platform.ScreenCaptureResult{}, err)
		return err
	}
	snapshot, err := a.pinShotDisplaySnapshot(placement.ScreenID)
	if err != nil {
		a.finishScreenRegionCapture(platform.ScreenCaptureResult{}, err)
		return err
	}
	a.hideScreenCaptureWindows()
	go func() {
		if ctx.Err() != nil {
			a.finishScreenRegionCapture(platform.ScreenCaptureResult{Canceled: true}, nil)
			return
		}
		result, captureErr := cropPinShotDisplaySnapshot(snapshot, placement.SnapshotBounds)
		a.finishScreenRegionCapture(result, captureErr)
	}()
	return nil
}

func (a *App) capturePinShotDisplaySnapshots(ctx context.Context) error {
	appInst := application.Get()
	if appInst == nil {
		return errors.New("application is unavailable")
	}
	screens := appInst.Screen.GetAll()
	if len(screens) == 0 {
		return errors.New("no displays are available for screen capture")
	}

	snapshots := make(map[string]platform.ScreenCaptureResult, len(screens))
	for _, screen := range screens {
		if err := ctx.Err(); err != nil {
			return err
		}
		pixelWidth := screen.PhysicalBounds.Width
		pixelHeight := screen.PhysicalBounds.Height
		if pixelWidth <= 1 || pixelHeight <= 1 {
			pixelWidth = int(math.Round(float64(screen.Bounds.Width) * float64(screen.ScaleFactor)))
			pixelHeight = int(math.Round(float64(screen.Bounds.Height) * float64(screen.ScaleFactor)))
		}
		snapshot, err := platform.CaptureScreenSnapshot(ctx, platform.ScreenCaptureRect{
			DisplayID:   screen.ID,
			X:           screen.Bounds.X,
			Y:           screen.Bounds.Y,
			Width:       screen.Bounds.Width,
			Height:      screen.Bounds.Height,
			PixelWidth:  pixelWidth,
			PixelHeight: pixelHeight,
		})
		if err != nil {
			return err
		}
		snapshots[screen.ID] = snapshot
	}

	a.screenCaptureMu.Lock()
	defer a.screenCaptureMu.Unlock()
	if !a.screenCaptureActive || a.screenCaptureContext != ctx {
		return context.Canceled
	}
	a.screenCaptureSnapshots = snapshots
	return nil
}

func (a *App) pinShotDisplaySnapshot(screenID string) (platform.ScreenCaptureResult, error) {
	a.screenCaptureMu.Lock()
	snapshot, ok := a.screenCaptureSnapshots[screenID]
	a.screenCaptureMu.Unlock()
	if !ok || len(snapshot.PNGData) == 0 {
		return platform.ScreenCaptureResult{}, errors.New("frozen screen capture is unavailable")
	}
	return snapshot, nil
}

func cropPinShotDisplaySnapshot(
	snapshot platform.ScreenCaptureResult,
	bounds application.Rect,
) (platform.ScreenCaptureResult, error) {
	left := bounds.X
	top := bounds.Y
	right := bounds.X + bounds.Width
	bottom := bounds.Y + bounds.Height
	left = max(0, min(left, snapshot.Width))
	top = max(0, min(top, snapshot.Height))
	right = max(0, min(right, snapshot.Width))
	bottom = max(0, min(bottom, snapshot.Height))
	return platform.CropScreenCapture(snapshot, left, top, right-left, bottom-top)
}
