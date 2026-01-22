import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Type,
  FunctionDeclaration,
} from '@google/genai';
import { createPcmBlob, decodeAudioData, base64ToUint8Array, blobToBase64 } from '../utils/audio';
import { CanvasElement, ChatMessage } from '../types';

// Tool Definitions
export const drawShapeTool: FunctionDeclaration = {
  name: 'draw_shape',
  description: 'Draw a basic geometric shape on the canvas. Coordinates are 0-100 percentages.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING, enum: ['rect', 'circle', 'triangle'], description: 'The type of shape' },
      x: { type: Type.NUMBER, description: 'X coordinate (0-100)' },
      y: { type: Type.NUMBER, description: 'Y coordinate (0-100)' },
      size: { type: Type.NUMBER, description: 'Size of the shape (width/diameter) (0-100)' },
      color: { type: Type.STRING, description: 'CSS color name or hex' },
    },
    required: ['type', 'x', 'y', 'size', 'color'],
  },
};

export const addTextTool: FunctionDeclaration = {
  name: 'add_text',
  description: 'Add text to the canvas.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      text: { type: Type.STRING, description: 'The text content' },
      x: { type: Type.NUMBER, description: 'X coordinate (0-100)' },
      y: { type: Type.NUMBER, description: 'Y coordinate (0-100)' },
      color: { type: Type.STRING, description: 'Color of text' },
      fontSize: { type: Type.NUMBER, description: 'Font size (1-20)' },
    },
    required: ['text', 'x', 'y'],
  },
};

export const removeElementTool: FunctionDeclaration = {
  name: 'remove_element',
  description: 'Remove the element at or closest to the specified X, Y coordinates.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      x: { type: Type.NUMBER, description: 'X coordinate (0-100) of the item to remove' },
      y: { type: Type.NUMBER, description: 'Y coordinate (0-100) of the item to remove' },
    },
    required: ['x', 'y'],
  },
};

