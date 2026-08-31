package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"dkst-text-flow/internal/ai"
	"dkst-text-flow/internal/flowengine"
	"dkst-text-flow/internal/hotkey"
	"dkst-text-flow/internal/loginitem"
	"dkst-text-flow/internal/ocr"
	"dkst-text-flow/internal/platform"
	"dkst-text-flow/internal/speech"
	"dkst-text-flow/internal/storage"
	"dkst-text-flow/internal/tray"
	"dkst-text-flow/internal/windowing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const (
	aiSettingsKey       = "ai.settings"
	aiPromptSettingsKey = "ai.prompt.settings"
	generalSettingsKey  = "general.settings"
)

const (
	ThemeAuto  = "auto"
	ThemeLight = "light"
	ThemeDark  = "dark"
)

const (
	LanguageEnglish = "en"
	LanguageKorean  = "ko"
)

type GeneralSettings struct {
	ThemeMode              string `json:"themeMode"`
	Language               string `json:"language"`
	TypingTrendEnabled     bool   `json:"typingTrendEnabled"`
	StartAtLogin           bool   `json:"startAtLogin"`
	SoundName              string `json:"soundName"`
	FlowToggleHotkey       string `json:"flowToggleHotkey"`
	PinShotEnabled         bool   `json:"pinShotEnabled"`
	PinShotHotkey          string `json:"pinShotHotkey"`
	AppleVisionOCREnabled  bool   `json:"appleVisionOcrEnabled"`
	OCRHotkey              string `json:"ocrHotkey"`
	OCRRecognitionLanguage string `json:"ocrRecognitionLanguage"`
	OCRResultAction        string `json:"ocrResultAction"`
}

type ApplicationSettings struct {
	General GeneralSettings `json:"general"`
	AI      ai.Settings     `json:"ai"`
}

type AIPromptRule struct {
	UseSelectedText     bool   `json:"useSelectedText"`
	RunWithoutSelection bool   `json:"runWithoutSelection"`
	SelectedTextPrompt  string `json:"selectedTextPrompt"`
	NoSelectionPrompt   string `json:"noSelectionPrompt"`
}

type AIPromptProfile struct {
	ID          string `json:"id"`
	AppName     string `json:"appName"`
	AppBundleID string `json:"appBundleId"`
	AIPromptRule
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

type AIPromptSettings struct {
	Common   AIPromptRule      `json:"common"`
	Profiles []AIPromptProfile `json:"profiles"`
}

type AIPromptProfileInput struct {
	AppName     string `json:"appName"`
	AppBundleID string `json:"appBundleId"`
	AIPromptRule
}

// App struct
type App struct {
	ctx                     context.Context
	store                   *storage.Store
	aiClient                *ai.Client
	aiHistory               *ai.ConversationHistory
	appleIntelligenceClient ai.AppleIntelligenceClient
	expansionSoundEvents    chan struct{}
	expansionSoundStopper   context.CancelFunc
	ttsCmd                  *exec.Cmd
	ttsCancel               context.CancelFunc
	ttsActiveID             uint64
	ttsMu                   sync.Mutex
	ttsSynthesisMu          sync.Mutex
	ttsAudioMu              sync.RWMutex
	lastTTSAudio            []byte
	aiSettingsMu            sync.Mutex
	settingsSaveMu          sync.Mutex
	globalShortcutMu        sync.Mutex
	flowStateMu             sync.Mutex
	flowLifecycleMu         sync.Mutex
	screenCaptureMu         sync.Mutex
	screenCaptureContext    context.Context
	screenCaptureCancel     context.CancelFunc
	screenCaptureActive     bool
	screenCaptureCompleting bool
	screenCaptureWindows    []application.Window
	screenCaptureWindowByID map[string]application.Window
	screenCaptureSnapshots  map[string]platform.ScreenCaptureResult
	screenCapturePurpose    screenCapturePurpose
	screenCapturePlacement  *screenCapturePlacement
	screenCaptureSourcePID  int
	screenCaptureRestoreAI  bool
	screenCaptureRestoreOCR bool
	floatingCaptureMu       sync.RWMutex
	floatingCaptures        map[string]*floatingCapture
	nextFloatingCaptureID   uint64
	ocrProcessingMu         sync.Mutex
	ocrProcessing           bool
	ocrWarmupMu             sync.Mutex
	ocrWarmupGeneration     uint64
	flowPaused              bool
	flowStatusStopper       context.CancelFunc
	trayManager             *tray.Manager
	supertonicEngine        *ai.SupertonicEngine
	supertonicEngineMu      sync.Mutex
	menuIcon                []byte
	pausedMenuIcon          []byte
}

// New creates the Wails application service.
func New(menuIcon []byte, pausedMenuIcon []byte) *App {
	return &App{
		aiClient:                ai.NewClient(),
		aiHistory:               ai.NewConversationHistory(),
		appleIntelligenceClient: ai.NewAppleIntelligenceClient(),
		expansionSoundEvents:    make(chan struct{}, 8),
		menuIcon:                append([]byte(nil), menuIcon...),
		pausedMenuIcon:          append([]byte(nil), pausedMenuIcon...),
		floatingCaptures:        make(map[string]*floatingCapture),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	a.ctx = ctx

	store, err := storage.OpenDefault()
	if err != nil {
		println("failed to open storage:", err.Error())
		return err
	}
	a.store = store
	a.startExpansionSoundDispatcher(ctx)
	a.configureExpansionSoundEvent()

	// Initialize the system tray and the global shortcuts before monitoring starts.
	appInst := application.Get()
	a.configureSystemTray(appInst)
	a.configureGlobalShortcuts()
	a.reconcileFlowStatus(true)
	a.startFlowStatusMonitor()
	if settings, settingsErr := a.GetGeneralSettings(); settingsErr == nil && settings.AppleVisionOCREnabled {
		a.scheduleOCRWarmUp(settings.OCRRecognitionLanguage)
	}

	return nil
}

func (a *App) ServiceShutdown() error {
	appInst := application.Get()
	a.cancelScreenRegionCapture(false)
	a.closeAllFloatingCaptures()
	if a.aiClient != nil {
		a.aiClient.Cancel()
	}
	if a.appleIntelligenceClient != nil {
		a.appleIntelligenceClient.Cancel()
	}
	a.stopFlowStatusMonitor()
	a.destroySystemTray()
	if appInst.GlobalShortcut != nil {
		_ = appInst.GlobalShortcut.UnregisterAll()
	}
	flowengine.SetExpansionHandler(nil)
	if a.expansionSoundStopper != nil {
		a.expansionSoundStopper()
		a.expansionSoundStopper = nil
	}
	flowengine.Stop()
	a.supertonicEngineMu.Lock()
	if a.supertonicEngine != nil {
		a.supertonicEngine.Destroy()
		a.supertonicEngine = nil
	}
	a.supertonicEngineMu.Unlock()
	a.clearLastTTSAudio()

	if a.store == nil {
		return nil
	}
	if err := a.store.Close(); err != nil {
		println("failed to close storage:", err.Error())
	}
	return nil
}

func (a *App) ListSnippets(query string) ([]storage.Snippet, error) {
	return a.store.ListSnippets(query)
}

func (a *App) ListSnippetsByLabel(query string, labelID int64) ([]storage.Snippet, error) {
	return a.store.ListSnippetsByLabel(query, labelID)
}

func (a *App) CreateSnippet(input storage.SnippetInput) (storage.Snippet, error) {
	return a.store.CreateSnippet(input)
}

func (a *App) UpdateSnippet(id int64, input storage.SnippetInput) (storage.Snippet, error) {
	return a.store.UpdateSnippet(id, input)
}

func (a *App) DeleteSnippet(id int64) error {
	return a.store.DeleteSnippet(id)
}

func (a *App) ConfirmSnippetDeletion(title string) (bool, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "Untitled snippet"
	}

	resultChan := make(chan bool, 1)
	appInst := application.Get()
	dialog := appInst.Dialog.Question().
		SetTitle("Delete Snippet").
		SetMessage(fmt.Sprintf("Delete snippet \"%s\"?\nThis action cannot be undone.", title))

	deleteBtn := dialog.AddButton("Delete")
	deleteBtn.OnClick(func() {
		resultChan <- true
	})

	cancelBtn := dialog.AddButton("Cancel")
	cancelBtn.OnClick(func() {
		resultChan <- false
	})

	dialog.SetDefaultButton(cancelBtn)
	dialog.SetCancelButton(cancelBtn)
	dialog.Show()

	return <-resultChan, nil
}

func (a *App) ToggleSnippet(id int64, enabled bool) (storage.Snippet, error) {
	return a.store.ToggleSnippet(id, enabled)
}

func (a *App) ListLabels() ([]storage.Label, error) {
	return a.store.ListLabels()
}

func (a *App) CreateLabel(input storage.LabelInput) (storage.Label, error) {
	return a.store.CreateLabel(input)
}

func (a *App) UpdateLabel(id int64, input storage.LabelInput) (storage.Label, error) {
	return a.store.UpdateLabel(id, input)
}

func (a *App) DeleteLabel(id int64) error {
	return a.store.DeleteLabel(id)
}

func (a *App) ConfirmLabelDeletion(name string) (bool, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Untitled label"
	}

	resultChan := make(chan bool, 1)
	appInst := application.Get()
	dialog := appInst.Dialog.Question().
		SetTitle("Delete Label").
		SetMessage(fmt.Sprintf("Delete label \"%s\"?\nSnippets in this label will move back to All.", name))

	deleteBtn := dialog.AddButton("Delete")
	deleteBtn.OnClick(func() {
		resultChan <- true
	})

	cancelBtn := dialog.AddButton("Cancel")
	cancelBtn.OnClick(func() {
		resultChan <- false
	})

	dialog.SetDefaultButton(cancelBtn)
	dialog.SetCancelButton(cancelBtn)
	dialog.Show()

	return <-resultChan, nil
}

