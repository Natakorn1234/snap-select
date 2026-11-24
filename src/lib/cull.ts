import { CullStatus, StatusMap } from './types';

/** Pure reducer for statuses with an undo stack. Status is per group, so RAW+JPEG always change together. */
export interface CullState {
  statuses: StatusMap;
  undo: { ids: string[]; prev: CullStatus[] }[];
}

export type CullAction =
  | { type: 'set'; ids: string[]; status: CullStatus }
  | { type: 'undo' }
  | { type: 'load'; statuses: StatusMap };

const MAX_UNDO = 500;

export function cullReducer(state: CullState, action: CullAction): CullState {
  switch (action.type) {
    case 'set': {
      const ids = action.ids.filter((id) => (state.statuses[id] ?? 'UNRATED') !== action.status);
      if (!ids.length) return state;
      const prev = ids.map((id) => state.statuses[id] ?? 'UNRATED');
      const statuses = { ...state.statuses };
      for (const id of ids) statuses[id] = action.status;
      return { statuses, undo: [...state.undo, { ids, prev }].slice(-MAX_UNDO) };
    }
    case 'undo': {
      const last = state.undo[state.undo.length - 1];
      if (!last) return state;
      const statuses = { ...state.statuses };
      last.ids.forEach((id, i) => (statuses[id] = last.prev[i]));
      return { statuses, undo: state.undo.slice(0, -1) };
    }
    case 'load':
      return { statuses: { ...action.statuses }, undo: [] };
  }
}

export function countStatuses(ids: string[], statuses: StatusMap): Record<CullStatus, number> {
  const c: Record<CullStatus, number> = { UNRATED: 0, KEEP: 0, MAYBE: 0, REJECT: 0 };
  for (const id of ids) c[statuses[id] ?? 'UNRATED']++;
  return c;
}
