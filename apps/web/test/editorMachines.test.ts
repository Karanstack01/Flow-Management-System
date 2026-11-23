import { describe, expect, it } from 'vitest';
import {
  PANEL_CLOSED,
  SAVE_IDLE,
  canRedo,
  canStartSave,
  canUndo,
  historyReducer,
  initHistory,
  panelReducer,
  saveReducer,
  type HistoryEvent,
  type PanelEvent,
  type PanelState,
  type SaveEvent,
  type SaveState,
} from '../src/pages/flows/editor/machines';

const runPanel = (events: PanelEvent[], from: PanelState = PANEL_CLOSED) => events.reduce(panelReducer, from);
const runSave = (events: SaveEvent[], from: SaveState = SAVE_IDLE) => events.reduce(saveReducer, from);

describe('editor side panel', () => {
  it('starts closed and opens when a node is selected', () => {
    expect(runPanel([{ type: 'SELECT', id: 'a' }])).toEqual({ kind: 'node', id: 'a' });
  });
  it('collapses again when the selection is cleared, but leaves flow settings alone', () => {
    expect(runPanel([{ type: 'SELECT', id: 'a' }, { type: 'DESELECT' }])).toEqual(PANEL_CLOSED);
    expect(runPanel([{ type: 'TOGGLE_SETTINGS' }, { type: 'DESELECT' }])).toEqual({ kind: 'settings' });
  });
  it('toggles flow settings and switches straight from a node to settings', () => {
    expect(runPanel([{ type: 'SELECT', id: 'a' }, { type: 'TOGGLE_SETTINGS' }])).toEqual({ kind: 'settings' });
    expect(runPanel([{ type: 'TOGGLE_SETTINGS' }, { type: 'TOGGLE_SETTINGS' }])).toEqual(PANEL_CLOSED);
  });
  it('closes when the open node is deleted, not when another one is', () => {
    expect(runPanel([{ type: 'SELECT', id: 'a' }, { type: 'REMOVED', ids: ['b'] }])).toEqual({ kind: 'node', id: 'a' });
    expect(runPanel([{ type: 'SELECT', id: 'a' }, { type: 'REMOVED', ids: ['a', 'b'] }])).toEqual(PANEL_CLOSED);
  });
  it('returns the same object for no-op transitions (no needless re-render)', () => {
    const open: PanelState = { kind: 'node', id: 'a' };
    expect(panelReducer(open, { type: 'SELECT', id: 'a' })).toBe(open);
    expect(panelReducer(PANEL_CLOSED, { type: 'CLOSE' })).toBe(PANEL_CLOSED);
  });
});

describe('editor save', () => {
  it('ignores a second start while a save is in flight', () => {
    const s = runSave([{ type: 'START', publish: false }, { type: 'START', publish: true }]);
    expect(s).toEqual({ kind: 'saving', publish: false });
    expect(canStartSave(s)).toBe(false);
  });
  it('goes saving → saved → idle on the next edit', () => {
    const saved = runSave([{ type: 'START', publish: true }, { type: 'SUCCEEDED', version: 3, at: 1 }]);
    expect(saved).toEqual({ kind: 'saved', version: 3, at: 1 });
    expect(saveReducer(saved, { type: 'EDITED' })).toEqual(SAVE_IDLE);
  });
  it('ignores late results that do not belong to an in-flight save', () => {
    expect(runSave([{ type: 'SUCCEEDED', version: 9, at: 1 }])).toEqual(SAVE_IDLE);
    expect(runSave([{ type: 'FAILED', message: 'x' }])).toEqual(SAVE_IDLE);
  });
  it('records failures and allows retry', () => {
    const failed = runSave([{ type: 'START', publish: false }, { type: 'FAILED', message: 'boom' }]);
    expect(failed).toEqual({ kind: 'failed', message: 'boom' });
    expect(canStartSave(failed)).toBe(true);
  });
});

describe('editor history (undo / redo)', () => {
  it('initializes with empty past and future', () => {
    const h = initHistory('state-0');
    expect(h.past).toEqual([]);
    expect(h.present).toBe('state-0');
    expect(h.future).toEqual([]);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('pushes new state into past and clears future', () => {
    const h0 = initHistory('state-0');
    const h1 = historyReducer(h0, { type: 'PUSH', snapshot: 'state-1' });
    expect(h1.past).toEqual(['state-0']);
    expect(h1.present).toBe('state-1');
    expect(canUndo(h1)).toBe(true);
    expect(canRedo(h1)).toBe(false);
  });

  it('undoes back to previous state and redoes forward', () => {
    let h = initHistory('state-0');
    h = historyReducer(h, { type: 'PUSH', snapshot: 'state-1' });
    h = historyReducer(h, { type: 'PUSH', snapshot: 'state-2' });

    expect(h.present).toBe('state-2');
    expect(canUndo(h)).toBe(true);

    // Undo -> state-1
    h = historyReducer(h, { type: 'UNDO' });
    expect(h.present).toBe('state-1');
    expect(h.future).toEqual(['state-2']);
    expect(canRedo(h)).toBe(true);

    // Redo -> state-2
    h = historyReducer(h, { type: 'REDO' });
    expect(h.present).toBe('state-2');
    expect(h.future).toEqual([]);
    expect(canRedo(h)).toBe(false);
  });

  it('coalesces rapid pushes when coalesce is true within debounce window', () => {
    let h = initHistory('state-0');
    h = historyReducer(h, { type: 'PUSH', snapshot: 'state-1' });
    h = historyReducer(h, { type: 'PUSH', snapshot: 'state-2', coalesce: true, debounceMs: 5000 });
    // past still has state-0, present was replaced with state-2
    expect(h.past).toEqual(['state-0']);
    expect(h.present).toBe('state-2');
  });
});