func (a *App) AssignSnippetLabel(snippetID int64, labelID int64) (storage.Snippet, error) {
	return a.store.AssignSnippetLabel(snippetID, labelID)
}

func (a *App) SetLabelSnippetsEnabled(labelID int64, enabled bool) error {
	return a.store.SetLabelSnippetsEnabled(labelID, enabled)
}

func (a *App) GetDashboard() (storage.DashboardStats, error) {
	return a.store.Dashboard()
}

func (a *App) LogExpansion(snippetID int64, appBundleID string) error {
	return a.store.LogExpansion(snippetID, appBundleID)
}

func (a *App) GetPlatformStatus() platform.Status {
	return a.reconcileFlowStatus(false)
}

func (a *App) RequestAccessibilityPermission() platform.Status {
	platform.RequestAccessibilityPermission()
	return a.reconcileFlowStatus(true)
}

func (a *App) RequestScreenRecordingPermission() platform.Status {
	platform.RequestScreenRecordingPermission()
	return a.reconcileFlowStatus(false)
}

func (a *App) ToggleFlowPaused() platform.Status {
	a.flowStateMu.Lock()
	a.flowPaused = !a.flowPaused
	paused := a.flowPaused
	a.flowStateMu.Unlock()

	if paused {
		a.stopFlowStatusMonitor()
	}
	a.configureGlobalShortcuts()
	if paused {
		a.cancelFlowOperations()
	}
	status := a.reconcileFlowStatus(true)
	if !paused {
		a.startFlowStatusMonitor()
	}
	return status
}

func (a *App) isFlowPaused() bool {
	a.flowStateMu.Lock()
	defer a.flowStateMu.Unlock()
	return a.flowPaused
}

func (a *App) reconcileFlowStatus(emit bool) platform.Status {
	a.flowLifecycleMu.Lock()
	status := platform.CurrentStatus()
	paused := a.isFlowPaused()
	shouldRun := a.store != nil && status.AccessibilityTrusted && !paused
	if shouldRun && !flowengine.Running() {
		flowengine.Start(a.store)
	}
	if !shouldRun && flowengine.Running() {
		flowengine.Stop()
	}
	status.FlowEngineRunning = flowengine.Running()
	status.FlowPaused = paused
	switch {
	case paused:
		status.Message = "Flow is paused by the Flow toggle."
	case !status.AccessibilityTrusted:
		status.Message = "Accessibility permission is required before Flow can run."
	case status.FlowEngineRunning:
		status.Message = "Flow is active."
	default:
		status.Message = "Flow Engine could not start."
	}
	a.flowLifecycleMu.Unlock()

	if a.trayManager != nil {
		aiEnabled := false
		ocrEnabled := false
		pinShotEnabled := false
		if settings, err := a.GetGeneralSettings(); err == nil {
			ocrEnabled = settings.AppleVisionOCREnabled
			pinShotEnabled = settings.PinShotEnabled
		}
		if settings, err := a.GetAISettings(); err == nil {
			aiEnabled = settings.Enabled
		}
		a.trayManager.UpdateState(tray.State{
			FlowPaused:     paused,
			Running:        status.FlowEngineRunning,
			AIEnabled:      aiEnabled,
			PinShotEnabled: pinShotEnabled,
			OCREnabled:     ocrEnabled,
		})
	}
	if emit {
		if appInst := application.Get(); appInst != nil {
			appInst.Event.Emit("flow:status-changed", status)
		}
	}
	return status
}

