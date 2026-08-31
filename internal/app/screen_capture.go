package app

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/url"
	"runtime"
	"strings"

	"dkst-text-flow/internal/ocr"
	"dkst-text-flow/internal/platform"
	"dkst-text-flow/internal/windowing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type ScreenRegionSelection struct {
	ScreenID       string  `json:"screenId"`
	X              float64 `json:"x"`
	Y              float64 `json:"y"`
	Width          float64 `json:"width"`
	Height         float64 `json:"height"`
	ViewportWidth  float64 `json:"viewportWidth"`
	ViewportHeight float64 `json:"viewportHeight"`
}

type screenCapturePurpose uint8

const (
	screenCapturePurposeAI screenCapturePurpose = iota
	screenCapturePurposeOCR
	screenCapturePurposeFloating
)

type screenCapturePlacement struct {
	ScreenID       string
	LogicalBounds  application.Rect
	PhysicalBounds application.Rect
	SnapshotBounds application.Rect
	PixelWidth     int
	PixelHeight    int
}

func (a *App) BeginScreenRegionCapture() error {
	return a.beginScreenRegionCapture(screenCapturePurposeAI, 0)
}

// BeginPinShotScreenRegionCapture starts the independent Pin Shot
// workflow. Unlike AI and OCR capture on macOS, this workflow uses our own
// overlay so the exact selection position is available for the floating window.
func (a *App) BeginPinShotScreenRegionCapture() error {
	settings, err := a.GetGeneralSettings()
	if err != nil {
		return err
	}
	if !settings.PinShotEnabled {
		return errors.New("Pin Shot is disabled")
	}
	return a.beginScreenRegionCapture(screenCapturePurposeFloating, 0)
}

func (a *App) beginOCRScreenRegionCapture(sourceProcessID int) error {
	if !a.tryBeginOCRProcessing() {
		return errors.New("Apple Vision OCR is already processing")
	}
	settings, err := a.GetGeneralSettings()
	if err != nil {
		a.finishOCRProcessing()
		return err
	}
	if !settings.AppleVisionOCREnabled {
		a.finishOCRProcessing()
		return errors.New("Apple Vision OCR is disabled")
	}
	if err := a.beginScreenRegionCapture(screenCapturePurposeOCR, sourceProcessID); err != nil {
		a.finishOCRProcessing()
		a.showOCRWindow(OCRInvocation{
			SourceProcessID: sourceProcessID,
			Error:           err.Error(),
		})
		return err
	}
	return nil
}

