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
      { value: '20', label: '20 ms' },
      { value: '40', label: '40 ms' },
      { value: '80', label: '80 ms' },
      { value: '160', label: '160 ms' },
    ],
    description: 'Applies after restarting the app or reloading the browser. Electron queues complete audio blocks with at least 20 ms of rendering headroom plus a device-buffer burst margin. Higher settings increase that headroom and live-note delay. Device latency is an additional request and may differ. Browsers use direct rendering.',
  });
}

export function audioLatencyHint(preferencesManager) {
  const value = preferencesManager.get(AUDIO_LATENCY_ID);
  return value === 'interactive' ? value : Number(value) / 1000;
}