func (a *App) startFlowStatusMonitor() {
	a.flowStateMu.Lock()
	if a.flowPaused || a.flowStatusStopper != nil || a.ctx == nil {
		a.flowStateMu.Unlock()
		return
	}
	monitorCtx, stop := context.WithCancel(a.ctx)
	a.flowStatusStopper = stop
	a.flowStateMu.Unlock()

	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-monitorCtx.Done():
				return
			case <-ticker.C:
				a.reconcileFlowStatus(true)
			}
		}
	}()
}

func (a *App) stopFlowStatusMonitor() {
	a.flowStateMu.Lock()
	stop := a.flowStatusStopper
	a.flowStatusStopper = nil
	a.flowStateMu.Unlock()
	if stop != nil {
		stop()
	}
}

func (a *App) cancelFlowOperations() {
	a.CancelAIRequest()
	a.StopSpeaking()
	if appInst := application.Get(); appInst != nil {
		if aiWin, ok := appInst.Window.GetByName("ai"); ok {
			application.InvokeSync(func() {
				aiWin.Hide()
			})
		}
	}
}

func (a *App) GetGeneralSettings() (GeneralSettings, error) {
	settings := DefaultGeneralSettings()
	if a.store == nil {
		return settings, nil
	}

	found, err := a.store.GetJSONSetting(generalSettingsKey, &settings)
	if err != nil {
		return GeneralSettings{}, err
	}
	if !found {
		settings.StartAtLogin = loginitem.Enabled()
		return settings, nil
	}
	normalized := NormalizeGeneralSettings(settings)
	normalized.StartAtLogin = loginitem.Enabled()
	return normalized, nil
}

func (a *App) SaveGeneralSettings(settings GeneralSettings) (GeneralSettings, error) {
	a.settingsSaveMu.Lock()
	defer a.settingsSaveMu.Unlock()

	if a.store == nil {
		return GeneralSettings{}, errors.New("storage is not ready")
	}

	previous, err := a.GetGeneralSettings()
	if err != nil {
		return GeneralSettings{}, err
	}
	normalized := NormalizeGeneralSettings(settings)
	aiSettings, err := a.GetAISettings()
	if err != nil {
		return GeneralSettings{}, err
	}
	if err := validateUniqueHotkeys(normalized, aiSettings); err != nil {
		return GeneralSettings{}, err
	}
	if err := a.updateStartAtLoginIfChanged(normalized.StartAtLogin); err != nil {
		return GeneralSettings{}, err
	}
	if err := a.store.SetJSONSetting(generalSettingsKey, normalized); err != nil {
		return GeneralSettings{}, err
	}
	a.configureGlobalShortcuts()
	a.reconcileFlowStatus(false)
	if appInst := application.Get(); appInst != nil {
		appInst.Event.Emit("general:settings-updated", normalized)
	}
	if shouldWarmUpOCR(previous, normalized) {
		a.scheduleOCRWarmUp(normalized.OCRRecognitionLanguage)
	}
	return normalized, nil
}

func (a *App) SaveApplicationSettings(general GeneralSettings, settings ai.Settings) (ApplicationSettings, error) {
	a.settingsSaveMu.Lock()
	defer a.settingsSaveMu.Unlock()

	if a.store == nil {
		return ApplicationSettings{}, errors.New("storage is not ready")
	}

	previousGeneral, err := a.GetGeneralSettings()
	if err != nil {
		return ApplicationSettings{}, err
	}
	normalizedGeneral := NormalizeGeneralSettings(general)
	normalizedAI := a.normalizeAISettings(settings)
	if err := validateUniqueHotkeys(normalizedGeneral, normalizedAI); err != nil {
		return ApplicationSettings{}, err
	}
	if err := a.updateStartAtLoginIfChanged(normalizedGeneral.StartAtLogin); err != nil {
		return ApplicationSettings{}, err
	}
	if err := a.store.SetJSONSetting(generalSettingsKey, normalizedGeneral); err != nil {
		return ApplicationSettings{}, err
	}

	a.aiSettingsMu.Lock()
	err = a.store.SetJSONSetting(aiSettingsKey, normalizedAI)
	a.aiSettingsMu.Unlock()
	if err != nil {
		return ApplicationSettings{}, err
	}

	a.configureGlobalShortcuts()
	a.reconcileFlowStatus(false)
	if appInst := application.Get(); appInst != nil {
		appInst.Event.Emit("general:settings-updated", normalizedGeneral)
		appInst.Event.Emit("ai:settings-updated", normalizedAI)
	}
	if shouldWarmUpOCR(previousGeneral, normalizedGeneral) {
		a.scheduleOCRWarmUp(normalizedGeneral.OCRRecognitionLanguage)
	}
	return ApplicationSettings{General: normalizedGeneral, AI: normalizedAI}, nil
}

func (a *App) GetAIPromptSettings() (AIPromptSettings, error) {
	settings := DefaultAIPromptSettings()
	if a.store == nil {
		return settings, nil
	}

	found, err := a.store.GetJSONSetting(aiPromptSettingsKey, &settings)
	if err != nil {
		return AIPromptSettings{}, err
	}
	if !found {
		return settings, nil
	}
	return NormalizeAIPromptSettings(settings), nil
}

func (a *App) SaveCommonAIPromptRule(rule AIPromptRule) (AIPromptSettings, error) {
	settings, err := a.GetAIPromptSettings()
	if err != nil {
		return AIPromptSettings{}, err
	}
	settings.Common = NormalizeAIPromptRule(rule)
	return a.saveAIPromptSettings(settings)
}

