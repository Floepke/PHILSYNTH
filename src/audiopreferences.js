export const AUDIO_LATENCY_ID = 'audio.latency';

export function registerAudioPreferences(preferencesManager) {
  preferencesManager.register({
    id: AUDIO_LATENCY_ID,
    category: 'Audio',
    label: 'Audio Latency',
    type: 'select',
    defaultValue: 'interactive',
    options: [
      { value: 'interactive', label: 'Interactive (default)' },
      { value: '10', label: '10 ms' },
      { value: '20', label: '20 ms' },
      { value: '40', label: '40 ms' },
      { value: '80', label: '80 ms' },
      { value: '160', label: '160 ms' },
    ],
    description: 'Applies after restarting the app or reloading the browser. Electron uses 20 ms of rendering headroom for Interactive, or the selected numeric setting, plus a device-buffer burst margin. Lower settings reduce live-note delay but may cause dropouts under load. Device latency is an additional request and may differ. Browsers use direct rendering.',
  });
}

export function audioLatencyHint(preferencesManager) {
  const value = preferencesManager.get(AUDIO_LATENCY_ID);
  return value === 'interactive' ? value : Number(value) / 1000;
}