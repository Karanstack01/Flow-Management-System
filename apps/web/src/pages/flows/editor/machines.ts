/**
 * Explicit state machines for the flow editor UI. Previously these were loose
 * booleans (`selectedId`, `inspectorOpen`, `busy`) that could combine into
 * impossible states — e.g. a selected node with a hidden inspector, or a second
 * save starting while the first was still in flight.
 */

// ------------------------------------------------------------------ side panel
export type PanelState = { kind: 'closed' } | { kind: 'node'; id: string } | { kind: 'settings' };

export type PanelEvent =
  /** A single node became selected (click, add, issue jump). */
  | { type: 'SELECT'; id: string }
  /** Selection became empty (e.g. rubber-band cleared). Only closes a node panel. */
  | { type: 'DESELECT' }
  /** Toolbar button / flow name: toggles flow settings. */
  | { type: 'TOGGLE_SETTINGS' }
  /** Close button, Escape, click on empty canvas. */
  | { type: 'CLOSE' }
  /** Nodes were deleted; close if the open one is among them. */
  | { type: 'REMOVED'; ids: readonly string[] };

export const PANEL_CLOSED: PanelState = { kind: 'closed' };

export function panelReducer(state: PanelState, event: PanelEvent): PanelState {
  switch (event.type) {
    case 'SELECT':
      return state.kind === 'node' && state.id === event.id ? state : { kind: 'node', id: event.id };
    case 'DESELECT':
      return state.kind === 'node' ? PANEL_CLOSED : state;
    case 'TOGGLE_SETTINGS':
      return state.kind === 'settings' ? PANEL_CLOSED : { kind: 'settings' };
    case 'CLOSE':
      return state.kind === 'closed' ? state : PANEL_CLOSED;
    case 'REMOVED':
      return state.kind === 'node' && event.ids.includes(state.id) ? PANEL_CLOSED : state;
  }
}

// ------------------------------------------------------------------ save
export type SaveState = { kind: 'idle' } | { kind: 'saving'; publish: boolean } | { kind: 'saved'; version: number; at: number } | { kind: 'failed'; message: string };

export type SaveEvent = { type: 'START'; publish: boolean } | { type: 'SUCCEEDED'; version: number; at: number } | { type: 'FAILED'; message: string } | { type: 'EDITED' } | { type: 'SETTLE' };

export const SAVE_IDLE: SaveState = { kind: 'idle' };

export function saveReducer(state: SaveState, event: SaveEvent): SaveState {
  switch (event.type) {
    case 'START':
      // A save in flight cannot be started again (double click, Ctrl+S spam).
      return state.kind === 'saving' ? state : { kind: 'saving', publish: event.publish };
    case 'SUCCEEDED':
      return state.kind === 'saving' ? { kind: 'saved', version: event.version, at: event.at } : state;
    case 'FAILED':
      return state.kind === 'saving' ? { kind: 'failed', message: event.message } : state;
    case 'EDITED':
    case 'SETTLE':
      // The "Saved" tick / error badge fades once the user edits again or after a moment.
      return state.kind === 'saved' || state.kind === 'failed' ? SAVE_IDLE : state;
  }
}

export const canStartSave = (s: SaveState) => s.kind !== 'saving';