func (a *App) CreateAIPromptProfile(input AIPromptProfileInput) (AIPromptSettings, error) {
	settings, err := a.GetAIPromptSettings()
	if err != nil {
		return AIPromptSettings{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	profile := AIPromptProfile{
		ID:           fmt.Sprintf("profile-%d", time.Now().UnixNano()),
		AppName:      strings.TrimSpace(input.AppName),
		AppBundleID:  strings.TrimSpace(input.AppBundleID),
		AIPromptRule: NormalizeAIPromptRule(input.AIPromptRule),
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if profile.AppName == "" {
		profile.AppName = "New App"
	}
	settings.Profiles = append(settings.Profiles, profile)
	return a.saveAIPromptSettings(settings)
}

func (a *App) UpdateAIPromptProfile(id string, input AIPromptProfileInput) (AIPromptSettings, error) {
	settings, err := a.GetAIPromptSettings()
	if err != nil {
		return AIPromptSettings{}, err
	}
	id = strings.TrimSpace(id)
	for index := range settings.Profiles {
		if settings.Profiles[index].ID != id {
			continue
		}
		settings.Profiles[index].AppName = strings.TrimSpace(input.AppName)
		settings.Profiles[index].AppBundleID = strings.TrimSpace(input.AppBundleID)
		settings.Profiles[index].AIPromptRule = NormalizeAIPromptRule(input.AIPromptRule)
		settings.Profiles[index].UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		if settings.Profiles[index].AppName == "" {
			settings.Profiles[index].AppName = "New App"
		}
		return a.saveAIPromptSettings(settings)
	}
	return AIPromptSettings{}, errors.New("AI prompt profile was not found")
}

func (a *App) DeleteAIPromptProfile(id string) (AIPromptSettings, error) {
	settings, err := a.GetAIPromptSettings()
	if err != nil {
		return AIPromptSettings{}, err
	}
	id = strings.TrimSpace(id)
	nextProfiles := make([]AIPromptProfile, 0, len(settings.Profiles))
	found := false
	for _, profile := range settings.Profiles {
		if profile.ID == id {
			found = true
			continue
		}
		nextProfiles = append(nextProfiles, profile)
	}
	if !found {
		return AIPromptSettings{}, errors.New("AI prompt profile was not found")
	}
	settings.Profiles = nextProfiles
	return a.saveAIPromptSettings(settings)
}

func (a *App) BrowseAIPromptApp() (platform.AppInfo, error) {
	appInst := application.Get()
	dialog := appInst.Dialog.OpenFile().
		SetTitle("Choose an application").
		CanChooseFiles(true).
		CanChooseDirectories(false)
	switch runtime.GOOS {
	case "darwin":
		dialog.SetDirectory("/Applications")
	case "windows":
		if programFiles := strings.TrimSpace(os.Getenv("ProgramFiles")); programFiles != "" {
			dialog.SetDirectory(programFiles)
		}
		dialog.
			AddFilter("Windows applications (*.exe)", "*.exe;*.EXE").
			AllowsOtherFileTypes(false)
	}

	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		return platform.AppInfo{}, err
	}
	path = normalizeAIPromptAppPath(path, runtime.GOOS)
	if path == "" {
		return platform.AppInfo{}, nil
	}
	return platform.AppInfoFromBundlePath(path), nil
}

func (a *App) ListRunningApps() []platform.AppInfo {
	var apps []platform.AppInfo
	application.InvokeSync(func() {
		apps = platform.ListRunningApps()
	})
	return apps
}

func enclosingAppBundlePath(path string) string {
	path = strings.TrimSpace(path)
	for path != "" && path != "." && path != string(filepath.Separator) {
		if strings.EqualFold(filepath.Ext(path), ".app") {
			return path
		}
		next := filepath.Dir(path)
		if next == path {
			break
		}
		path = next
	}
	return ""
}

func normalizeAIPromptAppPath(path, goos string) string {
	path = strings.TrimSpace(path)
	switch goos {
	case "darwin":
		return enclosingAppBundlePath(path)
	case "windows":
		if !strings.EqualFold(filepath.Ext(path), ".exe") {
			return ""
		}
		return filepath.Clean(path)
	default:
		return path
	}
}

func (a *App) GetAISettings() (ai.Settings, error) {
	a.aiSettingsMu.Lock()
	defer a.aiSettingsMu.Unlock()

	settings := ai.DefaultSettings()
	if a.store == nil {
		return settings, nil
	}

	found, err := a.store.GetJSONSetting(aiSettingsKey, &settings)
	if err != nil {
		return ai.Settings{}, err
	}
	if !found {
		return settings, nil
	}
	return a.normalizeAISettings(settings), nil
}

func (a *App) SaveAISettings(settings ai.Settings) (ai.Settings, error) {
	a.settingsSaveMu.Lock()
	defer a.settingsSaveMu.Unlock()

	a.aiSettingsMu.Lock()
	if a.store == nil {
		a.aiSettingsMu.Unlock()
		return ai.Settings{}, errors.New("storage is not ready")
	}

	normalized := a.normalizeAISettings(settings)
	generalSettings, err := a.GetGeneralSettings()
	if err != nil {
		a.aiSettingsMu.Unlock()
		return ai.Settings{}, err
	}
	if err := validateUniqueHotkeys(generalSettings, normalized); err != nil {
		a.aiSettingsMu.Unlock()
		return ai.Settings{}, err
	}
	if err := a.store.SetJSONSetting(aiSettingsKey, normalized); err != nil {
		a.aiSettingsMu.Unlock()
		return ai.Settings{}, err
	}
	a.aiSettingsMu.Unlock()

	a.configureGlobalShortcuts()
	a.reconcileFlowStatus(false)
	if appInst := application.Get(); appInst != nil {
		appInst.Event.Emit("ai:settings-updated", normalized)
	}
	return normalized, nil
}

func (a *App) GetTTSModelStatus() (ai.TTSModelStatus, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return ai.TTSModelStatus{}, fmt.Errorf("failed to resolve user config dir: %w", err)
	}
	supertonicDir := filepath.Join(configDir, "DKST Text Flow", "supertonic")
	return ai.CheckModelStatus(supertonicDir), nil
}

func (a *App) ListOSVoices() ([]speech.Voice, error) {
	return speech.ListNativeVoices()
}

func (a *App) StartTTSModelDownload() error {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return fmt.Errorf("failed to resolve user config dir: %w", err)
	}
	supertonicDir := filepath.Join(configDir, "DKST Text Flow", "supertonic")
	return ai.StartTTSModelDownload(supertonicDir, func(status ai.TTSModelStatus) {
		appInst := application.Get()
		if appInst != nil {
			appInst.Event.Emit("tts:download-progress", status)
		}
	})
}

func (a *App) CancelTTSModelDownload() {
	ai.CancelTTSModelDownload()
}

func (a *App) MakeAIRequest(endpoint string, headers map[string]string, body string) (string, error) {
	if a.isFlowPaused() {
		return "", errors.New("Flow is paused")
	}
	if a.aiClient == nil {
		a.aiClient = ai.NewClient()
	}
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return "", errors.New("AI endpoint is required")
	}
	return a.aiClient.MakeRequest(endpoint, headers, body)
}

func (a *App) RunAIAssist(input ai.AssistRequest) (ai.AssistResult, error) {
	if a.isFlowPaused() {
		return ai.AssistResult{}, errors.New("Flow is paused")
	}
	settings, err := a.GetAISettings()
	if err != nil {
		return ai.AssistResult{}, err
	}
	if a.aiClient == nil {
		a.aiClient = ai.NewClient()
	}
	if a.aiHistory == nil {
		a.aiHistory = ai.NewConversationHistory()
	}
	input.CustomPrompt = a.customPromptForRequest(input)
	if settings.Provider == ai.ProviderAppleIntelligence {
		a.aiHistory.Reset()
		if a.appleIntelligenceClient == nil {
			a.appleIntelligenceClient = ai.NewAppleIntelligenceClient()
		}
		return ai.RunAppleIntelligenceAssist(a.appleIntelligenceClient, settings, input)
	}
	return ai.RunAssistWithHistory(a.aiClient, settings, input, a.aiHistory)
}

