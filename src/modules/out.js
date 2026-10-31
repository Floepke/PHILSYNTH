// System module: the single Output of every patch. Always id 0, cannot be deleted or inserted.
// Its state holds free text: comments / notes about the song (or patch), edited in its panel and
// saved with the project.
export const MAX_COMMENT = 20000;
export const normalizeComment = (state) => ({
  comment: typeof state?.comment === 'string' ? state.comment.slice(0, MAX_COMMENT) : '',
});

export default {
  type: 'OUT',
  label: 'Output',
  system: true,
  isOutput: true,
  hasInput: true,
  hasOutput: false,
  acceptsMidi: false,
  params: [
    { id: 'volume', label: 'Master volume', min: 0, max: 1, default: 0.8, step: 0.01 },
    // tempo of this patch level; LFO, DELAY and ECHO sync to it
    { id: 'bpm', label: 'BPM', min: 20, max: 1000, default: 120, step: 1, wheelStep: 1 }, // 1 BPM per wheel click
  ],
  defaultState: () => ({ comment: '' }),
  normalizeState: normalizeComment,
  // panel (below the controllers): a text box for comments, saved as you type
  view(entry, api) {
    const el = document.createElement('label');
    el.className = 'out-comment';
    const title = document.createElement('span');
    title.textContent = 'Comments';
    const text = document.createElement('textarea');
    text.rows = 8;
    text.maxLength = MAX_COMMENT;
    text.spellcheck = true;
    text.placeholder = 'Notes about the song: ideas, structure, credits…';
    text.value = entry.state?.comment ?? '';
    text.addEventListener('input', () => api.setState({ comment: text.value }));
    // the app's key shortcuts skip textareas; Escape leaves the box (instead of going up a patch level)
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      text.blur();
    });
    el.append(title, text);
    return { el };
  },
  create(_ctx, _def, host) {
    const input = host.dsp.create('out'); // DSP: out.dsp.js (sum × Master volume)
    return {
      input,
      node: null,
      setParam: (id, v) => input.param(id, v),
      destroy: () => input.destroy(),
    };
  },
};
