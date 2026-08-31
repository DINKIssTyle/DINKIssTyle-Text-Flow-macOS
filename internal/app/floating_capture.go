package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"dkst-text-flow/internal/platform"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

type floatingCapture struct {
	id             string
	pngData        []byte
	dataURL        string
	pixelWidth     int
	pixelHeight    int
	originalBounds application.Rect
	shadowPadding  int
	window         application.Window
}

type FloatingCaptureInfo struct {
	ID             string `json:"id"`
	DataURL        string `json:"dataUrl"`
	PixelWidth     int    `json:"pixelWidth"`
	PixelHeight    int    `json:"pixelHeight"`
	OriginalWidth  int    `json:"originalWidth"`
	OriginalHeight int    `json:"originalHeight"`
}

func (a *App) finishFloatingScreenRegionCapture(
	result platform.ScreenCaptureResult,
	captureErr error,
	placement *screenCapturePlacement,
) {
	if result.Canceled {
		return
	}
	if captureErr != nil {
		a.showFloatingCaptureError(captureErr)
		return
	}
	if placement == nil {
		a.showFloatingCaptureError(errors.New("screen capture position is unavailable"))
		return
	}
	if err := a.createFloatingCapture(result, placement); err != nil {
		a.showFloatingCaptureError(err)
	}
}

func (a *App) showFloatingCaptureError(err error) {
	if err == nil {
		return
	}
	println("Pin Shot failed:", err.Error())
	appInst := application.Get()
	if appInst == nil {
		return
	}
	appInst.Dialog.Error().
		SetTitle("Pin Shot").
		SetMessage(err.Error()).
		Show()
}

func (a *App) createFloatingCapture(
	result platform.ScreenCaptureResult,
	placement *screenCapturePlacement,
) error {
	if len(result.PNGData) == 0 || result.DataURL == "" {
		return errors.New("screen capture returned an empty image")
	}
	if placement.LogicalBounds.Width <= 1 || placement.LogicalBounds.Height <= 1 {
		return errors.New("screen capture position is empty")
	}

	a.floatingCaptureMu.Lock()
	a.nextFloatingCaptureID++
	id := fmt.Sprintf("%d", a.nextFloatingCaptureID)
	entry := &floatingCapture{
		id:             id,
		pngData:        append([]byte(nil), result.PNGData...),
		dataURL:        result.DataURL,
		pixelWidth:     result.Width,
		pixelHeight:    result.Height,
		originalBounds: placement.LogicalBounds,
		shadowPadding:  floatingCaptureShadowPadding(),
	}
	a.floatingCaptures[id] = entry
	a.floatingCaptureMu.Unlock()

	windowName := "floating-capture-" + id
	windowURL := "/?mode=floating&id=" + id
	if entry.shadowPadding > 0 {
		windowURL += fmt.Sprintf("&shadowPadding=%d", entry.shadowPadding)
	}
	windowBounds := floatingCaptureWindowBounds(entry.originalBounds, entry.shadowPadding)
	options := application.WebviewWindowOptions{
		Name:                       windowName,
		Title:                      "Pin Shot",
		Width:                      windowBounds.Width,
		Height:                     windowBounds.Height,
		MinWidth:                   24 + entry.shadowPadding*2,
		MinHeight:                  24 + entry.shadowPadding*2,
		AlwaysOnTop:                true,
		Hidden:                     true,
		URL:                        windowURL,
		Frameless:                  true,
		BackgroundType:             application.BackgroundTypeTransparent,
		MaximiseButtonState:        application.ButtonDisabled,
		MinimiseButtonState:        application.ButtonDisabled,
		DefaultContextMenuDisabled: true,
		Windows: application.WindowsWindow{
			DisableFramelessWindowDecorations: true,
			HiddenOnTaskbar:                   true,
		},
		Mac: application.MacWindow{
			Backdrop:    application.MacBackdropTransparent,
			WindowLevel: application.MacWindowLevelFloating,
			CollectionBehavior: application.MacWindowCollectionBehaviorCanJoinAllSpaces |
				application.MacWindowCollectionBehaviorFullScreenAuxiliary,
		},
		KeyBindings: map[string]func(application.Window){
			"cmdorctrl+s": func(application.Window) {
				if _, err := a.SaveFloatingCapture(id); err != nil {
					a.showFloatingCaptureError(err)
				}
			},
			"cmdorctrl+c": func(application.Window) {
				if err := a.CopyFloatingCapture(id); err != nil {
					a.showFloatingCaptureError(err)
				}
			},
			"cmdorctrl+1": func(application.Window) {
				_ = a.ResetFloatingCaptureSize(id)
			},
			"cmdorctrl+w": func(application.Window) {
				a.CloseFloatingCapture(id)
			},
		},
	}

	var captureWindow application.Window
	application.InvokeSync(func() {
		captureWindow = application.Get().Window.NewWithOptions(options)
		platform.ConfigurePinShotWindow(captureWindow.NativeWindow())
		captureWindow.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) {
			a.removeFloatingCapture(id)
		})
		setWindowBoundsExact(captureWindow, windowBounds)
		captureWindow.SetAlwaysOnTop(true)
		captureWindow.Show()
		captureWindow.Focus()
		// AppKit can constrain a newly shown window by a few pixels to keep its
		// shadow inside the visible screen frame. Pin Shot must instead place the
		// captured pixels at the exact coordinates they came from, including when
		// the selection touches a display edge. Reapply the native frame after the
		// first Show/Focus cycle so that automatic placement cannot shift it.
		setWindowBoundsExact(captureWindow, windowBounds)
	})
	if captureWindow == nil {
		a.removeFloatingCapture(id)
		return errors.New("failed to create Pin Shot window")
	}

	a.floatingCaptureMu.Lock()
	if current := a.floatingCaptures[id]; current != nil {
		current.window = captureWindow
	}
	a.floatingCaptureMu.Unlock()
	return nil
}