func (a *App) GetAppleIntelligenceStatus() ai.AppleIntelligenceStatus {
	if a.appleIntelligenceClient == nil {
		a.appleIntelligenceClient = ai.NewAppleIntelligenceClient()
	}
	return a.appleIntelligenceClient.Status()
}

func (a *App) ReplaceSelectedText(processID int, replacement string) error {
	if a.isFlowPaused() {
		return errors.New("Flow is paused")
	}
	if processID <= 0 {
		return errors.New("source process is missing")
	}
	if strings.TrimSpace(replacement) == "" {
		return errors.New("replacement text is empty")
	}
	preferPaste := false
	if settings, err := a.GetAISettings(); err == nil {
		bundleID := strings.TrimSpace(platform.AppInfoFromProcess(processID).BundleID)
		for _, pasteBundleID := range settings.PasteReplacementBundleIDs {
			if bundleID != "" && bundleID == strings.TrimSpace(pasteBundleID) {
				preferPaste = true
				break
			}
		}
	}
	return platform.ReplaceSelectedTextInProcess(processID, replacement, preferPaste)
}

func (a *App) InsertOCRTextAtCursor(processID int, text string) error {
	if processID <= 0 {
		return errors.New("OCR insertion target is missing")
	}
	if strings.TrimSpace(text) == "" {
		return errors.New("OCR text is empty")
	}
	return platform.InsertTextAtCursorInProcess(processID, text)
}

func (a *App) GetExternalFrontmostProcessID() int {
	processID := platform.GetFrontmostPID()
	if processID == os.Getpid() {
		return 0
	}
	return processID
}

func (a *App) IsFocusedElementEditable(processID int) bool {
	return platform.IsFocusedElementEditableForProcess(processID)
}

func (a *App) ActivateProcess(processID int) error {
	if a.isFlowPaused() {
		return errors.New("Flow is paused")
	}
	return platform.ActivateProcess(processID)
}

func (a *App) CancelAIRequest() {
	if a.aiClient != nil {
		a.aiClient.Cancel()
	}
	if a.appleIntelligenceClient != nil {
		a.appleIntelligenceClient.Cancel()
	}
}

func (a *App) ShowMainWindow() {
	appInst := application.Get()
	if mainWin, ok := appInst.Window.GetByName("main"); ok {
		application.InvokeSync(func() {
			mainWin.SetAlwaysOnTop(false)
			mainWin.UnMinimise()
			mainWin.SetMinSize(900, 560)
			mainWin.SetSize(900, 560)
			mainWin.Center()
			mainWin.Show()
			mainWin.Focus()
			appInst.Show()
			appInst.Event.Emit("app:show-main")
		})
	}
}

func (a *App) configureSystemTray(appInst *application.App) {
	a.trayManager = tray.New(appInst, a.menuIcon, a.pausedMenuIcon, tray.Actions{
		AskAI: func() {
			go a.showAIPrompt(platform.GetFrontmostPID(), true)
		},
		OCR: func() {
			go a.beginOCRScreenRegionCapture(platform.GetFrontmostPID())
		},
		PinShot: func() {
			go func() {
				if err := a.BeginPinShotScreenRegionCapture(); err != nil {
					println("failed to begin Pin Shot:", err.Error())
				}
			}()
		},
		ShowMainWindow: func() {
			go a.ShowMainWindow()
		},
		ToggleFlow: func() {
			go a.ToggleFlowPaused()
		},
		Quit: func() {
			go appInst.Quit()
		},
	})
}

func (a *App) destroySystemTray() {
	if a.trayManager == nil {
		return
	}
	a.trayManager.Destroy()
	a.trayManager = nil
}

func (a *App) startExpansionSoundDispatcher(ctx context.Context) {
	if a.expansionSoundStopper != nil {
		return
	}
	dispatchCtx, stop := context.WithCancel(ctx)
	a.expansionSoundStopper = stop
	go func() {
		for {
			select {
			case <-dispatchCtx.Done():
				return
			case <-a.expansionSoundEvents:
				application.Get().Event.Emit("snippet:expanded")
			}
		}
	}()
}

func (a *App) configureExpansionSoundEvent() {
	flowengine.SetExpansionHandler(func(snippet storage.Snippet) {
		if a.expansionSoundEvents == nil {
			return
		}
		select {
		case a.expansionSoundEvents <- struct{}{}:
		default:
		}
	})
}

func (a *App) configureGlobalShortcuts() {
	a.globalShortcutMu.Lock()
	defer a.globalShortcutMu.Unlock()

	appInst := application.Get()
	if appInst == nil || appInst.GlobalShortcut == nil {
		return
	}
	_ = appInst.GlobalShortcut.UnregisterAll()

	generalSettings, err := a.GetGeneralSettings()
	if err == nil && generalSettings.FlowToggleHotkey != "" {
		err = appInst.GlobalShortcut.Register(generalSettings.FlowToggleHotkey, func() {
			go a.ToggleFlowPaused()
		})
		if err != nil {
			println("failed to register Flow toggle hotkey:", err.Error())
		}
	}
	if err == nil &&
		generalSettings.PinShotEnabled &&
		generalSettings.PinShotHotkey != "" {
		err = appInst.GlobalShortcut.Register(generalSettings.PinShotHotkey, func() {
			go func() {
				if beginErr := a.BeginPinShotScreenRegionCapture(); beginErr != nil {
					println("failed to begin Pin Shot:", beginErr.Error())
				}
			}()
		})
		if err != nil {
			println("failed to register Pin Shot hotkey:", err.Error())
		}
	}
	if runtime.GOOS == "darwin" &&
		generalSettings.AppleVisionOCREnabled &&
		generalSettings.OCRHotkey != "" {
		err = appInst.GlobalShortcut.Register(generalSettings.OCRHotkey, func() {
			go a.beginOCRScreenRegionCapture(platform.GetFrontmostPID())
		})
		if err != nil {
			println("failed to register OCR hotkey:", err.Error())
		}
	}
	if a.isFlowPaused() {
		return
	}

	settings, err := a.GetAISettings()
	if err != nil {
		println("failed to load AI hotkey settings:", err.Error())
		return
	}
	if settings.Enabled && settings.Hotkey != "" {
		err = appInst.GlobalShortcut.Register(settings.Hotkey, func() {
			a.handleAIHotkey(platform.GetFrontmostPID())
		})
		if err != nil {
			println("failed to register AI hotkey:", err.Error())
		}
	}
	if settings.TTSEnabled && settings.TTSUseShortcut && settings.TTSShortcut != "" {
		err = appInst.GlobalShortcut.Register(settings.TTSShortcut, func() {
			a.handleTTSHotkey(platform.GetFrontmostPID())
		})
		if err != nil {
			println("failed to register TTS hotkey:", err.Error())
		}
	}
}