export const clearBoardTool: FunctionDeclaration = {
  name: 'clear_board',
  description: 'Clear everything from the canvas.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

export const SYSTEM_INSTRUCTION = `
  You are a collaborative creative assistant and a PERFECTIONIST.
  You help users draw on a shared digital canvas (100x100 units).
  
  CRITICAL VISUAL FEEDBACK LOOP:
  1. When asked to draw, use the provided tools.
  2. After you draw, you will receive an IMAGE of the canvas.
  3. You MUST look at this image to verify if it is EXACTLY what the user wanted.
  
  ERROR CORRECTION RULES (BULLETPROOF):
  - If the drawing is incorrect, you MUST FIX IT IMMEDIATELY.
  - NEVER just draw a new correct shape on top of a wrong one. This creates a mess.
  - YOU MUST DELETE THE MISTAKE FIRST using the 'remove_element' tool (at the location of the error).
  - OR, if the board is cluttered with mistakes, use 'clear_board' and redraw the scene from scratch.
  - Be precise with coordinates.
  
  When asked "what is this?" describe what you see visually.
  Be concise, enthusiastic, and helpful.
`;

export class GeminiLiveService {
  private client: GoogleGenAI;
  private session: any = null; // Session type isn't fully exported for 'LiveSession', using any
  private inputAudioContext: AudioContext | null = null;
  private outputAudioContext: AudioContext | null = null;
  private nextStartTime = 0;
  private toolsHandler: (name: string, args: any) => void;
  private onTranscript: (message: ChatMessage) => void;
  private frameInterval: number | null = null;
  private stream: MediaStream | null = null;

  // Transcription buffers
  private currentInputTranscription = '';
  private currentOutputTranscription = '';

  constructor(
    apiKey: string, 
    toolsHandler: (name: string, args: any) => void,
    onTranscript: (message: ChatMessage) => void
  ) {
    this.client = new GoogleGenAI({ apiKey });
    this.toolsHandler = toolsHandler;
    this.onTranscript = onTranscript;
  }

  async connect(getCanvasSnapshot: () => Promise<globalThis.Blob | null>) {
    this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: 16000,
    });
    this.outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: 24000,
    });
    
    // Resume audio contexts if suspended (browser policy)
    if (this.outputAudioContext.state === 'suspended') {
      await this.outputAudioContext.resume();
    }

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const config = {
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
        },
        tools: [{ functionDeclarations: [drawShapeTool, addTextTool, removeElementTool, clearBoardTool] }],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: SYSTEM_INSTRUCTION,
      },
    };

    const sessionPromise = this.client.live.connect({
      model: config.model,
      config: config.config,
      callbacks: {
        onopen: async () => {
            console.log("Session opened");
            // Start Audio Stream
            const source = this.inputAudioContext!.createMediaStreamSource(this.stream!);
            const processor = this.inputAudioContext!.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const blob = createPcmBlob(inputData);
                sessionPromise.then(session => session.sendRealtimeInput({ media: blob }));
            };
            
            source.connect(processor);
            processor.connect(this.inputAudioContext!.destination);

            // Start Video Stream (Canvas Snapshots)
            // 1 FPS is enough for context
            this.frameInterval = window.setInterval(async () => {
                const blob = await getCanvasSnapshot();
                if (blob) {
                    const base64 = await blobToBase64(blob);
                    sessionPromise.then(session => session.sendRealtimeInput({ 
                        media: { 
                            mimeType: 'image/jpeg', 
                            data: base64 
                        } 
                    }));
                }
            }, 1000);
        },
        onmessage: async (msg: LiveServerMessage) => {
            // Handle Tool Calls
            if (msg.toolCall) {
                for (const fc of msg.toolCall.functionCalls) {
                    this.toolsHandler(fc.name, fc.args);
                    // Send success response
                    sessionPromise.then(session => session.sendToolResponse({
                        functionResponses: {
                            id: fc.id,
                            name: fc.name,
                            response: { result: 'success' }
                        }
                    }));
                }
            }

            // Handle Transcriptions
            if (msg.serverContent?.inputTranscription) {
              const text = msg.serverContent.inputTranscription.text;
              this.currentInputTranscription += text;
            }
            if (msg.serverContent?.outputTranscription) {
              const text = msg.serverContent.outputTranscription.text;
              this.currentOutputTranscription += text;
            }

            if (msg.serverContent?.turnComplete) {
              if (this.currentInputTranscription.trim()) {
                this.onTranscript({
                  id: crypto.randomUUID(),
                  role: 'user',
                  text: this.currentInputTranscription,
                  isFinal: true
                });
                this.currentInputTranscription = '';
              }
              if (this.currentOutputTranscription.trim()) {
                this.onTranscript({
                  id: crypto.randomUUID(),
                  role: 'model',
                  text: this.currentOutputTranscription,
                  isFinal: true
                });
                this.currentOutputTranscription = '';
              }
            }

            // Handle Audio Output
            if (msg.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                const audioData = msg.serverContent.modelTurn.parts[0].inlineData.data;
                this.playAudio(audioData);
            }
        },
        onclose: () => {
            console.log("Session closed");
            this.cleanup();
        },
        onerror: (err) => {
            console.error("Session error", err);
            this.cleanup();
        }
      }
    });

    this.session = sessionPromise;
  }

  async sendText(text: string) {
    if (this.session) {
      const session = await this.session;
      session.sendRealtimeInput({
        content: {
          role: 'user',
          parts: [{ text: text }],
        },
      });
    }
  }

  async playAudio(base64Data: string) {
    if (!this.outputAudioContext) return;
    
    this.nextStartTime = Math.max(this.outputAudioContext.currentTime, this.nextStartTime);
    
    try {
        const audioBuffer = await decodeAudioData(
            base64ToUint8Array(base64Data),
            this.outputAudioContext,
            24000
        );
        
        const source = this.outputAudioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.outputAudioContext.destination);
        source.start(this.nextStartTime);
        
        this.nextStartTime += audioBuffer.duration;
    } catch (e) {
        console.error("Error decoding audio", e);
    }
  }

  async disconnect() {
    if (this.session) {
        const session = await this.session;
        session.close();
    }
    this.cleanup();
  }

  cleanup() {
    if (this.frameInterval) clearInterval(this.frameInterval);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.inputAudioContext) this.inputAudioContext.close();
    if (this.outputAudioContext) this.outputAudioContext.close();
    
    this.frameInterval = null;
    this.stream = null;
    this.inputAudioContext = null;
    this.outputAudioContext = null;
    this.session = null;
    this.currentInputTranscription = '';
    this.currentOutputTranscription = '';
  }
}