func (a *App) beginScreenRegionCapture(purpose screenCapturePurpose, sourceProcessID int) error {
	appInst := application.Get()
	restoreAI := false
	restoreOCR := false
	if purpose == screenCapturePurposeFloating && appInst != nil {
		if aiWindow, ok := appInst.Window.GetByName("ai"); ok {
			restoreAI = aiWindow.IsVisible()
		}
		if ocrWindow, ok := appInst.Window.GetByName("ocr"); ok {
			restoreOCR = ocrWindow.IsVisible()
		}
	}

	a.screenCaptureMu.Lock()
	if a.screenCaptureActive {
		a.screenCaptureMu.Unlock()
		return errors.New("screen capture is already active")
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.screenCaptureActive = true
	a.screenCaptureCompleting = false
	a.screenCaptureContext = ctx
	a.screenCaptureCancel = cancel
	a.screenCapturePurpose = purpose
	a.screenCapturePlacement = nil
	a.screenCaptureWindowByID = nil
	a.screenCaptureSnapshots = nil
	a.screenCaptureSourcePID = sourceProcessID
	a.screenCaptureRestoreAI = restoreAI
	a.screenCaptureRestoreOCR = restoreOCR
	a.screenCaptureMu.Unlock()

	if aiWindow, ok := appInst.Window.GetByName("ai"); ok {
		application.InvokeSync(func() {
			aiWindow.Hide()
		})
	}
	if ocrWindow, ok := appInst.Window.GetByName("ocr"); ok {
		application.InvokeSync(func() {
			ocrWindow.Hide()
		})
	}
	if err := a.beginPlatformScreenRegionCapture(ctx, purpose); err != nil {
		a.finishScreenRegionCapture(platform.ScreenCaptureResult{}, err)
		return err
	}
	return nil
}

func (a *App) CompleteScreenRegionCapture(selection ScreenRegionSelection) error {
	return a.completePlatformScreenRegionCapture(selection)
}

func (a *App) CancelScreenRegionCapture() {
	a.cancelScreenRegionCapture(true)
}

func (a *App) cancelScreenRegionCapture(restoreHUD bool) {
	a.screenCaptureMu.Lock()
	if !a.screenCaptureActive {
		a.screenCaptureMu.Unlock()
		return
	}
	cancel := a.screenCaptureCancel
	purpose := a.screenCapturePurpose
	if !restoreHUD {
		a.screenCaptureActive = false
		a.screenCaptureCompleting = false
		a.screenCaptureContext = nil
		a.screenCaptureCancel = nil
		a.screenCapturePurpose = screenCapturePurposeAI
		a.screenCapturePlacement = nil
		a.screenCaptureWindowByID = nil
		a.screenCaptureSnapshots = nil
		a.screenCaptureSourcePID = 0
		a.screenCaptureRestoreAI = false
		a.screenCaptureRestoreOCR = false
	}
	windows := append([]application.Window(nil), a.screenCaptureWindows...)
	if !restoreHUD {
		a.screenCaptureWindows = nil
	}
	a.screenCaptureMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if !restoreHUD && purpose == screenCapturePurposeOCR {
		a.finishOCRProcessing()
	}
	if restoreHUD {
		a.finishScreenRegionCapture(platform.ScreenCaptureResult{Canceled: true}, nil)
		return
	}
	for _, captureWindow := range windows {
		captureWindow.Close()
	}
}

func (a *App) finishScreenRegionCapture(result platform.ScreenCaptureResult, captureErr error) {
	a.screenCaptureMu.Lock()
	if !a.screenCaptureActive {
		a.screenCaptureMu.Unlock()
		return
	}
	cancel := a.screenCaptureCancel
	a.screenCaptureActive = false
	a.screenCaptureCompleting = false
	a.screenCaptureContext = nil
	a.screenCaptureCancel = nil
	purpose := a.screenCapturePurpose
	placement := a.screenCapturePlacement
	sourceProcessID := a.screenCaptureSourcePID
	restoreAI := a.screenCaptureRestoreAI
	restoreOCR := a.screenCaptureRestoreOCR
	a.screenCapturePurpose = screenCapturePurposeAI
	a.screenCapturePlacement = nil
	a.screenCaptureWindowByID = nil
	a.screenCaptureSnapshots = nil
	a.screenCaptureSourcePID = 0
	a.screenCaptureRestoreAI = false
	a.screenCaptureRestoreOCR = false
	windows := a.screenCaptureWindows
	a.screenCaptureWindows = nil
	a.screenCaptureMu.Unlock()

	if cancel != nil {
		cancel()
	}
	for _, captureWindow := range windows {
		captureWindow.Close()
	}
	if purpose == screenCapturePurposeOCR {
		a.finishOCRScreenRegionCapture(result, captureErr, sourceProcessID)
		return
	}
	if purpose == screenCapturePurposeFloating {
		a.restoreWindowsAfterFloatingCapture(restoreAI, restoreOCR)
		a.finishFloatingScreenRegionCapture(result, captureErr, placement)
		return
	}

	appInst := application.Get()
	application.InvokeSync(func() {
		if aiWindow, ok := appInst.Window.GetByName("ai"); ok {
			aiWindow.SetAlwaysOnTop(true)
			aiWindow.UnMinimise()
			aiWindow.Show()
			windowing.ActivateForInput(aiWindow)
			aiWindow.Focus()
		}
	})
	switch {
	case captureErr != nil:
		appInst.Event.Emit("ai:screenshot-error", captureErr.Error())
	case result.Canceled:
		appInst.Event.Emit("ai:screenshot-canceled")
	default:
		appInst.Event.Emit("ai:screenshot-captured", result)
	}
}

func (a *App) restoreWindowsAfterFloatingCapture(restoreAI, restoreOCR bool) {
	if !restoreAI && !restoreOCR {
		return
	}
	appInst := application.Get()
	if appInst == nil {
		return
	}
	application.InvokeSync(func() {
		if restoreAI {
			if aiWindow, ok := appInst.Window.GetByName("ai"); ok {
				aiWindow.SetAlwaysOnTop(true)
				aiWindow.Show()
			}
		}
		if restoreOCR {
			if ocrWindow, ok := appInst.Window.GetByName("ocr"); ok {
				ocrWindow.SetAlwaysOnTop(true)
				ocrWindow.Show()
			}
		}
	})
}

func (a *App) beginScreenRegionCaptureOverlay() error {
	appInst := application.Get()
	screens := appInst.Screen.GetAll()
	if len(screens) == 0 {
		return errors.New("no displays are available for screen capture")
	}

	var captureWindows []application.Window
	captureWindowByID := make(map[string]application.Window, len(screens))
	var overlayErr error
	application.InvokeSync(func() {
		for index, screen := range screens {
			query := url.Values{}
			query.Set("mode", "capture")
			query.Set("screenId", screen.ID)
			options := application.WebviewWindowOptions{
				Name:           fmt.Sprintf("screen-capture-%d", index),
				Title:          "Select screenshot region",
				Width:          screen.Bounds.Width,
				Height:         screen.Bounds.Height,
				AlwaysOnTop:    true,
				Hidden:         true,
				URL:            "/?" + query.Encode(),
				Frameless:      true,
				DisableResize:  true,
				BackgroundType: application.BackgroundTypeTransparent,
				Windows: application.WindowsWindow{
					DisableFramelessWindowDecorations: true,
					HiddenOnTaskbar:                   true,
				},
				Mac: application.MacWindow{
					DisableShadow: true,
					Backdrop:      application.MacBackdropTransparent,
					CornerType:    application.MacWindowCornerTypeSquare,
					WindowLevel:   application.MacWindowLevelScreenSaver,
					CollectionBehavior: application.MacWindowCollectionBehaviorCanJoinAllSpaces |
						application.MacWindowCollectionBehaviorFullScreenAuxiliary,
				},
			}
			captureWindow := appInst.Window.NewWithOptions(options)
			platform.ConfigurePinShotWindow(captureWindow.NativeWindow())
			if !platform.SetPinShotWindowDisplayBounds(captureWindow.NativeWindow(), screen.ID) {
				setWindowBoundsExact(captureWindow, screen.Bounds)
			}
			a.screenCaptureMu.Lock()
			snapshot := a.screenCaptureSnapshots[screen.ID]
			a.screenCaptureMu.Unlock()
			if len(snapshot.PNGData) > 0 {
				if !platform.SetPinShotWindowSnapshot(captureWindow.NativeWindow(), snapshot.PNGData) {
					captureWindow.Close()
					overlayErr = errors.New("failed to freeze screen capture overlay")
					break
				}
			}
			captureWindow.SetAlwaysOnTop(true)
			captureWindow.Show()
			captureWindows = append(captureWindows, captureWindow)
			captureWindowByID[screen.ID] = captureWindow
		}
		if overlayErr == nil && len(captureWindows) > 0 {
			if runtime.GOOS == "darwin" {
				appInst.Show()
			}
			captureWindows[0].Focus()
		}
	})
	if overlayErr != nil {
		for _, captureWindow := range captureWindows {
			captureWindow.Close()
		}
		return overlayErr
	}

	a.screenCaptureMu.Lock()
	if a.screenCaptureActive {
		a.screenCaptureWindows = captureWindows
		a.screenCaptureWindowByID = captureWindowByID
		a.screenCaptureMu.Unlock()
		return nil
	}
	a.screenCaptureMu.Unlock()
	for _, captureWindow := range captureWindows {
		captureWindow.Close()
	}
	return nil
}

// Wails' macOS SetBounds implementation positions the window before resizing
// it. For borderless windows, the initial native frame is one point smaller,
// so resizing second changes the final top edge. Size-first preserves the
// requested top-left coordinate exactly and is also safe on Windows.
func setWindowBoundsExact(window application.Window, bounds application.Rect) {
	if platform.SetPinShotWindowBounds(
		window.NativeWindow(),
		bounds.X,
		bounds.Y,
		bounds.Width,
		bounds.Height,
	) {
		return
	}
	window.SetSize(bounds.Width, bounds.Height)
	window.SetPosition(bounds.X, bounds.Y)
}

func (a *App) resolveScreenRegionSelection(
	selection ScreenRegionSelection,
) (*screenCapturePlacement, error) {
	if selection.ViewportWidth <= 0 || selection.ViewportHeight <= 0 ||
		selection.Width <= 1 || selection.Height <= 1 {
		return nil, errors.New("screen capture region is empty")
	}

	screen := application.Get().Screen.GetByID(selection.ScreenID)
	if screen == nil {
		return nil, errors.New("the selected display is no longer available")
	}

	a.screenCaptureMu.Lock()
	captureWindow := a.screenCaptureWindowByID[selection.ScreenID]
	a.screenCaptureMu.Unlock()
	if captureWindow != nil {
		if resolved, ok := platform.ResolvePinShotSelection(
			captureWindow.NativeWindow(),
			selection.X,
			selection.Y,
			selection.Width,
			selection.Height,
			selection.ViewportWidth,
			selection.ViewportHeight,
		); ok {
			return &screenCapturePlacement{
				ScreenID: selection.ScreenID,
				LogicalBounds: application.Rect{
					X:      resolved.X,
					Y:      resolved.Y,
					Width:  resolved.Width,
					Height: resolved.Height,
				},
				PhysicalBounds: application.Rect{
					X:      screen.PhysicalBounds.X,
					Y:      screen.PhysicalBounds.Y,
					Width:  resolved.PixelWidth,
					Height: resolved.PixelHeight,
				},
				SnapshotBounds: application.Rect{
					X:      resolved.PixelX,
					Y:      resolved.PixelY,
					Width:  resolved.PixelWidth,
					Height: resolved.PixelHeight,
				},
				PixelWidth:  resolved.PixelWidth,
				PixelHeight: resolved.PixelHeight,
			}, nil
		}
	}

	logicalScaleX := float64(screen.Bounds.Width) / selection.ViewportWidth
	logicalScaleY := float64(screen.Bounds.Height) / selection.ViewportHeight
	logicalLeft := screen.Bounds.X + int(math.Floor(selection.X*logicalScaleX))
	logicalTop := screen.Bounds.Y + int(math.Floor(selection.Y*logicalScaleY))
	logicalRight := screen.Bounds.X + int(math.Ceil((selection.X+selection.Width)*logicalScaleX))
	logicalBottom := screen.Bounds.Y + int(math.Ceil((selection.Y+selection.Height)*logicalScaleY))
	logicalLeft = max(logicalLeft, screen.Bounds.X)
	logicalTop = max(logicalTop, screen.Bounds.Y)
	logicalRight = min(logicalRight, screen.Bounds.X+screen.Bounds.Width)
	logicalBottom = min(logicalBottom, screen.Bounds.Y+screen.Bounds.Height)

	physicalScaleX := float64(screen.PhysicalBounds.Width) / selection.ViewportWidth
	physicalScaleY := float64(screen.PhysicalBounds.Height) / selection.ViewportHeight
	physicalLeft := screen.PhysicalBounds.X + int(math.Floor(selection.X*physicalScaleX))
	physicalTop := screen.PhysicalBounds.Y + int(math.Floor(selection.Y*physicalScaleY))
	physicalRight := screen.PhysicalBounds.X + int(math.Ceil((selection.X+selection.Width)*physicalScaleX))
	physicalBottom := screen.PhysicalBounds.Y + int(math.Ceil((selection.Y+selection.Height)*physicalScaleY))
	physicalLeft = max(physicalLeft, screen.PhysicalBounds.X)
	physicalTop = max(physicalTop, screen.PhysicalBounds.Y)
	physicalRight = min(physicalRight, screen.PhysicalBounds.X+screen.PhysicalBounds.Width)
	physicalBottom = min(physicalBottom, screen.PhysicalBounds.Y+screen.PhysicalBounds.Height)

	placement := &screenCapturePlacement{
		ScreenID: selection.ScreenID,
		LogicalBounds: application.Rect{
			X:      logicalLeft,
			Y:      logicalTop,
			Width:  logicalRight - logicalLeft,
			Height: logicalBottom - logicalTop,
		},
		PhysicalBounds: application.Rect{
			X:      physicalLeft,
			Y:      physicalTop,
			Width:  physicalRight - physicalLeft,
			Height: physicalBottom - physicalTop,
		},
		SnapshotBounds: application.Rect{
			X:      physicalLeft - screen.PhysicalBounds.X,
			Y:      physicalTop - screen.PhysicalBounds.Y,
			Width:  physicalRight - physicalLeft,
			Height: physicalBottom - physicalTop,
		},
		PixelWidth:  physicalRight - physicalLeft,
		PixelHeight: physicalBottom - physicalTop,
	}
	if placement.LogicalBounds.Width <= 1 || placement.LogicalBounds.Height <= 1 ||
		placement.PhysicalBounds.Width <= 1 || placement.PhysicalBounds.Height <= 1 ||
		placement.SnapshotBounds.Width <= 1 || placement.SnapshotBounds.Height <= 1 {
		return nil, errors.New("screen capture region is empty")
	}
	return placement, nil
}

func (a *App) prepareOverlayScreenRegionCapture(
	selection ScreenRegionSelection,
) (context.Context, *screenCapturePlacement, error) {
	a.screenCaptureMu.Lock()
	if !a.screenCaptureActive {
		a.screenCaptureMu.Unlock()
		return nil, nil, errors.New("screen capture is not active")
	}
	if a.screenCaptureCompleting {
		a.screenCaptureMu.Unlock()
		return nil, nil, nil
	}
	purpose := a.screenCapturePurpose
	a.screenCaptureMu.Unlock()

	placement, err := a.resolveScreenRegionSelection(selection)
	if err != nil {
		return nil, nil, err
	}

	a.screenCaptureMu.Lock()
	defer a.screenCaptureMu.Unlock()
	if !a.screenCaptureActive {
		return nil, nil, errors.New("screen capture is not active")
	}
	if a.screenCaptureCompleting {
		return nil, nil, nil
	}
	if purpose != a.screenCapturePurpose {
		return nil, nil, errors.New("screen capture mode changed unexpectedly")
	}
	a.screenCaptureCompleting = true
	a.screenCapturePlacement = placement
	return a.screenCaptureContext, placement, nil
}

type OCRInvocation struct {
	Text            string `json:"text"`
	SourceProcessID int    `json:"sourceProcessId"`
	Error           string `json:"error,omitempty"`
	Loading         bool   `json:"loading,omitempty"`
}

func (a *App) finishOCRScreenRegionCapture(
	result platform.ScreenCaptureResult,
	captureErr error,
	sourceProcessID int,
) {
	defer a.finishOCRProcessing()

	if result.Canceled {
		if sourceProcessID > 0 {
			_ = platform.ActivateProcess(sourceProcessID)
		}
		return
	}
	if captureErr != nil {
		a.showOCRWindow(OCRInvocation{
			SourceProcessID: sourceProcessID,
			Error:           captureErr.Error(),
		})
		return
	}

	settings, err := a.GetGeneralSettings()
	if err != nil {
		a.showOCRWindow(OCRInvocation{SourceProcessID: sourceProcessID, Error: err.Error()})
		return
	}
	a.showOCRWindow(OCRInvocation{
		SourceProcessID: sourceProcessID,
		Loading:         true,
	})
	recognized, err := ocr.RecognizePNG(result.PNGData, settings.OCRRecognitionLanguage)
	if err != nil {
		a.showOCRWindow(OCRInvocation{SourceProcessID: sourceProcessID, Error: err.Error()})
		return
	}
	if strings.TrimSpace(recognized.Text) == "" {
		a.showOCRWindow(OCRInvocation{
			SourceProcessID: sourceProcessID,
			Error:           "Apple Vision OCR did not recognize any text",
		})
		return
	}

	if settings.OCRResultAction == ocr.ResultActionClipboard {
		if err := copyTextToClipboard(recognized.Text); err != nil {
			a.showOCRWindow(OCRInvocation{SourceProcessID: sourceProcessID, Error: err.Error()})
			return
		}
		hideOCRWindow()
		if sourceProcessID > 0 {
			_ = platform.ActivateProcess(sourceProcessID)
		}
		application.Get().Event.Emit("ocr:copied", recognized.Text)
		return
	}

	a.showOCRWindow(OCRInvocation{
		Text:            recognized.Text,
		SourceProcessID: sourceProcessID,
	})
}

func (a *App) tryBeginOCRProcessing() bool {
	a.ocrProcessingMu.Lock()
	defer a.ocrProcessingMu.Unlock()
	if a.ocrProcessing {
		return false
	}
	a.ocrProcessing = true
	return true
}

func (a *App) finishOCRProcessing() {
	a.ocrProcessingMu.Lock()
	a.ocrProcessing = false
	a.ocrProcessingMu.Unlock()
}

func copyTextToClipboard(text string) error {
	if err := platform.WriteClipboardText(text); err != nil {
		return fmt.Errorf("failed to copy OCR text to the clipboard: %w", err)
	}
	return nil
}

func hideOCRWindow() {
	appInst := application.Get()
	if appInst == nil {
		return
	}
	application.InvokeSync(func() {
		if ocrWindow, ok := appInst.Window.GetByName("ocr"); ok {
			ocrWindow.Hide()
		}
	})
}

func (a *App) showOCRWindow(invocation OCRInvocation) {
	appInst := application.Get()
	if appInst == nil {
		return
	}
	application.InvokeSync(func() {
		if mainWindow, ok := appInst.Window.GetByName("main"); ok {
			mainWindow.Hide()
		}
		if aiWindow, ok := appInst.Window.GetByName("ai"); ok {
			aiWindow.Hide()
		}
		if ocrWindow, ok := appInst.Window.GetByName("ocr"); ok {
			ocrWindow.SetMinSize(460, 74)
			ocrWindow.SetSize(460, 74)
			ocrWindow.Center()
			ocrWindow.SetAlwaysOnTop(true)
			ocrWindow.UnMinimise()
			ocrWindow.Show()
			windowing.ActivateForInput(ocrWindow)
			ocrWindow.Focus()
		}
	})
	appInst.Event.Emit("ocr:result", invocation)
}

func (a *App) hideScreenCaptureWindows() {
	a.screenCaptureMu.Lock()
	windows := append([]application.Window(nil), a.screenCaptureWindows...)
	a.screenCaptureMu.Unlock()
	application.InvokeSync(func() {
		for _, captureWindow := range windows {
			captureWindow.Hide()
		}
	})
}