func (a *App) handleAIHotkey(sourceProcessID int) {
	a.showAIPrompt(sourceProcessID, true)
}

func (a *App) showAIPrompt(sourceProcessID int, requireEnabled bool) {
	a.showAIPromptWithScreenshot(sourceProcessID, requireEnabled, nil)
}

func (a *App) showAIPromptWithScreenshot(
	sourceProcessID int,
	requireEnabled bool,
	screenshot *platform.ScreenCaptureResult,
) {
	if a.isFlowPaused() {
		return
	}
	settings, err := a.GetAISettings()
	if err != nil || (requireEnabled && !settings.Enabled) {
		return
	}

	invocation := ai.InvocationContext{
		Kind:            ai.ContextNone,
		Label:           "No Context",
		SourceProcessID: sourceProcessID,
		IsEditable: sourceProcessID > 0 &&
			platform.IsFocusedElementEditableForProcess(sourceProcessID),
	}
	appInfo := platform.AppInfo{}
	if sourceProcessID > 0 {
		appInfo = platform.AppInfoFromProcess(sourceProcessID)
		invocation.AppName = appInfo.Name
		invocation.AppBundleID = appInfo.BundleID
	}
	if screenshot != nil {
		invocation.ScreenshotDataURL = screenshot.DataURL
		invocation.ScreenshotMimeType = screenshot.MimeType
		invocation.ScreenshotWidth = screenshot.Width
		invocation.ScreenshotHeight = screenshot.Height
	}
	rule := a.aiPromptRuleForBundleID(appInfo.BundleID)
	if sourceProcessID > 0 && settings.UseSelectedText && rule.UseSelectedText {
		if selected, err := platform.SelectedTextFromProcess(sourceProcessID); err == nil && strings.TrimSpace(selected) != "" {
			invocation.Kind = ai.ContextSelectedText
			invocation.Text = selected
			invocation.Label = "Selected Text"
		}
	}
	if requireEnabled && invocation.Kind == ai.ContextNone && !rule.RunWithoutSelection {
		return
	}

	appInst := application.Get()
	if aiWin, ok := appInst.Window.GetByName("ai"); ok {
		application.InvokeSync(func() {
			if mainWin, mainWindowExists := appInst.Window.GetByName("main"); mainWindowExists {
				mainWin.Hide()
			}
			aiWin.SetMinSize(460, 74)
			aiWin.SetSize(460, 74)
			aiWin.Center()
			aiWin.SetAlwaysOnTop(true)
			aiWin.UnMinimise()
			aiWin.Show()
			windowing.ActivateForInput(aiWin)
			aiWin.Focus()
		})
		appInst.Event.Emit("ai:invoke", invocation)
	}
}

// ResizeAIPromptWindow smoothly resizes the AI prompt. Screenshot previews keep
// the bottom edge fixed so the HUD grows upward instead of covering more content below.
func (a *App) ResizeAIPromptWindow(height int, growUp bool) {
	a.resizeHUDWindow("ai", height, growUp)
}

func (a *App) ResizeOCRWindow(height int, growUp bool) {
	a.resizeHUDWindow("ocr", height, growUp)
}

func (a *App) resizeHUDWindow(name string, height int, growUp bool) {
	const (
		width     = 460
		maxHeight = 620
	)
	minHeight := 74
	height = max(minHeight, min(maxHeight, height))

	appInst := application.Get()
	if hudWindow, ok := appInst.Window.GetByName(name); ok {
		application.InvokeSync(func() {
			if growUp {
				windowing.ResizeFromBottom(hudWindow, width, height)
				return
			}
			windowing.ResizeFromTop(hudWindow, width, height)
		})
	}
}

func (a *App) normalizeAISettings(settings ai.Settings) ai.Settings {
	normalized := ai.NormalizeSettings(settings)
	if normalized.Hotkey != "" {
		if parsed, err := hotkey.Parse(normalized.Hotkey); err == nil {
			normalized.Hotkey = parsed.Canonical
		} else {
			normalized.Hotkey = ""
		}
	}
	if normalized.TTSShortcut != "" {
		if parsed, err := hotkey.Parse(normalized.TTSShortcut); err == nil {
			normalized.TTSShortcut = parsed.Canonical
		} else {
			normalized.TTSShortcut = ""
		}
	}
	return normalized
}

func (a *App) Speak(text string) error {
	settings, err := a.GetAISettings()
	if err != nil {
		return err
	}
	return a.speakWithSettings(text, settings, true)
}

func (a *App) TestSpeak(text string, settings ai.Settings) error {
	settings = a.normalizeAISettings(settings)
	settings.TTSEnabled = true
	return a.speakWithSettings(text, settings, false)
}

