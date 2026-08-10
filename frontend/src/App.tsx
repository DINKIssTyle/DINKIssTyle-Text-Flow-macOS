import { Children, cloneElement, CSSProperties, FormEvent, isValidElement, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode, useEffect, useMemo, useRef, useState, WheelEvent as ReactWheelEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import './App.css';
import appIcon from './assets/images/appicon.png';
import { createTranslator, languageOptions, normalizeLanguage, Translator, Language, TranslationKey } from './i18n';
import {
    ActivateProcess,
    AssignSnippetLabel,
    BackupSnippetsAndAIPrompts,
    BeginScreenRegionCapture,
    BrowseAIPromptApp,
    CancelAIRequest,
    CancelScreenRegionCapture,
    ConfirmLabelDeletion,
    ConfirmSnippetDeletion,
    CloseFloatingCapture,
    CopyFloatingCapture,
    CompleteScreenRegionCapture,
    CreateAIPromptProfile,
    CreateLabel,
    CreateSnippet,
    DeleteAIPromptProfile,
    DeleteLabel,
    DeleteSnippet,
    GetAISettings,
    GetAppleIntelligenceStatus,
    GetAIPromptSettings,
    GetDashboard,
    GetGeneralSettings,
    GetExternalFrontmostProcessID,
    GetFloatingCapture,
    GetOCRLanguages,
    GetPlatformStatus,
    GetTTSModelStatus,
    ImportSnippetsAndAIPrompts,
    InsertOCRTextAtCursor,
    IsFocusedElementEditable,
    ListAIModels,
    ListOSVoices,
    StartTTSModelDownload,
    CancelTTSModelDownload,
    ListLabels,
    ListSnippetsByLabel,
    ListRunningApps,
    RequestAccessibilityPermission,
    RequestScreenRecordingPermission,
    ReplayLastTTSAudio,
    ReplaceSelectedText,
    ResetFloatingCaptureSize,
    ResizeAIPromptWindow,
    ResizeOCRWindow,
    RunAIAssist,
    SaveFloatingCapture,
    SaveLastTTSAudio,
    SaveApplicationSettings,
    SaveCommonAIPromptRule,
    SendFloatingCaptureToAI,
    Speak,
    TestSpeak,
    StopSpeaking,
    SetLabelSnippetsEnabled,
    ToggleSnippet,
    UpdateAIPromptProfile,
    UpdateLabel,
    UpdateSnippet,
    UnloadAIModel,
} from "../bindings/dkst-text-flow/internal/app/app";
import { Application, Clipboard, Events, System, Window } from "@wailsio/runtime";

import { Snippet, SnippetInput, Label, LabelInput, DashboardStats, DailyTypingStat } from "../bindings/dkst-text-flow/internal/storage/models";
import { AppInfo, Status as PlatformStatus } from "../bindings/dkst-text-flow/internal/platform/models";
import { ModelInfo as AIModelInfo, Settings as AISettings } from "../bindings/dkst-text-flow/internal/ai/models";
import { GeneralSettings, AIPromptRule, AIPromptProfile, AIPromptProfileInput, AIPromptSettings } from "../bindings/dkst-text-flow/internal/app/models";

type AIInvocationContext = {
    kind: string;
    text: string;
    filePath: string;
    label: string;
    sourceProcessId: number;
    appName: string;
    appBundleId: string;
    isEditable?: boolean;
    screenshotDataUrl?: string;
    screenshotMimeType?: string;
    screenshotWidth?: number;
    screenshotHeight?: number;
};

type ScreenCaptureAttachment = {
    dataUrl: string;
    mimeType: string;
    width: number;
    height: number;
};

type FloatingCaptureInfo = {
    id: string;
    dataUrl: string;
    pixelWidth: number;
    pixelHeight: number;
    originalWidth: number;
    originalHeight: number;
};

type PreparedSound = {
    buffer: AudioBuffer;
    startOffset: number;
};

type AppPickerTarget =
    | { kind: 'create' }
    | { kind: 'profile'; profileID: string };

const aiHUDCollapsedHeight = 74;
const aiHUDMaxHeight = 620;
const isMacOS = System.IsMac();
const isWindows = System.IsWindows();

// Keep WebKit/macOS writing assistance UI out of the app's editable fields.
// `writingsuggestions` is intentionally lowercase because React 18 does not
// expose the newer global HTML attribute in its TypeScript definitions yet.
const textInputAssistanceDisabled = {
    autoComplete: 'off',
    autoCorrect: 'off',
    spellCheck: false,
    writingsuggestions: 'false',
} as const;

const emptyInput: SnippetInput = {
    labelId: 0,
    shortcut: '',
    title: '',
    content: '',
    contentType: 'plain',
    enabled: true,
    caseSensitive: false,
    usePaste: false,
    expandMode: 'delimiter',
};

const emptyLabelInput: LabelInput = {
    name: '',
    description: '',
    color: '#153e75',
};

const contentTypeOptions: { value: string; labelKey: TranslationKey }[] = [
    { value: 'plain', labelKey: 'plain' },
    { value: 'rich', labelKey: 'rich' },
];

function normalizeContentType(contentType: string) {
    return contentTypeOptions.some((option) => option.value === contentType) ? contentType : 'plain';
}

function contentTypeLabel(contentType: string, t: Translator) {
    const normalized = normalizeContentType(contentType);
    const labelKey = contentTypeOptions.find((option) => option.value === normalized)?.labelKey ?? 'plain';
    return t(labelKey);
}

function formatCount(value: number) {
    return new Intl.NumberFormat().format(value);
}

function hasUnsupportedShortcutCharacters(shortcut: string) {
    return /[^\x21-\x7E]/.test(shortcut.trim());
}

function shouldSuggestPaste(content: string) {
    return content.includes('\n') || content.length >= 240;
}

function isDuplicateShortcutError(err: unknown) {
    return String(err).toLowerCase().includes('unique constraint failed: snippets.shortcut');
}

const snippetTokens: { labelKey: TranslationKey; value: string }[] = [
    { labelKey: 'tokenPaste', value: '{{clipboard}}' },
    { labelKey: 'tokenDate', value: '{{date:2006-01-02}}' },
    { labelKey: 'tokenTime', value: '{{time:15:04}}' },
    { labelKey: 'tab', value: '{{tab}}' },
    { labelKey: 'return', value: '{{return}}' },
    { labelKey: 'esc', value: '{{esc}}' },
    { labelKey: 'tokenSpaceBar', value: '{{space}}' },
    { labelKey: 'home', value: '{{home}}' },
    { labelKey: 'end', value: '{{end}}' },
    { labelKey: 'pageUp', value: '{{pageup}}' },
    { labelKey: 'pageDown', value: '{{pagedown}}' },
    { labelKey: 'up', value: '{{up}}' },
    { labelKey: 'down', value: '{{down}}' },
    { labelKey: 'left', value: '{{left}}' },
    { labelKey: 'right', value: '{{right}}' },
];

const noSoundName = 'None';
const soundAssetModules = import.meta.glob('./assets/sounds/*.wav', {
    eager: true,
    as: 'url',
}) as Record<string, string>;
const soundURLs = Object.fromEntries(
    Object.entries(soundAssetModules).map(([path, url]) => {
        const filename = path.split('/').pop() ?? '';
        return [filename.replace(/\.[^.]+$/, ''), url];
    }),
) as Record<string, string>;
const soundOptions = [
    noSoundName,
    ...Object.keys(soundURLs)
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
];

function resolveSoundName(soundName?: string) {
    if (!soundName) {
        return noSoundName;
    }
    return soundOptions.find((option) => option.toLowerCase() === soundName.toLowerCase()) ?? noSoundName;
}

function audibleStartOffset(buffer: AudioBuffer) {
    const audibleThreshold = 0.004;
    let firstAudibleFrame = buffer.length;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const samples = buffer.getChannelData(channel);
        for (let frame = 0; frame < firstAudibleFrame; frame += 1) {
            if (Math.abs(samples[frame]) >= audibleThreshold) {
                firstAudibleFrame = frame;
                break;
            }
        }
    }
    if (firstAudibleFrame >= buffer.length) {
        return 0;
    }
    return Math.max(0, firstAudibleFrame / buffer.sampleRate - 0.005);
}

const emptyPromptRule: AIPromptRule = {
    useSelectedText: true,
    runWithoutSelection: true,
    selectedTextPrompt: '',
    noSelectionPrompt: '',
};

const hotkeyCodeLabels: Record<string, string> = {
    Space: 'Space',
    Tab: 'Tab',
    Enter: 'Enter',
    Escape: 'Esc',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
};

function formatCapturedHotkey(event: KeyboardEvent): string {
    if (event.key === 'Escape') {
        return '';
    }

    const key = keyLabelFromKeyboardEvent(event);
    if (['Control', 'Shift', 'Alt', 'Meta', 'Command'].includes(key)) {
        return '';
    }

    const parts = [];
    if (event.metaKey) parts.push(isMacOS ? 'Cmd' : (isWindows ? 'Win' : 'Super'));
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push(isMacOS ? 'Option' : 'Alt');
    if (event.shiftKey) parts.push('Shift');
    parts.push(key);

    return parts.length >= 2 ? parts.join('+') : '';
}

function displayHotkey(value: string) {
    if (isMacOS) {
        return value;
    }
    return value
        .replace(/\b(?:Cmd|Command|Meta)\b/gi, isWindows ? 'Win' : 'Super')
        .replace(/\bOption\b/gi, 'Alt');
}

function normalizedHotkey(value: string) {
    return value.trim().toLowerCase();
}

function hasDuplicateHotkeys(general: GeneralSettings, settings: AISettings) {
    const values = [
        general.flowToggleHotkey,
        general.pinShotHotkey,
        general.ocrHotkey,
        settings.hotkey,
        settings.ttsShortcut,
    ]
        .map((value) => normalizedHotkey(value || ''))
        .filter(Boolean);
    return new Set(values).size !== values.length;
}

function keyLabelFromKeyboardEvent(event: KeyboardEvent): string {
    if (event.code.startsWith('Key')) {
        return event.code.slice(3).toUpperCase();
    }
    if (event.code.startsWith('Digit')) {
        return event.code.slice(5);
    }
    if (event.code.startsWith('Numpad')) {
        return event.code.slice(6);
    }
    return hotkeyCodeLabels[event.code] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
}

type HotkeyCaptureControlProps = {
    value: string;
    recording: boolean;
    onStart: () => void;
    onStop: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
    onClear: () => void;
    disabled?: boolean;
    t: Translator;
};

function HotkeyCaptureControl({ value, recording, onStart, onStop, onKeyDown, onClear, disabled = false, t }: HotkeyCaptureControlProps) {
    return (
        <div className={"hotkey-control" + (value ? " has-value" : "")}>
            <button
                type="button"
                className={"hotkey-capture" + (recording ? " recording" : "")}
                disabled={disabled}
                onClick={(event) => {
                    onStart();
                    event.currentTarget.focus();
                }}
                onBlur={onStop}
                onKeyDown={onKeyDown}
            >
                {recording ? t("pressShortcut") : displayHotkey(value || t("recordShortcut"))}
            </button>
            {value && (
                <button
                    type="button"
                    className="hotkey-clear"
                    disabled={disabled}
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onClear();
                    }}
                    aria-label={t("clearShortcut")}
                    title={t("clearShortcut")}
                >
                    <span aria-hidden="true">×</span>
                </button>
            )}
        </div>
    );
}

function flowStatusDetail(status: PlatformStatus | null, t: Translator) {
    if (status?.flowPaused) {
        return t('flowPausedByToggle');
    }
    if (!status?.accessibilityTrusted) {
        return t('permissionPending');
    }
    if (!status?.flowEngineRunning) {
        return t('flowEngineUnavailable');
    }
    return t('accessibilityReady');
}

function aiStatusLabel(elapsedMs: number, t: Translator) {
    if (elapsedMs < 1000) {
        return t('preparingRequest');
    }
    if (elapsedMs < 4000) {
        return t('waitingForModel');
    }
    return t('generatingResponse');
}

type AppleIntelligenceStatusInfo = {
    available: boolean;
    state: string;
    detail?: string;
};

type OSVoiceInfo = {
    id: string;
    name: string;
    language: string;
    gender: string;
    quality?: string;
};

function osVoiceLabel(voice: OSVoiceInfo, t: Translator) {
    const quality = voice.quality === 'premium'
        ? t('voiceQualityPremium')
        : voice.quality === 'enhanced'
            ? t('voiceQualityEnhanced')
            : '';
    const details = [voice.language, quality, voice.gender].filter(Boolean);
    return details.length > 0 ? `${voice.name} (${details.join(', ')})` : voice.name;
}

function appleIntelligenceStatusLabel(status: AppleIntelligenceStatusInfo, t: Translator) {
    switch (status.state) {
    case 'available':
        return t('appleIntelligenceAvailable');
    case 'device_not_eligible':
        return t('appleIntelligenceDeviceNotEligible');
    case 'not_enabled':
        return t('appleIntelligenceNotEnabled');
    case 'model_not_ready':
        return t('appleIntelligenceModelNotReady');
    case 'os_unsupported':
        return t('appleIntelligenceOSUnsupported');
    case 'sdk_unavailable':
        return t('appleIntelligenceSDKUnavailable');
    case 'helper_unavailable':
        return t('appleIntelligenceHelperUnavailable');
    case 'checking':
        return t('appleIntelligenceChecking');
    default:
        return t('appleIntelligenceUnavailable');
    }
}

type MarkdownAlertType = 'tip' | 'important' | 'caution';

const markdownAlertLabels: Record<MarkdownAlertType, string> = {
    tip: 'Tip',
    important: 'Important',
    caution: 'Caution',
};

function renderMarkdownBlockquote(children: ReactNode) {
    const childArray = Children.toArray(children);
    const firstParagraphIndex = childArray.findIndex((child) => (
        isValidElement<{ children?: ReactNode }>(child) && child.type === 'p'
    ));
    const firstChild = firstParagraphIndex >= 0 ? childArray[firstParagraphIndex] : undefined;

    if (!isValidElement<{ children?: ReactNode }>(firstChild) || firstChild.type !== 'p') {
        return <blockquote>{children}</blockquote>;
    }

    const paragraphChildren = Children.toArray(firstChild.props.children);
    const firstParagraphNode = paragraphChildren[0];

    if (typeof firstParagraphNode !== 'string') {
        return <blockquote>{children}</blockquote>;
    }

    const markerMatch = firstParagraphNode.match(/^\s*\[!(TIP|IMPORTANT|CAUTION)\]\s*/i);

    if (!markerMatch) {
        return <blockquote>{children}</blockquote>;
    }

    const alertType = markerMatch[1].toLowerCase() as MarkdownAlertType;
    const remainingText = firstParagraphNode.slice(markerMatch[0].length);
    const nextParagraphChildren = remainingText
        ? [remainingText, ...paragraphChildren.slice(1)]
        : paragraphChildren.slice(1);
    const bodyChildren = nextParagraphChildren.length
        ? [
            cloneElement(
                firstChild as ReactElement<{ children?: ReactNode }>,
                undefined,
                ...nextParagraphChildren,
            ),
            ...childArray.slice(firstParagraphIndex + 1),
        ]
        : childArray.slice(firstParagraphIndex + 1);

    return (
        <div className={`markdown-alert markdown-alert-${alertType}`}>
            <p className="markdown-alert-title">{markdownAlertLabels[alertType]}</p>
            {childArray.slice(0, firstParagraphIndex)}
            {bodyChildren}
        </div>
    );
}

const aboutMarkdownComponents = {
    blockquote({ children }: { children?: ReactNode }) {
        return renderMarkdownBlockquote(children);
    },
};

type CapturePoint = { x: number; y: number };

function ScreenCaptureOverlay({ screenID }: { screenID: string }) {
    const [start, setStart] = useState<CapturePoint | null>(null);
    const [current, setCurrent] = useState<CapturePoint | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [captureError, setCaptureError] = useState('');
    const [language, setLanguage] = useState<Language>('en');
    const t = useMemo(() => createTranslator(language), [language]);

    useEffect(() => {
        document.documentElement.classList.add('capture-mode');
        Window.SetBackgroundColour(0, 0, 0, 0).catch(() => {});
        return () => document.documentElement.classList.remove('capture-mode');
    }, []);

    useEffect(() => {
        GetGeneralSettings()
            .then((settings) => setLanguage(normalizeLanguage(settings.language)))
            .catch(() => {});
    }, []);

    useEffect(() => {
        const handleKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key !== 'Escape') {
                return;
            }
            event.preventDefault();
            CancelScreenRegionCapture().catch(() => {});
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, []);

    const selection = useMemo(() => {
        if (!start || !current) {
            return null;
        }
        return {
            x: Math.min(start.x, current.x),
            y: Math.min(start.y, current.y),
            width: Math.abs(current.x - start.x),
            height: Math.abs(current.y - start.y),
        };
    }, [current, start]);

    function eventPoint(event: ReactPointerEvent<HTMLDivElement>): CapturePoint {
        const bounds = event.currentTarget.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
            y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
        };
    }

    function beginSelection(event: ReactPointerEvent<HTMLDivElement>) {
        if (event.button !== 0 || submitting) {
            return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = eventPoint(event);
        setCaptureError('');
        setStart(point);
        setCurrent(point);
    }

    function updateSelection(event: ReactPointerEvent<HTMLDivElement>) {
        if (!start || submitting) {
            return;
        }
        setCurrent(eventPoint(event));
    }

    async function finishSelection(event: ReactPointerEvent<HTMLDivElement>) {
        if (!start || submitting) {
            return;
        }
        const point = eventPoint(event);
        const nextSelection = {
            x: Math.min(start.x, point.x),
            y: Math.min(start.y, point.y),
            width: Math.abs(point.x - start.x),
            height: Math.abs(point.y - start.y),
        };
        if (nextSelection.width <= 3 || nextSelection.height <= 3) {
            setStart(null);
            setCurrent(null);
            return;
        }
        setCurrent(point);
        setSubmitting(true);
        try {
            const viewport = event.currentTarget.getBoundingClientRect();
            await CompleteScreenRegionCapture({
                screenId: screenID,
                ...nextSelection,
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
            });
        } catch (err) {
            setCaptureError(String(err));
            setSubmitting(false);
        }
    }

    return (
        <div
            className={`screen-capture-overlay ${start ? 'is-selecting' : ''}`}
            onPointerDown={beginSelection}
            onPointerMove={updateSelection}
            onPointerUp={finishSelection}
            onContextMenu={(event) => {
                event.preventDefault();
                CancelScreenRegionCapture().catch(() => {});
            }}
        >
            <div className="screen-capture-hint">
                <span className="material-symbols-rounded" aria-hidden="true">screenshot_region</span>
                <span>{submitting ? t('capturingScreenshot') : t('screenCaptureHint')}</span>
            </div>
            {selection && (
                <div
                    className="screen-capture-selection"
                    style={{
                        left: selection.x,
                        top: selection.y,
                        width: selection.width,
                        height: selection.height,
                    }}
                >
                    {selection.width > 90 && selection.height > 48 && (
                        <span>{Math.round(selection.width)} × {Math.round(selection.height)}</span>
                    )}
                </div>
            )}
            {captureError && <div className="screen-capture-error" role="alert">{captureError}</div>}
        </div>
    );
}

