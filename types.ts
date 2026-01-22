export type ShapeType = 'rect' | 'circle' | 'triangle' | 'text';

export interface CanvasElement {
  id: string;
  type: ShapeType;
  x: number; // percentage 0-100
  y: number; // percentage 0-100
  width?: number; // percentage 0-100 (for rect, triangle)
  height?: number; // percentage 0-100 (for rect, triangle)
  radius?: number; // percentage 0-100 (for circle)
  fill: string;
  text?: string; // for text type
  fontSize?: number;
}

export interface CanvasState {
  elements: CanvasElement[];
}

export type CanvasAction =
  | { type: 'ADD_ELEMENT'; payload: CanvasElement }
  | { type: 'UPDATE_ELEMENT'; payload: { id: string; updates: Partial<CanvasElement> } }
  | { type: 'REMOVE_ELEMENT'; payload: string }
  | { type: 'SET_STATE'; payload: CanvasElement[] }
  | { type: 'CLEAR' };

export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  isFinal?: boolean;
}