func (a *App) speakWithSettings(text string, settings ai.Settings, requireEnabled bool) error {
	if a.isFlowPaused() {
		return errors.New("Flow is paused")
	}

	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}

	if requireEnabled && !settings.TTSEnabled {
		return errors.New("TTS is disabled in settings")
	}
	a.clearLastTTSAudio()

	ctx, speechID := a.beginSpeaking()
	playbackStarted := false
	defer func() {
		if !playbackStarted {
			a.finishSpeaking(speechID, nil)
		}
	}()

	switch settings.TTSEngine {
	case "os":
		if err := ctx.Err(); err != nil {
			return err
		}
		cmd, err := speech.StartNative(text, settings.TTSOSVoice)
		if err != nil {
			return err
		}
		if !a.attachSpeakingCommand(speechID, cmd) {
			stopSpeakingCommand(cmd)
			return context.Canceled
		}
		playbackStarted = true
		go func(id uint64, cmd *exec.Cmd) {
			_ = cmd.Wait()
			a.finishSpeaking(id, cmd)
		}(speechID, cmd)

	case "supertonic3":
		if err := ctx.Err(); err != nil {
			return err
		}
		a.ttsSynthesisMu.Lock()
		defer a.ttsSynthesisMu.Unlock()
		if err := ctx.Err(); err != nil {
			return err
		}
		configDir, err := os.UserConfigDir()
		if err != nil {
			return fmt.Errorf("failed to resolve user config dir: %w", err)
		}
		supertonicDir := filepath.Join(configDir, "DKST Text Flow", "supertonic")

		status := ai.CheckModelStatus(supertonicDir)
		if !status.IsDownloaded {
			return errors.New("TTS model and runtime are not downloaded; please configure them in settings")
		}

		// Initialize local engine if not loaded yet
		a.supertonicEngineMu.Lock()
		if a.supertonicEngine == nil {
			engine, err := ai.LoadSupertonicEngine(supertonicDir)
			if err != nil {
				a.supertonicEngineMu.Unlock()
				return fmt.Errorf("failed to load local Supertonic engine: %w", err)
			}
			a.supertonicEngine = engine
		}
		engine := a.supertonicEngine
		a.supertonicEngineMu.Unlock()
		if err := ctx.Err(); err != nil {
			return err
		}

		// Load selected voice style JSON
		voiceStylePath := filepath.Join(supertonicDir, "voice_styles", settings.TTSVoice+".json")
		style, err := ai.LoadVoiceStyle(voiceStylePath)
		if err != nil {
			return fmt.Errorf("failed to load voice style %s: %w", settings.TTSVoice, err)
		}
		defer style.Destroy()

		// Determine language: Check if Korean Hangul is present, otherwise language-agnostic "na"
		lang := "na"
		for _, r := range text {
			if r >= 0xAC00 && r <= 0xD7A3 {
				lang = "ko"
				break
			}
		}

		// Synthesize waveform
		wavData, err := engine.SynthesizeContext(ctx, text, lang, style, settings.TTSSteps, float32(settings.TTSSpeed))
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return context.Canceled
			}
			return fmt.Errorf("failed to synthesize speech: %w", err)
		}
		if err := ctx.Err(); err != nil {
			return err
		}

		// Write to a temporary WAV file
		tempFile, err := os.CreateTemp("", "dkst-tts-*.wav")
		if err != nil {
			return fmt.Errorf("failed to create temp file: %w", err)
		}
		tempFilePath := tempFile.Name()
		_ = tempFile.Close() // close immediately so we can write to it using WriteWav

		err = ai.WriteWav(tempFilePath, wavData, engine.SampleRate)
		if err != nil {
			_ = os.Remove(tempFilePath)
			return fmt.Errorf("failed to write WAV data: %w", err)
		}
		wavFileData, err := os.ReadFile(tempFilePath)
		if err != nil {
			_ = os.Remove(tempFilePath)
			return fmt.Errorf("failed to retain synthesized speech: %w", err)
		}
		a.setLastTTSAudio(wavFileData)
		if err := a.startTemporaryTTSAudioPlayback(ctx, speechID, tempFilePath); err != nil {
			a.clearLastTTSAudio()
			return err
		}
		playbackStarted = true

	default:
		return fmt.Errorf("unknown TTS engine: %s", settings.TTSEngine)
	}

	return nil
}

func (a *App) StopSpeaking() {
	a.ttsMu.Lock()
	cancel := a.ttsCancel
	cmd := a.ttsCmd
	a.ttsActiveID++
	a.ttsCancel = nil
	a.ttsCmd = nil
	a.ttsMu.Unlock()

	if cancel != nil {
		cancel()
	}
	stopSpeakingCommand(cmd)
}

func (a *App) beginSpeaking() (context.Context, uint64) {
	a.ttsMu.Lock()
	previousCancel := a.ttsCancel
	previousCmd := a.ttsCmd
	a.ttsActiveID++
	speechID := a.ttsActiveID
	ctx, cancel := context.WithCancel(context.Background())
	a.ttsCancel = cancel
	a.ttsCmd = nil
	a.ttsMu.Unlock()

	if previousCancel != nil {
		previousCancel()
	}
	stopSpeakingCommand(previousCmd)
	return ctx, speechID
}

func (a *App) attachSpeakingCommand(speechID uint64, cmd *exec.Cmd) bool {
	a.ttsMu.Lock()
	defer a.ttsMu.Unlock()
	if a.ttsActiveID != speechID || a.ttsCancel == nil {
		return false
	}
	a.ttsCmd = cmd
	return true
}

func (a *App) finishSpeaking(speechID uint64, cmd *exec.Cmd) {
	a.ttsMu.Lock()
	defer a.ttsMu.Unlock()
	if a.ttsActiveID != speechID {
		return
	}
	if cmd != nil && a.ttsCmd != cmd {
		return
	}
	if a.ttsCancel != nil {
		a.ttsCancel()
	}
	a.ttsCancel = nil
	a.ttsCmd = nil
}

