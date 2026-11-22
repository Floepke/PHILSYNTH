const RECORDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isRecordingId = (id) => typeof id === 'string' && RECORDING_ID.test(id);