func (a *App) GetFloatingCapture(id string) (FloatingCaptureInfo, error) {
	a.floatingCaptureMu.RLock()
	entry := a.floatingCaptures[id]
	if entry == nil {
		a.floatingCaptureMu.RUnlock()
		return FloatingCaptureInfo{}, errors.New("Pin Shot was not found")
	}
	info := FloatingCaptureInfo{
		ID:             entry.id,
		DataURL:        entry.dataURL,
		PixelWidth:     entry.pixelWidth,
		PixelHeight:    entry.pixelHeight,
		OriginalWidth:  entry.originalBounds.Width,
		OriginalHeight: entry.originalBounds.Height,
	}
	a.floatingCaptureMu.RUnlock()
	return info, nil
}

func (a *App) SaveFloatingCapture(id string) (bool, error) {
	entry, err := a.floatingCaptureSnapshot(id)
	if err != nil {
		return false, err
	}
	filename := "screenshot-" + time.Now().Format("2006-01-02-150405") + ".png"
	saveDialog := application.Get().Dialog.SaveFile()
	saveDialog.SetOptions(&application.SaveFileDialogOptions{
		CanCreateDirectories: true,
		AllowOtherFileTypes:  false,
		Title:                "Save Pin Shot",
		Filename:             filename,
		ButtonText:           "Save",
		Filters: []application.FileFilter{{
			DisplayName: "PNG image (*.png)",
			Pattern:     "*.png",
		}},
	})
	path, err := saveDialog.PromptForSingleSelection()
	if err != nil {
		return false, err
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return false, nil
	}
	if !strings.EqualFold(filepath.Ext(path), ".png") {
		path += ".png"
	}
	if err := os.WriteFile(path, entry.pngData, 0o600); err != nil {
		return false, fmt.Errorf("save Pin Shot: %w", err)
	}
	return true, nil
}

func (a *App) CopyFloatingCapture(id string) error {
	entry, err := a.floatingCaptureSnapshot(id)
	if err != nil {
		return err
	}
	if err := platform.WriteClipboardPNG(entry.pngData); err != nil {
		return fmt.Errorf("copy Pin Shot: %w", err)
	}
	return nil
}

