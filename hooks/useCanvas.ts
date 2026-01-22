import { useReducer, useEffect, useCallback } from 'react';
import { CanvasState, CanvasAction, CanvasElement } from '../types';

const initialState: CanvasState = {
  elements: [],
};

export function canvasReducer(state: CanvasState, action: CanvasAction): CanvasState {
  switch (action.type) {
    case 'ADD_ELEMENT':
      return { ...state, elements: [...state.elements, action.payload] };
    case 'UPDATE_ELEMENT':
      return {
        ...state,
        elements: state.elements.map((el) =>
          el.id === action.payload.id ? { ...el, ...action.payload.updates } : el
        ),
      };
    case 'REMOVE_ELEMENT':
      return {
        ...state,
        elements: state.elements.filter((el) => el.id !== action.payload),
      };
    case 'SET_STATE':
      return { ...state, elements: action.payload };
    case 'CLEAR':
      return { ...state, elements: [] };
    default:
      return state;
  }
}

export function useCanvas() {
  const [state, dispatch] = useReducer(canvasReducer, initialState);

  // Sync with BroadcastChannel for "Collaboration"
  useEffect(() => {
    const channel = new BroadcastChannel('canvas_collab');

    channel.onmessage = (event) => {
      const { type, payload } = event.data;
      // We process the action locally without re-broadcasting
      dispatch({ type, payload });
    };

    return () => {
      channel.close();
    };
  }, []);

  // Wrapper for dispatch that also broadcasts
  const broadcastAction = useCallback((action: CanvasAction) => {
    dispatch(action);
    const channel = new BroadcastChannel('canvas_collab');
    channel.postMessage(action);
    channel.close();
  }, []);

  const addElement = (element: CanvasElement) => broadcastAction({ type: 'ADD_ELEMENT', payload: element });
  const updateElement = (id: string, updates: Partial<CanvasElement>) =>
    broadcastAction({ type: 'UPDATE_ELEMENT', payload: { id, updates } });
  const removeElement = (id: string) => broadcastAction({ type: 'REMOVE_ELEMENT', payload: id });
  const clearCanvas = () => broadcastAction({ type: 'CLEAR' });
  const setElements = (elements: CanvasElement[]) => broadcastAction({ type: 'SET_STATE', payload: elements });

  return {
    elements: state.elements,
    addElement,
    updateElement,
    removeElement,
    clearCanvas,
    setElements,
  };
}
