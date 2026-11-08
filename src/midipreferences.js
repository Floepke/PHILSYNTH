import { MIDI_AUTO } from './midi.js';

export const MIDI_INPUT_ID = 'midi.input';
export const LEGACY_MIDI_INPUT_KEY = 'modsynth:midiInput';

export function registerMidiPreferences(manager, getMidi) {
  manager.register({
    id: MIDI_INPUT_ID, category: 'MIDI', label: 'MIDI Input', type: 'select', defaultValue: MIDI_AUTO,
    description: 'Auto uses all inputs except MIDI Through ports. Re-scan to refresh devices or request MIDI access. Changes preview immediately; Cancel restores the saved input.',
    options(value) {
      const inputs = getMidi()?.inputs() ?? [];
      const options = [{ value: MIDI_AUTO, label: 'Auto (all inputs except MIDI Through)' },
        ...inputs.filter(input => input.name !== MIDI_AUTO).map(input => ({ value: input.name, label: input.name }))];
      if (typeof value === 'string' && !options.some(option => option.value === value)) {
        options.push({ value, label: `${value} (not connected)` });
      }
      return options;
    },
    apply(value) {
      const midi = getMidi();
      if (midi && midi.selected() !== value) midi.select(value);
    },
    refreshLabel: 'Re-scan MIDI Inputs',
    async refresh() {
      const midi = getMidi();
      if (!midi || !await midi.enable()) throw new Error('MIDI access is unavailable. See the status bar for details.');
    },
  });
}

export async function migrateMidiInput(manager, storage = localStorage) {
  if (manager.hasStored(MIDI_INPUT_ID)) return;
  const input = storage.getItem(LEGACY_MIDI_INPUT_KEY);
  if (input) await manager.save({ [MIDI_INPUT_ID]: input });
}