function FloatingCaptureWindow({
    captureID,
    shadowPadding,
}: {
    captureID: string;
    shadowPadding: number;
}) {
    const [capture, setCapture] = useState<FloatingCaptureInfo | null>(null);
    const [opacity, setOpacity] = useState(1);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const [aiAssistantEnabled, setAIAssistantEnabled] = useState(false);
    const [toolbarSizeConstrained, setToolbarSizeConstrained] = useState(false);
    const statusTimerRef = useRef<number | null>(null);
    const toolbarRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        document.documentElement.classList.add('floating-capture-mode');
        Window.SetBackgroundColour(0, 0, 0, 0).catch(() => {});
        return () => {
            document.documentElement.classList.remove('floating-capture-mode');
            if (statusTimerRef.current !== null) {
                window.clearTimeout(statusTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        GetFloatingCapture(captureID)
            .then((value) => {
                setCapture(value as FloatingCaptureInfo);
                setError('');
            })
            .catch((err) => setError(String(err)));
    }, [captureID]);

    useEffect(() => {
        let mounted = true;
        const updateAIAvailability = (settings: AISettings) => {
            if (mounted) {
                setAIAssistantEnabled(settings.enabled === true);
            }
        };
        const cancel = Events.On('ai:settings-updated', (event) => {
            updateAIAvailability(event.data as AISettings);
        });
        GetAISettings()
            .then(updateAIAvailability)
            .catch(() => {
                if (mounted) {
                    setAIAssistantEnabled(false);
                }
            });
        return () => {
            mounted = false;
            cancel();
        };
    }, []);

    useEffect(() => {
        const toolbar = toolbarRef.current;
        if (!toolbar) {
            return;
        }
        const updateToolbarVisibility = () => {
            const horizontalClearance = 24;
            const verticalClearance = 24;
            const contentWidth = Math.max(0, window.innerWidth - shadowPadding * 2);
            const contentHeight = Math.max(0, window.innerHeight - shadowPadding * 2);
            setToolbarSizeConstrained(
                contentWidth <= toolbar.offsetWidth + horizontalClearance ||
                contentHeight <= toolbar.offsetHeight + verticalClearance,
            );
        };
        updateToolbarVisibility();
        const resizeObserver = new ResizeObserver(updateToolbarVisibility);
        resizeObserver.observe(document.documentElement);
        window.addEventListener('resize', updateToolbarVisibility);
        return () => {
            resizeObserver.disconnect();
            window.removeEventListener('resize', updateToolbarVisibility);
        };
    }, [aiAssistantEnabled, shadowPadding]);

    function showStatus(message: string) {
        setStatus(message);
        if (statusTimerRef.current !== null) {
            window.clearTimeout(statusTimerRef.current);
        }
        statusTimerRef.current = window.setTimeout(() => {
            setStatus('');
            statusTimerRef.current = null;
        }, 850);
    }

    function adjustOpacity(event: ReactWheelEvent<HTMLDivElement>) {
        event.preventDefault();
        const direction = event.deltaY === 0 ? 0 : (event.deltaY > 0 ? -1 : 1);
        if (direction === 0) {
            return;
        }
        setOpacity((currentOpacity) => {
            const nextOpacity = Math.max(
                0.1,
                Math.min(1, Math.round((currentOpacity + direction * 0.05) * 100) / 100),
            );
            showStatus(`${Math.round(nextOpacity * 100)}%`);
            return nextOpacity;
        });
    }

    async function saveCapture() {
        try {
            const saved = await SaveFloatingCapture(captureID);
            if (saved) {
                showStatus('Saved');
            }
        } catch (err) {
            setError(String(err));
        }
    }

    async function copyCapture() {
        try {
            await CopyFloatingCapture(captureID);
            showStatus('Copied');
        } catch (err) {
            setError(String(err));
        }
    }

    async function resetCaptureSize() {
        try {
            await ResetFloatingCaptureSize(captureID);
            showStatus('100%');
        } catch (err) {
            setError(String(err));
        }
    }

    async function sendCaptureToAI() {
        try {
            await SendFloatingCaptureToAI(captureID);
            showStatus('Sent to Ask AI');
        } catch (err) {
            setError(String(err));
        }
    }

    useEffect(() => {
        const handleShortcut = (event: globalThis.KeyboardEvent) => {
            if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) {
                return;
            }
            const key = event.key.toLowerCase();
            if (!['s', 'c', 'w', '1'].includes(key)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            setError('');
            switch (key) {
            case 's':
                void saveCapture();
                break;
            case 'c':
                void copyCapture();
                break;
            case '1':
                void resetCaptureSize();
                break;
            case 'w':
                void CloseFloatingCapture(captureID);
                break;
            }
        };
        window.addEventListener('keydown', handleShortcut, true);
        return () => window.removeEventListener('keydown', handleShortcut, true);
    }, [captureID]);

    const content = (
        <>
            {capture && (
                <img
                    className="floating-capture-image"
                    src={capture.dataUrl}
                    alt=""
                    draggable={false}
                    style={{ opacity }}
                />
            )}
            <div
                ref={toolbarRef}
                className={`floating-capture-toolbar${toolbarSizeConstrained ? ' is-size-constrained' : ''}`}
                role="toolbar"
                aria-label="Pin Shot"
                aria-hidden={toolbarSizeConstrained}
            >
                <button type="button" onClick={saveCapture} title="Save (⌘/Ctrl+S)" aria-label="Save">
                    <span className="material-symbols-rounded" aria-hidden="true">save</span>
                </button>
                <button type="button" onClick={copyCapture} title="Copy (⌘/Ctrl+C)" aria-label="Copy">
                    <span className="material-symbols-rounded" aria-hidden="true">content_copy</span>
                </button>
                <button type="button" onClick={resetCaptureSize} title="Reset to 100%" aria-label="Reset to 100%">
                    <span className="floating-capture-reset-label" aria-hidden="true">1:1</span>
                </button>
                {aiAssistantEnabled && (
                    <button type="button" onClick={sendCaptureToAI} title="Send to Ask AI" aria-label="Send to Ask AI">
                        <span className="material-symbols-rounded" aria-hidden="true">smart_toy</span>
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => CloseFloatingCapture(captureID)}
                    title="Close (⌘/Ctrl+W)"
                    aria-label="Close"
                >
                    <span className="material-symbols-rounded" aria-hidden="true">close</span>
                </button>
            </div>
            {status && <div className="floating-capture-status">{status}</div>}
            {error && <div className="floating-capture-error" role="alert">{error}</div>}
        </>
    );
    const hasWindowShadow = shadowPadding > 0;

    return (
        <div
            className={`floating-capture-surface${hasWindowShadow ? ' has-window-shadow' : ''}`}
            onWheel={adjustOpacity}
            style={hasWindowShadow ? { padding: shadowPadding } : undefined}
        >
            {hasWindowShadow ? (
                <div className="floating-capture-shadow-frame">{content}</div>
            ) : content}
        </div>
    );
}

function App() {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    if (mode === 'capture') {
        return <ScreenCaptureOverlay screenID={params.get('screenId') || ''} />;
    }
    if (mode === 'floating') {
        const parsedPadding = Number.parseInt(params.get('shadowPadding') || '0', 10);
        const shadowPadding = Number.isFinite(parsedPadding)
            ? Math.max(0, Math.min(64, parsedPadding))
            : 0;
        return (
            <FloatingCaptureWindow
                captureID={params.get('id') || ''}
                shadowPadding={shadowPadding}
            />
        );
    }
    const hudMode = mode === 'ocr' ? 'ocr' : (mode === 'hud' ? 'ai' : null);
    return <MainApp hudMode={hudMode} />;
}

function MainApp({ hudMode }: { hudMode: 'ai' | 'ocr' | null }) {
    const isHUD = hudMode !== null;
    const isAIHUD = hudMode === 'ai';
    const isOCRHUD = hudMode === 'ocr';
    const [activeView, setActiveView] = useState<'snippets' | 'dashboard' | 'aiPrompts' | 'ai' | 'settings' | 'about'>(isHUD ? 'ai' : 'snippets');
    const [windowMode, setWindowMode] = useState<'main' | 'hud'>(isHUD ? 'hud' : 'main');
    const [snippets, setSnippets] = useState<Snippet[]>([]);
    const [labels, setLabels] = useState<Label[]>([]);
    const [stats, setStats] = useState<DashboardStats>({
        totalExpansions: 0,
        todayExpansions: 0,
        snippetCount: 0,
        enabledCount: 0,
        todayTypingCount: 0,
        averageDailyTyping: 0,
        typingHistory: [],
        topSnippets: [],
    });
    const [platformStatus, setPlatformStatus] = useState<PlatformStatus | null>(null);
    const [generalSettings, setGeneralSettings] = useState<GeneralSettings | null>(null);
    const [aiSettings, setAISettings] = useState<AISettings | null>(null);
    const [appleIntelligenceStatus, setAppleIntelligenceStatus] = useState<AppleIntelligenceStatusInfo>({
        available: false,
        state: 'checking',
    });
    const [modelStatus, setModelStatus] = useState<any>({
        isDownloaded: false,
        status: 'idle',
        progress: 0,
        currentFile: '',
    });
    const [osVoices, setOSVoices] = useState<OSVoiceInfo[]>([]);
    const [osVoicesLoading, setOSVoicesLoading] = useState(true);
    const [osVoicesError, setOSVoicesError] = useState('');
    const [aiPromptSettings, setAIPromptSettings] = useState<AIPromptSettings | null>(null);
    const [selectedPromptID, setSelectedPromptID] = useState('common');
    const [promptSaving, setPromptSaving] = useState(false);
    const [settingsSaving, setSettingsSaving] = useState(false);
    const [settingsTransfer, setSettingsTransfer] = useState<'backup' | 'import' | null>(null);
    const [settingsTransferNotice, setSettingsTransferNotice] = useState('');
    const [query, setQuery] = useState('');
    const [selectedLabelID, setSelectedLabelID] = useState(0);
    const [selectedID, setSelectedID] = useState<number | null>(null);
    const [detailMode, setDetailMode] = useState<'all' | 'label' | 'snippet'>('all');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isPermissionModalOpen, setIsPermissionModalOpen] = useState(false);
    const [appPickerTarget, setAppPickerTarget] = useState<AppPickerTarget | null>(null);
    const [appPickerStage, setAppPickerStage] = useState<'method' | 'running'>('method');
    const [runningApps, setRunningApps] = useState<AppInfo[]>([]);
    const [runningAppsLoading, setRunningAppsLoading] = useState(false);
    const [selectedRunningAppBundleID, setSelectedRunningAppBundleID] = useState('');
    const [modelPickerOpen, setModelPickerOpen] = useState(false);
    const [availableAIModels, setAvailableAIModels] = useState<AIModelInfo[]>([]);
    const [aiModelsLoading, setAIModelsLoading] = useState(false);
    const [aiModelsError, setAIModelsError] = useState('');
    const [unmountingModelInstanceID, setUnmountingModelInstanceID] = useState('');
    const [requestingPermission, setRequestingPermission] = useState<'accessibility' | 'screenRecording' | null>(null);
    const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
    const [form, setForm] = useState<SnippetInput>(emptyInput);
    const [labelForm, setLabelForm] = useState<LabelInput>(emptyLabelInput);
    const [error, setError] = useState('');
    const [saveToast, setSaveToast] = useState<{ id: number; message: string } | null>(null);
    const [shortcutWarning, setShortcutWarning] = useState('');
    const [pastePreferenceTouched, setPastePreferenceTouched] = useState(false);
    const [pasteWarning, setPasteWarning] = useState('');
    const [aboutMarkdown, setAboutMarkdown] = useState('');
    const [aboutLoading, setAboutLoading] = useState(true);
    const [aboutError, setAboutError] = useState('');
    const [aiPrompt, setAIPrompt] = useState('');
    const [aiResult, setAIResult] = useState('');
    const [aiReplacement, setAIReplacement] = useState('');
    const [aiScreenshot, setAIScreenshot] = useState<ScreenCaptureAttachment | null>(null);
    const [aiScreenshotCapturing, setAIScreenshotCapturing] = useState(false);
    const [aiRunning, setAIRunning] = useState(false);
    const [aiElapsedMs, setAIElapsedMs] = useState(0);
    const [aiResponseAction, setAIResponseAction] = useState<'idle' | 'copying' | 'copied' | 'inserting'>('idle');
    const [aiTTSSynthesizing, setAITTSSynthesizing] = useState(false);
    const [aiTTSAudioReady, setAITTSAudioReady] = useState(false);
    const [aiTTSAudioAction, setAITTSAudioAction] = useState<'idle' | 'replaying' | 'saving' | 'saved'>('idle');
    const [ocrText, setOCRText] = useState('');
    const [ocrLoading, setOCRLoading] = useState(false);
    const [ocrLanguages, setOCRLanguages] = useState<string[]>([]);
    const [recordingHotkey, setRecordingHotkey] = useState(false);
    const [recordingTtsHotkey, setRecordingTtsHotkey] = useState(false);
    const [recordingFlowToggleHotkey, setRecordingFlowToggleHotkey] = useState(false);
    const [recordingPinShotHotkey, setRecordingPinShotHotkey] = useState(false);
    const [recordingOCRHotkey, setRecordingOCRHotkey] = useState(false);
    const [hasBeenInvoked, setHasBeenInvoked] = useState(false);
    const [aiContext, setAIContext] = useState<AIInvocationContext>({
        kind: 'none',
        text: '',
        filePath: '',
        label: 'No Context',
        sourceProcessId: 0,
        appName: '',
        appBundleId: '',
        isEditable: false,
    });
    const aiPromptRef = useRef<HTMLTextAreaElement | null>(null);
    const aiHUDHeightRef = useRef(aiHUDCollapsedHeight);
    const aiHUDGrowUpRef = useRef(false);
    const aiHUDMeasureFrameRef = useRef<number | null>(null);
    const aiResponseActionTimerRef = useRef<number | null>(null);
    const aiTTSAudioActionTimerRef = useRef<number | null>(null);
    const aiFocusGenerationRef = useRef(0);
    // Invalidates callbacks from requests that belonged to a closed or replaced HUD session.
    const aiRequestGenerationRef = useRef(0);
    const aiRequestRunningRef = useRef(false);
    const aiInsertionInFlightRef = useRef(false);
    const aiTTSGenerationRef = useRef(0);
    const aiSettingsRef = useRef<AISettings | null>(null);
    const savedGeneralSettingsRef = useRef<GeneralSettings | null>(null);
    const savedAISettingsRef = useRef<AISettings | null>(null);
    const saveToastSequenceRef = useRef(0);
    const snippetContentRef = useRef<HTMLTextAreaElement | null>(null);
    const shortcutInputRef = useRef<HTMLInputElement | null>(null);
    const soundNameRef = useRef(noSoundName);
    const soundAudioRef = useRef<HTMLAudioElement | null>(null);
    const soundAudioContextRef = useRef<AudioContext | null>(null);
    const preparedSoundsRef = useRef<Map<string, PreparedSound>>(new Map());
    const soundPreparationRef = useRef<Map<string, Promise<PreparedSound | null>>>(new Map());

    const selectedSnippet = useMemo(() => {
        return snippets.find((snippet) => snippet.id === selectedID) ?? null;
    }, [selectedID, snippets]);

    const selectedLabel = useMemo(() => {
        return labels.find((label) => label.id === selectedLabelID) ?? null;
    }, [labels, selectedLabelID]);

    const language = (generalSettings?.language ?? 'en') as Language;
    const t = useMemo(() => createTranslator(language), [language]);
    const ocrLanguageOptions = useMemo(() => {
        const current = generalSettings?.ocrRecognitionLanguage || 'auto';
        const preferred = ['en-US', 'ko-KR', 'zh-Hans', 'zh-Hant', 'ja-JP'];
        const available = Array.from(new Set([
            ...preferred.filter((code) => ocrLanguages.includes(code)),
            ...ocrLanguages,
            ...(current !== 'auto' ? [current] : []),
        ]));
        const displayNames = new Intl.DisplayNames(
            [language === 'ko' ? 'ko-KR' : 'en-US'],
            { type: 'language' },
        );
        return [
            { value: 'auto', label: t('auto') },
            ...available.map((code) => ({
                value: code,
                label: displayNames.of(code) || code,
            })),
        ];
    }, [generalSettings?.ocrRecognitionLanguage, language, ocrLanguages, t]);

    useEffect(() => {
        if (!saveToast) {
            return;
        }
        const timeout = window.setTimeout(() => setSaveToast(null), 2600);
        return () => window.clearTimeout(timeout);
    }, [saveToast]);

    useEffect(() => {
        if (!isPermissionModalOpen) {
            return;
        }
        const closeOnEscape = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsPermissionModalOpen(false);
            }
        };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [isPermissionModalOpen]);

    useEffect(() => {
        if (!appPickerTarget) {
            return;
        }
        const closeOnEscape = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') {
                setAppPickerTarget(null);
            }
        };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [appPickerTarget]);

    function showSaveToast(message: string) {
        saveToastSequenceRef.current += 1;
        setError('');
        setSaveToast({
            id: saveToastSequenceRef.current,
            message,
        });
    }

    useEffect(() => {
        const soundName = generalSettings?.soundName || noSoundName;
        soundNameRef.current = soundName;
        if (soundName === noSoundName || !soundURLs[soundName]) {
            soundAudioRef.current = null;
            return;
        }
        const audio = new Audio(soundURLs[soundName]);
        audio.preload = 'auto';
        audio.load();
        soundAudioRef.current = audio;
        void prepareSound(soundName);
    }, [generalSettings?.soundName]);

    useEffect(() => {
        aiSettingsRef.current = aiSettings;
    }, [aiSettings]);

    const allLabel = useMemo<Label>(() => ({
        id: 0,
        name: t('all'),
        description: t('snippetsEnabledCount', { snippets: stats.snippetCount, enabled: stats.enabledCount }),
        color: '#667386',
        snippetCount: stats.snippetCount,
        enabledCount: stats.enabledCount,
        createdAt: '',
        updatedAt: '',
    }), [stats.enabledCount, stats.snippetCount, t]);

    async function refresh(search = query, labelID = selectedLabelID) {
        const [nextLabels, nextSnippets, nextStats, nextStatus] = await Promise.all([
            ListLabels(),
            ListSnippetsByLabel(search, labelID),
            GetDashboard(),
            GetPlatformStatus(),
        ]);
        setLabels(nextLabels || []);
        const snippetsList = nextSnippets || [];
        setSnippets(snippetsList);
        setStats({
            ...nextStats,
            typingHistory: nextStats.typingHistory || [],
            topSnippets: nextStats.topSnippets || [],
        });
        setPlatformStatus(nextStatus);
        if (snippetsList.length > 0 && !snippetsList.some((snippet) => snippet.id === selectedID)) {
            setSelectedID(snippetsList[0].id);
            if (detailMode === 'snippet') {
                setDetailMode('snippet');
            }
        }
        if (snippetsList.length === 0 && detailMode === 'snippet') {
            setSelectedID(null);
            setDetailMode(labelID > 0 ? 'label' : 'all');
        }
    }

    useEffect(() => {
        refresh('').catch((err) => setError(String(err)));
        GetGeneralSettings().then((settings) => {
            const normalized = normalizeGeneralSettings(settings);
            savedGeneralSettingsRef.current = normalized;
            setGeneralSettings(normalized);
        }).catch((err) => setError(String(err)));
        GetAISettings().then((settings) => {
            const normalized = normalizeAISettings(settings);
            aiSettingsRef.current = normalized;
            savedAISettingsRef.current = normalized;
            setAISettings(normalized);
        }).catch((err) => setError(String(err)));
        GetAIPromptSettings().then((settings) => setAIPromptSettings(normalizeAIPromptSettings(settings))).catch((err) => setError(String(err)));
        if (isMacOS && !isHUD) {
            GetOCRLanguages()
                .then((languages) => setOCRLanguages(Array.isArray(languages) ? languages : []))
                .catch((err) => setError(String(err)));
        }
    }, []);

    useEffect(() => {
        const cancel = Events.On('flow:status-changed', (event) => {
            setPlatformStatus(event.data as PlatformStatus);
        });
        return () => cancel();
    }, []);

    useEffect(() => {
        const cancel = Events.On('ai:settings-updated', (event) => {
            if (!isHUD) {
                return;
            }
            const normalized = normalizeAISettings(event.data);
            aiSettingsRef.current = normalized;
            savedAISettingsRef.current = normalized;
            setAISettings(normalized);
        });
        return () => cancel();
    }, [isHUD]);

    useEffect(() => {
        const cancel = Events.On('general:settings-updated', (event) => {
            if (!isHUD) {
                return;
            }
            const normalized = normalizeGeneralSettings(event.data);
            savedGeneralSettingsRef.current = normalized;
            setGeneralSettings(normalized);
        });
        return () => cancel();
    }, [isHUD]);

    useEffect(() => {
        GetTTSModelStatus().then((status) => {
            setModelStatus(status);
        }).catch((err) => console.error(err));

        const cancel = Events.On('tts:download-progress', (event) => {
            const status = event.data as any;
            setModelStatus(status);
        });
        return () => {
            cancel();
        };
    }, []);

    useEffect(() => {
        ListOSVoices().then((voices) => {
            setOSVoices((voices || []) as OSVoiceInfo[]);
            setOSVoicesError('');
        }).catch((err) => {
            setOSVoices([]);
            setOSVoicesError(String(err));
        }).finally(() => setOSVoicesLoading(false));
    }, []);

    useEffect(() => {
        let cancelled = false;
        setAboutLoading(true);
        fetch(`${import.meta.env.BASE_URL}ABOUT.md`)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Failed to load ABOUT.md (${response.status})`);
                }
                return response.text();
            })
            .then((markdown) => {
                if (cancelled) {
                    return;
                }
                setAboutMarkdown(markdown);
                setAboutError('');
            })
            .catch((err) => {
                if (cancelled) {
                    return;
                }
                setAboutError(String(err));
            })
            .finally(() => {
                if (!cancelled) {
                    setAboutLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const themeMode = generalSettings?.themeMode || 'auto';
        document.documentElement.dataset.theme = themeMode;
    }, [generalSettings?.themeMode]);

    useEffect(() => {
        if (isHUD || aiSettings?.provider !== 'apple_intelligence') {
            return;
        }
        refreshAppleIntelligenceStatus();
    }, [aiSettings?.provider, isHUD]);

    useEffect(() => {
        if (detailMode === 'label' && selectedLabel) {
            setLabelForm({
                name: selectedLabel.name,
                description: selectedLabel.description,
                color: selectedLabel.color,
            });
        }
        if (detailMode === 'all') {
            setLabelForm(emptyLabelInput);
        }
    }, [detailMode, selectedLabel]);

    useEffect(() => {
        const timer = window.setInterval(() => {
            GetDashboard().then((nextStats) => {
                setStats({
                    ...nextStats,
                    typingHistory: nextStats.typingHistory || [],
                    topSnippets: nextStats.topSnippets || [],
                });
            }).catch((err) => setError(String(err)));
        }, 2500);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        const handleWindowShortcut = (event: globalThis.KeyboardEvent) => {
            if (event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
                event.preventDefault();
                event.stopPropagation();
                hideCurrentWindow();
                return;
            }
            if (windowMode === 'hud' && event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                hideCurrentWindow();
            }
        };
        window.addEventListener('keydown', handleWindowShortcut, true);
        return () => window.removeEventListener('keydown', handleWindowShortcut, true);
    }, [aiRunning, windowMode]);

    useEffect(() => {
        if (!isAIHUD) {
            return;
        }
        const cancel = Events.On('ai:invoke', (event) => {
            const context = event.data as AIInvocationContext;
            const shouldCancelPreviousRequest = aiRequestRunningRef.current;
            resetAIHUDContent();
            if (shouldCancelPreviousRequest) {
                CancelAIRequest().catch((err) => setError(String(err)));
            }
            setHasBeenInvoked(true);
            setWindowMode('hud');
            setActiveView('ai');
            setAIContext({
                kind: context?.kind || 'none',
                text: context?.text || '',
                filePath: context?.filePath || '',
                label: context?.label || 'No Context',
                sourceProcessId: context?.sourceProcessId || 0,
                appName: context?.appName || '',
                appBundleId: context?.appBundleId || '',
                isEditable: context?.isEditable ?? false,
            });
            if (context?.screenshotDataUrl) {
                aiHUDGrowUpRef.current = true;
                setAIScreenshot({
                    dataUrl: context.screenshotDataUrl,
                    mimeType: context.screenshotMimeType || 'image/png',
                    width: context.screenshotWidth || 1,
                    height: context.screenshotHeight || 1,
                });
            }
            const focusGeneration = ++aiFocusGenerationRef.current;
            window.setTimeout(() => {
                focusAIPromptInput(focusGeneration);
                resizeAIPrompt();
            }, 0);
        });
        return cancel;
    }, [isAIHUD]);

    useEffect(() => {
        if (!isAIHUD) {
            return;
        }
        const focusAfterCapture = () => {
            const focusGeneration = ++aiFocusGenerationRef.current;
            window.setTimeout(() => {
                focusAIPromptInput(focusGeneration);
                resizeAIHUD();
            }, 0);
        };
        const cancelCaptured = Events.On('ai:screenshot-captured', (event) => {
            const attachment = event.data as ScreenCaptureAttachment;
            if (!attachment?.dataUrl) {
                setAIScreenshotCapturing(false);
                setError(t('screenCaptureInvalid'));
                focusAfterCapture();
                return;
            }
            aiHUDGrowUpRef.current = true;
            setAIScreenshot(attachment);
            setAIScreenshotCapturing(false);
            setError('');
            focusAfterCapture();
        });
        const cancelCanceled = Events.On('ai:screenshot-canceled', () => {
            setAIScreenshotCapturing(false);
            focusAfterCapture();
        });
        const cancelError = Events.On('ai:screenshot-error', (event) => {
            setAIScreenshotCapturing(false);
            setError(localizedAIError(event.data, t('screenCaptureFailed')));
            focusAfterCapture();
        });
        return () => {
            cancelCaptured();
            cancelCanceled();
            cancelError();
        };
    }, [isAIHUD, t]);

    useEffect(() => {
        if (!isOCRHUD) {
            return;
        }
        const cancel = Events.On('ocr:result', (event) => {
            const result = event.data as { text?: string; sourceProcessId?: number; error?: string; loading?: boolean };
            StopSpeaking().catch(() => {});
            resetAIHUDContent();
            setHasBeenInvoked(true);
            setWindowMode('hud');
            setActiveView('ai');
            setOCRText(result?.text || '');
            setOCRLoading(result?.loading === true);
            setAIContext({
                kind: 'none',
                text: '',
                filePath: '',
                label: 'OCR',
                sourceProcessId: result?.sourceProcessId || 0,
                appName: '',
                appBundleId: '',
                isEditable: true,
            });
            setError(result?.error ? localizedOCRError(result.error) : '');
            if (result?.text) {
                speakHUDText(result.text, aiSettingsRef.current);
            }
            window.requestAnimationFrame(resizeAIHUD);
        });
        return cancel;
    }, [isOCRHUD, t]);

    useEffect(() => {
        if (!isOCRHUD) {
            return;
        }
        const cancel = Events.On('common:WindowLostFocus', () => {
            window.setTimeout(() => {
                GetExternalFrontmostProcessID()
                    .then((processID) => {
                        if (processID > 0) {
                            setAIContext((current) => ({
                                ...current,
                                sourceProcessId: processID,
                            }));
                        }
                    })
                    .catch(() => {});
            }, 80);
        });
        return cancel;
    }, [isOCRHUD]);

    useEffect(() => {
        if (!isHUD) {
            return;
        }
        const stopAITTS = () => {
            aiTTSGenerationRef.current += 1;
            setAITTSSynthesizing(false);
            StopSpeaking().catch(() => {});
        };
        const cancelHide = Events.On('common:WindowHide', stopAITTS);
        const cancelClosing = Events.On('common:WindowClosing', stopAITTS);
        return () => {
            cancelHide();
            cancelClosing();
        };
    }, []);

    useEffect(() => {
        if (isHUD) {
            return;
        }
        const cancel = Events.On('snippet:expanded', () => {
            playCompletionSound();
        });
        return cancel;
    }, []);

    useEffect(() => {
        if (isHUD) {
            return;
        }
        const cancel = Events.On('ocr:copied', () => {
            playCompletionSound();
        });
        return cancel;
    }, [isHUD]);

    useEffect(() => {
        resizeAIPrompt();
        resizeAIHUD();
    }, [aiPrompt, windowMode]);

    useEffect(() => {
        resizeAIHUD();
    }, [aiResult, aiReplacement, aiRunning, aiScreenshot, aiScreenshotCapturing, ocrText, ocrLoading, windowMode, aiElapsedMs, aiTTSSynthesizing, aiTTSAudioReady]);

    useEffect(() => {
        return () => {
            aiFocusGenerationRef.current += 1;
            if (aiHUDMeasureFrameRef.current !== null) {
                window.cancelAnimationFrame(aiHUDMeasureFrameRef.current);
            }
            if (aiResponseActionTimerRef.current !== null) {
                window.clearTimeout(aiResponseActionTimerRef.current);
            }
            if (aiTTSAudioActionTimerRef.current !== null) {
                window.clearTimeout(aiTTSAudioActionTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!aiRunning) {
            setAIElapsedMs(0);
            return;
        }

        const startedAt = Date.now();
        setAIElapsedMs(0);
        const timer = window.setInterval(() => {
            setAIElapsedMs(Date.now() - startedAt);
        }, 250);
        return () => window.clearInterval(timer);
    }, [aiRunning]);

    useEffect(() => {
        if (isHUD) {
            return;
        }
        const cancel = Events.On('app:show-main', () => {
            setWindowMode('main');
            setActiveView('snippets');
            setAIResult('');
            setAIReplacement('');
        });
        return cancel;
    }, []);

    async function searchSnippets(value: string) {
        setQuery(value);
        try {
            await refresh(value, selectedLabelID);
        } catch (err) {
            setError(String(err));
        }
    }

    async function selectLabel(labelID: number) {
        setSelectedLabelID(labelID);
        setSelectedID(null);
        setDetailMode(labelID > 0 ? 'label' : 'all');
        try {
            await refresh(query, labelID);
        } catch (err) {
            setError(String(err));
        }
    }

    function openCreateModal() {
        setEditingSnippet(null);
        setForm({ ...emptyInput, labelId: selectedLabelID });
        setError('');
        setShortcutWarning('');
        setPastePreferenceTouched(false);
        setPasteWarning('');
        setIsModalOpen(true);
    }

    function openEditModal(snippet: Snippet) {
        setEditingSnippet(snippet);
        setForm({
            shortcut: snippet.shortcut,
            labelId: snippet.labelId,
            title: snippet.title,
            content: snippet.content,
            contentType: normalizeContentType(snippet.contentType),
            enabled: snippet.enabled,
            caseSensitive: snippet.caseSensitive,
            usePaste: snippet.usePaste,
            expandMode: snippet.expandMode,
        });
        setError('');
        setShortcutWarning('');
        setPastePreferenceTouched(false);
        setPasteWarning('');
        setIsModalOpen(true);
    }

    function updateSnippetContent(content: string) {
        if (!pastePreferenceTouched && !form.usePaste && shouldSuggestPaste(content)) {
            setForm({ ...form, content, usePaste: true });
            setPasteWarning('Paste is more stable for multiline or long snippets.');
            return;
        }
        setForm({ ...form, content });
    }

    function updateUsePaste(usePaste: boolean) {
        setPastePreferenceTouched(true);
        setPasteWarning('');
        setForm({ ...form, usePaste });
    }

    function insertSnippetToken(token: string) {
        const textarea = snippetContentRef.current;
        if (!textarea) {
            setForm((current) => ({ ...current, content: `${current.content}${token}` }));
            return;
        }

        const start = textarea.selectionStart ?? form.content.length;
        const end = textarea.selectionEnd ?? form.content.length;
        const nextContent = `${form.content.slice(0, start)}${token}${form.content.slice(end)}`;
        updateSnippetContent(nextContent);
        window.setTimeout(() => {
            textarea.focus();
            const nextCursor = start + token.length;
            textarea.setSelectionRange(nextCursor, nextCursor);
        }, 0);
    }

    async function submitSnippet(event: FormEvent) {
        event.preventDefault();
        setSaveToast(null);
        setError('');
        if (hasUnsupportedShortcutCharacters(form.shortcut)) {
            setShortcutWarning('Shortcuts support only Roman letters, numbers, and symbols.');
            shortcutInputRef.current?.focus();
            return;
        }
        try {
            const saved = editingSnippet
                ? await UpdateSnippet(editingSnippet.id, form)
                : await CreateSnippet(form);
            setIsModalOpen(false);
            setSelectedID(saved.id);
            setDetailMode('snippet');
            await refresh();
            showSaveToast(t('snippetSaved'));
        } catch (err) {
            if (isDuplicateShortcutError(err)) {
                setShortcutWarning('This shortcut is already in use.');
                shortcutInputRef.current?.focus();
                return;
            }
            setError(String(err));
        }
    }

    async function toggleSnippet(snippet: Snippet) {
        try {
            const updated = await ToggleSnippet(snippet.id, !snippet.enabled);
            setSnippets((current) => current.map((item) => item.id === updated.id ? updated : item));
            await refresh();
        } catch (err) {
            setError(String(err));
        }
    }

    async function createLabel() {
        const labelNumber = labels.length + 1;
        try {
            const label = await CreateLabel({
                name: `New Label ${labelNumber}`,
                description: '',
                color: '#153e75',
            });
            await selectLabel(label.id);
        } catch (err) {
            setError(String(err));
        }
    }

    async function saveSelectedLabel() {
        if (!selectedLabel) {
            return;
        }
        setSaveToast(null);
        setError('');
        try {
            const label = await UpdateLabel(selectedLabel.id, labelForm);
            setLabels((current) => current.map((item) => item.id === label.id ? label : item));
            await refresh(query, selectedLabelID);
            showSaveToast(t('labelSaved'));
        } catch (err) {
            setError(String(err));
        }
    }

    async function removeSelectedLabel() {
        if (!selectedLabel) {
            return;
        }
        try {
            const confirmed = await ConfirmLabelDeletion(selectedLabel.name);
            if (!confirmed) {
                return;
            }
            await DeleteLabel(selectedLabel.id);
            await selectLabel(0);
        } catch (err) {
            setError(String(err));
        }
    }

    async function setCurrentLabelSnippetsEnabled(enabled: boolean) {
        const labelID = detailMode === 'label' && selectedLabel ? selectedLabel.id : 0;
        try {
            await SetLabelSnippetsEnabled(labelID, enabled);
            await refresh(query, selectedLabelID);
        } catch (err) {
            setError(String(err));
        }
    }

    async function assignSnippetToLabel(snippetID: number, labelID: number) {
        try {
            const updated = await AssignSnippetLabel(snippetID, labelID);
            setSnippets((current) => current.map((snippet) => snippet.id === updated.id ? updated : snippet));
            await refresh(query, selectedLabelID);
            setSelectedID(updated.id);
            setDetailMode('snippet');
        } catch (err) {
            setError(String(err));
        }
    }

    async function requestAccessibilityPermission() {
        setError('');
        setRequestingPermission('accessibility');
        try {
            const nextStatus = await RequestAccessibilityPermission();
            setPlatformStatus(nextStatus);
        } catch (err) {
            setError(String(err));
        } finally {
            setRequestingPermission(null);
        }
    }

    async function requestScreenRecordingPermission() {
        setError('');
        setRequestingPermission('screenRecording');
        try {
            const nextStatus = await RequestScreenRecordingPermission();
            setPlatformStatus(nextStatus);
        } catch (err) {
            setError(String(err));
        } finally {
            setRequestingPermission(null);
        }
    }

    async function refreshPlatformStatus() {
        setError('');
        try {
            const nextStatus = await GetPlatformStatus();
            setPlatformStatus(nextStatus);
        } catch (err) {
            setError(String(err));
        }
    }

    async function refreshAppleIntelligenceStatus() {
        setAppleIntelligenceStatus({ available: false, state: 'checking' });
        try {
            const status = await GetAppleIntelligenceStatus();
            setAppleIntelligenceStatus({
                available: !!status.available,
                state: status.state || 'unavailable',
                detail: status.detail || '',
            });
        } catch (err) {
            setAppleIntelligenceStatus({
                available: false,
                state: 'helper_unavailable',
                detail: String(err),
            });
        }
    }

    function resetAIHUDContent() {
        aiRequestGenerationRef.current += 1;
        aiRequestRunningRef.current = false;
        aiTTSGenerationRef.current += 1;
        if (aiHUDMeasureFrameRef.current !== null) {
            window.cancelAnimationFrame(aiHUDMeasureFrameRef.current);
            aiHUDMeasureFrameRef.current = null;
        }
        if (aiResponseActionTimerRef.current !== null) {
            window.clearTimeout(aiResponseActionTimerRef.current);
            aiResponseActionTimerRef.current = null;
        }
        if (aiTTSAudioActionTimerRef.current !== null) {
            window.clearTimeout(aiTTSAudioActionTimerRef.current);
            aiTTSAudioActionTimerRef.current = null;
        }
        aiHUDHeightRef.current = aiHUDCollapsedHeight;
        aiHUDGrowUpRef.current = false;
        setAIPrompt('');
        setAIResult('');
        setAIReplacement('');
        setOCRText('');
        setOCRLoading(false);
        setAIScreenshot(null);
        setAIScreenshotCapturing(false);
        setAIElapsedMs(0);
        setAIResponseAction('idle');
        setAITTSSynthesizing(false);
        setAITTSAudioReady(false);
        setAITTSAudioAction('idle');
        setAIRunning(false);
        setAIContext({
            kind: 'none',
            text: '',
            filePath: '',
            label: 'No Context',
            sourceProcessId: 0,
            appName: '',
            appBundleId: '',
        });
    }

    async function hideCurrentWindow(cancelRunning = true) {
        aiFocusGenerationRef.current += 1;
        setHasBeenInvoked(false);
        const shouldCancelRequest = cancelRunning && aiRequestRunningRef.current;
        resetAIHUDContent();
        StopSpeaking().catch(() => {});
        if (cancelRunning) {
            if (shouldCancelRequest) {
                try {
                    await CancelAIRequest();
                } catch (err) {
                    setError(String(err));
                }
            }
        }
        await Window.Hide();
    }

    function normalizeGeneralSettings(settings: {
        themeMode?: string;
        language?: string;
        typingTrendEnabled?: boolean;
        startAtLogin?: boolean;
        soundName?: string;
        flowToggleHotkey?: string;
        pinShotEnabled?: boolean;
        pinShotHotkey?: string;
        appleVisionOcrEnabled?: boolean;
        ocrHotkey?: string;
        ocrRecognitionLanguage?: string;
        ocrResultAction?: string;
    } = {}): GeneralSettings {
        const themeMode = settings.themeMode === 'light' || settings.themeMode === 'dark' ? settings.themeMode : 'auto';
        const soundName = resolveSoundName(settings.soundName);
        return {
            themeMode,
            language: normalizeLanguage(settings.language),
            typingTrendEnabled: settings.typingTrendEnabled !== false,
            startAtLogin: settings.startAtLogin === true,
            soundName,
            flowToggleHotkey: settings.flowToggleHotkey || '',
            pinShotEnabled: settings.pinShotEnabled !== false,
            pinShotHotkey: settings.pinShotHotkey || '',
            appleVisionOcrEnabled: settings.appleVisionOcrEnabled === true,
            ocrHotkey: settings.ocrHotkey || '',
            ocrRecognitionLanguage: settings.ocrRecognitionLanguage || 'auto',
            ocrResultAction: settings.ocrResultAction === 'clipboard' ? 'clipboard' : 'show',
        };
    }

    function soundAudioContext() {
        if (!soundAudioContextRef.current) {
            soundAudioContextRef.current = new AudioContext({ latencyHint: 'interactive' });
        }
        return soundAudioContextRef.current;
    }

    function prepareSound(soundName: string) {
        const prepared = preparedSoundsRef.current.get(soundName);
        if (prepared) {
            return Promise.resolve(prepared);
        }
        const pending = soundPreparationRef.current.get(soundName);
        if (pending) {
            return pending;
        }
        const soundURL = soundURLs[soundName];
        if (!soundURL) {
            return Promise.resolve(null);
        }
        const preparation = fetch(soundURL)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Failed to load sound: ${response.status}`);
                }
                return response.arrayBuffer();
            })
            .then((data) => soundAudioContext().decodeAudioData(data))
            .then((buffer) => {
                const result = {
                    buffer,
                    startOffset: audibleStartOffset(buffer),
                };
                preparedSoundsRef.current.set(soundName, result);
                return result;
            })
            .catch(() => null)
            .finally(() => {
                soundPreparationRef.current.delete(soundName);
            });
        soundPreparationRef.current.set(soundName, preparation);
        return preparation;
    }

    function playPreparedSound(prepared: PreparedSound) {
        const context = soundAudioContext();
        const start = () => {
            const source = context.createBufferSource();
            source.buffer = prepared.buffer;
            source.connect(context.destination);
            source.start(0, prepared.startOffset);
        };
        if (context.state === 'suspended') {
            void context.resume().then(start).catch(() => undefined);
            return;
        }
        start();
    }

    function playCompletionSound(selectedSoundName = soundNameRef.current) {
        const soundName = selectedSoundName;
        if (soundName === noSoundName) {
            return;
        }
        const soundURL = soundURLs[soundName];
        if (!soundURL) {
            return;
        }
        const prepared = preparedSoundsRef.current.get(soundName);
        if (prepared) {
            playPreparedSound(prepared);
            return;
        }
        void prepareSound(soundName);
        const audio = soundName === soundNameRef.current && soundAudioRef.current
            ? soundAudioRef.current
            : new Audio(soundURL);
        audio.currentTime = 0;
        void audio.play().catch(() => undefined);
    }

    function updateGeneralSettings(patch: Partial<GeneralSettings>) {
        setGeneralSettings((current) => {
            if (!current) {
                return current;
            }
            return {
                ...current,
                ...patch,
            };
        });
    }

    function updateSoundSetting(soundName: string) {
        updateGeneralSettings({ soundName });
        playCompletionSound(soundName);
    }

    function normalizeAIPromptRule(rule: Partial<AIPromptRule> = {}): AIPromptRule {
        return {
            ...emptyPromptRule,
            ...rule,
            selectedTextPrompt: rule.selectedTextPrompt || '',
            noSelectionPrompt: rule.noSelectionPrompt || '',
        };
    }

    function normalizeAIPromptSettings(settings: any): AIPromptSettings {
        return {
            common: normalizeAIPromptRule(settings?.common),
            profiles: Array.isArray(settings?.profiles)
                ? settings.profiles.map((profile: any) => ({
                    ...normalizeAIPromptRule(profile),
                    id: profile.id || '',
                    appName: profile.appName || 'New App',
                    appBundleId: profile.appBundleId || '',
                    createdAt: profile.createdAt || '',
                    updatedAt: profile.updatedAt || '',
                }))
                : [],
        };
    }

    function normalizeAISettings(settings: any): AISettings {
        return {
            enabled: !!settings?.enabled,
            provider: settings?.provider || 'openai',
            endpoint: settings?.endpoint || 'http://localhost:1234',
            model: settings?.model || '',
            apiKey: settings?.apiKey || '',
            temperature: Number(settings?.temperature ?? 0),
            hotkey: settings?.hotkey || '',
            useSelectedText: settings?.useSelectedText ?? true,
            useSelectedFile: !!settings?.useSelectedFile,
            replaceSelectedText: settings?.replaceSelectedText ?? true,
            historyEnabled: !!settings?.historyEnabled,
            historyCount: Math.min(100, Math.max(1, Number(settings?.historyCount) || 10)),
            pasteReplacementBundleIds: Array.isArray(settings?.pasteReplacementBundleIds)
                ? settings.pasteReplacementBundleIds.filter((bundleId: unknown) => typeof bundleId === 'string')
                : (isMacOS ? ['com.apple.Terminal', 'com.apple.iWork.Keynote', 'com.apple.iWork.Pages', 'com.apple.iWork.Numbers'] : []),
            ttsEnabled: !!settings?.ttsEnabled,
            ttsEngine: settings?.ttsEngine || 'os',
            ttsEndpoint: settings?.ttsEndpoint || 'http://localhost:7788',
            ttsVoice: settings?.ttsVoice || 'M1',
            ttsOsVoice: settings?.ttsOsVoice || '',
            ttsUseAiResponse: !!settings?.ttsUseAiResponse,
            ttsUseShortcut: !!settings?.ttsUseShortcut,
            ttsShortcut: settings?.ttsShortcut || '',
            ttsShowAudioActions: settings?.ttsShowAudioActions ?? true,
            ttsSpeed: settings?.ttsSpeed || 1.05,
            ttsSteps: settings?.ttsSteps || 8,
        } as any;
    }

    function parseBundleIdList(value: string) {
        return Array.from(new Set(value
            .split(/[\n,]+/)
            .map((bundleId) => bundleId.trim())
            .filter(Boolean)));
    }

    function formatBundleIdList(bundleIds: string[] = []) {
        return bundleIds.join('\n');
    }

    async function saveAllSettings() {
        if (!generalSettings || !aiSettings) {
            return;
        }
        setSaveToast(null);
        if (hasDuplicateHotkeys(generalSettings, aiSettings)) {
            setError(t('hotkeyAlreadyAssigned'));
            return;
        }

        setSettingsSaving(true);
        setError('');
        try {
            const result = await SaveApplicationSettings(generalSettings, aiSettings);
            const normalizedGeneral = normalizeGeneralSettings(result.general);
            const normalizedAI = normalizeAISettings(result.ai);
            savedGeneralSettingsRef.current = normalizedGeneral;
            savedAISettingsRef.current = normalizedAI;
            aiSettingsRef.current = normalizedAI;
            setGeneralSettings(normalizedGeneral);
            setAISettings(normalizedAI);
            showSaveToast(createTranslator(normalizeLanguage(normalizedGeneral.language))('settingsSaved'));
        } catch (err) {
            setError(String(err));
        } finally {
            setSettingsSaving(false);
        }
    }

    function cancelSettingsChanges() {
        if (savedGeneralSettingsRef.current) {
            setGeneralSettings(normalizeGeneralSettings(savedGeneralSettingsRef.current));
        }
        if (savedAISettingsRef.current) {
            const normalized = normalizeAISettings(savedAISettingsRef.current);
            aiSettingsRef.current = normalized;
            setAISettings(normalized);
        }
        setRecordingHotkey(false);
        setRecordingTtsHotkey(false);
        setRecordingFlowToggleHotkey(false);
        setError('');
    }

    async function backupSnippetsAndAIPrompts() {
        setSettingsTransfer('backup');
        setSettingsTransferNotice('');
        setError('');
        try {
            const completed = await BackupSnippetsAndAIPrompts(language);
            if (completed) {
                setSettingsTransferNotice(t('contentBackupComplete'));
            }
        } catch (err) {
            setError(String(err));
        } finally {
            setSettingsTransfer(null);
        }
    }

    async function importSnippetsAndAIPrompts() {
        setSettingsTransfer('import');
        setSettingsTransferNotice('');
        setError('');
        try {
            const completed = await ImportSnippetsAndAIPrompts(language);
            if (!completed) {
                return;
            }
            const nextPromptSettings = await GetAIPromptSettings();
            setAIPromptSettings(normalizeAIPromptSettings(nextPromptSettings));
            setSelectedPromptID('common');
            setQuery('');
            setSelectedLabelID(0);
            setSelectedID(null);
            setDetailMode('all');
            await refresh('', 0);
            setSettingsTransferNotice(t('contentImportComplete'));
        } catch (err) {
            setError(String(err));
        } finally {
            setSettingsTransfer(null);
        }
    }

    function updateAITTSSettings(patch: Partial<AISettings>) {
        setAISettings((currentSettings) => {
            if (!currentSettings) {
                return currentSettings;
            }
            const nextSettings = {
                ...currentSettings,
                ...patch,
            };
            aiSettingsRef.current = nextSettings;
            return nextSettings;
        });
    }

    async function testTTSPlayback() {
        const currentSettings = aiSettings;
        if (!currentSettings) {
            return;
        }
        setError('');
        try {
            await TestSpeak("Hello! 안녕하세요. DKST Text Flow TTS 테스트입니다.", currentSettings);
        } catch (err) {
            setError(String(err));
            alert(err);
        }
    }

    async function saveCommonPromptRule() {
        if (!aiPromptSettings) {
            return;
        }
        setSaveToast(null);
        setPromptSaving(true);
        setError('');
        try {
            const saved = await SaveCommonAIPromptRule(aiPromptSettings.common);
            setAIPromptSettings(normalizeAIPromptSettings(saved));
            showSaveToast(t('aiPromptSaved'));
        } catch (err) {
            setError(String(err));
        } finally {
            setPromptSaving(false);
        }
    }

    function openAppPicker(target: AppPickerTarget) {
        setError('');
        setAppPickerTarget(target);
        setAppPickerStage('method');
        setRunningApps([]);
        setSelectedRunningAppBundleID('');
        setRunningAppsLoading(false);
    }

    function closeAppPicker() {
        setAppPickerTarget(null);
        setAppPickerStage('method');
        setRunningApps([]);
        setSelectedRunningAppBundleID('');
        setRunningAppsLoading(false);
    }

    async function refreshAIModels() {
        if (!aiSettings || aiSettings.provider === 'apple_intelligence') {
            return;
        }
        setAIModelsLoading(true);
        setAIModelsError('');
        try {
            const models = await ListAIModels(
                aiSettings.provider,
                aiSettings.endpoint,
                aiSettings.apiKey,
            );
            setAvailableAIModels((models || []) as AIModelInfo[]);
        } catch (err) {
            setAvailableAIModels([]);
            const message = String(err || '').replace(/^RuntimeError:\s*/i, '').trim();
            setAIModelsError(message || t('modelListFailed'));
        } finally {
            setAIModelsLoading(false);
        }
    }

    function openModelPicker() {
        setModelPickerOpen(true);
        setAvailableAIModels([]);
        setAIModelsError('');
        setUnmountingModelInstanceID('');
        void refreshAIModels();
    }

    function closeModelPicker() {
        if (unmountingModelInstanceID) {
            return;
        }
        setModelPickerOpen(false);
        setAIModelsError('');
    }

    function selectAIModel(model: AIModelInfo) {
        if (!aiSettings) {
            return;
        }
        setAISettings({ ...aiSettings, model: model.id });
        closeModelPicker();
    }

    async function unmountAIModel(model: AIModelInfo) {
        if (!aiSettings || !model.instanceId || unmountingModelInstanceID) {
            return;
        }
        setUnmountingModelInstanceID(model.instanceId);
        setAIModelsError('');
        try {
            await UnloadAIModel(
                aiSettings.provider,
                aiSettings.endpoint,
                aiSettings.apiKey,
                model.instanceId,
            );
            showSaveToast(t('modelUnmounted'));
            await refreshAIModels();
        } catch (err) {
            const message = String(err || '').replace(/^RuntimeError:\s*/i, '').trim();
            setAIModelsError(message || t('modelListFailed'));
        } finally {
            setUnmountingModelInstanceID('');
        }
    }

    async function createPromptProfile(appInfo: AppInfo) {
        setPromptSaving(true);
        setError('');
        try {
            const saved = await CreateAIPromptProfile({
                appName: appInfo.name || 'New App',
                appBundleId: appInfo.bundleId || '',
                ...emptyPromptRule,
            });
            const normalized = normalizeAIPromptSettings(saved);
            setAIPromptSettings(normalized);
            setSelectedPromptID((normalized.profiles || [])[(normalized.profiles || []).length - 1]?.id || 'common');
        } catch (err) {
            setError(String(err));
        } finally {
            setPromptSaving(false);
        }
    }

    async function applyPickedApp(target: AppPickerTarget, appInfo: AppInfo) {
        if (!appInfo?.bundleId && !appInfo?.name) {
            return;
        }
        closeAppPicker();
        if (target.kind === 'create') {
            await createPromptProfile(appInfo);
            return;
        }
        const profile = (aiPromptSettings?.profiles || []).find((item) => item.id === target.profileID);
        if (!profile) {
            return;
        }
        updatePromptProfile(profile.id, {
            appName: appInfo.name || profile.appName,
            appBundleId: appInfo.bundleId || profile.appBundleId,
        });
    }

    async function showRunningAppPicker() {
        setAppPickerStage('running');
        setRunningAppsLoading(true);
        setSelectedRunningAppBundleID('');
        setError('');
        try {
            const apps = await ListRunningApps();
            setRunningApps(apps || []);
        } catch (err) {
            setRunningApps([]);
            setError(String(err));
        } finally {
            setRunningAppsLoading(false);
        }
    }

    async function chooseDirectApp() {
        const target = appPickerTarget;
        if (!target) {
            return;
        }
        closeAppPicker();
        setError('');
        try {
            const appInfo = await BrowseAIPromptApp();
            if (!appInfo?.bundleId && !appInfo?.name) {
                return;
            }
            await applyPickedApp(target, appInfo);
        } catch (err) {
            setError(String(err));
        }
    }

    async function chooseSelectedRunningApp(appInfo?: AppInfo) {
        const target = appPickerTarget;
        const selected = appInfo || runningApps.find((app) => app.bundleId === selectedRunningAppBundleID);
        if (!target || !selected) {
            return;
        }
        await applyPickedApp(target, selected);
    }

    async function savePromptProfile(profile: AIPromptProfile) {
        setSaveToast(null);
        setPromptSaving(true);
        setError('');
        try {
            const saved = await UpdateAIPromptProfile(profile.id, {
                appName: profile.appName,
                appBundleId: profile.appBundleId,
                useSelectedText: profile.useSelectedText,
                runWithoutSelection: profile.runWithoutSelection,
                selectedTextPrompt: profile.selectedTextPrompt,
                noSelectionPrompt: profile.noSelectionPrompt,
            });
            setAIPromptSettings(normalizeAIPromptSettings(saved));
            showSaveToast(t('aiPromptSaved'));
        } catch (err) {
            setError(String(err));
        } finally {
            setPromptSaving(false);
        }
    }

    async function deletePromptProfile(profile: AIPromptProfile) {
        setPromptSaving(true);
        setError('');
        try {
            const saved = await DeleteAIPromptProfile(profile.id);
            setAIPromptSettings(normalizeAIPromptSettings(saved));
            setSelectedPromptID('common');
        } catch (err) {
            setError(String(err));
        } finally {
            setPromptSaving(false);
        }
    }

    async function browsePasteReplacementApp() {
        if (!aiSettings) {
            return;
        }
        setError('');
        try {
            const appInfo = await BrowseAIPromptApp();
            if (!appInfo?.bundleId) {
                return;
            }
            setAISettings({
                ...aiSettings,
                pasteReplacementBundleIds: parseBundleIdList([
                    ...(aiSettings.pasteReplacementBundleIds || []),
                    appInfo.bundleId,
                ].join('\n')),
            });
        } catch (err) {
            setError(String(err));
        }
    }

    function updateCommonPromptRule(patch: Partial<AIPromptRule>) {
        if (!aiPromptSettings) {
            return;
        }
        setAIPromptSettings({
            ...aiPromptSettings,
            common: { ...aiPromptSettings.common, ...patch },
        });
    }

    function updatePromptProfile(profileID: string, patch: Partial<AIPromptProfile>) {
        if (!aiPromptSettings) {
            return;
        }
        setAIPromptSettings({
            ...aiPromptSettings,
            profiles: (aiPromptSettings.profiles || []).map((profile) => (
                profile.id === profileID ? { ...profile, ...patch } : profile
            )),
        });
    }

    async function removeSnippet(snippet: Snippet) {
        const snippetLabel = snippet.title.trim() || snippet.shortcut;
        try {
            const confirmed = await ConfirmSnippetDeletion(snippetLabel);
            if (!confirmed) {
                return;
            }
            await DeleteSnippet(snippet.id);
            if (selectedID === snippet.id) {
                setSelectedID(null);
            }
            await refresh();
        } catch (err) {
            setError(String(err));
        }
    }

    function resizeAIPrompt() {
        const textarea = aiPromptRef.current;
        if (!textarea) {
            return;
        }
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 118)}px`;
        window.requestAnimationFrame(resizeAIHUD);
    }

    async function focusAIPromptInput(generation: number, attempt = 0) {
        if (generation !== aiFocusGenerationRef.current) {
            return;
        }
        try {
            await Window.Focus();
        } catch {
            // The DOM focus retry below still handles an already-active window.
        }
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (generation !== aiFocusGenerationRef.current) {
            return;
        }
        const textarea = aiPromptRef.current;
        textarea?.focus({ preventScroll: true });
        if (textarea && document.activeElement === textarea) {
            return;
        }
        if (attempt < 5) {
            window.setTimeout(() => focusAIPromptInput(generation, attempt + 1), 50 * (attempt + 1));
        }
    }

    function resizeAIHUD() {
        if (windowMode !== 'hud' || !hasBeenInvoked) {
            return;
        }
        if (aiHUDMeasureFrameRef.current !== null) {
            window.cancelAnimationFrame(aiHUDMeasureFrameRef.current);
        }
        aiHUDMeasureFrameRef.current = window.requestAnimationFrame(() => {
            aiHUDMeasureFrameRef.current = null;
            const hud = document.querySelector<HTMLElement>('.ai-hud');
            const workspace = document.querySelector<HTMLElement>('.hud-shell .workspace');
            if (!hud || !workspace) {
                return;
            }
            const workspaceStyle = window.getComputedStyle(workspace);
            const verticalPadding =
                Number.parseFloat(workspaceStyle.paddingTop) +
                Number.parseFloat(workspaceStyle.paddingBottom);
            const nextHeight = Math.max(
                aiHUDCollapsedHeight,
                Math.min(aiHUDMaxHeight, Math.ceil(hud.scrollHeight + verticalPadding + 2)),
            );
            if (nextHeight === aiHUDHeightRef.current) {
                return;
            }
            aiHUDHeightRef.current = nextHeight;
            const growUp = aiHUDGrowUpRef.current;
            aiHUDGrowUpRef.current = false;
            const resize = isOCRHUD ? ResizeOCRWindow : ResizeAIPromptWindow;
            resize(nextHeight, growUp).catch((err) => setError(String(err)));
        });
    }

    function updateAIPrompt(value: string) {
        setAIPrompt(value);
        window.requestAnimationFrame(resizeAIPrompt);
    }

    async function captureScreenshot() {
        if (aiScreenshotCapturing || aiRunning) {
            return;
        }
        setAIScreenshotCapturing(true);
        setError('');
        try {
            await BeginScreenRegionCapture();
        } catch (err) {
            setAIScreenshotCapturing(false);
            setError(localizedAIError(err, t('screenCaptureFailed')));
        }
    }

    function removeScreenshot() {
        // Match screenshot expansion: keep the HUD's bottom edge fixed while it collapses.
        aiHUDGrowUpRef.current = true;
        setAIScreenshot(null);
    }

    async function stopAIRequest() {
        aiRequestGenerationRef.current += 1;
        aiRequestRunningRef.current = false;
        setAIRunning(false);
        try {
            await CancelAIRequest();
        } catch (err) {
            setError(String(err));
        }
    }

    function waits(ms: number) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    function aiResponseText() {
        return isOCRHUD ? ocrText : (aiReplacement || aiResult);
    }

    function localizedOCRError(err: unknown) {
        const message = String(err || '').replace(/^RuntimeError:\s*/i, '').trim();
        if (message.toLowerCase().includes('did not recognize any text')) {
            return t('ocrNoTextRecognized');
        }
        if (message.toLowerCase().includes('does not support')) {
            return t('ocrLanguageUnsupported');
        }
        return message || t('ocrRecognitionFailed');
    }

    function speakHUDText(text: string, settings: AISettings | null, automatic = true) {
        if (!text || !settings?.ttsEnabled || (automatic && !settings?.ttsUseAiResponse)) {
            return Promise.resolve();
        }
        const ttsGeneration = aiTTSGenerationRef.current + 1;
        aiTTSGenerationRef.current = ttsGeneration;
        setAITTSSynthesizing(true);
        return Speak(text)
            .then(() => {
                if (
                    ttsGeneration === aiTTSGenerationRef.current &&
                    settings.ttsEngine === 'supertonic3'
                ) {
                    setAITTSAudioReady(true);
                }
            })
            .catch((err) => {
                if (ttsGeneration === aiTTSGenerationRef.current) {
                    setError(String(err));
                }
            })
            .finally(() => {
                if (ttsGeneration === aiTTSGenerationRef.current) {
                    setAITTSSynthesizing(false);
                }
            });
    }

    function localizedAIError(err: unknown, fallback?: string) {
        const message = String(err || '').replace(/^RuntimeError:\s*/i, '').trim();
        const knownErrors: Array<[string, string]> = [
            ['Apple Intelligence does not support screenshot input', t('appleIntelligenceScreenshotUnsupported')],
            ['Apple Intelligence client is required', t('appleIntelligenceClientRequiredError')],
            ['AI assistant is disabled', t('aiAssistantDisabledError')],
            ['AI instruction is required', t('aiInstructionRequiredError')],
            ['screen capture is already active', t('screenCaptureAlreadyActive')],
            ['no displays are available for screen capture', t('screenCaptureNoDisplays')],
            ['screen capture region is empty', t('screenCaptureEmptyRegion')],
            ['screen capture is not active', t('screenCaptureInactive')],
            ['the selected display is no longer available', t('screenCaptureDisplayUnavailable')],
            ['screen region capture is not supported on this platform', t('screenCaptureUnsupported')],
        ];
        const localized = knownErrors.find(([source]) => message.toLowerCase().includes(source.toLowerCase()));
        return localized?.[1] || message || fallback || t('screenCaptureFailed');
    }

    async function insertAIResponse() {
        const response = aiResponseText();
        const sourceProcessID = aiContext.sourceProcessId;
        if (
            !response ||
            sourceProcessID <= 0 ||
            aiResponseAction === 'inserting' ||
            aiInsertionInFlightRef.current
        ) {
            return;
        }
        aiInsertionInFlightRef.current = true;
        setAIResponseAction('inserting');
        try {
            await hideCurrentWindow(false);
            await waits(80);
            await ReplaceSelectedText(sourceProcessID, response);
            playCompletionSound();
        } catch (err) {
            setAIResponseAction('idle');
            setError(String(err));
        } finally {
            aiInsertionInFlightRef.current = false;
        }
    }

    async function insertOCRText() {
        const response = ocrText;
        const targetProcessID = aiContext.sourceProcessId;
        if (
            !response ||
            targetProcessID <= 0 ||
            aiResponseAction === 'inserting' ||
            aiInsertionInFlightRef.current
        ) {
            return;
        }
        aiInsertionInFlightRef.current = true;
        setAIResponseAction('inserting');
        try {
            await hideCurrentWindow(false);
            await waits(100);
            await InsertOCRTextAtCursor(targetProcessID, response);
            playCompletionSound();
        } catch (err) {
            setAIResponseAction('idle');
            setError(String(err));
        } finally {
            aiInsertionInFlightRef.current = false;
        }
    }

    async function copyAIResponse() {
        const response = aiResponseText();
        if (!response || aiResponseAction === 'copying') {
            return;
        }
        setAIResponseAction('copying');
        try {
            await Clipboard.SetText(response);
            setAIResponseAction('copied');
            if (aiResponseActionTimerRef.current !== null) {
                window.clearTimeout(aiResponseActionTimerRef.current);
            }
            aiResponseActionTimerRef.current = window.setTimeout(() => {
                setAIResponseAction('idle');
                aiResponseActionTimerRef.current = null;
            }, 1400);
        } catch (err) {
            setAIResponseAction('idle');
            setError(String(err));
        }
    }

    async function playAITTSAudio() {
        if (aiTTSAudioAction === 'replaying' || aiTTSAudioAction === 'saving') {
            return;
        }
        setAITTSAudioAction('replaying');
        setError('');
        let ttsGeneration = aiTTSGenerationRef.current;
        try {
            if (aiTTSAudioReady) {
                await ReplayLastTTSAudio();
            } else {
                const speech = speakHUDText(aiResponseText(), aiSettings, false);
                ttsGeneration = aiTTSGenerationRef.current;
                await speech;
            }
        } catch (err) {
            if (ttsGeneration === aiTTSGenerationRef.current) {
                setError(String(err));
            }
        } finally {
            if (ttsGeneration === aiTTSGenerationRef.current) {
                setAITTSAudioAction('idle');
            }
        }
    }

    async function saveAITTSAudio() {
        if (!aiTTSAudioReady || aiTTSAudioAction === 'replaying' || aiTTSAudioAction === 'saving') {
            return;
        }
        const ttsGeneration = aiTTSGenerationRef.current;
        setAITTSAudioAction('saving');
        setError('');
        try {
            const saved = await SaveLastTTSAudio(language);
            if (ttsGeneration !== aiTTSGenerationRef.current) {
                return;
            }
            setAITTSAudioAction(saved ? 'saved' : 'idle');
            if (saved) {
                if (aiTTSAudioActionTimerRef.current !== null) {
                    window.clearTimeout(aiTTSAudioActionTimerRef.current);
                }
                aiTTSAudioActionTimerRef.current = window.setTimeout(() => {
                    setAITTSAudioAction('idle');
                    aiTTSAudioActionTimerRef.current = null;
                }, 1400);
            }
        } catch (err) {
            if (ttsGeneration === aiTTSGenerationRef.current) {
                setAITTSAudioAction('idle');
                setError(String(err));
            }
        }
    }

    async function runAIPrompt() {
        const screenshot = aiScreenshot;
        const instruction = aiPrompt.trim() || (screenshot ? t('describeScreenshotInstruction') : '');
        if (!instruction || aiRequestRunningRef.current) {
            return;
        }
        const requestGeneration = aiRequestGenerationRef.current + 1;
        aiRequestGenerationRef.current = requestGeneration;
        aiRequestRunningRef.current = true;
        const requestContext = { ...aiContext };
        let requestSettings = aiSettings;
        setAIRunning(true);
        setAIResponseAction('idle');
        aiTTSGenerationRef.current += 1;
        setAITTSSynthesizing(false);
        setAITTSAudioReady(false);
        setAITTSAudioAction('idle');
        setError('');
        setAIResult('');
        setAIReplacement('');
        try {
            requestSettings = normalizeAISettings(await GetAISettings());
            setAISettings(requestSettings);
            StopSpeaking().catch(() => {});

            const hasSelectedText = requestContext.kind === 'selected_text' &&
                !!requestContext.text.trim() &&
                requestContext.sourceProcessId > 0;
            const preferPasteReplacement = hasSelectedText &&
                !!requestContext.appBundleId &&
                (requestSettings.pasteReplacementBundleIds || []).includes(requestContext.appBundleId);
            let isEditableTarget = requestContext.isEditable === true || preferPasteReplacement;
            if (hasSelectedText && !isEditableTarget) {
                try {
                    isEditableTarget = await IsFocusedElementEditable(requestContext.sourceProcessId);
                } catch {
                    // Keep the invocation-time result when a live recheck is unavailable.
                }
            }

            const result = await RunAIAssist({
                instruction,
                contextKind: (requestContext.kind || 'none') as any,
                contextText: requestContext.text || '',
                filePath: '',
                appName: requestContext.appName || '',
                appBundleId: requestContext.appBundleId || '',
                customPrompt: '',
                // Selected-text requests still need edit-vs-answer classification when
                // platform accessibility cannot prove that the source is editable.
                canReplace: hasSelectedText,
                imageDataUrl: screenshot?.dataUrl || '',
            });
            if (requestGeneration !== aiRequestGenerationRef.current) {
                return;
            }
            const isEdit = result.intent === 'edit' && !!result.replacement;
            const forceReplacement = result.forceReplace === true;
            if (
                requestSettings?.replaceSelectedText &&
                hasSelectedText &&
                isEdit &&
                (isEditableTarget || forceReplacement)
            ) {
                const prepareBeforeReplacement = preferPasteReplacement || forceReplacement;
                if (prepareBeforeReplacement) {
                    await hideCurrentWindow(false);
                    await ActivateProcess(requestContext.sourceProcessId);
                    await waits(180);
                }
                await ReplaceSelectedText(requestContext.sourceProcessId, result.replacement);
                playCompletionSound();
                if (!prepareBeforeReplacement) {
                    await hideCurrentWindow(false);
                    await ActivateProcess(requestContext.sourceProcessId);
                }
                return;
            }
            setAIResult(isEdit ? '' : (result.supportReport || ''));
            setAIReplacement(isEdit ? result.replacement : '');

            const textToSpeak = isEdit ? result.replacement : (result.supportReport || '');
            speakHUDText(textToSpeak, requestSettings);
        } catch (err) {
            if (requestGeneration === aiRequestGenerationRef.current) {
                setError(localizedAIError(err));
            }
        } finally {
            if (requestGeneration === aiRequestGenerationRef.current) {
                aiRequestRunningRef.current = false;
                setAIRunning(false);
            }
        }
    }

    async function submitAIPrompt(event: FormEvent) {
        event.preventDefault();
        await runAIPrompt();
    }

    function handleAIPromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }
        event.preventDefault();
        if (aiRunning) {
            stopAIRequest();
            return;
        }
        runAIPrompt();
    }

    function hotkeyIsUsedByAnother(nextHotkey: string, field: 'flow' | 'pinShot' | 'ocr' | 'prompt' | 'tts') {
        if (!generalSettings || !aiSettings) {
            return false;
        }
        const candidate = normalizedHotkey(nextHotkey);
        const assigned = {
            flow: generalSettings.flowToggleHotkey,
            pinShot: generalSettings.pinShotHotkey,
            ocr: generalSettings.ocrHotkey,
            prompt: aiSettings.hotkey,
            tts: aiSettings.ttsShortcut,
        };
        return Object.entries(assigned).some(([name, value]) =>
            name !== field && normalizedHotkey(value || '') === candidate,
        );
    }

    function captureHotkey(event: KeyboardEvent<HTMLButtonElement>) {
        if (!recordingHotkey || !aiSettings) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape') {
            setRecordingHotkey(false);
            return;
        }

        const nextHotkey = formatCapturedHotkey(event);
        if (!nextHotkey) {
            return;
        }
        if (hotkeyIsUsedByAnother(nextHotkey, 'prompt')) {
            setError(t('hotkeyAlreadyAssigned'));
            return;
        }
        setError('');
        setAISettings({ ...aiSettings, hotkey: nextHotkey });
        setRecordingHotkey(false);
    }

    function captureFlowToggleHotkey(event: KeyboardEvent<HTMLButtonElement>) {
        if (!recordingFlowToggleHotkey || !generalSettings) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape') {
            setRecordingFlowToggleHotkey(false);
            return;
        }

        const nextHotkey = formatCapturedHotkey(event);
        if (!nextHotkey) {
            return;
        }
        if (hotkeyIsUsedByAnother(nextHotkey, 'flow')) {
            setError(t('hotkeyAlreadyAssigned'));
            return;
        }
        setError('');
        updateGeneralSettings({ flowToggleHotkey: nextHotkey });
        setRecordingFlowToggleHotkey(false);
    }

    function captureOCRHotkey(event: KeyboardEvent<HTMLButtonElement>) {
        if (!recordingOCRHotkey || !generalSettings) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape') {
            setRecordingOCRHotkey(false);
            return;
        }

        const nextHotkey = formatCapturedHotkey(event);
        if (!nextHotkey) {
            return;
        }
        if (hotkeyIsUsedByAnother(nextHotkey, 'ocr')) {
            setError(t('hotkeyAlreadyAssigned'));
            return;
        }
        setError('');
        updateGeneralSettings({ ocrHotkey: nextHotkey });
        setRecordingOCRHotkey(false);
    }

    function capturePinShotHotkey(event: KeyboardEvent<HTMLButtonElement>) {
        if (!recordingPinShotHotkey || !generalSettings) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape') {
            setRecordingPinShotHotkey(false);
            return;
        }

        const nextHotkey = formatCapturedHotkey(event);
        if (!nextHotkey) {
            return;
        }
        if (hotkeyIsUsedByAnother(nextHotkey, 'pinShot')) {
            setError(t('hotkeyAlreadyAssigned'));
            return;
        }
        setError('');
        updateGeneralSettings({ pinShotHotkey: nextHotkey });
        setRecordingPinShotHotkey(false);
    }

    function captureTtsHotkey(event: KeyboardEvent<HTMLButtonElement>) {
        if (!recordingTtsHotkey || !aiSettings) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape') {
            setRecordingTtsHotkey(false);
            return;
        }

        const nextHotkey = formatCapturedHotkey(event);
        if (!nextHotkey) {
            return;
        }
        if (hotkeyIsUsedByAnother(nextHotkey, 'tts')) {
            setError(t('hotkeyAlreadyAssigned'));
            return;
        }
        setError('');
        setAISettings({
            ...aiSettings,
            ttsShortcut: nextHotkey,
        });
        setRecordingTtsHotkey(false);
    }

    const aiHUDPromptHint = aiContext.kind === 'selected_text'
        ? t('aiHudSelectedPlaceholder', { count: aiContext.text.length })
        : t('aiHudPlaceholder');

    return (
        <div className={`app-shell ${windowMode === 'hud' ? 'hud-shell' : ''}`}>
            {windowMode === 'main' && <aside className="sidebar">
                <div className="brand">
                    <img className="brand-mark" src={appIcon} alt="" />
                    <div>
                        <strong>DKST Text Flow</strong>
                        <span>{t('assistWithTextInput')}</span>
                    </div>
                </div>
                <nav className="nav">
                    <button className={activeView === 'snippets' ? 'active' : ''} onClick={() => setActiveView('snippets')}>
                        <span className="material-symbols-rounded" aria-hidden="true">snippet_folder</span>
                        <span>{t('snippets')}</span>
                    </button>
                    <button className={activeView === 'dashboard' ? 'active' : ''} onClick={() => setActiveView('dashboard')}>
                        <span className="material-symbols-rounded" aria-hidden="true">analytics</span>
                        <span>{t('dashboard')}</span>
                    </button>
                    <button className={activeView === 'aiPrompts' ? 'active' : ''} onClick={() => setActiveView('aiPrompts')}>
                        <span className="material-symbols-rounded" aria-hidden="true">chat_paste_go</span>
                        <span>{t('aiPrompt')}</span>
                    </button>
                    <button className={activeView === 'settings' ? 'active' : ''} onClick={() => setActiveView('settings')}>
                        <span className="material-symbols-rounded" aria-hidden="true">discover_tune</span>
                        <span>{t('settings')}</span>
                    </button>
                </nav>
                <div className="sidebar-bottom-actions">
                    <button className={`about-button ${activeView === 'about' ? 'active' : ''}`} type="button" onClick={() => setActiveView('about')}>
                        <span className="material-symbols-rounded" aria-hidden="true">info</span>
                        <span>{t('about')}</span>
                    </button>
                    <button className="quit-button" type="button" onClick={() => Application.Quit()}>
                        <span className="material-symbols-rounded" aria-hidden="true">power_settings_new</span>
                        <span>{t('quit')}</span>
                    </button>
                </div>
                <div className="status-tile">
                    <span className={platformStatus?.flowEngineRunning ? 'dot good' : 'dot idle'} />
                    <div>
                        <strong>{platformStatus?.flowEngineRunning ? t('flowActive') : t('flowPaused')}</strong>
                        <span>{flowStatusDetail(platformStatus, t)}</span>
                    </div>
                </div>
            </aside>}

            <main className="workspace">
                {windowMode === 'hud' ? (
                    isOCRHUD ? (
                        <section className="ai-hud ocr-hud">
                            <div className="ai-result hud-result ocr-hud-result">
                                <button
                                    className="ocr-hud-close"
                                    type="button"
                                    onClick={() => hideCurrentWindow()}
                                    aria-label={t('close')}
                                    title={t('close')}
                                >
                                    <span className="material-symbols-rounded" aria-hidden="true">close</span>
                                </button>
                                <div className="hud-result-content">
                                    {ocrLoading ? (
                                        <div className="ocr-loading-status" role="status" aria-live="polite">
                                            <span className="hud-tts-spinner" aria-hidden="true" />
                                            <span>{t('ocrModelLoading')}</span>
                                        </div>
                                    ) : (
                                        <pre>{ocrText || error || t('ocrNoTextRecognized')}</pre>
                                    )}
                                </div>
                                {!ocrLoading && <div className="hud-result-footer">
                                    {aiTTSSynthesizing && (
                                        <div className="hud-tts-status" role="status" aria-live="polite">
                                            <span className="hud-tts-spinner" aria-hidden="true" />
                                            <span>{t('ttsSynthesizing')}</span>
                                        </div>
                                    )}
                                    {!aiTTSSynthesizing &&
                                        aiSettings?.ttsEnabled &&
                                        aiSettings.ttsShowAudioActions !== false &&
                                        !!ocrText && (
                                        <div className="hud-result-actions hud-tts-actions" role="group" aria-label={t('audioActions')}>
                                            <button
                                                type="button"
                                                onClick={playAITTSAudio}
                                                disabled={aiTTSAudioAction === 'replaying' || aiTTSAudioAction === 'saving'}
                                                title={aiTTSAudioReady ? t('replayAudioTitle') : t('playAudioTitle')}
                                            >
                                                <span className="material-symbols-rounded" aria-hidden="true">
                                                    {aiTTSAudioReady ? 'replay' : 'volume_up'}
                                                </span>
                                                <span>{aiTTSAudioReady ? t('replayAudio') : t('playAudio')}</span>
                                            </button>
                                            {aiTTSAudioReady && <button
                                                type="button"
                                                onClick={saveAITTSAudio}
                                                disabled={aiTTSAudioAction === 'replaying' || aiTTSAudioAction === 'saving'}
                                                title={t('saveAudioTitle')}
                                            >
                                                <span className="material-symbols-rounded" aria-hidden="true">
                                                    {aiTTSAudioAction === 'saved' ? 'check' : 'download'}
                                                </span>
                                                <span>{aiTTSAudioAction === 'saved' ? t('audioSaved') : t('saveAudio')}</span>
                                            </button>}
                                        </div>
                                    )}
                                    {!!ocrText && (
                                        <div className="hud-result-actions" role="group" aria-label={t('responseActions')}>
                                            <button
                                                type="button"
                                                onClick={insertOCRText}
                                                disabled={aiContext.sourceProcessId <= 0 || aiResponseAction === 'inserting'}
                                                title={t('insertOCRText')}
                                            >
                                                <span className="material-symbols-rounded" aria-hidden="true">input</span>
                                                <span>{t('insert')}</span>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={copyAIResponse}
                                                disabled={aiResponseAction === 'copying'}
                                                title={t('copyOCRText')}
                                            >
                                                <span className="material-symbols-rounded" aria-hidden="true">
                                                    {aiResponseAction === 'copied' ? 'check' : 'content_copy'}
                                                </span>
                                                <span>{aiResponseAction === 'copied' ? t('copied') : t('copy')}</span>
                                            </button>
                                        </div>
                                    )}
                                </div>}
                            </div>
                        </section>
                    ) : (
                    <section className="ai-hud">
                        {aiScreenshot && (
                            <div className="hud-screenshot-preview">
                                <div
                                    className="hud-screenshot-image-wrap"
                                    style={{ aspectRatio: `${aiScreenshot.width} / ${aiScreenshot.height}` }}
                                >
                                    <img
                                        src={aiScreenshot.dataUrl}
                                        alt={t('attachedScreenshot')}
                                        draggable={false}
                                    />
                                </div>
                                <div className="hud-screenshot-meta">
                                    <span>
                                        {t('screenshotDimensions', {
                                            width: aiScreenshot.width,
                                            height: aiScreenshot.height,
                                        })}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={removeScreenshot}
                                        disabled={aiRunning}
                                        aria-label={t('removeScreenshot')}
                                        title={t('removeScreenshot')}
                                    >
                                        <span className="material-symbols-rounded" aria-hidden="true">delete</span>
                                    </button>
                                </div>
                            </div>
                        )}
                        <form
                            className={`ai-prompt-form hud-prompt-form ${aiRunning ? 'is-running' : ''} ${aiPrompt ? 'has-value' : ''}`}
                            data-hint={aiHUDPromptHint}
                            onSubmit={submitAIPrompt}
                        >
                            <textarea
                                {...textInputAssistanceDisabled}
                                ref={aiPromptRef}
                                autoFocus
                                value={aiPrompt}
                                onChange={(event) => updateAIPrompt(event.target.value)}
                                onKeyDown={handleAIPromptKeyDown}
                                aria-label={aiHUDPromptHint}
                                rows={1}
                            />
                            <button
                                className="hud-inline-send"
                                type={aiRunning ? 'button' : 'submit'}
                                disabled={!aiRunning && !aiPrompt.trim() && !aiScreenshot}
                                onClick={aiRunning ? stopAIRequest : undefined}
                                aria-label={aiRunning ? t('stop') : t('send')}
                                title={aiRunning ? t('stop') : t('send')}
                            >
                                <span className="material-symbols-rounded" aria-hidden="true">
                                    {aiRunning ? 'stop_circle' : 'arrow_circle_right'}
                                </span>
                            </button>
                            <button
                                className={`hud-inline-screenshot ${aiScreenshotCapturing ? 'is-capturing' : ''}`}
                                type="button"
                                onClick={captureScreenshot}
                                disabled={aiRunning || aiScreenshotCapturing}
                                aria-label={aiScreenshotCapturing ? t('capturingScreenshot') : t('captureScreenshot')}
                                title={aiScreenshotCapturing ? t('capturingScreenshot') : t('captureScreenshot')}
                            >
                                <span className="material-symbols-rounded" aria-hidden="true">screenshot_region</span>
                            </button>
                            <button
                                className="hud-inline-close"
                                type="button"
                                onClick={() => hideCurrentWindow()}
                                aria-label={t('close')}
                                title={t('close')}
                            >
                                <span className="material-symbols-rounded" aria-hidden="true">close</span>
                            </button>
                        </form>
                        {aiRunning && <AIProgressStatus elapsedMs={aiElapsedMs} t={t} />}
                        {(aiResult || aiReplacement) && (
                            <div className="ai-result hud-result">
                                <div className="hud-result-content">
                                    {aiResult && <p>{aiResult}</p>}
                                    {aiReplacement && <pre>{aiReplacement}</pre>}
                                </div>
                                <div className="hud-result-footer">
                                    {aiTTSSynthesizing && (
                                        <div className="hud-tts-status" role="status" aria-live="polite">
                                            <span className="hud-tts-spinner" aria-hidden="true" />
                                            <span>{t('ttsSynthesizing')}</span>
                                        </div>
                                    )}
                                    {!aiTTSSynthesizing &&
                                        aiSettings?.ttsEnabled &&
                                        aiSettings.ttsShowAudioActions !== false && (
                                        <div className="hud-result-actions hud-tts-actions" role="group" aria-label={t('audioActions')}>
                                            <button
                                                type="button"
                                                onClick={playAITTSAudio}
                                                disabled={aiTTSAudioAction === 'replaying' || aiTTSAudioAction === 'saving'}
                                                title={aiTTSAudioReady ? t('replayAudioTitle') : t('playAudioTitle')}
                                            >
                                                <span className="material-symbols-rounded" aria-hidden="true">
                                                    {aiTTSAudioReady ? 'replay' : 'volume_up'}
                                                </span>
                                                <span>{aiTTSAudioReady ? t('replayAudio') : t('playAudio')}</span>
                                            </button>
                                            {aiTTSAudioReady && <button
                                                type="button"
                                                onClick={saveAITTSAudio}
                                                disabled={aiTTSAudioAction === 'replaying' || aiTTSAudioAction === 'saving'}
                                                title={t('saveAudioTitle')}
                                            >
                                                <span className="material-symbols-rounded" aria-hidden="true">
                                                    {aiTTSAudioAction === 'saved' ? 'check' : 'download'}
                                                </span>
                                                <span>{aiTTSAudioAction === 'saved' ? t('audioSaved') : t('saveAudio')}</span>
                                            </button>}
                                        </div>
                                    )}
                                    <div className="hud-result-actions" role="group" aria-label={t('responseActions')}>
                                        <button
                                            type="button"
                                            onClick={insertAIResponse}
                                            disabled={aiContext.sourceProcessId <= 0 || aiResponseAction === 'inserting'}
                                            title={t('insertResponse')}
                                        >
                                            <span className="material-symbols-rounded" aria-hidden="true">input</span>
                                            <span>{t('insert')}</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={copyAIResponse}
                                            disabled={aiResponseAction === 'copying'}
                                            title={t('copyResponse')}
                                        >
                                            <span className="material-symbols-rounded" aria-hidden="true">
                                                {aiResponseAction === 'copied' ? 'check' : 'content_copy'}
                                            </span>
                                            <span>{aiResponseAction === 'copied' ? t('copied') : t('copy')}</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </section>
                    )
                ) : activeView === 'snippets' ? (
                    <section className="content-grid">
                        <div className="panel labels-panel">
                            <div className="panel-header compact-header">
                                <div>
                                    <h1>{t('labels')}</h1>
                                    <p>{t('groups')}</p>
                                </div>
                                <button className="primary-button icon-button" onClick={createLabel} aria-label={t('addLabel')} title={t('addLabel')}>
                                    <span className="material-symbols-rounded" aria-hidden="true">add</span>
                                </button>
                            </div>
                            <div className="label-list">
                                {[allLabel, ...labels].map((label) => (
                                    <button
                                        key={label.id}
                                        className={`label-row ${selectedLabelID === label.id ? 'selected' : ''}`}
                                        onClick={() => selectLabel(label.id)}
                                        onDragOver={(event) => event.preventDefault()}
                                        onDrop={(event) => {
                                            const snippetID = Number(event.dataTransfer.getData('text/plain'));
                                            if (snippetID > 0) {
                                                assignSnippetToLabel(snippetID, label.id);
                                            }
                                        }}
                                    >
                                        <span className="label-color" style={{ backgroundColor: label.color }} />
                                        <span className="label-copy">
                                            <strong>{label.name}</strong>
                                            <span>{label.id === 0 ? t('everySnippet') : (label.description || t('noDescription'))}</span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="panel list-panel">
                            <div className="panel-header">
                                <div>
                                    <h1>{t('snippetLibrary')}</h1>
                                    <p>{selectedLabelID === 0 ? t('allSnippetsPeriod') : t('labelSnippets', { label: selectedLabel?.name ?? t('labelFallback') })}</p>
                                </div>
                                <button className="primary-button icon-button" onClick={openCreateModal} aria-label={t('newSnippet')} title={t('newSnippet')}>
                                    <span className="material-symbols-rounded" aria-hidden="true">add</span>
                                </button>
                            </div>
                            <input
                                {...textInputAssistanceDisabled}
                                className="search-input"
                                value={query}
                                placeholder={t('searchSnippets')}
                                onChange={(event) => searchSnippets(event.target.value)}
                            />
                            <div className="snippet-list">
                                {snippets.map((snippet) => (
                                    <button
                                        key={snippet.id}
                                        className={`snippet-row ${selectedSnippet?.id === snippet.id ? 'selected' : ''}`}
                                        style={{ '--snippet-label-color': labels.find((label) => label.id === snippet.labelId)?.color ?? '#667386' } as CSSProperties}
                                        draggable
                                        onDragStart={(event) => event.dataTransfer.setData('text/plain', String(snippet.id))}
                                        onClick={() => {
                                            setSelectedID(snippet.id);
                                            setDetailMode('snippet');
                                        }}
                                        onDoubleClick={() => openEditModal(snippet)}
                                    >
                                        <span className="shortcut">{snippet.shortcut}</span>
                                        <span className="snippet-title">{snippet.title}</span>
                                        <span className={snippet.enabled ? 'state enabled' : 'state disabled'}>{snippet.enabled ? t('on') : t('off')}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="panel detail-panel">
                            {detailMode === 'label' && selectedLabel ? (
                                <>
                                    <div className="panel-header">
                                        <div>
                                            <h2>{selectedLabel.name}</h2>
                                            <p>{t('snippetsEnabledCount', { snippets: selectedLabel.snippetCount, enabled: selectedLabel.enabledCount })}</p>
                                        </div>
                                        <button className="danger icon-button" onClick={removeSelectedLabel} aria-label={t('deleteLabel')} title={t('deleteLabel')}>
                                            <span className="material-symbols-rounded" aria-hidden="true">delete_forever</span>
                                        </button>
                                        <div className="action-row">
                                            <button onClick={() => setCurrentLabelSnippetsEnabled(true)}>{t('enableAll')}</button>
                                            <button onClick={() => setCurrentLabelSnippetsEnabled(false)}>{t('disableAll')}</button>
                                        </div>
                                    </div>
                                    <div className="label-detail-form">
                                        <label>
                                            {t('name')}
                                            <input {...textInputAssistanceDisabled} value={labelForm.name} onChange={(event) => setLabelForm({ ...labelForm, name: event.target.value })} />
                                        </label>
                                        <label>
                                            {t('color')}
                                            <input type="color" value={labelForm.color} onChange={(event) => setLabelForm({ ...labelForm, color: event.target.value })} />
                                        </label>
                                        <label className="label-description-field">
                                            {t('description')}
                                            <textarea {...textInputAssistanceDisabled} value={labelForm.description} onChange={(event) => setLabelForm({ ...labelForm, description: event.target.value })} />
                                        </label>
                                    </div>
                                    <div className="modal-actions detail-actions">
                                        <button className="primary-button" onClick={saveSelectedLabel}>{t('saveLabel')}</button>
                                    </div>
                                </>
                            ) : detailMode === 'all' ? (
                                <>
                                    <div className="panel-header">
                                        <div>
                                            <h2>{t('allSnippets')}</h2>
                                            <p>{t('snippetsEnabledCount', { snippets: stats.snippetCount, enabled: stats.enabledCount })}</p>
                                        </div>
                                        <div className="action-row">
                                            <button onClick={() => setCurrentLabelSnippetsEnabled(true)}>{t('enableAll')}</button>
                                            <button onClick={() => setCurrentLabelSnippetsEnabled(false)}>{t('disableAll')}</button>
                                        </div>
                                    </div>
                                    <div className="empty-state">{t('selectLabelOrSnippet')}</div>
                                </>
                            ) : selectedSnippet ? (
                                <>
                                    <div className="panel-header">
                                        <div>
                                            <h2>{selectedSnippet.title}</h2>
                                            <p>{t('expandsAfter', { shortcut: selectedSnippet.shortcut, mode: t(selectedSnippet.expandMode === 'instant' ? 'instant' : 'delimiter') })}</p>
                                        </div>
                                        <button className="danger icon-button" onClick={() => removeSnippet(selectedSnippet)} aria-label={t('deleteSnippet')} title={t('deleteSnippet')}>
                                            <span className="material-symbols-rounded" aria-hidden="true">delete_forever</span>
                                        </button>
                                        <div className="action-row">
                                            <button onClick={() => toggleSnippet(selectedSnippet)}>{selectedSnippet.enabled ? t('disable') : t('enable')}</button>
                                            <button onClick={() => openEditModal(selectedSnippet)}>{t('edit')}</button>
                                        </div>
                                    </div>
                                    <pre className="snippet-preview">{selectedSnippet.content}</pre>
                                    <div className="meta-grid">
                                        <span>{t('label')}<strong>{labels.find((label) => label.id === selectedSnippet.labelId)?.name ?? t('all')}</strong></span>
                                        <span>{t('type')}<strong>{contentTypeLabel(selectedSnippet.contentType, t)}</strong></span>
                                        <span>{t('case')}<strong>{selectedSnippet.caseSensitive ? t('sensitive') : t('insensitive')}</strong></span>
                                        <span>{t('used')}<strong>{selectedSnippet.usageCount}</strong></span>
                                    </div>
                                </>
                            ) : (
                                <div className="empty-state">{t('createFirstSnippet')}</div>
                            )}
                        </div>
                    </section>
                ) : activeView === 'dashboard' ? (
                    <section className="panel dashboard-panel">
                        <div className="panel-header">
                            <div>
                                <h1>{t('dashboard')}</h1>
                                <p>{t('dashboardDescription')}</p>
                            </div>
                            <button onClick={() => refresh()}>{t('refresh')}</button>
                        </div>
                        <div className="dashboard">
                            <article>
                                <span>{t('totalExpansions')}</span>
                                <strong>{stats.totalExpansions}</strong>
                            </article>
                            <article>
                                <span>{t('today')}</span>
                                <strong>{stats.todayExpansions}</strong>
                            </article>
                            <article>
                                <span>{t('enabledSnippets')}</span>
                                <strong>{stats.enabledCount}/{stats.snippetCount}</strong>
                            </article>
                            <article>
                                <span>{t('todaysTyping')}</span>
                                <strong>{formatCount(stats.todayTypingCount)}</strong>
                            </article>
                            <article>
                                <span>{t('dailyAverage')}</span>
                                <strong>{formatCount(stats.averageDailyTyping)}</strong>
                            </article>
                        </div>
                        <TypingChart history={stats.typingHistory || []} enabled={generalSettings?.typingTrendEnabled !== false} t={t} />
                        <div className="top-list">
                            <h2>{t('topSnippets')}</h2>
                            {(stats.topSnippets || []).length === 0 ? (
                                <p>{t('noExpansionsYet')}</p>
                            ) : (stats.topSnippets || []).map((snippet) => (
                                <div key={snippet.id} className="top-row">
                                    <span className="shortcut">{snippet.shortcut}</span>
                                    <span className="top-title">{snippet.title}</span>
                                    <strong>{snippet.usageCount}</strong>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : activeView === 'aiPrompts' ? (
                    <section className="content-grid ai-prompt-grid">
                        <div className="panel list-panel">
                            <div className="panel-header">
                                <div>
                                    <h1>{t('aiPrompt')}</h1>
                                    <p>{t('aiPromptDescription')}</p>
                                </div>
                                <button className="primary-button icon-button" onClick={() => openAppPicker({ kind: 'create' })} disabled={promptSaving} aria-label={t('addAIPrompt')} title={t('addAIPrompt')}>
                                    <span className="material-symbols-rounded" aria-hidden="true">add</span>
                                </button>
                            </div>
                            <div className="snippet-list">
                                <button
                                    className={`snippet-row prompt-row ${selectedPromptID === 'common' ? 'selected' : ''}`}
                                    onClick={() => setSelectedPromptID('common')}
                                >
                                    <span className="shortcut">{t('common')}</span>
                                    <span className="snippet-title">{t('defaultBehavior')}</span>
                                    <span className="state enabled">{t('base')}</span>
                                </button>
                                {(aiPromptSettings?.profiles || []).map((profile) => (
                                    <button
                                        key={profile.id}
                                        className={`snippet-row prompt-row ${selectedPromptID === profile.id ? 'selected' : ''}`}
                                        onClick={() => setSelectedPromptID(profile.id)}
                                    >
                                        <span className="shortcut">{profile.appName}</span>
                                        <span className="snippet-title">{profile.appBundleId || t('noBundleId')}</span>
                                        <span className="state enabled">{t('app')}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="panel detail-panel prompt-detail-panel">
                            {selectedPromptID === 'common' ? (
                                aiPromptSettings && (
                                    <>
                                        <div className="panel-header">
                                            <div>
                                                <h2>{t('common')}</h2>
                                                <p>{t('commonPromptDescription')}</p>
                                            </div>
                                            <button className="primary-button" onClick={saveCommonPromptRule} disabled={promptSaving}>
                                                {promptSaving ? t('saving') : t('save')}
                                            </button>
                                        </div>
                                        <PromptRuleEditor rule={aiPromptSettings.common} onChange={updateCommonPromptRule} t={t} />
                                    </>
                                )
                            ) : (
                                (() => {
                                    const profile = (aiPromptSettings?.profiles || []).find((item) => item.id === selectedPromptID);
                                    if (!profile) {
                                        return <div className="empty-state">{t('chooseAIPromptProfile')}</div>;
                                    }
                                    return (
                                        <>
                                            <div className="panel-header">
                                                <div>
                                                    <h2>{profile.appName}</h2>
                                                    <p>{profile.appBundleId || t('bundleIdNotSet')}</p>
                                                </div>
                                                <div className="action-row">
                                                    <button onClick={() => savePromptProfile(profile)} disabled={promptSaving}>{t('save')}</button>
                                                    <button className="danger icon-button" onClick={() => deletePromptProfile(profile)} disabled={promptSaving} aria-label={t('deleteSnippet')} title={t('deleteSnippet')}>
                                                        <span className="material-symbols-rounded" aria-hidden="true">delete_forever</span>
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="prompt-app-fields">
                                                <label>
                                                    {t('appName')}
                                                    <input {...textInputAssistanceDisabled} value={profile.appName} onChange={(event) => updatePromptProfile(profile.id, { appName: event.target.value })} />
                                                </label>
                                                <label>
                                                    {t('bundleId')}
                                                    <input {...textInputAssistanceDisabled} value={profile.appBundleId} onChange={(event) => updatePromptProfile(profile.id, { appBundleId: event.target.value })} placeholder="com.apple.Terminal" />
                                                </label>
                                                <button type="button" onClick={() => openAppPicker({ kind: 'profile', profileID: profile.id })}>{t('change')}</button>
                                            </div>
                                            <PromptRuleEditor rule={profile} onChange={(patch) => updatePromptProfile(profile.id, patch)} t={t} />
                                        </>
                                    );
                                })()
                            )}
                        </div>
                    </section>
                ) : activeView === 'ai' ? (
                    <section className="panel ai-panel">
                        <div className="panel-header">
                            <div>
                                <h1>{t('aiAssistant')}</h1>
                                <p>{aiContext.kind === 'selected_text' ? t('aiPanelSelectedDescription') : t('aiPanelDefaultDescription')}</p>
                            </div>
                            <button onClick={() => setActiveView('settings')}>{t('settings')}</button>
                        </div>
                        <div className={`ai-context ${aiContext.kind !== 'none' ? 'active' : ''}`}>
                            <strong>
                                {aiContext.kind === 'selected_text'
                                    ? t('selectedText')
                                    : (aiContext.label && aiContext.label !== 'No Context' ? aiContext.label : t('noContext'))}
                            </strong>
                            <span>
                                {aiContext.kind === 'selected_text'
                                    ? t('charactersCaptured', { count: aiContext.text.length })
                                    : t('noSelectedTextCaptured')}
                            </span>
                        </div>
                        <form className="ai-prompt-form" onSubmit={submitAIPrompt}>
                            <textarea
                                {...textInputAssistanceDisabled}
                                ref={aiPromptRef}
                                value={aiPrompt}
                                onChange={(event) => updateAIPrompt(event.target.value)}
                                onKeyDown={handleAIPromptKeyDown}
                                placeholder={aiContext.kind === 'selected_text' ? t('aiSelectedPlaceholder') : t('aiPlaceholder')}
                                rows={1}
                            />
                            <div className="prompt-actions">
                                <button
                                    className="primary-button"
                                    type={aiRunning ? 'button' : 'submit'}
                                    disabled={!aiRunning && !aiPrompt.trim()}
                                    onClick={aiRunning ? stopAIRequest : undefined}
                                >
                                    {aiRunning && <span className="button-spinner" />}
                                    {aiRunning ? t('stop') : t('send')}
                                </button>
                            </div>
                        </form>
                        {aiRunning && <AIProgressStatus elapsedMs={aiElapsedMs} t={t} />}
                        {(aiResult || aiReplacement) && (
                            <div className="ai-result">
                                {aiResult && <p>{aiResult}</p>}
                                {aiReplacement && <pre>{aiReplacement}</pre>}
                            </div>
                        )}
                    </section>
                ) : activeView === 'about' ? (
                    <section className="panel about-panel">
                        {aboutLoading ? (
                            <div className="empty-state">{t('loadingAbout')}</div>
                        ) : aboutError ? (
                            <div className="empty-state">{aboutError}</div>
                        ) : (
                            <ReactMarkdown
                                className="markdown-body"
                                remarkPlugins={[remarkGfm]}
                                rehypePlugins={[rehypeRaw]}
                                components={aboutMarkdownComponents}
                            >
                                {aboutMarkdown}
                            </ReactMarkdown>
                        )}
                    </section>
                ) : (
                    <section className="panel settings-panel">
                        <div className="panel-header">
                            <div>
                                <h1>{t('settings')}</h1>
                                <p>{t('settingsDescription')}</p>
                            </div>
                            {isMacOS && <div className="action-row">
                                <button onClick={refreshPlatformStatus}>{t('refresh')}</button>
                                <button
                                    className={
                                        platformStatus?.accessibilityTrusted && platformStatus?.screenRecordingGranted
                                            ? undefined
                                            : 'primary-button'
                                    }
                                    onClick={() => setIsPermissionModalOpen(true)}
                                >
                                    {t('requestPermission')}
                                </button>
                            </div>}
                        </div>
                        <div className="settings-list platform-status-list">
                            {!isMacOS && (
                                <>
                                    <div className="settings-status-card settings-status-placeholder" aria-hidden="true" />
                                    <div className="settings-status-card settings-status-placeholder" aria-hidden="true" />
                                </>
                            )}
                            {isMacOS && (
                                <div className={`settings-status-card ${platformStatus?.accessibilityTrusted ? 'success' : 'danger'}`}>
                                    <span className="settings-status-label">
                                        <span className="material-symbols-rounded settings-role-icon" aria-hidden="true">keyboard_keys</span>
                                        <span className="settings-status-label-text">{t('accessibilityPermission')}</span>
                                    </span>
                                    <span
                                        className="material-symbols-rounded settings-state-icon"
                                        role="img"
                                        aria-label={platformStatus?.accessibilityTrusted ? t('granted') : t('permissionMissing')}
                                        title={platformStatus?.accessibilityTrusted ? t('granted') : t('permissionMissing')}
                                    >
                                        {platformStatus?.accessibilityTrusted ? 'verified' : 'do_not_touch'}
                                    </span>
                                </div>
                            )}
                            {isMacOS && (
                                <div className={`settings-status-card ${platformStatus?.screenRecordingGranted ? 'success' : 'danger'}`}>
                                    <span className="settings-status-label">
                                        <span className="material-symbols-rounded settings-role-icon" aria-hidden="true">screenshot_region</span>
                                        <span className="settings-status-label-text">{t('screenRecordingPermission')}</span>
                                    </span>
                                    <span
                                        className="material-symbols-rounded settings-state-icon"
                                        role="img"
                                        aria-label={platformStatus?.screenRecordingGranted ? t('granted') : t('permissionMissing')}
                                        title={platformStatus?.screenRecordingGranted ? t('granted') : t('permissionMissing')}
                                    >
                                        {platformStatus?.screenRecordingGranted ? 'verified' : 'do_not_touch'}
                                    </span>
                                </div>
                            )}
                            <div className={`settings-status-card ${aiSettings?.enabled ? 'success' : 'danger'}`}>
                                <span className="settings-status-label">
                                    <span className="material-symbols-rounded settings-role-icon" aria-hidden="true">wand_stars</span>
                                    <span className="settings-status-label-text">{t('aiActiveStatus')}</span>
                                </span>
                                <span
                                    className="material-symbols-rounded settings-state-icon"
                                    role="img"
                                    aria-label={aiSettings?.enabled ? t('enabled') : t('disabled')}
                                    title={aiSettings?.enabled ? t('enabled') : t('disabled')}
                                >
                                    {aiSettings?.enabled ? 'verified' : 'do_not_touch'}
                                </span>
                            </div>
                        </div>
                        {aiSettings && (
                            <form
                                className="settings-editor"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void saveAllSettings();
                                }}
                            >
                                {generalSettings && (
                                    <section className="settings-section">
                                        <div className="panel-header compact">
                                            <div>
                                                <h2 className="settings-section-title">
                                                    <span className="material-symbols-rounded settings-section-icon" aria-hidden="true">display_settings</span>
                                                    {t('general')}
                                                </h2>
                                                <p>{t('generalDescription')}</p>
                                            </div>
                                        </div>
                                        <div className="settings-form-grid">
                                            <label>
                                                {t('language')}
                                                <select
                                                    value={generalSettings.language}
                                                    onChange={(event) => updateGeneralSettings({
                                                        language: normalizeLanguage(event.target.value),
                                                    })}
                                                >
                                                    {languageOptions.map((option) => (
                                                        <option key={option.value} value={option.value}>{option.label}</option>
                                                    ))}
                                                </select>
                                            </label>
                                            <label>
                                                {t('appearance')}
                                                <select
                                                    value={generalSettings.themeMode}
                                                    onChange={(event) => updateGeneralSettings({
                                                        themeMode: event.target.value as GeneralSettings['themeMode'],
                                                    })}
                                                >
                                                    <option value="auto">{t('auto')}</option>
                                                    <option value="light">{t('light')}</option>
                                                    <option value="dark">{t('dark')}</option>
                                                </select>
                                            </label>
                                            <label>
                                                {t('typingTrend')}
                                                <select
                                                    value={generalSettings.typingTrendEnabled ? 'on' : 'off'}
                                                    onChange={(event) => updateGeneralSettings({
                                                        typingTrendEnabled: event.target.value === 'on',
                                                    })}
                                                >
                                                    <option value="on">{t('on')}</option>
                                                    <option value="off">{t('off')}</option>
                                                </select>
                                            </label>
                                            <label>
                                                {t('flowToggleHotkey')}
                                                <HotkeyCaptureControl
                                                    value={generalSettings.flowToggleHotkey}
                                                    recording={recordingFlowToggleHotkey}
                                                    onStart={() => {
                                                        setError("");
                                                        setRecordingFlowToggleHotkey(true);
                                                    }}
                                                    onStop={() => setRecordingFlowToggleHotkey(false)}
                                                    onKeyDown={captureFlowToggleHotkey}
                                                    onClear={() => {
                                                        setError("");
                                                        setRecordingFlowToggleHotkey(false);
                                                        updateGeneralSettings({ flowToggleHotkey: "" });
                                                    }}
                                                    t={t}
                                                />
                                            </label>
                                            <label>
                                                {t('sound')}
                                                <select
                                                    value={generalSettings.soundName}
                                                    onChange={(event) => updateSoundSetting(event.target.value)}
                                                >
                                                    {soundOptions.map((soundName) => (
                                                        <option key={soundName} value={soundName}>{soundName}</option>
                                                    ))}
                                                </select>
                                            </label>
                                            <label className="checkbox-setting">
                                                <span>{t('startAtLogin')}</span>
                                                <input
                                                    type="checkbox"
                                                    checked={generalSettings.startAtLogin}
                                                    disabled={settingsSaving}
                                                    onChange={(event) => updateGeneralSettings({
                                                        startAtLogin: event.target.checked,
                                                    })}
                                                />
                                            </label>
                                        </div>
                                    </section>
                                )}
                                {generalSettings && (
                                    <section className="settings-section pin-shot-settings">
                                        <div className="panel-header compact">
                                            <div>
                                                <h2 className="settings-section-title">
                                                    <span className="material-symbols-rounded settings-section-icon" aria-hidden="true">pinboard</span>
                                                    {t('pinShot')}
                                                </h2>
                                                <p>{t('pinShotSettingsDescription')}</p>
                                            </div>
                                        </div>
                                        <div className="settings-form-grid">
                                            <label className="checkbox-setting">
                                                <span>{t('usePinShot')}</span>
                                                <input
                                                    type="checkbox"
                                                    checked={generalSettings.pinShotEnabled}
                                                    disabled={settingsSaving}
                                                    onChange={(event) => {
                                                        setRecordingPinShotHotkey(false);
                                                        updateGeneralSettings({
                                                            pinShotEnabled: event.target.checked,
                                                        });
                                                    }}
                                                />
                                            </label>
                                            <label>
                                                {t('pinShotHotkey')}
                                                <HotkeyCaptureControl
                                                    value={generalSettings.pinShotHotkey}
                                                    recording={recordingPinShotHotkey}
                                                    disabled={!generalSettings.pinShotEnabled || settingsSaving}
                                                    onStart={() => {
                                                        setError("");
                                                        setRecordingPinShotHotkey(true);
                                                    }}
                                                    onStop={() => setRecordingPinShotHotkey(false)}
                                                    onKeyDown={capturePinShotHotkey}
                                                    onClear={() => {
                                                        setError("");
                                                        setRecordingPinShotHotkey(false);
                                                        updateGeneralSettings({ pinShotHotkey: "" });
                                                    }}
                                                    t={t}
                                                />
                                            </label>
                                        </div>
                                    </section>
                                )}
                                {isMacOS && generalSettings && (
                                    <section className="settings-section ocr-settings">
                                        <div className="panel-header compact">
                                            <div>
                                                <h2 className="settings-section-title">
                                                    <span className="material-symbols-rounded settings-section-icon" aria-hidden="true">document_scanner</span>
                                                    {t('ocr')}
                                                </h2>
                                                <p>{t('ocrSettingsDescription')}</p>
                                            </div>
                                        </div>
                                        <div className="settings-form-grid">
                                            <label className="checkbox-setting">
                                                <span>{t('useAppleVisionOCR')}</span>
                                                <input
                                                    type="checkbox"
                                                    checked={generalSettings.appleVisionOcrEnabled}
                                                    disabled={settingsSaving}
                                                    onChange={(event) => updateGeneralSettings({
                                                        appleVisionOcrEnabled: event.target.checked,
                                                    })}
                                                />
                                            </label>
                                            <label>
                                                {t('ocrHotkey')}
                                                <HotkeyCaptureControl
                                                    value={generalSettings.ocrHotkey}
                                                    recording={recordingOCRHotkey}
                                                    onStart={() => {
                                                        setError("");
                                                        setRecordingOCRHotkey(true);
                                                    }}
                                                    onStop={() => setRecordingOCRHotkey(false)}
                                                    onKeyDown={captureOCRHotkey}
                                                    onClear={() => {
                                                        setError("");
                                                        setRecordingOCRHotkey(false);
                                                        updateGeneralSettings({ ocrHotkey: "" });
                                                    }}
                                                    t={t}
                                                />
                                            </label>
                                            <label>
                                                {t('ocrRecognitionPriority')}
                                                <select
                                                    value={generalSettings.ocrRecognitionLanguage}
                                                    disabled={!generalSettings.appleVisionOcrEnabled || settingsSaving}
                                                    onChange={(event) => updateGeneralSettings({
                                                        ocrRecognitionLanguage: event.target.value,
                                                    })}
                                                >
                                                    {ocrLanguageOptions.map((option) => (
                                                        <option key={option.value} value={option.value}>{option.label}</option>
                                                    ))}
                                                </select>
                                            </label>
                                            <label>
                                                {t('ocrResultAction')}
                                                <select
                                                    value={generalSettings.ocrResultAction}
                                                    disabled={!generalSettings.appleVisionOcrEnabled || settingsSaving}
                                                    onChange={(event) => updateGeneralSettings({
                                                        ocrResultAction: event.target.value,
                                                    })}
                                                >
                                                    <option value="clipboard">{t('copyToClipboard')}</option>
                                                    <option value="show">{t('showRecognizedText')}</option>
                                                </select>
                                            </label>
                                        </div>
                                    </section>
                                )}
                                <section className="settings-section ai-settings">
                                    <div className="panel-header compact">
                                        <div>
                                            <h2 className="settings-section-title">
                                                <span className="material-symbols-rounded settings-section-icon" aria-hidden="true">smart_toy</span>
                                                {t('aiAssistant')}
                                            </h2>
                                            <p>{t('aiSettingsDescription')}</p>
                                        </div>
                                    </div>
                                    <div className="check-row">
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={aiSettings.enabled}
                                                onChange={(event) => setAISettings({ ...aiSettings, enabled: event.target.checked })}
                                            /> {t('enableAiAssistant')}
                                        </label>
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={aiSettings.useSelectedText}
                                                onChange={(event) => setAISettings({ ...aiSettings, useSelectedText: event.target.checked })}
                                            /> {t('useSelectedText')}
                                        </label>
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={aiSettings.replaceSelectedText}
                                                onChange={(event) => setAISettings({ ...aiSettings, replaceSelectedText: event.target.checked })}
                                            /> {t('replaceSelectedText')}
                                        </label>
                                    </div>
                                    <div className="settings-form-grid">
                                        <label>
                                            {t('provider')}
                                            <select
                                                value={aiSettings.provider}
                                                onChange={(event) => setAISettings({ ...aiSettings, provider: event.target.value })}
                                            >
                                                <option value="openai">{t('openaiCompatible')}</option>
                                                <option value="lmstudio">{t('lmStudioCompatible')}</option>
                                                {isMacOS && <option value="apple_intelligence">{t('appleIntelligence')}</option>}
                                            </select>
                                        </label>
                                        <label>
                                            {t('promptHotkey')}
                                            <HotkeyCaptureControl
                                                value={aiSettings.hotkey}
                                                recording={recordingHotkey}
                                                onStart={() => {
                                                    setError("");
                                                    setRecordingHotkey(true);
                                                }}
                                                onStop={() => setRecordingHotkey(false)}
                                                onKeyDown={captureHotkey}
                                                onClear={() => {
                                                    setError("");
                                                    setRecordingHotkey(false);
                                                    setAISettings({ ...aiSettings, hotkey: "" });
                                                }}
                                                t={t}
                                            />
                                        </label>
                                    </div>
                                    {aiSettings.provider === 'apple_intelligence' ? (
                                        <div className={`apple-intelligence-status-card ${appleIntelligenceStatus.available ? 'available' : ''}`}>
                                            <span className="material-symbols-rounded" aria-hidden="true">auto_awesome</span>
                                            <div>
                                                <strong>{t('appleIntelligenceOnDevice')}</strong>
                                                <span>{t('appleIntelligenceDescription')}</span>
                                            </div>
                                            <span
                                                className="apple-intelligence-state"
                                                title={appleIntelligenceStatus.detail || undefined}
                                            >
                                                {appleIntelligenceStatusLabel(appleIntelligenceStatus, t)}
                                            </span>
                                            <button type="button" onClick={refreshAppleIntelligenceStatus}>
                                                {t('refresh')}
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="settings-form-grid">
                                                <label>
                                                    {t('endpointOrHostPort')}
                                                    <input
                                                        {...textInputAssistanceDisabled}
                                                        value={aiSettings.endpoint}
                                                        onChange={(event) => setAISettings({ ...aiSettings, endpoint: event.target.value })}
                                                        placeholder="http://localhost:1234"
                                                    />
                                                </label>
                                                <label>
                                                    {t('model')}
                                                    <span className="model-setting-control">
                                                        <input
                                                            {...textInputAssistanceDisabled}
                                                            value={aiSettings.model}
                                                            onChange={(event) => setAISettings({ ...aiSettings, model: event.target.value })}
                                                            placeholder={t('modelPlaceholder')}
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={openModelPicker}
                                                            aria-label={t('chooseModel')}
                                                            title={t('chooseModel')}
                                                        >
                                                            <span className="material-symbols-rounded" aria-hidden="true">view_list</span>
                                                        </button>
                                                    </span>
                                                </label>
                                            </div>
                                            <div className="settings-form-grid">
                                                <label>
                                                    {t('apiKey')}
                                                    <input
                                                        {...textInputAssistanceDisabled}
                                                        value={aiSettings.apiKey}
                                                        onChange={(event) => setAISettings({ ...aiSettings, apiKey: event.target.value })}
                                                        placeholder={t('optional')}
                                                        type="password"
                                                    />
                                                </label>
                                                <label>
                                                    {t('temperature')}
                                                    <input
                                                        value={aiSettings.temperature}
                                                        min={0}
                                                        max={2}
                                                        step={0.1}
                                                        type="number"
                                                        onChange={(event) => setAISettings({ ...aiSettings, temperature: Number(event.target.value) })}
                                                    />
                                                </label>
                                            </div>
                                        </>
                                    )}
                                    <div className="settings-section-header">
                                        <h3>{t('aiHistory')}</h3>
                                        <p>{t('aiHistoryDescription')}</p>
                                    </div>
                                    <div className="settings-form-grid">
                                        <label className="checkbox-setting">
                                            <span>{t('useAiHistory')}</span>
                                            <input
                                                type="checkbox"
                                                checked={aiSettings.historyEnabled}
                                                disabled={aiSettings.provider === 'apple_intelligence'}
                                                onChange={(event) => setAISettings({
                                                    ...aiSettings,
                                                    historyEnabled: event.target.checked,
                                                })}
                                            />
                                        </label>
                                        <label>
                                            {t('aiHistoryCount')}
                                            <input
                                                value={aiSettings.historyCount}
                                                min={1}
                                                max={100}
                                                step={1}
                                                type="number"
                                                disabled={!aiSettings.historyEnabled || aiSettings.provider === 'apple_intelligence'}
                                                onChange={(event) => setAISettings({
                                                    ...aiSettings,
                                                    historyCount: Math.min(100, Math.max(1, Number(event.target.value) || 10)),
                                                })}
                                            />
                                        </label>
                                    </div>
                                    <span className="field-hint">
                                        {t(aiSettings.provider === 'lmstudio'
                                            ? 'lmStudioHistoryHint'
                                            : aiSettings.provider === 'apple_intelligence'
                                                ? 'aiHistoryUnavailableHint'
                                                : 'aiHistoryHint')}
                                    </span>
                                    {isMacOS && <>
                                        <hr className="settings-divider" />
                                        <div className="settings-section-header">
                                            <h3 className="settings-section-title">
                                                <span className="material-symbols-rounded settings-section-icon" aria-hidden="true">flag_check</span>
                                                {t('appCompatibility')}
                                            </h3>
                                            <p>{t('appCompatibilityDescription')}</p>
                                        </div>
                                        <label className="wide-setting">
                                            {t('pasteReplacementBundleIds')}
                                            <div className="bundle-list-control">
                                                <textarea
                                                    {...textInputAssistanceDisabled}
                                                    value={formatBundleIdList(aiSettings.pasteReplacementBundleIds || [])}
                                                    onChange={(event) => setAISettings({
                                                        ...aiSettings,
                                                        pasteReplacementBundleIds: parseBundleIdList(event.target.value),
                                                    })}
                                                    placeholder="com.apple.iWork.Keynote&#10;com.apple.iWork.Pages&#10;com.apple.iWork.Numbers"
                                                    rows={3}
                                                />
                                                <button type="button" onClick={browsePasteReplacementApp}>{t('browse')}</button>
                                            </div>
                                            <span className="field-hint">{t('pasteReplacementBundleIdsHint')}</span>
                                        </label>
                                    </>}

                                    <hr className="settings-divider" />

                                    <div className="settings-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div>
                                            <h3 className="settings-section-title">
                                                <span className="material-symbols-rounded settings-section-icon" aria-hidden="true">text_to_speech</span>
                                                {t('ttsSettings')}
                                            </h3>
                                            <p>{t('ttsSettingsDescription')}</p>
                                        </div>
                                        <button
                                            className="tts-test-playback-btn"
                                            type="button"
                                            onClick={testTTSPlayback}
                                        >
                                            {t('testPlayback')}
                                        </button>
                                    </div>

                                    <div className="check-row">
                                        <label>
                                            <input
                                                type="checkbox"
                                                // @ts-ignore
                                                checked={!!aiSettings.ttsEnabled}
                                                // @ts-ignore
                                                onChange={(event) => setAISettings({ ...aiSettings, ttsEnabled: event.target.checked })}
                                            /> {t('enableTts')}
                                        </label>
                                        <label>
                                            <input
                                                type="checkbox"
                                                // @ts-ignore
                                                checked={!!aiSettings.ttsUseAiResponse}
                                                // @ts-ignore
                                                onChange={(event) => setAISettings({ ...aiSettings, ttsUseAiResponse: event.target.checked })}
                                            /> {t('ttsUseAiResponse')}
                                        </label>
                                        <label>
                                            <input
                                                type="checkbox"
                                                // @ts-ignore
                                                checked={!!aiSettings.ttsUseShortcut}
                                                // @ts-ignore
                                                onChange={(event) => setAISettings({ ...aiSettings, ttsUseShortcut: event.target.checked })}
                                            /> {t('ttsUseShortcut')}
                                        </label>
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={aiSettings.ttsShowAudioActions !== false}
                                                onChange={(event) => setAISettings({
                                                    ...aiSettings,
                                                    ttsShowAudioActions: event.target.checked,
                                                })}
                                            /> {t('ttsShowAudioActions')}
                                        </label>
                                    </div>

                                    <div className="settings-form-grid">
                                        <label>
                                            {t('ttsEngine')}
                                            <select
                                                // @ts-ignore
                                                value={aiSettings.ttsEngine || 'os'}
                                                // @ts-ignore
                                                onChange={(event) => updateAITTSSettings({ ttsEngine: event.target.value } as Partial<AISettings>)}
                                            >
                                                <option value="os">{t('osTts')}</option>
                                                <option value="supertonic3">{t('supertonic3')}</option>
                                            </select>
                                        </label>
                                        <label>
                                            {t('ttsShortcut')}
                                            <HotkeyCaptureControl
                                                value={aiSettings.ttsShortcut}
                                                recording={recordingTtsHotkey}
                                                onStart={() => {
                                                    setError("");
                                                    setRecordingTtsHotkey(true);
                                                }}
                                                onStop={() => setRecordingTtsHotkey(false)}
                                                onKeyDown={captureTtsHotkey}
                                                onClear={() => {
                                                    setError("");
                                                    setRecordingTtsHotkey(false);
                                                    setAISettings({ ...aiSettings, ttsShortcut: "" });
                                                }}
                                                t={t}
                                            />
                                        </label>
                                    </div>

                                    {/* @ts-ignore */}
                                    {aiSettings.ttsEngine === 'os' && (
                                        <div className="settings-form-grid">
                                            <label>
                                                {t('osTtsVoice')}
                                                <select
                                                    // @ts-ignore
                                                    value={aiSettings.ttsOsVoice || ''}
                                                    disabled={osVoicesLoading}
                                                    // @ts-ignore
                                                    onChange={(event) => updateAITTSSettings({ ttsOsVoice: event.target.value } as Partial<AISettings>)}
                                                >
                                                    <option value="">
                                                        {osVoicesLoading ? t('loadingOsVoices') : t('systemDefaultVoice')}
                                                    </option>
                                                    {/* @ts-ignore */}
                                                    {aiSettings.ttsOsVoice && !osVoices.some((voice) => voice.id === aiSettings.ttsOsVoice) && (
                                                        // @ts-ignore
                                                        <option value={aiSettings.ttsOsVoice}>{t('unavailableOsVoice')}</option>
                                                    )}
                                                    {osVoices.map((voice) => (
                                                        <option key={voice.id || voice.name} value={voice.id}>
                                                            {osVoiceLabel(voice, t)}
                                                        </option>
                                                    ))}
                                                </select>
                                            </label>
                                            {osVoicesError && <span className="field-hint">{t('osVoicesLoadFailed')}</span>}
                                        </div>
                                    )}

                                    {/* @ts-ignore */}
                                    {aiSettings.ttsEngine === 'supertonic3' && (
                                        <>
                                            <div className="settings-form-grid">
                                                <label>
                                                    {t('supertonicVoiceStyle')}
                                                    <select
                                                        // @ts-ignore
                                                        value={aiSettings.ttsVoice || 'M1'}
                                                        // @ts-ignore
                                                        onChange={(event) => setAISettings({ ...aiSettings, ttsVoice: event.target.value })}
                                                    >
                                                        <option value="M1">{t('voiceM1')}</option>
                                                        <option value="M2">{t('voiceM2')}</option>
                                                        <option value="M3">{t('voiceM3')}</option>
                                                        <option value="M4">{t('voiceM4')}</option>
                                                        <option value="M5">{t('voiceM5')}</option>
                                                        <option value="F1">{t('voiceF1')}</option>
                                                        <option value="F2">{t('voiceF2')}</option>
                                                        <option value="F3">{t('voiceF3')}</option>
                                                        <option value="F4">{t('voiceF4')}</option>
                                                        <option value="F5">{t('voiceF5')}</option>
                                                    </select>
                                                </label>
                                            </div>
                                            <div className="settings-form-grid" style={{ marginTop: '10px' }}>
                                                <label>
                                                    {t('supertonicSpeed')} ({aiSettings.ttsSpeed || 1.05})
                                                    <input
                                                        type="range"
                                                        min="0.7"
                                                        max="2.0"
                                                        step="0.05"
                                                        // @ts-ignore
                                                        value={aiSettings.ttsSpeed || 1.05}
                                                        // @ts-ignore
                                                        onChange={(event) => setAISettings({ ...aiSettings, ttsSpeed: parseFloat(event.target.value) })}
                                                    />
                                                </label>
                                                <label>
                                                    {t('supertonicSteps')} ({aiSettings.ttsSteps || 8})
                                                    <input
                                                        type="range"
                                                        min="5"
                                                        max="12"
                                                        step="1"
                                                        // @ts-ignore
                                                        value={aiSettings.ttsSteps || 8}
                                                        // @ts-ignore
                                                        onChange={(event) => setAISettings({ ...aiSettings, ttsSteps: parseInt(event.target.value) })}
                                                    />
                                                </label>
                                            </div>
                                            <div className={`tts-model-status-section ${modelStatus.isDownloaded && modelStatus.status !== 'downloading' ? 'ready' : ''}`}>
                                                <div className="tts-model-status-title">
                                                    {modelStatus.isDownloaded ? t('ttsModelReady') : (
                                                        modelStatus.status === 'error' ? t('ttsModelDownloadFailed') : t('ttsModelNotReady')
                                                    )}
                                                    {modelStatus.status === 'error' && modelStatus.error && (
                                                        <div style={{ color: '#ff4d4f', fontSize: '11px', marginTop: '4px', fontWeight: 'normal', wordBreak: 'break-all' }}>
                                                            {modelStatus.error}
                                                        </div>
                                                    )}
                                                </div>
                                                {modelStatus.status === 'downloading' && (
                                                    <>
                                                        <div className="tts-model-status-desc">
                                                            {t('downloadingTtsModel', { progress: Math.round(modelStatus.progress) })}
                                                            {modelStatus.currentFile && ` (${modelStatus.currentFile})`}
                                                        </div>
                                                        <div className="tts-model-progress-bar">
                                                            <div className="tts-model-progress-fill" style={{ width: `${modelStatus.progress}%` }}></div>
                                                        </div>
                                                        <button
                                                            className="tts-model-download-btn cancel"
                                                            type="button"
                                                            onClick={() => CancelTTSModelDownload()}
                                                        >
                                                            {t('cancel')}
                                                        </button>
                                                    </>
                                                )}
                                                {modelStatus.status !== 'downloading' && !modelStatus.isDownloaded && (
                                                    <button
                                                        className="tts-model-download-btn"
                                                        type="button"
                                                        onClick={() => {
                                                            StartTTSModelDownload().catch(err => alert(err));
                                                        }}
                                                    >
                                                        {t('downloadTtsModel')}
                                                    </button>
                                                )}
                                                {modelStatus.status !== 'downloading' && modelStatus.isDownloaded && (
                                                    <button
                                                        className="tts-model-redownload-link"
                                                        type="button"
                                                        onClick={() => {
                                                            StartTTSModelDownload().catch(err => alert(err));
                                                        }}
                                                    >
                                                        {t('redownloadTtsModel')}
                                                    </button>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </section>
                                <div className="settings-footer-actions">
                                    <div className="settings-footer-transfer-actions">
                                        <button
                                            type="button"
                                            disabled={settingsTransfer !== null}
                                            onClick={() => void backupSnippetsAndAIPrompts()}
                                        >
                                            <span className="material-symbols-rounded" aria-hidden="true">backup</span>
                                            {settingsTransfer === 'backup' ? t('backingUpContent') : t('backupSnippetsAndAIPrompts')}
                                        </button>
                                        <button
                                            type="button"
                                            disabled={settingsTransfer !== null}
                                            onClick={() => void importSnippetsAndAIPrompts()}
                                        >
                                            <span className="material-symbols-rounded" aria-hidden="true">upload_file</span>
                                            {settingsTransfer === 'import' ? t('importingContent') : t('importContentBackup')}
                                        </button>
                                        {settingsTransferNotice && (
                                            <span className="settings-footer-notice" role="status">{settingsTransferNotice}</span>
                                        )}
                                    </div>
                                    <div className="settings-footer-save-actions">
                                        <button
                                            type="button"
                                            disabled={settingsSaving || settingsTransfer !== null}
                                            onClick={cancelSettingsChanges}
                                        >
                                            {t('cancel')}
                                        </button>
                                        <button
                                            className="primary-button"
                                            type="submit"
                                            disabled={settingsSaving || settingsTransfer !== null || !generalSettings}
                                        >
                                            {settingsSaving ? t('saving') : t('save')}
                                        </button>
                                    </div>
                                </div>
                            </form>
                        )}
                    </section>
                )}

                {error ? (
                    <div className={`toast ${windowMode === 'hud' ? 'hud-error-toast' : ''}`} role="alert">
                        <span className="toast-message">{error}</span>
                        <button
                            type="button"
                            onClick={() => setError('')}
                            aria-label={t('close')}
                            title={t('close')}
                        >
                            <span className="material-symbols-rounded" aria-hidden="true">close</span>
                        </button>
                    </div>
                ) : saveToast && (
                    <div key={saveToast.id} className="toast success" role="status" aria-live="polite">
                        <span className="material-symbols-rounded" aria-hidden="true">check_circle</span>
                        <span>{saveToast.message}</span>
                    </div>
                )}
            </main>

            {appPickerTarget && (
                <div
                    className="modal-backdrop app-picker-backdrop"
                    onClick={(event) => {
                        if (event.currentTarget === event.target) {
                            closeAppPicker();
                        }
                    }}
                >
                    <section
                        className="modal app-picker-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="app-picker-title"
                        aria-describedby="app-picker-description"
                    >
                        <div className="app-picker-header">
                            <div className="app-picker-header-icon" aria-hidden="true">
                                <span className="material-symbols-rounded">apps</span>
                            </div>
                            <div>
                                <h2 id="app-picker-title">
                                    {t(appPickerStage === 'running' ? 'runningAppsTitle' : 'appPickerTitle')}
                                </h2>
                                <p id="app-picker-description">
                                    {t(appPickerStage === 'running' ? 'runningAppsDescription' : 'appPickerDescription')}
                                </p>
                            </div>
                        </div>

                        {appPickerStage === 'method' ? (
                            <div className="app-picker-methods">
                                <button type="button" onClick={() => void showRunningAppPicker()}>
                                    <span className="material-symbols-rounded" aria-hidden="true">dynamic_feed</span>
                                    <strong>{t('chooseRunningApp')}</strong>
                                    <span>{t('chooseRunningAppDescription')}</span>
                                </button>
                                <button type="button" onClick={() => void chooseDirectApp()}>
                                    <span className="material-symbols-rounded" aria-hidden="true">folder_open</span>
                                    <strong>{t('chooseDirectApp')}</strong>
                                    <span>{t('chooseDirectAppDescription')}</span>
                                </button>
                            </div>
                        ) : (
                            <div className="running-app-picker">
                                <div className="running-app-list" role="listbox" aria-label={t('runningAppsTitle')}>
                                    {runningAppsLoading ? (
                                        <div className="app-picker-empty">
                                            <span className="button-spinner" aria-hidden="true" />
                                            <span>{t('runningAppsLoading')}</span>
                                        </div>
                                    ) : runningApps.length === 0 ? (
                                        <div className="app-picker-empty">{t('noRunningApps')}</div>
                                    ) : runningApps.map((app) => (
                                        <button
                                            key={app.bundleId}
                                            type="button"
                                            role="option"
                                            aria-selected={selectedRunningAppBundleID === app.bundleId}
                                            className={`running-app-row ${selectedRunningAppBundleID === app.bundleId ? 'selected' : ''}`}
                                            onClick={() => setSelectedRunningAppBundleID(app.bundleId)}
                                            onDoubleClick={() => void chooseSelectedRunningApp(app)}
                                        >
                                            {app.iconDataUrl ? (
                                                <img src={app.iconDataUrl} alt="" />
                                            ) : (
                                                <span className="running-app-fallback-icon" aria-hidden="true">
                                                    {(app.name || app.bundleId || '?').trim().charAt(0).toUpperCase()}
                                                </span>
                                            )}
                                            <span className="running-app-details">
                                                <strong>{app.name}</strong>
                                                <span>{app.bundleId}</span>
                                            </span>
                                        </button>
                                    ))}
                                </div>
                                <div className="modal-actions app-picker-actions">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setAppPickerStage('method');
                                            setSelectedRunningAppBundleID('');
                                        }}
                                    >
                                        {t('back')}
                                    </button>
                                    <span className="app-picker-action-spacer" />
                                    <button type="button" onClick={closeAppPicker}>{t('cancel')}</button>
                                    <button
                                        className="primary-button"
                                        type="button"
                                        disabled={!selectedRunningAppBundleID || runningAppsLoading}
                                        onClick={() => void chooseSelectedRunningApp()}
                                    >
                                        {t('selectApp')}
                                    </button>
                                </div>
                            </div>
                        )}

                        {appPickerStage === 'method' && (
                            <div className="modal-actions app-picker-actions">
                                <button type="button" onClick={closeAppPicker}>{t('cancel')}</button>
                            </div>
                        )}
                    </section>
                </div>
            )}

            {modelPickerOpen && aiSettings && aiSettings.provider !== 'apple_intelligence' && (
                <div
                    className="modal-backdrop model-picker-backdrop"
                    onClick={(event) => {
                        if (event.currentTarget === event.target) {
                            closeModelPicker();
                        }
                    }}
                >
                    <section
                        className="modal model-picker-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="model-picker-title"
                        aria-describedby="model-picker-description"
                    >
                        <div className="model-picker-header">
                            <div>
                                <h2 id="model-picker-title">{t('modelPickerTitle')}</h2>
                                <p id="model-picker-description">{t('modelPickerDescription')}</p>
                            </div>
                            <div className="model-picker-header-actions">
                                <button
                                    type="button"
                                    onClick={() => void refreshAIModels()}
                                    disabled={aiModelsLoading || !!unmountingModelInstanceID}
                                    aria-label={t('refreshModels')}
                                    title={t('refreshModels')}
                                >
                                    <span className="material-symbols-rounded" aria-hidden="true">refresh</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={closeModelPicker}
                                    disabled={!!unmountingModelInstanceID}
                                    aria-label={t('close')}
                                    title={t('close')}
                                >
                                    <span className="material-symbols-rounded" aria-hidden="true">close</span>
                                </button>
                            </div>
                        </div>
                        <div className="ai-model-list" role="listbox" aria-label={t('modelPickerTitle')}>
                            {aiModelsLoading && availableAIModels.length === 0 ? (
                                <div className="ai-model-list-state">
                                    <span className="button-spinner" aria-hidden="true" />
                                    <span>{t('loadingModels')}</span>
                                </div>
                            ) : aiModelsError && availableAIModels.length === 0 ? (
                                <div className="ai-model-list-state is-error">
                                    <span className="material-symbols-rounded" aria-hidden="true">error</span>
                                    <span>{aiModelsError}</span>
                                </div>
                            ) : availableAIModels.length === 0 ? (
                                <div className="ai-model-list-state">{t('noModelsAvailable')}</div>
                            ) : availableAIModels.map((model) => {
                                const selected = model.id === aiSettings.model;
                                const unmounting = model.instanceId === unmountingModelInstanceID;
                                return (
                                    <div
                                        key={model.id}
                                        className={`ai-model-row${selected ? ' selected' : ''}`}
                                    >
                                        <button
                                            className="ai-model-select"
                                            type="button"
                                            role="option"
                                            aria-selected={selected}
                                            disabled={!!unmountingModelInstanceID}
                                            onClick={() => selectAIModel(model)}
                                        >
                                            <span className="ai-model-copy">
                                                <strong>{model.displayName || model.id}</strong>
                                                <span className="ai-model-meta">
                                                    {model.loaded && <span className="ai-model-loaded">{t('loadedModel')}</span>}
                                                    {(selected || model.displayName !== model.id) && <span>{model.id}</span>}
                                                </span>
                                            </span>
                                        </button>
                                        {model.loaded && model.instanceId && (
                                            <button
                                                className="ai-model-unmount"
                                                type="button"
                                                disabled={!!unmountingModelInstanceID}
                                                onClick={() => void unmountAIModel(model)}
                                                aria-label={unmounting ? t('unmountingModel') : t('unmountModel')}
                                                title={unmounting ? t('unmountingModel') : t('unmountModel')}
                                            >
                                                {unmounting ? (
                                                    <span className="button-spinner" aria-hidden="true" />
                                                ) : (
                                                    <span className="material-symbols-rounded" aria-hidden="true">eject</span>
                                                )}
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        {aiModelsError && availableAIModels.length > 0 && (
                            <div className="model-picker-inline-error" role="alert">{aiModelsError}</div>
                        )}
                    </section>
                </div>
            )}

            {isPermissionModalOpen && (
                <div
                    className="modal-backdrop permission-modal-backdrop"
                    onClick={(event) => {
                        if (event.currentTarget === event.target) {
                            setIsPermissionModalOpen(false);
                        }
                    }}
                >
                    <section
                        className="modal permission-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="permission-modal-title"
                        aria-describedby="permission-modal-description"
                    >
                        <div className="permission-modal-header">
                            <div className="permission-modal-icon" aria-hidden="true">
                                <span className="material-symbols-rounded">verified_user</span>
                            </div>
                            <div>
                                <h2 id="permission-modal-title">{t('macOSPermissions')}</h2>
                                <p id="permission-modal-description">{t('macOSPermissionsDescription')}</p>
                            </div>
                        </div>
                        <div className="permission-options">
                            <section className="permission-option">
                                <div className="permission-option-heading">
                                    <div>
                                        <h3>{t('accessibilityPermission')}</h3>
                                        <span className={platformStatus?.accessibilityTrusted ? 'permission-state granted' : 'permission-state required'}>
                                            {platformStatus?.accessibilityTrusted ? t('granted') : t('required')}
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        className={platformStatus?.accessibilityTrusted ? undefined : 'primary-button'}
                                        disabled={platformStatus?.accessibilityTrusted || requestingPermission !== null}
                                        onClick={requestAccessibilityPermission}
                                    >
                                        {platformStatus?.accessibilityTrusted ? t('granted') : t('grantAccess')}
                                    </button>
                                </div>
                                <p>{t('accessibilityPermissionDescription')}</p>
                            </section>
                            <section className="permission-option">
                                <div className="permission-option-heading">
                                    <div>
                                        <h3>{t('screenRecordingPermission')}</h3>
                                        <span className={platformStatus?.screenRecordingGranted ? 'permission-state granted' : 'permission-state required'}>
                                            {platformStatus?.screenRecordingGranted ? t('granted') : t('required')}
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        className={platformStatus?.screenRecordingGranted ? undefined : 'primary-button'}
                                        disabled={platformStatus?.screenRecordingGranted || requestingPermission !== null}
                                        onClick={requestScreenRecordingPermission}
                                    >
                                        {platformStatus?.screenRecordingGranted ? t('granted') : t('grantAccess')}
                                    </button>
                                </div>
                                <p>{t('screenRecordingPermissionDescription')}</p>
                            </section>
                        </div>
                        <div className="modal-actions permission-modal-actions">
                            <button type="button" onClick={() => setIsPermissionModalOpen(false)}>{t('close')}</button>
                        </div>
                    </section>
                </div>
            )}

            {isModalOpen && (
                <div className="modal-backdrop">
                    <form className="modal snippet-modal" onSubmit={submitSnippet}>
                        <div className="panel-header">
                            <div>
                                <h2>{editingSnippet ? t('editSnippet') : t('newSnippetTitle')}</h2>
                                <p>{t('snippetHelp')}</p>
                            </div>
                            <div className="modal-actions header-actions">
                                <button type="button" onClick={() => setIsModalOpen(false)}>{t('cancel')}</button>
                                <button className="primary-button" type="submit">{t('save')}</button>
                            </div>
                        </div>
                        <div className="snippet-main-fields">
                            <label className={`shortcut-field ${shortcutWarning ? 'invalid' : ''}`}>
                                <span>{t('shortcut')}</span>
                                <span className="shortcut-input-wrap">
                                    <input
                                        {...textInputAssistanceDisabled}
                                        ref={shortcutInputRef}
                                        value={form.shortcut}
                                        onChange={(event) => {
                                            setForm({ ...form, shortcut: event.target.value });
                                            setShortcutWarning('');
                                        }}
                                        aria-invalid={Boolean(shortcutWarning)}
                                        aria-describedby={shortcutWarning ? 'shortcut-warning' : undefined}
                                        placeholder={t('shortcutPlaceholder')}
                                    />
                                    {shortcutWarning && (
                                        <span className="field-tooltip" id="shortcut-warning" role="alert">
                                            {shortcutWarning}
                                        </span>
                                    )}
                                </span>
                            </label>
                            <label>
                                {t('label')}
                                <select value={form.labelId} onChange={(event) => setForm({ ...form, labelId: Number(event.target.value) })}>
                                    <option value={0}>{t('all')}</option>
                                    {labels.map((label) => (
                                        <option key={label.id} value={label.id}>{label.name}</option>
                                    ))}
                                </select>
                            </label>
                            <label className="title-field">
                                {t('title')}
                                <input {...textInputAssistanceDisabled} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder={t('titlePlaceholder')} />
                            </label>
                        </div>
                        <label className="content-field">
                            {t('content')}
                            <textarea
                                {...textInputAssistanceDisabled}
                                ref={snippetContentRef}
                                value={form.content}
                                onChange={(event) => updateSnippetContent(event.target.value)}
                            />
                        </label>
                        <div className="snippet-token-row modal-token-row">
                            {snippetTokens.map((token) => (
                                <button key={token.value} type="button" onClick={() => insertSnippetToken(token.value)}>
                                    {t(token.labelKey)}
                                </button>
                            ))}
                        </div>
                        <div className="form-grid">
                            <label>
                                {t('expandMode')}
                                <select value={form.expandMode} onChange={(event) => setForm({ ...form, expandMode: event.target.value })}>
                                    <option value="delimiter">{t('delimiter')}</option>
                                    <option value="instant">{t('instant')}</option>
                                </select>
                            </label>
                            <label>
                                {t('contentType')}
                                <select value={form.contentType} onChange={(event) => setForm({ ...form, contentType: event.target.value })}>
                                    {contentTypeOptions.map((option) => (
                                        <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                                    ))}
                                </select>
                            </label>
                        </div>
                        <div className="check-row">
                            <label><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> {t('enabled')}</label>
                            <label className="paste-option">
                                <input type="checkbox" checked={form.usePaste} onChange={(event) => updateUsePaste(event.target.checked)} /> {t('paste')}
                                {pasteWarning && (
                                    <span className="field-tooltip paste-tooltip" role="status">
                                        {pasteWarning}
                                    </span>
                                )}
                            </label>
                            <label><input type="checkbox" checked={form.caseSensitive} onChange={(event) => setForm({ ...form, caseSensitive: event.target.checked })} /> {t('caseSensitive')}</label>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}

function AIProgressStatus({ elapsedMs, t }: { elapsedMs: number; t: Translator }) {
    return (
        <div className="ai-progress-status" role="status" aria-live="polite">
            <div className="ai-progress-row">
                <span className="ai-pulse-dot" />
                <span>{aiStatusLabel(elapsedMs, t)}</span>
                <span className="ai-elapsed">{Math.floor(elapsedMs / 1000)}s</span>
            </div>
            <div className="ai-progress-track">
                <span />
            </div>
        </div>
    );
}

function TypingChart({ history, enabled, t }: { history: DailyTypingStat[]; enabled: boolean; t: Translator }) {
    const maxCount = Math.max(1, ...history.map((day) => day.count));
    return (
        <div className="typing-chart">
            <div className="typing-chart-header">
                <div>
                    <h2>{t('typingTrend')}</h2>
                    <p>{t('typingTrendDescription')}</p>
                </div>
            </div>
            <div className="typing-bars" aria-label={t('typingTrendDescription')}>
                {history.map((day, index) => {
                    const height = Math.max(3, Math.round((day.count / maxCount) * 100));
                    const edgeClass = index < 8
                        ? ' tooltip-align-start'
                        : index >= history.length - 8
                            ? ' tooltip-align-end'
                            : '';
                    return (
                        <span
                            key={day.date}
                            className={`typing-bar${edgeClass}`}
                            style={{ height: `${height}%` }}
                            aria-label={`${day.date}: ${formatCount(day.count)}`}
                            tabIndex={enabled ? 0 : -1}
                        >
                            <span className="typing-bar-tooltip" role="tooltip">
                                <span className="typing-tooltip-row">
                                    <span>{t('typingTooltipDate')}</span>
                                    <strong>{day.date}</strong>
                                </span>
                                <span className="typing-tooltip-row">
                                    <span>{t('typingTooltipInputCount')}</span>
                                    <strong>{formatCount(day.count)}</strong>
                                </span>
                            </span>
                        </span>
                    );
                })}
                {!enabled && (
                    <div className="typing-disabled-overlay">
                        <strong>{t('typingTrendOff')}</strong>
                        <span>{t('typingTrendOffDescription')}</span>
                    </div>
                )}
            </div>
        </div>
    );
}

function PromptRuleEditor({ rule, onChange, t }: { rule: AIPromptRule; onChange: (patch: Partial<AIPromptRule>) => void; t: Translator }) {
    return (
        <div className="prompt-rule-editor">
            <div className="check-row">
                <label>
                    <input
                        type="checkbox"
                        checked={rule.useSelectedText}
                        onChange={(event) => onChange({ useSelectedText: event.target.checked })}
                    /> {t('useSelectedText')}
                </label>
                <label>
                    <input
                        type="checkbox"
                        checked={rule.runWithoutSelection}
                        onChange={(event) => onChange({ runWithoutSelection: event.target.checked })}
                    /> {t('runWithoutSelection')}
                </label>
            </div>
            <label>
                {t('promptWhenTextSelected')}
                <textarea
                    {...textInputAssistanceDisabled}
                    value={rule.selectedTextPrompt}
                    onChange={(event) => onChange({ selectedTextPrompt: event.target.value })}
                    placeholder={t('selectedTextPromptPlaceholder')}
                    rows={7}
                />
            </label>
            <label>
                {t('promptWhenNoTextSelected')}
                <textarea
                    {...textInputAssistanceDisabled}
                    value={rule.noSelectionPrompt}
                    onChange={(event) => onChange({ noSelectionPrompt: event.target.value })}
                    placeholder={t('noTextPromptPlaceholder')}
                    rows={7}
                />
            </label>
        </div>
    );
}

export default App;