func stopSpeakingCommand(cmd *exec.Cmd) {
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func (a *App) handleTTSHotkey(sourceProcessID int) {
	settings, err := a.GetAISettings()
	if err != nil || !settings.TTSEnabled || !settings.TTSUseShortcut {
		return
	}

	a.ttsMu.Lock()
	isSpeaking := a.ttsCancel != nil || a.ttsCmd != nil
	a.ttsMu.Unlock()

	if isSpeaking {
		a.StopSpeaking()
		return
	}

	selected, err := platform.SelectedTextFromProcess(sourceProcessID)
	if err != nil || strings.TrimSpace(selected) == "" {
		return
	}

	_ = a.Speak(selected)
}

func (a *App) saveAIPromptSettings(settings AIPromptSettings) (AIPromptSettings, error) {
	if a.store == nil {
		return AIPromptSettings{}, errors.New("storage is not ready")
	}
	normalized := NormalizeAIPromptSettings(settings)
	if err := a.store.SetJSONSetting(aiPromptSettingsKey, normalized); err != nil {
		return AIPromptSettings{}, err
	}
	return normalized, nil
}

func (a *App) customPromptForRequest(request ai.AssistRequest) string {
	rule := a.aiPromptRuleForBundleID(request.AppBundleID)
	if request.ContextKind == ai.ContextSelectedText && strings.TrimSpace(request.ContextText) != "" {
		if !rule.UseSelectedText {
			return ""
		}
		return rule.SelectedTextPrompt
	}
	if !rule.RunWithoutSelection {
		return ""
	}
	return rule.NoSelectionPrompt
}

func (a *App) aiPromptRuleForBundleID(bundleID string) AIPromptRule {
	settings, err := a.GetAIPromptSettings()
	if err != nil {
		return DefaultAIPromptSettings().Common
	}
	for _, profile := range settings.Profiles {
		if appIdentifiersMatch(profile.AppBundleID, bundleID) {
			return profile.AIPromptRule
		}
	}
	return settings.Common
}

func appIdentifiersMatch(configured, active string) bool {
	configured = strings.TrimSpace(configured)
	active = strings.TrimSpace(active)
	if configured == "" || active == "" {
		return false
	}
	if strings.EqualFold(configured, active) {
		return true
	}

	// Windows profiles historically stored only an executable name. Accept a
	// manually entered full executable path without weakening matching between
	// two distinct full paths.
	configuredHasPath := strings.ContainsAny(configured, `/\`)
	activeHasPath := strings.ContainsAny(active, `/\`)
	if configuredHasPath == activeHasPath {
		return false
	}
	return strings.EqualFold(appIdentifierBase(configured), appIdentifierBase(active))
}

func appIdentifierBase(value string) string {
	if separator := strings.LastIndexAny(value, `/\`); separator >= 0 {
		return value[separator+1:]
	}
	return value
}

func DefaultGeneralSettings() GeneralSettings {
	return GeneralSettings{
		ThemeMode:              ThemeAuto,
		Language:               LanguageEnglish,
		TypingTrendEnabled:     true,
		SoundName:              "None",
		FlowToggleHotkey:       "",
		PinShotEnabled:         true,
		PinShotHotkey:          "",
		AppleVisionOCREnabled:  false,
		OCRHotkey:              "",
		OCRRecognitionLanguage: ocr.LanguageAutomatic,
		OCRResultAction:        ocr.ResultActionShow,
	}
}

func (a *App) updateStartAtLoginIfChanged(enabled bool) error {
	if a.store == nil {
		return errors.New("storage is not ready")
	}

	stored := DefaultGeneralSettings()
	found, err := a.store.GetJSONSetting(generalSettingsKey, &stored)
	if err != nil {
		return err
	}
	if found && stored.StartAtLogin == enabled {
		return nil
	}
	if loginitem.Enabled() == enabled {
		return nil
	}
	if err := loginitem.SetEnabled(enabled); err != nil {
		return fmt.Errorf("update start at login: %w", err)
	}
	return nil
}

func DefaultAIPromptSettings() AIPromptSettings {
	return AIPromptSettings{
		Common: AIPromptRule{
			UseSelectedText:     true,
			RunWithoutSelection: true,
		},
		Profiles: []AIPromptProfile{},
	}
}

func NormalizeAIPromptSettings(settings AIPromptSettings) AIPromptSettings {
	settings.Common = NormalizeAIPromptRule(settings.Common)
	if settings.Profiles == nil {
		settings.Profiles = []AIPromptProfile{}
	}
	for index := range settings.Profiles {
		settings.Profiles[index].ID = strings.TrimSpace(settings.Profiles[index].ID)
		if settings.Profiles[index].ID == "" {
			settings.Profiles[index].ID = fmt.Sprintf("profile-%d", index+1)
		}
		settings.Profiles[index].AppName = strings.TrimSpace(settings.Profiles[index].AppName)
		if settings.Profiles[index].AppName == "" {
			settings.Profiles[index].AppName = "New App"
		}
		settings.Profiles[index].AppBundleID = strings.TrimSpace(settings.Profiles[index].AppBundleID)
		settings.Profiles[index].AIPromptRule = NormalizeAIPromptRule(settings.Profiles[index].AIPromptRule)
	}
	return settings
}

func NormalizeAIPromptRule(rule AIPromptRule) AIPromptRule {
	rule.SelectedTextPrompt = strings.TrimSpace(rule.SelectedTextPrompt)
	rule.NoSelectionPrompt = strings.TrimSpace(rule.NoSelectionPrompt)
	return rule
}

func validateUniqueHotkeys(general GeneralSettings, settings ai.Settings) error {
	shortcuts := []struct {
		name  string
		value string
	}{
		{name: "Flow toggle hotkey", value: general.FlowToggleHotkey},
		{name: "Pin Shot hotkey", value: general.PinShotHotkey},
		{name: "OCR hotkey", value: general.OCRHotkey},
		{name: "Prompt hotkey", value: settings.Hotkey},
		{name: "TTS hotkey", value: settings.TTSShortcut},
	}
	seen := make(map[string]string, len(shortcuts))
	for _, shortcut := range shortcuts {
		value := strings.ToLower(strings.TrimSpace(shortcut.value))
		if value == "" {
			continue
		}
		if previous, exists := seen[value]; exists {
			return fmt.Errorf("%s duplicates %s", shortcut.name, previous)
		}
		seen[value] = shortcut.name
	}
	return nil
}

func NormalizeGeneralSettings(settings GeneralSettings) GeneralSettings {
	settings.ThemeMode = strings.TrimSpace(settings.ThemeMode)
	switch settings.ThemeMode {
	case ThemeAuto, ThemeLight, ThemeDark:
	default:
		settings.ThemeMode = ThemeAuto
	}

	settings.Language = strings.TrimSpace(settings.Language)
	switch settings.Language {
	case LanguageEnglish, LanguageKorean:
	default:
		settings.Language = LanguageEnglish
	}

	settings.SoundName = strings.TrimSpace(settings.SoundName)
	if settings.SoundName == "" {
		settings.SoundName = "None"
	}

	settings.FlowToggleHotkey = strings.TrimSpace(settings.FlowToggleHotkey)
	if settings.FlowToggleHotkey != "" {
		if parsed, err := hotkey.Parse(settings.FlowToggleHotkey); err == nil {
			settings.FlowToggleHotkey = parsed.Canonical
		} else {
			settings.FlowToggleHotkey = ""
		}
	}

	settings.PinShotHotkey = strings.TrimSpace(settings.PinShotHotkey)
	if settings.PinShotHotkey != "" {
		if parsed, err := hotkey.Parse(settings.PinShotHotkey); err == nil {
			settings.PinShotHotkey = parsed.Canonical
		} else {
			settings.PinShotHotkey = ""
		}
	}

	settings.OCRHotkey = strings.TrimSpace(settings.OCRHotkey)
	if settings.OCRHotkey != "" {
		if parsed, err := hotkey.Parse(settings.OCRHotkey); err == nil {
			settings.OCRHotkey = parsed.Canonical
		} else {
			settings.OCRHotkey = ""
		}
	}

	settings.OCRRecognitionLanguage = strings.TrimSpace(settings.OCRRecognitionLanguage)
	if settings.OCRRecognitionLanguage == "" {
		settings.OCRRecognitionLanguage = ocr.LanguageAutomatic
	}

	settings.OCRResultAction = strings.TrimSpace(settings.OCRResultAction)
	switch settings.OCRResultAction {
	case ocr.ResultActionClipboard, ocr.ResultActionShow:
	default:
		settings.OCRResultAction = ocr.ResultActionShow
	}

	return settings
}

func (a *App) GetOCRLanguages() ([]string, error) {
	return ocr.SupportedLanguages()
}