// SendFloatingCaptureToAI opens the AI HUD with the Pin Shot attached as
// screenshot context. The Pin Shot stays open so it can still be referenced.
func (a *App) SendFloatingCaptureToAI(id string) error {
	entry, err := a.floatingCaptureSnapshot(id)
	if err != nil {
		return err
	}
	if a.isFlowPaused() {
		return errors.New("Flow is paused")
	}
	settings, err := a.GetAISettings()
	if err != nil {
		return err
	}
	if !settings.Enabled {
		return errors.New("AI assistant is disabled")
	}

	appInst := application.Get()
	if appInst == nil {
		return errors.New("application is unavailable")
	}
	a.showAIPromptWithScreenshot(0, false, &platform.ScreenCaptureResult{
		DataURL:  entry.dataURL,
		MimeType: "image/png",
		Width:    entry.pixelWidth,
		Height:   entry.pixelHeight,
	})
	return nil
}

func (a *App) ResetFloatingCaptureSize(id string) error {
	entry, err := a.floatingCaptureSnapshot(id)
	if err != nil {
		return err
	}
	if entry.window == nil {
		return errors.New("Pin Shot window is unavailable")
	}
	current := entry.window.Bounds()
	original := entry.originalBounds
	originalWindow := floatingCaptureWindowBounds(original, entry.shadowPadding)
	next := application.Rect{
		X:      current.X + (current.Width-originalWindow.Width)/2,
		Y:      current.Y + (current.Height-originalWindow.Height)/2,
		Width:  originalWindow.Width,
		Height: originalWindow.Height,
	}
	setWindowBoundsExact(entry.window, next)
	entry.window.SetAlwaysOnTop(true)
	return nil
}

func (a *App) CloseFloatingCapture(id string) {
	a.floatingCaptureMu.RLock()
	entry := a.floatingCaptures[id]
	var window application.Window
	if entry != nil {
		window = entry.window
	}
	a.floatingCaptureMu.RUnlock()
	if window != nil {
		window.Close()
		return
	}
	a.removeFloatingCapture(id)
}

func (a *App) floatingCaptureSnapshot(id string) (*floatingCapture, error) {
	a.floatingCaptureMu.RLock()
	entry := a.floatingCaptures[id]
	if entry == nil {
		a.floatingCaptureMu.RUnlock()
		return nil, errors.New("Pin Shot was not found")
	}
	snapshot := &floatingCapture{
		id:             entry.id,
		pngData:        append([]byte(nil), entry.pngData...),
		dataURL:        entry.dataURL,
		pixelWidth:     entry.pixelWidth,
		pixelHeight:    entry.pixelHeight,
		originalBounds: entry.originalBounds,
		shadowPadding:  entry.shadowPadding,
		window:         entry.window,
	}
	a.floatingCaptureMu.RUnlock()
	return snapshot, nil
}

const windowsFloatingCaptureShadowPadding = 16

func floatingCaptureShadowPadding() int {
	if runtime.GOOS == "windows" {
		return windowsFloatingCaptureShadowPadding
	}
	return 0
}

func floatingCaptureWindowBounds(contentBounds application.Rect, padding int) application.Rect {
	if padding <= 0 {
		return contentBounds
	}
	return application.Rect{
		X:      contentBounds.X - padding,
		Y:      contentBounds.Y - padding,
		Width:  contentBounds.Width + padding*2,
		Height: contentBounds.Height + padding*2,
	}
}

func (a *App) removeFloatingCapture(id string) {
	a.floatingCaptureMu.Lock()
	delete(a.floatingCaptures, id)
	a.floatingCaptureMu.Unlock()
}

func (a *App) closeAllFloatingCaptures() {
	a.floatingCaptureMu.Lock()
	windows := make([]application.Window, 0, len(a.floatingCaptures))
	for _, entry := range a.floatingCaptures {
		if entry.window != nil {
			windows = append(windows, entry.window)
		}
	}
	clear(a.floatingCaptures)
	a.floatingCaptureMu.Unlock()
	for _, window := range windows {
		window.Close()
	}
}
