package main

import (
	"embed"
	"log"
	"runtime"

	appservice "dkst-text-flow/internal/app"
	"dkst-text-flow/internal/windowing"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/menu_icon.png
var menuIcon []byte

//go:embed build/menu_icon_paused.png
var pausedMenuIcon []byte

// Windows notification-area icons need to use more of the image canvas than
// macOS menu-bar icons, otherwise Windows scales the visible glyph too small.
//
//go:embed build/menu_icon_windows.png
var windowsMenuIcon []byte

//go:embed build/menu_icon_paused_windows.png
var windowsPausedMenuIcon []byte

func main() {
	// Wails does not expose WKWebViewConfiguration.writingToolsBehavior yet.
	// Install the macOS hook before Wails creates any webviews.
	windowing.DisableWritingTools()

	if runtime.GOOS == "windows" {
		menuIcon = windowsMenuIcon
		pausedMenuIcon = windowsPausedMenuIcon
	}

	// Create an instance of the app structure
	app := appservice.New(menuIcon, pausedMenuIcon)

	// Create application with options
	appInst := application.New(application.Options{
		Name:        "DKST Text Flow",
		Description: "DKST Text Flow by DINKI'ssTyle",
		Services: []application.Service{
			application.NewService(app),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ActivationPolicy: application.ActivationPolicyAccessory,
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
	})

	// Create main window
	mainWindow := appInst.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:                "main",
		Title:               "DKST Text Flow",
		Width:               900,
		Height:              560,
		MinWidth:            900,
		MinHeight:           560,
		Hidden:              true,
		URL:                 "/",
		MaximiseButtonState: application.ButtonDisabled,
	})

	// Hide main window on close instead of destroying it
	mainWindow.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		event.Cancel()
		mainWindow.Hide()
	})

	// Show only the main window when macOS asks the running app to reopen.
	appInst.Event.RegisterApplicationEventHook(events.Mac.ApplicationShouldHandleReopen, func(event *application.ApplicationEvent) {
		event.Cancel()
		app.ShowMainWindow()
	})

	// Create AI prompt window
	aiWindow := appInst.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:                "ai",
		Title:               "AI Assist",
		Width:               460,
		Height:              74,
		MinWidth:            460,
		MinHeight:           74,
		AlwaysOnTop:         true,
		Hidden:              true,
		URL:                 "/?mode=hud",
		Frameless:           true,
		BackgroundType:      application.BackgroundTypeTransparent,
		MaximiseButtonState: application.ButtonDisabled,
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBar{
				Hide:            true,
				FullSizeContent: true,
			},
		},
	})

	// Hide AI window on close instead of destroying it
	aiWindow.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		event.Cancel()
		aiWindow.Hide()
	})

	if runtime.GOOS == "darwin" {
		ocrWindow := appInst.Window.NewWithOptions(application.WebviewWindowOptions{
			Name:                "ocr",
			Title:               "Apple Vision OCR",
			Width:               460,
			Height:              74,
			MinWidth:            460,
			MinHeight:           74,
			AlwaysOnTop:         true,
			Hidden:              true,
			URL:                 "/?mode=ocr",
			Frameless:           true,
			BackgroundType:      application.BackgroundTypeTransparent,
			MaximiseButtonState: application.ButtonDisabled,
			Mac: application.MacWindow{
				TitleBar: application.MacTitleBar{
					Hide:            true,
					FullSizeContent: true,
				},
			},
		})

		ocrWindow.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
			event.Cancel()
			ocrWindow.Hide()
		})
	}

	// Run the application
	err := appInst.Run()
	if err != nil {
		log.Fatal("Error:", err.Error())
	}
}
